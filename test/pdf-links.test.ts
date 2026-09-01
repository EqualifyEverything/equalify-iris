import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LINKS_PER_PAGE,
  MAX_PDF_PAGES,
  PdfTooLargeError,
  pageRanges,
  parsePdfHtmlLinks,
  rasterShards,
  rasterizePdf,
  type PdfLink,
} from "../src/util/pdf.ts";
import {
  droppedHrefs,
  missingLinkProblem,
  missingLinks,
  pageLinkContext,
  unexpectedHrefs,
  unresolvedRefs,
} from "../src/pipeline/links.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { enumerateInputs } from "../src/pipeline/orchestrator.ts";
import { Paths } from "../src/store/paths.ts";
import type { IrisConfig } from "../src/config.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// A link in a PDF is an annotation over the page, not ink on it, so rasterizing for
// the vision model destroys every link target while leaving the text that carried it.
// These tests cover the path that carries them across anyway: read the targets out of
// the file, persist them beside the page images, put them in front of the page agent,
// and check deterministically that they came back.

// ---------------------------------------------------------------------------
// Reading the annotations out of the file
// ---------------------------------------------------------------------------

// Captured pdftohtml -xml output. Verbatim in shape, including two things real files
// do and a hand-written sample would not: a link's text split across lines into two
// <a> elements with the same href, and stray document text ahead of the first <page>
// marker (poppler prints an outline title there), which is why the parse is a scan.
const CAPTURED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd">

<pdf2xml producer="poppler" version="26.04.0">
 link to page 2 <page number="1" position="absolute" top="0" left="0" height="1188" width="918">
\t<fontspec id="0" size="21" family="Helvetica" color="#000000"/>
<text top="123" left="108" width="124" height="19" font="0"><a href="https://example.org/report?y=2026&amp;q=1">Read the full </a></text>
<text top="153" left="108" width="172" height="19" font="0"><a href="https://example.org/report?y=2026&amp;q=1"><b>annual report</b> here</a></text>
<text top="273" left="108" width="107" height="19" font="0"><a href="linky2.html#2">See page 2</a></text>
<text top="303" left="108" width="107" height="19" font="0"><a href="javascript:alert(1)">Danger zone</a></text>
</page>
<page number="2" position="absolute" top="0" left="0" height="1188" width="918">
<text top="123" left="108" width="81" height="19" font="0"><a href="mailto:a11y@example.org">Email us</a></text>
<text top="183" left="108" width="432" height="19" font="0">No link on this line.</text>
</page>
</pdf2xml>`;

test("links are read per page, with runs of one link joined into one", () => {
  const byPage = parsePdfHtmlLinks(CAPTURED_XML);
  assert.deepEqual(byPage.get(1), [
    // Two <a> elements, one link: the trailing space in the first run is what tells
    // the join not to insert another. Inner <b> is styling, not text.
    { text: "Read the full annual report here", href: "https://example.org/report?y=2026&q=1" },
  ]);
  assert.deepEqual(byPage.get(2), [{ text: "Email us", href: "mailto:a11y@example.org" }]);
});

test("only schemes we can safely re-emit survive", () => {
  const page1 = parsePdfHtmlLinks(CAPTURED_XML).get(1) ?? [];
  const hrefs = page1.map((l) => l.href);
  // A PDF's URI action is text the file controls, and it lands in a document we hand
  // to a browser.
  assert.ok(!hrefs.some((h) => h.startsWith("javascript:")), "script URL dropped, not sanitized");
  // Internal destinations are rendered by poppler as a file that does not exist here.
  assert.ok(!hrefs.some((h) => h.includes(".html#")), "internal GoTo destination dropped");
});

test("a URL that would break out of the attribute it is written into is dropped", () => {
  // An allowlisted scheme is not enough. poppler escapes a quote inside a URI action
  // as `&quot;` (verified against poppler 26.04.0, see the round trip below), so the
  // payload arrives whole through the href regex, and decodeEntities restores the raw
  // quote before anything writes it into a document served as text/html.
  const xml =
    `<page number="1">` +
    `<text><a href="https://ok.example/a&quot; onmouseover=&quot;alert(1)">Click here</a></text>` +
    `<text><a href="https://ok.example/b&#34;&gt;&lt;script&gt;">Numeric</a></text>` +
    `<text><a href="https://ok.example/c and d">Spaced</a></text>` +
    `<text><a href="https://ok.example/safe-with-hyphens_and~stuff?a=1&amp;b=2#f">Fine</a></text>` +
    `</page>`;
  assert.deepEqual(parsePdfHtmlLinks(xml).get(1), [
    // The one legitimate URL survives — including its hyphens, which a careless
    // character class would reject along with the payloads.
    { text: "Fine", href: "https://ok.example/safe-with-hyphens_and~stuff?a=1&b=2#f" },
  ]);
});

test("a link before any page marker is dropped rather than misattributed", () => {
  const xml = `<a href="https://example.org/orphan">Outline entry</a>\n<page number="1"><text><a href="https://example.org/real">Real</a></text></page>`;
  assert.deepEqual(parsePdfHtmlLinks(xml).get(1), [{ text: "Real", href: "https://example.org/real" }]);
});

test("a line-broken link with no spaces around the break does not run its words together", () => {
  const xml =
    `<page number="1">` +
    `<text><a href="https://example.org/p">our accessibility</a></text>` +
    `<text><a href="https://example.org/p">policy</a></text>` +
    `</page>`;
  assert.equal(parsePdfHtmlLinks(xml).get(1)?.[0].text, "our accessibility policy");
});

test("a hyphenated break keeps its hyphen instead of gaining a space", () => {
  const xml =
    `<page number="1">` +
    `<text><a href="https://example.org/p">accessi-</a></text>` +
    `<text><a href="https://example.org/p">bility</a></text>` +
    `</page>`;
  assert.equal(parsePdfHtmlLinks(xml).get(1)?.[0].text, "accessi-bility");
});

test("two different links on one page stay two links", () => {
  const xml =
    `<page number="1">` +
    `<text><a href="https://example.org/a">A</a></text>` +
    `<text><a href="https://example.org/b">B</a></text>` +
    `<text><a href="https://example.org/a">A again</a></text>` +
    `</page>`;
  assert.deepEqual(parsePdfHtmlLinks(xml).get(1)?.map((l) => l.href), [
    "https://example.org/a",
    "https://example.org/b",
    "https://example.org/a",
  ]);
});

// ---------------------------------------------------------------------------
// End to end through poppler
// ---------------------------------------------------------------------------

// A PDF built byte by byte, because the properties worth testing here are properties
// of a real file read by the real tool: which page an annotation belongs to, and
// whether poppler can find the text under its rectangle. Two pages — page 1 carries a
// URI link whose text breaks across two lines, a script URL, and an internal jump;
// page 2 carries a mailto.
function linkPdf(): Buffer {
  const page1 =
    "BT /F1 14 Tf 72 700 Td (Read the full ) Tj 0 -20 Td (annual report here) Tj ET\n" +
    "BT /F1 14 Tf 72 620 Td (Danger zone) Tj ET\n" +
    "BT /F1 14 Tf 72 580 Td (See page two) Tj ET";
  const page2 = "BT /F1 14 Tf 72 700 Td (Email the team) Tj ET";
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> " +
      "/Contents 4 0 R /Annots [6 0 R 7 0 R 10 0 R] >>",
    stream(page1),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 674 300 716] /Border [0 0 0] " +
      "/A << /S /URI /URI (https://example.org/report?y=2026&q=1) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 574 175 594] /Border [0 0 0] " +
      "/A << /S /GoTo /D [8 0 R /XYZ 0 700 0] >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> " +
      "/Contents 9 0 R /Annots [11 0 R] >>",
    stream(page2),
    "<< /Type /Annot /Subtype /Link /Rect [72 614 160 634] /Border [0 0 0] " +
      "/A << /S /URI /URI (javascript:alert%281%29) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 694 190 714] /Border [0 0 0] " +
      "/A << /S /URI /URI (mailto:team@example.org) >> >>",
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function hasPoppler(): boolean {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    execFileSync("pdftohtml", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "rasterizing a real PDF carries each page's links with its image",
  { skip: hasPoppler() ? false : "poppler-utils not installed" },
  async () => {
    const pages = await rasterizePdf(linkPdf(), "report.pdf");
    assert.equal(pages.length, 2);
    // Page 1's link, with its text rejoined across the line break, and nothing else:
    // the script URL and the internal jump are both dropped.
    assert.deepEqual(pages[0].links, [
      { text: "Read the full annual report here", href: "https://example.org/report?y=2026&q=1" },
    ]);
    // Attributed to the page it is actually on — page 2's link is not page 1's.
    assert.deepEqual(pages[1].links, [{ text: "Email the team", href: "mailto:team@example.org" }]);
  },
);

test(
  "a PDF with no links rasterizes to pages with no links, not a failure",
  { skip: hasPoppler() ? false : "poppler-utils not installed" },
  async () => {
    const plain = Buffer.from(
      linkPdf()
        .toString("latin1")
        // Drop both pages' /Annots arrays, leaving the rest of the file intact.
        .replace(/\/Annots \[[^\]]*\] /g, ""),
      "latin1",
    );
    const pages = await rasterizePdf(plain, "plain.pdf");
    assert.equal(pages.length, 2);
    for (const p of pages) assert.deepEqual(p.links, []);
  },
);

test(
  "a real PDF whose URI action carries a quote does not put that quote in the output",
  { skip: hasPoppler() ? false : "poppler-utils not installed" },
  async () => {
    // The `"` needs no escaping in a PDF literal string, so this is a URI action a
    // hostile file can simply contain. Parens are percent-encoded only because they
    // delimit that string.
    const payload = 'https://ok.example/a" onmouseover="alert%281%29';
    const hostile = Buffer.from(
      linkPdf().toString("latin1").replace("https://example.org/report?y=2026&q=1", payload),
      "latin1",
    );

    // First, the fact the filter exists for: this poppler build escapes the quote
    // rather than truncating the URL, so the payload really does reach the parse.
    // If a future poppler stops doing that, this assertion is where to find out.
    const dir = mkdtempSync(join(tmpdir(), "iris-pdf-hostile-"));
    try {
      const path = join(dir, "hostile.pdf");
      writeFileSync(path, hostile);
      const xml = execFileSync("pdftohtml", ["-xml", "-stdout", "-i", "-q", path], {
        encoding: "utf8",
      });
      assert.match(xml, /onmouseover=&quot;/, "poppler escapes the quote, keeping the payload whole");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Second, what we do about it: the link is dropped, not sanitized and not passed on.
    const pages = await rasterizePdf(hostile, "hostile.pdf");
    assert.deepEqual(pages[0].links, []);
    assert.deepEqual(pages[1].links, [{ text: "Email the team", href: "mailto:team@example.org" }]);
  },
);

// ---------------------------------------------------------------------------
// Dividing the render between processes
// ---------------------------------------------------------------------------

// pdftoppm is single-threaded, so a document is rasterized by splitting its page range
// across processes. What has to hold is that the split is a partition of the document —
// every page rendered, once, and no shard asking for a page the file does not have,
// which pdftoppm refuses outright rather than ignoring.

test("a shard count never exceeds the pages there are to render", () => {
  assert.equal(rasterShards(MAX_PDF_PAGES, 4, 0), 4);
  // One page cannot be split four ways, and a shard past the end is a failed render.
  assert.equal(rasterShards(1, 8, 0), 1);
  assert.equal(rasterShards(2, 8, 0), 2);
  // A machine that reports nothing usable renders the way it always did.
  for (const cpus of [0, -3, Number.NaN, 1.9]) {
    assert.equal(rasterShards(MAX_PDF_PAGES, cpus, 0), 1, `cpus=${cpus} falls back to one process`);
  }
});

test("the core budget is the host's, and a busy host still renders", () => {
  // Rasterization runs on the upload request, before anything queues it, so several
  // documents can be in pdftoppm at once. Each takes what is LEFT rather than a fresh
  // core count — otherwise a 32-core host serving four uploads runs a hundred renders.
  assert.equal(rasterShards(MAX_PDF_PAGES, 8, 0), 8);
  assert.equal(rasterShards(MAX_PDF_PAGES, 8, 5), 3);
  // Exhausted, and past exhausted: one process each, which is exactly what a document
  // got before the range was split at all. A stall here would be far worse than a slow
  // render — the uploader is waiting on this call.
  assert.equal(rasterShards(MAX_PDF_PAGES, 8, 8), 1);
  assert.equal(rasterShards(MAX_PDF_PAGES, 8, 99), 1);
  // A count that has somehow gone negative must not hand out MORE than the host has.
  assert.equal(rasterShards(MAX_PDF_PAGES, 8, -4), 8);
});

test("the ranges partition the document: every page once, none past the end", () => {
  for (let pages = 1; pages <= MAX_PDF_PAGES; pages++) {
    for (let cpus = 1; cpus <= 16; cpus++) {
      const ranges = pageRanges(pages, rasterShards(pages, cpus, 0));
      const covered: number[] = [];
      for (const [first, last] of ranges) {
        assert.ok(first >= 1 && last <= pages, `range ${first}-${last} inside 1-${pages} (cpus=${cpus})`);
        assert.ok(first <= last, `range ${first}-${last} is not inverted (cpus=${cpus})`);
        for (let p = first; p <= last; p++) covered.push(p);
      }
      assert.deepEqual(
        covered,
        Array.from({ length: pages }, (_, i) => i + 1),
        `pages=${pages} cpus=${cpus} renders each page exactly once, in order`,
      );
    }
  }
});

// An n-page PDF with one line of text per page and no annotations. Built the same way
// as linkPdf, and used only where the page COUNT is the subject.
function plainPdf(n: number): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (let p = 1; p <= n; p++) {
    const text = `BT /F1 14 Tf 72 700 Td (Page ${p}) Tj ET`;
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> ` +
        `/Contents ${objs.length} 0 R >>`,
    );
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test(
  "a document over the page cap is refused before anything is rendered",
  { skip: hasPoppler() ? false : "poppler-utils not installed" },
  async () => {
    // The page count is read for two reasons now — the cap and the shard count — and
    // the cap is the one a user meets: it is what turns an unbounded rasterization into
    // a clean 400 at the upload route.
    await assert.rejects(
      () => rasterizePdf(plainPdf(MAX_PDF_PAGES + 1), "long.pdf"),
      (e: Error) => e instanceof PdfTooLargeError && e.message.includes(String(MAX_PDF_PAGES + 1)),
    );
    // And a document exactly at the cap is not: the boundary is "more than", as the
    // message a user is shown claims.
    const pages = await rasterizePdf(plainPdf(MAX_PDF_PAGES), "atcap.pdf");
    assert.equal(pages.length, MAX_PDF_PAGES);
    assert.deepEqual(pages.map((p) => p.name).slice(0, 2), ["atcap-p1.png", "atcap-p2.png"]);
  },
);

// Long enough that poppler pads the filename to two digits and a shard holds more than
// one page on an ordinary host, short enough that the serial render it is compared
// against does not dominate the suite.
const SPLIT_PAGES = 12;

test(
  "a render in flight is subtracted from what the next document may take",
  {
    skip: !hasPoppler()
      ? "poppler-utils not installed"
      : // With one core a document takes one process whether or not anything else is
        // rendering, so there is no reduction to observe.
        rasterShards(MAX_PDF_PAGES, undefined, 0) < 2
        ? "single-core machine: nothing to subtract"
        : false,
  },
  async () => {
    // The arithmetic is covered above; what this covers is that it is WIRED — that
    // `rasterizePages` actually reserves its shards for as long as they run, so a second
    // upload arriving mid-render sees a smaller budget rather than a fresh core count.
    const idle = rasterShards(MAX_PDF_PAGES);
    let done = false;
    const inFlight = rasterizePdf(plainPdf(MAX_PDF_PAGES), "busy.pdf").finally(() => {
      done = true;
    });
    // Sampled until it moves or the render ends, rather than after a fixed sleep: the
    // reservation is held for the whole render, so any sample inside it will do, and
    // bounding the loop on `done` means a reservation that never happens fails the
    // assertion below instead of hanging.
    let seen = idle;
    while (!done && seen === idle) {
      await new Promise((r) => setTimeout(r, 2));
      seen = rasterShards(MAX_PDF_PAGES);
    }
    await inFlight;
    assert.ok(seen < idle, `a document rendering on ${idle} cores left fewer than ${idle} for the next`);
    // And released again: the next upload gets the whole host back.
    assert.equal(rasterShards(MAX_PDF_PAGES), idle, "the reservation is released when the render ends");
  },
);

test(
  "a document whose page count cannot be read still renders, still capped, and is still counted",
  { skip: hasPoppler() ? false : "poppler-utils not installed" },
  async () => {
    // pdfinfo missing or answering nonsense is the one path with no page count, and it
    // is the fallback everything else here is defined against: no shards, no size
    // rejection, just the single `-l MAX_PDF_PAGES` call this code made before any of
    // it. Both halves of that matter and neither was covered — the cap is what keeps an
    // unbounded document from being rasterized when pdfinfo cannot refuse it, and the
    // reservation is what keeps a render nobody counted from handing its core away.
    const bin = mkdtempSync(join(tmpdir(), "iris-pdf-nopdfinfo-"));
    const prevPath = process.env.PATH;
    try {
      writeFileSync(join(bin, "pdfinfo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      process.env.PATH = `${bin}:${prevPath}`;

      const idle = rasterShards(MAX_PDF_PAGES);
      let done = false;
      // One page OVER the cap: without pdfinfo there is nothing to reject it, so what
      // holds the line is pdftoppm's own `-l`.
      const inFlight = rasterizePdf(plainPdf(MAX_PDF_PAGES + 1), "unknown.pdf").finally(() => {
        done = true;
      });
      let seen = idle;
      while (!done && seen === idle) {
        await new Promise((r) => setTimeout(r, 2));
        seen = rasterShards(MAX_PDF_PAGES);
      }
      const pages = await inFlight;
      assert.equal(pages.length, MAX_PDF_PAGES, "the page cap still holds with no page count to read");
      if (idle > 1) {
        assert.ok(seen < idle, "the unsharded render is counted against the host budget too");
      }
      assert.equal(rasterShards(MAX_PDF_PAGES), idle, "and released when it ends");
    } finally {
      process.env.PATH = prevPath;
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

test(
  "a document rendered in shards is the same document rendered in one process",
  {
    skip: !hasPoppler()
      ? "poppler-utils not installed"
      : // A one-core machine renders in one process, so there would be no split to
        // compare against and the assertions below would pass without testing anything.
        rasterShards(SPLIT_PAGES, undefined, 0) < 2
        ? "single-core machine: nothing is split here"
        : false,
  },
  async () => {
    // The saving is only worth having if the pixels are identical, and they are for the
    // reason the split is safe at all: a page render reads that page and nothing else.
    // Compared against poppler run the way this code used to run it — one process over
    // the whole capped range — so a future poppler that stopped being page-local would
    // fail here rather than quietly shipping different images.
    //
    // Twelve pages rather than two, for the failure a split could hide silently.
    // poppler pads the output filename to the DOCUMENT's page count, so the shards
    // write pg-01..pg-12 into one directory and never collide; a build that numbered a
    // shard's output from 1 instead would have every shard overwrite pg-01, and what
    // came back would be a short document with no error anywhere. A two-page document
    // cannot show that — one page per shard, one digit either way.
    const pdf = plainPdf(SPLIT_PAGES);
    const sharded = await rasterizePdf(pdf, "report.pdf");
    assert.equal(sharded.length, SPLIT_PAGES, "every page survives the split");

    const dir = mkdtempSync(join(tmpdir(), "iris-pdf-serial-"));
    try {
      const path = join(dir, "in.pdf");
      writeFileSync(path, pdf);
      execFileSync("pdftoppm", ["-png", "-r", "150", "-l", String(MAX_PDF_PAGES), path, join(dir, "pg")]);
      for (let i = 0; i < sharded.length; i++) {
        const serial = readFileSync(join(dir, `pg-${String(i + 1).padStart(2, "0")}.png`));
        assert.ok(serial.equals(sharded[i].buffer), `page ${i + 1} is byte-identical`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// The prompt section and the arrival check
// ---------------------------------------------------------------------------

const LINKS: PdfLink[] = [
  { text: "annual report", href: "https://example.org/report?y=2026&q=1" },
  { text: "Email the team", href: "mailto:team@example.org" },
];

test("a page with no links adds nothing to the prompt", () => {
  assert.equal(pageLinkContext([]).section, "");
  assert.equal(pageLinkContext().section, "");
});

test("the prompt section carries every URL and its anchor text", () => {
  const { section, shown, dropped } = pageLinkContext(LINKS);
  assert.equal(shown.length, 2);
  assert.equal(dropped, 0);
  for (const l of LINKS) {
    assert.ok(section.includes(l.href), `${l.href} is in the prompt`);
    assert.ok(section.includes(l.text), `"${l.text}" is in the prompt`);
  }
  // The model is told which half of this it can trust.
  assert.match(section, /URLs are exact/i);
  assert.match(section, /APPROXIMATE/);
});

test("a page with more links than fit says how many were dropped", () => {
  const many = Array.from({ length: MAX_LINKS_PER_PAGE + 5 }, (_, i) => ({
    text: `link ${i}`,
    href: `https://example.org/${i}`,
  }));
  const { section, shown, dropped } = pageLinkContext(many);
  assert.equal(shown.length, MAX_LINKS_PER_PAGE);
  assert.equal(dropped, 5);
  // A cap that does not disclose itself reads as "all of them".
  assert.match(section, /and 5 more links on this page/);
});

test("a link that arrived is not reported missing, even re-encoded", () => {
  // The model writes &amp; into an attribute where poppler reported a bare &. Same URL.
  const html =
    `<p>Read the <a href="https://example.org/report?y=2026&amp;q=1">annual report</a> or ` +
    `<a href="mailto:team@example.org">email the team</a>.</p>`;
  assert.deepEqual(missingLinks(LINKS, html), []);
});

test("a scheme in different case, and a trailing slash, still match", () => {
  const links = [{ text: "home", href: "HTTPS://example.org/" }];
  assert.deepEqual(missingLinks(links, `<a href="https://example.org">home</a>`), []);
});

test("a dropped link is reported, and the report names the text and the URL", () => {
  const html = `<p>Read the annual report or email the team.</p>`;
  const missing = missingLinks(LINKS, html);
  assert.deepEqual(missing.map((l) => l.href), [LINKS[0].href, LINKS[1].href]);
  const problem = missingLinkProblem(missing[0]);
  assert.ok(problem.includes("annual report"), "says where the link belongs");
  assert.ok(problem.includes(LINKS[0].href), "says exactly what URL to use");
});

test("a URL used twice on a page is satisfied by one link to it", () => {
  const repeated: PdfLink[] = [
    { text: "the report", href: "https://example.org/r" },
    { text: "read it here", href: "https://example.org/r" },
  ];
  assert.deepEqual(missingLinks(repeated, `<a href="https://example.org/r">the report</a>`), []);
});

test("a path's case is not normalized away — those are different URLs", () => {
  const links = [{ text: "policy", href: "https://example.org/Policy" }];
  assert.equal(missingLinks(links, `<a href="https://example.org/policy">policy</a>`).length, 1);
});

test("an href no annotation accounts for is reported, but only where there is a ground truth", () => {
  const html = `<a href="https://example.org/report?y=2026&q=1">report</a> <a href="https://invented.example/x">x</a>`;
  assert.deepEqual(unexpectedHrefs(LINKS, html), ["https://invented.example/x"]);
  // No annotations on the page means nothing to be unexpected against — an image
  // upload is not evidence of a fabricated URL.
  assert.deepEqual(unexpectedHrefs([], html), []);
  // The page agent's own in-document anchors are not this function's business.
  assert.deepEqual(unexpectedHrefs(LINKS, `<a href="#fn-1">1</a>`), []);
});

test("a relative href is not a URL an annotation could have supplied, so it is not reported", () => {
  // This list is the one signal that reads as "possibly a fabricated URL". A relative
  // href cannot be one — no annotation supplies it — and counting it dilutes the list.
  assert.deepEqual(unexpectedHrefs(LINKS, `<a href="page2.html">next</a>`), []);
  assert.deepEqual(unexpectedHrefs(LINKS, `<a href="/about">about</a>`), []);
  assert.deepEqual(droppedHrefs(`<a href="page2.html">next</a>`, `<p>next</p>`), []);
});

test("an entity that names an inherited property decodes to itself, not to a function", () => {
  // `&constructor;` matches the named-reference pattern, and a plain object literal
  // would answer that lookup from Object.prototype — decoding the URL to
  // "function Object() { [native code] }" on one side of the comparison only, and
  // reporting a link that IS in the document as missing.
  const links = [{ text: "t", href: "https://x.example/a?q=&constructor;1" }];
  assert.deepEqual(missingLinks(links, `<a href="https://x.example/a?q=&amp;constructor;1">t</a>`), []);
});

test("a rewrite that loses a link is detectable; one that only renames anchors is not", () => {
  const before = `<p><a href="https://example.org/a">a</a> <a href="#fn-1">1</a></p>`;
  assert.deepEqual(droppedHrefs(before, `<p>a <a href="#fn-1">1</a></p>`), ["https://example.org/a"]);
  // Renumbered footnote: legitimate editorial work, not a lost link.
  assert.deepEqual(droppedHrefs(before, `<p><a href="https://example.org/a">a</a> <a href="#fn-2">1</a></p>`), []);
  // Link text may change (2.4.4) as long as the target survives.
  assert.deepEqual(droppedHrefs(before, `<p><a href="https://example.org/a">the annual report</a></p>`), []);
});

// ---------------------------------------------------------------------------
// In-document references (#234)
// ---------------------------------------------------------------------------

test("a reference that lands is not reported; one whose id is nowhere is", () => {
  const html = `<a href="#s1">one</a> <a href="#s9">nine</a> <h2 id="s1">One</h2>`;
  assert.deepEqual(unresolvedRefs(html), { refs: 2, empty: 0, dangling: 1, ids: ["s9"] });
});

test("href=\"#\" is counted apart from a dangling id, because it cannot be repaired", () => {
  // The shape a page agent produces when it is asked for a table of contents and the
  // destinations are not on the page it can see. There is no id to rename it to, so
  // reporting it beside the dangling ones would put an unfixable and a fixable defect
  // under one number.
  const toc = `<ul><li><a href="#">Introduction</a></li><li><a href="#">Methods</a></li></ul>`;
  assert.deepEqual(unresolvedRefs(toc), { refs: 2, empty: 2, dangling: 0, ids: [] });
});

test("#top resolves without an element, in whatever case it is written", () => {
  // HTML defines both `#` and `#top` as the top of the document; a browser scrolls
  // there whether or not anything is named `top`. Only `#` is counted, and as `empty`.
  assert.deepEqual(unresolvedRefs(`<a href="#top">back to top</a>`), {
    refs: 1,
    empty: 0,
    dangling: 0,
    ids: [],
  });
  // An element that IS called `top` changes nothing, which is the point.
  assert.equal(unresolvedRefs(`<a href="#top">top</a><div id="top"></div>`).dangling, 0);
  // The `top` fragment is matched ASCII case-insensitively, unlike an id — so this is
  // the one comparison here that folds case, and a document full of "#TOP" back-links
  // is not a document full of dead references.
  assert.deepEqual(unresolvedRefs(`<a href="#TOP">back to top</a>`).ids, []);
});

test("only in-document references are this function's business", () => {
  const html = `<a href="https://example.org/a">a</a> <a href="page2.html#s1">next</a> <a>none</a>`;
  // An absolute URL is missingLinks/droppedHrefs/unexpectedHrefs territory, and a
  // fragment on ANOTHER document names an id this document cannot be expected to have
  // — reporting it would call a working cross-document link broken.
  assert.deepEqual(unresolvedRefs(html), { refs: 0, empty: 0, dangling: 0, ids: [] });
});

test("a fragment and the id it means match through percent-encoding and entities", () => {
  // The two are written by different components in different escapings: a fragment is
  // part of a URL and gets percent-encoded, an id is attribute text and gets entities.
  // Comparing the bytes would report every non-ASCII anchor in the document as dead.
  assert.equal(unresolvedRefs(`<a href="#f%C3%BC">f</a><p id="fü">x</p>`).dangling, 0);
  assert.equal(unresolvedRefs(`<a href="#a&amp;b">a</a><p id="a&b">x</p>`).dangling, 0);
  // A malformed escape is compared as written rather than thrown on: a reference is
  // not dead on account of a stray `%`.
  assert.equal(unresolvedRefs(`<a href="#100%">p</a><p id="100%">x</p>`).dangling, 0);
});

test("markup inside a comment is not markup — the delivered document carries prose in one", () => {
  // Every delivered document ends with the @unresolved list and its siblings, which
  // are model-written sentences ABOUT the document and quote its markup freely. An
  // <a> in there is not a link a reader can activate, and counting one inflates the
  // count and invents ids that were never in the body. (The first hand count of this
  // defect was wrong for exactly this reason.)
  const html =
    `<a href="#s1">one</a><h2 id="s1">One</h2>` +
    `<!-- @unresolved: the page wrote <a href="#s404"> and no such section exists -->`;
  assert.deepEqual(unresolvedRefs(html), { refs: 1, empty: 0, dangling: 0, ids: [] });
});

test("references are counted per link and the ids are the distinct set", () => {
  // Two units on purpose, because they answer different questions. `dangling` is what
  // `refs` is the denominator of — "4 of 5 references go nowhere" is the fact the tally
  // publishes — while `ids` is capped at 20 in the log line, so a table of contents
  // pointing forty times at one missing section must not spend the cap on one fact.
  const html = `<a href="#b">1</a><a href="#b">2</a><a href="#b">3</a><a href="#a">4</a><a href="#c">5</a>`;
  const got = unresolvedRefs(`${html}<h2 id="c">C</h2>`);
  assert.equal(got.refs, 5);
  assert.equal(got.dangling, 4);
  assert.deepEqual(got.ids, ["a", "b"]);
});

test("an id on any element counts, however it was written", () => {
  // The scan is a scan, like the rest of this file: single quotes and unquoted values
  // are what a model writes from time to time, and an id missed here reads as a dead
  // reference to a target that is right there.
  const html = `<a href="#x">x</a><a href="#y">y</a><a href="#z">z</a>` +
    `<p id='x'>x</p><td ID="y">y</td><div id=z>z</div>`;
  assert.equal(unresolvedRefs(html).dangling, 0);
});

test("an id= inside another attribute's value is not an id this document has", () => {
  // The failure mode worth a test of its own, because it hides the very defect this
  // function exists to find. A source PDF's annotation carrying `?id=intro` would
  // otherwise register `intro` as a target, and a genuinely dead `#intro` would report
  // clean — a silent under-count on the one metric nothing else measures.
  const html = `<a href="https://example.org/doc?id=intro">report</a><a href="#intro">Introduction</a>`;
  assert.deepEqual(unresolvedRefs(html).ids, ["intro"]);
  // `-` is a non-word character, so a `\bid=` scan reads `data-id` as an id too.
  assert.deepEqual(unresolvedRefs(`<div data-id="s1"></div><a href="#s1">x</a>`).ids, ["s1"]);
  // And the same guard on the href side: a query parameter named `href` is not a link.
  assert.equal(unresolvedRefs(`<a href="https://example.org/go?href=%23gone">x</a>`).refs, 0);
  // The other half of the guard, and the reason a closing quote counts as a separator:
  // a browser reads this as two attributes, and a page's output is delivered
  // unserialized when no id collides, so a real id must not go unseen over spacing.
  assert.equal(unresolvedRefs(`<a href="#x">x</a><p class="a"id="x">x</p>`).dangling, 0);
  // And why the separator class here is not anchors.ts's `ATTR_SEP`, which contains `/`.
  // Sharing that constant was tried, and it turned a URL PATH segment into a phantom id —
  // the same silent under-count as the first case above, on a likelier spelling.
  assert.deepEqual(unresolvedRefs(`<a href="https://x.example/id=intro">r</a><a href="#intro">I</a>`).ids, ["intro"]);
  // `<` is not a separator either: a tag's first attribute has whitespace in front of it
  // anyway, so `<` catches nothing, while `<id="foo">` is a tag whose NAME the tokenizer
  // reads as `id="foo"` — one more phantom, no upside.
  assert.deepEqual(unresolvedRefs(`<id="foo"><a href="#foo">f</a>`).ids, ["foo"]);
  // The separator still has to catch a real first attribute, which is the whitespace case.
  assert.equal(unresolvedRefs(`<p id="ok">o</p><a href="#ok">o</a>`).dangling, 0);
});

// ---------------------------------------------------------------------------
// Through the pipeline
// ---------------------------------------------------------------------------

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-pdf-links-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
  prompts: string[];
}

// Same shape as reextract.test.ts's context: only what extraction touches is real.
// No feedback.md, so verifyAgentOutput short-circuits to ok and the only fidelity
// problems a page can have are the ones this feature raises.
function makeCtx(
  dir: string,
  links: PdfLink[],
  reply: (prompt: string, callsForImage: number) => string,
  // Write a Feedback Agent too, so verifyAgentOutput actually runs and `reply` is
  // asked to answer its TASK: verify prompts. Off by default: most of these tests are
  // about the link check, and a page that has no fidelity verdict to protect is the
  // simpler case to assert on.
  withFeedback = false,
): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  if (withFeedback) {
    writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  }
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");

  const rec: Recorded = { events: [], prompts: [] };
  const ctx = {
    sessionId: "ses_test",
    images: [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png"), links }],
    extractionConcurrency: 1,
    recheckSampleSize: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const prompt = messages.map((m) => m.content).join("\n");
        rec.prompts.push(prompt);
        return { text: reply(prompt, rec.prompts.length) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

test("the page agent is shown the page's links", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, LINKS, () =>
      JSON.stringify({
        html: `<p><a href="https://example.org/report?y=2026&q=1">annual report</a> ` +
          `<a href="mailto:team@example.org">Email the team</a></p>`,
        log: "",
      }),
    );
    const { fragments } = await runExtraction(ctx);
    assert.equal(rec.prompts.length, 1, "links arrived first time; no correction pass");
    assert.match(rec.prompts[0], /## Links on this page/);
    assert.ok(rec.prompts[0].includes("https://example.org/report?y=2026&q=1"));
    assert.ok(fragments[0].innerHtml.includes(`href="https://example.org/report?y=2026&q=1"`));
    assert.equal(rec.events.find((e) => e.type === "page_links")?.data.links, 2);
    assert.ok(!rec.events.some((e) => e.type === "page_links_missing"));
  });
});

test("a page with no links sends the prompt it always sent", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, [], () => JSON.stringify({ html: "<p>Plain page.</p>", log: "" }));
    await runExtraction(ctx);
    assert.equal(rec.prompts.length, 1);
    assert.ok(!rec.prompts[0].includes("## Links on this page"));
    assert.ok(!rec.events.some((e) => e.type.startsWith("page_links")));
  });
});

test("a link the page agent drops is fed back to it with the source image", async () => {
  await withTemp(async (dir) => {
    // First pass transcribes the text and loses both links; the correction pass
    // attaches them.
    const { ctx, rec } = makeCtx(dir, LINKS, (_prompt, call) =>
      JSON.stringify(
        call === 1
          ? { html: "<p>Read the annual report or email the team.</p>", log: "" }
          : {
              html:
                `<p>Read the <a href="https://example.org/report?y=2026&q=1">annual report</a> or ` +
                `<a href="mailto:team@example.org">email the team</a>.</p>`,
            },
      ),
    );
    const { fragments } = await runExtraction(ctx);

    assert.equal(rec.prompts.length, 2, "one render + one correction");
    const missing = rec.events.find((e) => e.type === "page_links_missing");
    assert.deepEqual(missing?.data.links, [LINKS[0].href, LINKS[1].href]);
    // The correction pass is told what to fix AND is shown the URLs again — it cannot
    // re-attach a target it can no longer see, and the image never showed it.
    assert.match(rec.prompts[1], /and your output does not link to it/);
    assert.match(rec.prompts[1], /## Links on this page/);
    assert.ok(fragments[0].innerHtml.includes(`href="mailto:team@example.org"`));
    assert.match(fragments[0].log, /self-corrected/);
    assert.ok(!rec.events.some((e) => e.type === "page_links_unrecovered"));
  });
});

test("a link still missing after the correction pass is recorded, not silently delivered", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, LINKS, (_prompt, call) =>
      JSON.stringify({
        // The correction changes the page but never attaches the second link.
        html:
          call === 1
            ? "<p>Read the annual report or email the team.</p>"
            : `<p>Read the <a href="https://example.org/report?y=2026&q=1">annual report</a> or email the team.</p>`,
        log: "",
      }),
    );
    await runExtraction(ctx);
    const unrecovered = rec.events.find((e) => e.type === "page_links_unrecovered");
    assert.deepEqual(unrecovered?.data.links, ["mailto:team@example.org"]);
  });
});

// A page that PASSED its fidelity check and is re-rendered only to recover a link is
// the case this feature introduced: before it, correctPage ran only on output already
// known to be bad. These two tests pin what the rewrite has to earn.
const ORIGINAL = "<h2>Annual report</h2><p>Read the annual report or email the team.</p>";
const WITH_LINKS =
  `<h2>Annual report</h2><p>Read the <a href="https://example.org/report?y=2026&q=1">annual report</a> ` +
  `or <a href="mailto:team@example.org">email the team</a>.</p>`;

test("a link fix that costs a verified page its structure is discarded, not delivered", async () => {
  await withTemp(async (dir) => {
    // The correction attaches both links but demotes the heading to a <p>. The page
    // had passed verification, so the fragment that passed is the one kept.
    const broken = WITH_LINKS.replace("<h2>Annual report</h2>", "<p><strong>Annual report</strong></p>");
    const { ctx, rec } = makeCtx(
      dir,
      LINKS,
      (prompt) => {
        if (prompt.includes("TASK: verify")) {
          return prompt.includes("<strong>Annual report</strong>")
            ? JSON.stringify({ faithful: false, accessible: false, problems: ["The page heading is now a bold paragraph."] })
            : JSON.stringify({ faithful: true, accessible: true, problems: [] });
        }
        return JSON.stringify({ html: prompt.includes("does not link to it") ? broken : ORIGINAL, log: "" });
      },
      true,
    );
    const { fragments } = await runExtraction(ctx);

    assert.equal(fragments[0].innerHtml, ORIGINAL, "the fragment that passed verification is delivered");
    const rejected = rec.events.find((e) => e.type === "page_links_correction_rejected");
    assert.deepEqual(rejected?.data.links, [LINKS[0].href, LINKS[1].href]);
    assert.deepEqual(rejected?.data.problems, ["The page heading is now a bold paragraph."]);
    assert.ok(!/self-corrected/.test(fragments[0].log ?? ""), "a discarded correction is not logged as one");
  });
});

test("a link fix that verifies clean replaces the page, and the verdict keeps its own name", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(
      dir,
      LINKS,
      (prompt) => {
        if (prompt.includes("TASK: verify")) {
          return JSON.stringify({ faithful: true, accessible: true, problems: [] });
        }
        return JSON.stringify({ html: prompt.includes("does not link to it") ? WITH_LINKS : ORIGINAL, log: "" });
      },
      true,
    );
    const { fragments } = await runExtraction(ctx);

    assert.equal(fragments[0].innerHtml, WITH_LINKS);
    assert.ok(!rec.events.some((e) => e.type === "page_links_correction_rejected"));
    // page_verify_ok/page_verify_failed report the Feedback Agent's verdict and only
    // that, so a missing link does not turn a page that passed into a page that failed.
    assert.ok(rec.events.some((e) => e.type === "page_verify_ok"));
    assert.ok(!rec.events.some((e) => e.type === "page_verify_failed"));
    assert.ok(rec.events.some((e) => e.type === "page_links_missing"));
  });
});

test("an href the page invented is logged for review", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = makeCtx(dir, [LINKS[0]], () =>
      JSON.stringify({
        html:
          `<p><a href="https://example.org/report?y=2026&q=1">annual report</a> ` +
          `<a href="https://guessed.example/contact">contact us</a></p>`,
        log: "",
      }),
    );
    await runExtraction(ctx);
    assert.deepEqual(rec.events.find((e) => e.type === "page_links_unexpected")?.data.hrefs, [
      "https://guessed.example/contact",
    ]);
    // Logged, not corrected: a visible URL linked to itself lands here too.
    assert.equal(rec.prompts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Surviving the wait between upload and extraction
// ---------------------------------------------------------------------------

test("links persisted at upload are attached to the images the pipeline enumerates", async () => {
  await withTemp(async (dir) => {
    const paths = new Paths({ storage: { data_dir: dir, agents_dir: join(dir, "agents") } } as IrisConfig);
    const id = "ses_01";
    paths.initSession(id);
    // Two pages, as the upload route writes them: order prefix + original name.
    writeFileSync(join(paths.sessionInput(id), "0001__report-p1.png"), "png");
    writeFileSync(join(paths.sessionInput(id), "0002__report-p2.png"), "png");
    writeFileSync(paths.sessionLinks(id), JSON.stringify({ "2": LINKS }));

    const images = enumerateInputs(paths, id);
    assert.deepEqual(images.map((i) => i.order), [1, 2]);
    assert.deepEqual(images[0].links, [], "a page with no links gets an empty list, not undefined");
    assert.deepEqual(images[1].links, LINKS);
  });
});

test("a session with no links file (or an unreadable one) enumerates as it always did", async () => {
  await withTemp(async (dir) => {
    const paths = new Paths({ storage: { data_dir: dir, agents_dir: join(dir, "agents") } } as IrisConfig);
    const id = "ses_02";
    paths.initSession(id);
    writeFileSync(join(paths.sessionInput(id), "0001__page.png"), "png");
    assert.deepEqual(enumerateInputs(paths, id)[0].links, [], "no file: no links");
    // A truncated write must not fail a run whose links are, at worst, absent.
    writeFileSync(paths.sessionLinks(id), "{ not json");
    assert.deepEqual(enumerateInputs(paths, id)[0].links, []);
  });
});
