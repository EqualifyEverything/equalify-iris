// Issue #333: a delivered document announced `<hr role="doc-pagebreak" aria-label="Page 52"
// id="page-52">` at the head of the sheet that prints 38. The label names the position of the image
// in the file, which `agents/page.md` forbids by name — "use the number the page shows (iv, 5, A-3),
// never the position of the image you were given in the file" (:99) — and has forbidden at every
// prompt blob there is a round for. Two of three vendors did it anyway, on the same document and the
// same blob, on the same two pages, so it is not answered with more prose. It is answered in code,
// because the page marker is the one number on a page Iris supplied itself and can therefore check
// (src/pipeline/markers.ts).
//
// What is pinned here is the check's DECISION, in both directions, because the false-positive
// direction is where it costs a reader something: every page it acts on loses the name of its
// anchor, and a document whose numbering is merely irregular has to come back untouched.
//
// The reference corpus's own rows are the fixtures. Replaying this module over 61 chunks of paid
// rounds removed 29 labels, all 29 repeating a number in the page's own filename; the shipped page
// model's 6 and another vendor's 5 on the pinned round are the two arms #333 measured, and their
// front matter (cover, commission list, title page, `PART I`) prints no folio at all, checked
// against the scans. The one label an earlier version of the rule removed wrongly is here too, as
// the test named for a non-contiguous submission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAxe } from "../src/pipeline/lint.ts";
import { wrapDocument, assembleBodyWithReport, runAssembly } from "../src/pipeline/assembly.ts";
import { stripPositionalMarkers, folio, type MarkerPage } from "../src/pipeline/markers.ts";
import type { Fragment } from "../src/pipeline/fragment.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";

// A page as the check sees it: its submitted position, the filename its agent was told, and what it
// wrote. `marker` builds the shape the prompt prescribes (pinned in test/pagebreak-marker.test.ts).
const marker = (label: string | null, id = "x") =>
  label === null
    ? `<hr role="doc-pagebreak" id="page-${id}">`
    : `<hr role="doc-pagebreak" aria-label="${label}" id="page-${id}">`;

// One page of the reference corpus's shape: a marker, then some content, so the fixtures are not
// markers alone — the scan walks the whole fragment and has to find the same marker either way.
function page(order: number, name: string, label: string | null): MarkerPage {
  return { order, name, html: `${marker(label, String(order))}\n<p>Body of the sheet.</p>` };
}

// The corpus's arabic body, as a round submitted it: 25 pages in one chunk, positions restarting at
// 1 while the filenames keep the document's own numbering — `acir-pNNN.png`, which is how Iris names
// its own renders (`util/pdf.ts`) and how the bench named these. The reference document is 14 sheets
// of front matter and then arabic 1, so a sheet's printed number is its file number less 14, and the
// chunk starting at file 26 sits at offset -11 while the one starting at 51 sits at -36. Both are
// measured rows of the pinned round, and `firstFile: 51` puts #333's own page — file 52, submitted
// 2nd, printing 38 — where the round had it. `leaks` replaces a page's honest label.
const FRONT_MATTER = 14;
function body(leaks: Record<number, string | null> = {}, firstFile = 26): MarkerPage[] {
  return Array.from({ length: 25 }, (_, i) => {
    const order = i + 1;
    const file = firstFile + i;
    const name = `acir-p${String(file).padStart(3, "0")}.png`;
    return page(order, name, order in leaks ? leaks[order]! : `Page ${file - FRONT_MATTER}`);
  });
}

const labels = (pages: string[]) => pages.map((p) => /aria-label="([^"]*)"/.exec(p)?.[1] ?? null);

test("the reported defect: a label repeating the filename's number, against a document that disagrees", () => {
  // #333's own row. The sheet is submitted 2nd in its chunk and named `acir-p052.png`, and the
  // label is 52 — not the position it was told (`page 2 of 25`), the number in its NAME, which is
  // why an offset-0 rule finds nothing here. 22 of the chunk's other 24 markers put the printed
  // number 36 below the position, so 52 is a departure and the label goes.
  const pages = body({ 2: "Page 52" }, 51);
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, ['page 2: "Page 52" → 38'], "the reported label was not removed");
  assert.deepEqual(labels(out).filter((l) => l !== null).length, 24, "another page lost its label too");
  assert.equal(labels(out)[1], null, "the reported page kept its label");
  // The derived number is in the report and NOT in the document: 38 is what the sheet prints, and
  // the four the derivation named on the reference corpus are the four read off the scans — but a
  // page whose own model just proved it was guessing is not where Iris asserts a number nobody saw.
  assert.doesNotMatch(out[1]!, /38/, "the derived folio was delivered rather than logged");
});

test("the element and its id are kept — only the announced number goes", () => {
  const { pages: out } = stripPositionalMarkers(body({ 2: "Page 52" }, 51));
  assert.equal(
    out[1]!.split("\n")[0],
    '<hr role="doc-pagebreak" id="page-2">',
    "the strip took more than the label, or reordered what was left",
  );
});

test("the stripped marker still lints clean", async () => {
  // The shape that ships after a strip has to be one the gate passes on its own terms, not merely
  // one this module produced. An unlabelled `<hr role="doc-pagebreak">` is #145's third case: no
  // naming attribute, so `aria-prohibited-attr` has nothing to judge (test/pagebreak-marker.test.ts).
  const lint = await runAxe(
    wrapDocument(`<h1>Report</h1>\n<p>Before.</p>\n<hr role="doc-pagebreak" id="page-2">\n<p>After.</p>`),
  );
  if (!lint.violations) return; // a lint that could not run is not a clean document (#164)
  assert.deepEqual(lint.violations.map((v) => v.id), [], "the marker left behind is not clean");
});

test("front matter with no printed folio: a label that is the page's own position", () => {
  // The corpus's first chunk, and the case an arabic-only reading of #333 missed. The cover, the
  // commission list, the title page and `PART I` print no folio — checked against the scans — and
  // both failing arms labelled them with their positions. Roman front matter that IS printed sits
  // at its own offset and is untouched, which is the whole reason the two systems are counted apart.
  const pages: MarkerPage[] = [
    page(1, "acir-p001.png", "Page 1"), // cover: prints `M — 16` and a date, no folio
    page(2, "acir-p002.png", "Page 2"), // commission members: nothing
    page(3, "acir-p003.png", "Page 3"), // title page: prints `M-16`
    page(5, "acir-p005.png", "Page iii"), // where the printed roman numbering starts
    page(6, "acir-p006.png", "Page iv"),
    page(7, "acir-p007.png", "Page v"),
    page(15, "acir-p015.png", "Page 15"), // `PART I`, unnumbered — arabic 1 by the body's own offset
    // The body pages of the same chunk, printing 14 less than their position. There have to be
    // enough of them to outvote the leaks: four labels at offset 0 against three honest ones would
    // make the LEAK the majority, and the check would then read the correct pages as the departures.
    // The corpus's own first chunk is 12 arabic markers with 9 agreeing, which is this shape.
    ...Array.from({ length: 10 }, (_, i) =>
      page(16 + i, `acir-p${String(16 + i).padStart(3, "0")}.png`, `Page ${2 + i}`),
    ),
  ];
  const { report } = stripPositionalMarkers(pages);
  assert.deepEqual(
    report.stripped,
    ['page 1: "Page 1"', 'page 2: "Page 2"', 'page 3: "Page 3"', 'page 15: "Page 15" → 1'],
    "the front matter's positional labels were not the four removed",
  );
  // The printed roman numbering agrees with itself at offset 2 and keeps every label.
  assert.ok(
    report.systems.includes("roman: offset 2 on 3 of 3"),
    `the roman offset was not derived: ${report.systems.join(" ; ")}`,
  );
  // `page 1: "Page 1"` carries no derived number: order 1 minus the arabic offset 14 is below 1, so
  // there is nothing to name and the report says so by omission rather than by printing `→ -13`.
  assert.doesNotMatch(report.stripped[0]!, /→/);
});

test("a roman leak is seen, because the two numbering systems are counted apart", () => {
  // `Page xv` on the sheet printing `PART I`, which the shipped model wrote on one round. Pooled
  // with the arabic markers it contributes to no majority and no departure; counted as roman it is
  // a departure from the front matter's offset of 2, and its 15 is the number in its filename.
  const pages: MarkerPage[] = [
    page(5, "acir-p005.png", "Page iii"),
    page(6, "acir-p006.png", "Page iv"),
    page(7, "acir-p007.png", "Page v"),
    page(15, "acir-p015.png", "Page xv"),
  ];
  const { report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, ['page 15: "Page xv" → 13']);
});

test("a NON-CONTIGUOUS submission keeps its correct labels", () => {
  // The false positive an earlier version of this rule produced on a real round, and the reason
  // `page N of M` is not tested. This round re-submitted a subset of an already-rendered document,
  // so the sheet printing `iv` arrived 4th: its folio equals its position by coincidence, while its
  // filename says 6. Reading the position convicts a true label; reading the filename does not.
  const pages: MarkerPage[] = [
    page(4, "acir-p006.png", "Page iv"),
    page(5, "acir-p009.png", "Page vii"),
    page(6, "acir-p010.png", "Page viii"),
    page(7, "acir-p011.png", "Page ix"),
    page(8, "acir-p012.png", "Page x"),
  ];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, [], "a correct label was removed on a coincidence with its position");
  assert.deepEqual(out, pages.map((p) => p.html), "the pages came back rewritten");
  // It is not silently agreed with, either: it departs from the derived offset and is counted.
  assert.equal(report.offMode, 1, "the departing label was not counted anywhere");
});

test("a wrong label that repeats no positional number is counted and left alone", () => {
  // A page printing `ix` labelled `Page 9` — a misread folio, not a leaked position. Nothing here
  // can tell that from a document whose numbering is irregular, so the label stays and the count is
  // the only trace. #333 classifies this row the same way, and it is why `off_mode` exists.
  const pages = body({ 11: "Page 9" });
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, []);
  assert.equal(report.offMode, 1);
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("no offset holding a majority decides nothing", () => {
  // A document whose markers agree on nothing — the maps corpus's 8 pages are this, measured — is
  // exactly where a check acting on a minority would do damage. Every label stays, and the count of
  // labels that repeat a positional number is reported so the blind spot has a size.
  const pages: MarkerPage[] = [
    page(1, "map-1.png", "Page 1"),
    page(2, "map-2.png", "Page 7"),
    page(3, "map-3.png", "Page 44"),
    page(4, "map-4.png", "Page 4"),
  ];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, []);
  // The best run is named too, so a reader can tell a document that agreed on nothing from one whose
  // agreement was a pair — the two are different sizes of blind spot and `stripped: []` says neither.
  assert.ok(
    report.systems.includes("arabic: no offset holds 4 markers (best: 2)"),
    `the undecidable document did not say so: ${report.systems.join(" ; ")}`,
  );
  assert.equal(report.undecided, 2, "the labels the check could not decide were not counted");
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("a numbering system with fewer than three markers is not asked", () => {
  // Two agreeing markers are already a regularity, but a page's number is deleted on the strength
  // of this and a third marker is the cheapest thing to insist on. The probe rounds are all here:
  // one or two pages, nothing to derive.
  const pages: MarkerPage[] = [page(1, "acir-p001.png", "Page 1"), page(2, "acir-p002.png", "Page 2")];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.systems, [], "an offset was derived from two markers");
  assert.deepEqual(report.stripped, []);
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("three markers are enough to ask and not enough to act: a pair is not a run", () => {
  // The population gate and the agreement gate are different gates. A strict majority of three
  // markers is two, so without the second gate `Page 1` and `Page 2` would hold an offset and take
  // the third page's number off it. Two markers are a coincidence a two-page document produces.
  const pages: MarkerPage[] = [
    page(1, "s-p1.png", "Page 1"),
    page(2, "s-p2.png", "Page 2"),
    page(3, "s-p9.png", "Page 9"),
  ];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, [], "a pair of markers deleted a third page's number");
  assert.ok(
    report.systems.includes("arabic: no offset holds 3 markers (best: 2)"),
    `the pair was treated as a run: ${report.systems.join(" ; ")}`,
  );
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("a document whose honest labels repeat their own filenames is refused, not acted on", () => {
  // The rule rests on a true label NOT repeating the number in its own filename, and there are
  // ordinary inputs where it does. This is one input read two ways: a model that leaked the position
  // on all 25 pages, and a plain report submitted whole whose sheets really do print 1..25. They are
  // the same bytes, so nothing here can act on either — and the reason is logged rather than passed
  // off as a document this checked and agreed with.
  const every = Array.from({ length: 25 }, (_, i) =>
    page(i + 1, `acir-p${String(i + 1).padStart(3, "0")}.png`, `Page ${i + 1}`),
  );
  const { pages: out, report } = stripPositionalMarkers(every);
  assert.deepEqual(report.stripped, []);
  assert.deepEqual(out, every.map((p) => p.html));
  assert.ok(
    report.systems.includes("arabic: offset 0 on 25 of 25, 25 of them repeating their own filename"),
    `the refusal was not reported: ${report.systems.join(" ; ")}`,
  );
  assert.equal(report.undecided, 25, "the labels the check declined to judge were not counted");
});

test("a gapped submission of Iris's own render keeps its correct numbers", () => {
  // `acir-p001..008` plus `acir-p020` and `acir-p021`, submitted as positions 1-10, every label the
  // number its sheet prints. The prefix holds offset 0 and the two pages after the gap depart from
  // it while repeating their filenames — the exact shape the rule acts on, and here every label is
  // true. What separates it from the defect is the prefix: those honest labels repeat their own
  // filenames too, so the positional test cannot discriminate on this document and is refused.
  const pages: MarkerPage[] = [1, 2, 3, 4, 5, 6, 7, 8, 20, 21].map((n, i) =>
    page(i + 1, `acir-p${String(n).padStart(3, "0")}.png`, `Page ${n}`),
  );
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, [], "correct page numbers were removed from a gapped submission");
  assert.deepEqual(out, pages.map((p) => p.html));
  assert.ok(
    report.systems.includes("arabic: offset 0 on 8 of 10, 8 of them repeating their own filename"),
    `the refusal was not reported: ${report.systems.join(" ; ")}`,
  );
});

test("only the last number in a filename is positional, because the rest is the document's", () => {
  // `util/pdf.ts` renders a PDF as `<base>-p<N>.png` where `<base>` is the uploaded file's own name,
  // so a PDF called `volume-1.pdf` puts a 1 in all 20 filenames. Reading every integer in the name
  // convicts the sheet that really does print 1 for being the thirteenth page of a file the caller
  // named `volume-1` — the same document called `report.pdf` keeps its label. Numbering restarts at
  // position 13, so the label is a true departure from the majority's offset and everything else
  // about it looks exactly like the defect.
  const restart = (base: string): MarkerPage[] =>
    Array.from({ length: 20 }, (_, i) => page(i + 1, `${base}-p${i + 1}.png`, `Page ${i < 12 ? i + 1 : i - 11}`));
  for (const base of ["volume-1", "part 2", "report"]) {
    const { pages: out, report } = stripPositionalMarkers(restart(base));
    assert.deepEqual(report.stripped, [], `a true label was removed on a ${base}.pdf document`);
    assert.deepEqual(out, restart(base).map((p) => p.html));
  }
});

test("a marker on a page with no filename is reported as unchecked, not as agreed with", () => {
  // The filename is the one input here that comes from the store rather than from this pass, and a
  // fragment written before `image` was recorded has none. Losing the document over that would be
  // the wrong trade, and so would logging `readable: 4, stripped: []` — which is what a document
  // this checked and agreed with looks like. The count is what separates them.
  const pages: MarkerPage[] = [
    page(1, "", "Page 1"),
    page(2, "", "Page 2"),
    page(3, "", "Page 3"),
    page(4, "", "Page 40"),
  ];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, []);
  assert.equal(report.readable, 4);
  assert.equal(report.unchecked, 4, "markers with no filename to check against were not counted");
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("a sectioned folio is unreadable, not positional", () => {
  // `A-3`, `M-16`, `3-14`. The corpus has one: a vendor labelled the title page `Page M-16`, the
  // report number the sheet really prints. It parses as no numeral, so it is counted unreadable and
  // left alone — a label carrying a number Iris never supplied is not this defect.
  const pages = [...body(), page(3, "acir-p003.png", "Page M-16"), page(4, "acir-p004.png", null)];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, []);
  assert.equal(report.unreadable, 2, "the sectioned label and the unlabelled marker were not counted");
  assert.equal(report.markers, 27);
  assert.deepEqual(out, pages.map((p) => p.html));
});

test("what counts as a page number, and what does not", () => {
  // The label the prompt asks for is `Page 5`; the corpus also produced `27` with the word dropped
  // and a lower-case `page 50`, deviations with no measured consequence and each still a number to
  // check. Roman numerals are validated by spelling the value back out, which is what keeps most
  // ordinary words made of roman letters (`civil`, `mild`, `did`) from reading as numbers.
  assert.deepEqual(folio("Page 5"), { value: 5, system: "arabic" });
  assert.deepEqual(folio("27"), { value: 27, system: "arabic" });
  assert.deepEqual(folio("page 50"), { value: 50, system: "arabic" });
  assert.deepEqual(folio("p. 7"), { value: 7, system: "arabic" });
  assert.deepEqual(folio("Page IV"), { value: 4, system: "roman" });
  assert.deepEqual(folio("Page xiii"), { value: 13, system: "roman" });
  for (const not of ["Page 5 of 25", "Page A-3", "M-16", "civil", "mild", "did", "Page 0", "", "Cover"]) {
    assert.equal(folio(not), null, `"${not}" was read as a page number`);
  }
  // Not all of them: `mix` really is M + IX and spells back the same way, so the round trip cannot
  // exclude it and this is what the reading costs. It buys nothing for an attacker or a confused
  // model — 1009 has to also be written in the page's filename before anything is removed — but a
  // label of `mix` is read as a number here, and that is worth stating rather than implying.
  assert.deepEqual(folio("mix"), { value: 1009, system: "roman" });
});

test("a document with nothing to strip comes back byte-identical", () => {
  // What the review loop's change detection and `anchors.ts`'s reserialization caution both depend
  // on: this rewrites one attribute inside one matched start tag and touches nothing else. The
  // fixture is markup a DOM round-trip would rewrite, so an unchanged string is a real claim.
  const html = `<hr role="doc-pagebreak" aria-label='Page 5' id=page-5>\n<table><tr><td>1994</td></tr></table>`;
  const pages: MarkerPage[] = [
    { order: 19, name: "acir-p019.png", html },
    ...body().slice(0, 5),
  ];
  const { pages: out } = stripPositionalMarkers(pages);
  assert.equal(out[0], html, "an untouched page was reserialized");
});

test("a marker whose start tag cannot be read to its end is declined", () => {
  // The JSON-escaping leak's shape (#233/#234/#257): `<hr role=\"doc-pagebreak\" …>`, where the
  // unquoted value reads as a `\` running into a quote. Editing an attribute located inside a tag
  // that cannot be parsed would mangle markup worse than the label it was taking off, so the tag is
  // skipped whole — the leak's other symptoms are the ones worth having.
  const leaked = `<hr role=\\"doc-pagebreak\\" aria-label=\\"Page 52\\" id=\\"page-52\\">`;
  const pages: MarkerPage[] = [{ order: 2, name: "acir-p052.png", html: leaked }, ...body({}, 51).slice(2)];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.equal(out[0], leaked, "a tag that could not be parsed was edited anyway");
  assert.deepEqual(report.stripped, []);
});

test("a repeated aria-label loses every copy, not the one the parser keeps", () => {
  // Deleting the first copy promotes the second into its place, which is the promotion `roles.ts`
  // answers by emptying a value instead. Here the whole attribute goes, however many there are — and
  // the reason it matters is the report: `stripped` is the only trace this check leaves, so a page
  // that went on announcing 52 while the line said the label was removed would have a round reading a
  // claim about a document that does not say that. Also covers the self-closing spelling, whose `/`
  // the scan reads as part of the attribute text and which has to come back out intact.
  const twice = `<hr role="doc-pagebreak" aria-label="Page 52" aria-label="Page 52" id="page-2"/><p>x</p>`;
  const pages: MarkerPage[] = [{ order: 2, name: "acir-p052.png", html: twice }, ...body({}, 51).slice(2)];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, ['page 2: "Page 52" → 38']);
  assert.equal(out[0], `<hr role="doc-pagebreak" id="page-2"/><p>x</p>`, "a copy of the label survived");
  assert.doesNotMatch(out[0]!, /aria-label/, "the report claimed a removal that did not happen");
});

test("the removals report their own shape, so a restart is separable from a leak", () => {
  // The blind spot this cannot act on: one PDF concatenating two reports, A printing 1-6 and B
  // printing 1-20, Iris rasterizing it itself. The majority holds offset 6, A's six true labels
  // depart from it and repeat their filenames, and the refusal cannot fire because none of the
  // agreeing markers is positional. Six correct page numbers go. What `departures` adds is that the
  // shape is on the record: a block of consecutive positions with no surviving label in it, which is
  // a restart's signature, against the interleaved single removal a leak produces.
  const concat: MarkerPage[] = Array.from({ length: 26 }, (_, i) =>
    page(i + 1, `two-reports-p${i + 1}.png`, `Page ${i < 6 ? i + 1 : i - 5}`),
  );
  const { report } = stripPositionalMarkers(concat);
  assert.equal(report.stripped.length, 6, "the accepted trade-off changed shape");
  assert.deepEqual(report.departures, ["arabic: 6 removed at offset 0, pages 1-6 (every marker in that span)"]);

  // The defect itself, on the same field: one removal, and no span clause, because the labels either
  // side of it survived and are what convicted it. Its offset is -50 and not 0, because the number it
  // repeated is its filename's rather than its position — the two are 50 apart in a batched round, and
  // that difference is the whole reason the filename is what gets tested.
  const { report: leak } = stripPositionalMarkers(body({ 2: "Page 52" }, 51));
  assert.deepEqual(leak.stripped, ['page 2: "Page 52" → 38']);
  assert.deepEqual(leak.departures, ["arabic: 1 removed at offset -50, page 2"]);
});

test("an aria-label is never located by searching for it", () => {
  // The attributes are walked in parser order, not searched for, because the values on these
  // elements are prose out of a document: an `alt` that mentions `aria-label=` would otherwise have
  // a word spliced out of the middle of it, a loss nothing in the gate can report. Same argument as
  // roles.ts's scan, and the fixture is the sentence that breaks a search.
  const trap = `<img src="a.png" alt="the aria-label=&quot;Page 52&quot; on the plate">\n${marker("Page 52", "2")}`;
  const pages: MarkerPage[] = [{ order: 2, name: "acir-p052.png", html: trap }, ...body({}, 51).slice(2)];
  const { pages: out, report } = stripPositionalMarkers(pages);
  assert.deepEqual(report.stripped, ['page 2: "Page 52" → 38'], "the marker on that page was not found");
  assert.match(out[0]!, /alt="the aria-label=&quot;Page 52&quot; on the plate"/, "the alt text was edited");
  assert.match(out[0]!, /<hr role="doc-pagebreak" id="page-2">/);
});

// The join is the only place this can run — it needs every page's marker at once to derive an
// offset — so the wiring is part of the fix rather than an implementation detail.
function frag(order: number, image: string, innerHtml: string): Fragment {
  return { image, order, agent: "page.md", region: "page", innerHtml, edges: [], log: "" };
}

test("assembly strips the label on the way to one document, and reports it", () => {
  const fragments = body({ 2: "Page 52" }, 51).map((p) => frag(p.order, p.name, p.html));
  const { body: joined, markers } = assembleBodyWithReport(fragments);
  assert.deepEqual(markers.stripped, ['page 2: "Page 52" → 38']);
  assert.match(joined, /<hr role="doc-pagebreak" id="page-2">/, "the marker itself was lost");
  // One label goes and only one. `aria-label="Page 52"` is still in this document — the sheet 14
  // positions further on really does print 52 — which is the reason to count the labels rather than
  // grep the body for the number: the leak and a correct label are the same string.
  assert.equal(labels(joined.split("\n\n")).filter((l) => l !== null).length, 24);
  assert.equal(joined.match(/aria-label="Page 52"/g)?.length, 1, "the honest 52 was removed, or the leak survived");
  // The prose join runs after the strip and is unaffected by it: it matches the marker's ROLE, not
  // its label, so a stripped marker still ends a sentence continuing across a page break.
  const across = assembleBodyWithReport([
    frag(1, "acir-p026.png", `<p>The commission recommends that the</p>`),
    frag(2, "acir-p027.png", `${marker("Page 27", "2")}\n<p>states adopt it.</p>`),
    frag(3, "acir-p028.png", `${marker("Page 14", "3")}\n<p>Next.</p>`),
    frag(4, "acir-p029.png", `${marker("Page 15", "4")}\n<p>Then.</p>`),
    frag(5, "acir-p030.png", `${marker("Page 16", "5")}\n<p>And.</p>`),
    frag(6, "acir-p031.png", `${marker("Page 17", "6")}\n<p>Last.</p>`),
  ]);
  assert.match(across.body, /recommends that the states adopt it\./, "the prose join stopped working");
  assert.deepEqual(across.markers.stripped, ['page 2: "Page 27" → 13']);
  assert.doesNotMatch(across.body, /aria-label="Page 27"/);
});

test("runAssembly logs the check even when it stripped nothing", async () => {
  // Deliberately a line on clean documents too, which the anchor line above it is not. The
  // denominators are the point: `stripped: []` beside `arabic: offset -11 on 25 of 25` is a document
  // this checked and agreed with, and no line at all is a document it could not decide — and a
  // round measuring whether the defect is fixed cannot tell those apart from silence. Same reading
  // as `prose_joined`, which reports its own zero.
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    log: { event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }) },
  } as unknown as PipelineContext;

  await runAssembly(ctx, body().map((p) => frag(p.order, p.name, p.html)));
  const clean = events.filter((e) => e.type === "page_markers");
  assert.equal(clean.length, 1, "a checked document logged nothing");
  assert.deepEqual(clean[0]!.data.stripped, []);
  assert.deepEqual(clean[0]!.data.systems, ["arabic: offset -11 on 25 of 25"]);
  assert.equal(clean[0]!.data.readable, 25);
  // And the filenames reached the check through the assembly wiring: had the name not been carried
  // from the fragment, every one of these would be `unchecked` and none of them checkable.
  assert.equal(clean[0]!.data.unchecked, 0, "the page filenames did not reach the check");

  events.length = 0;
  await runAssembly(ctx, body({ 2: "Page 52" }, 51).map((p) => frag(p.order, p.name, p.html)));
  const found = events.filter((e) => e.type === "page_markers");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.data.stripped, ['page 2: "Page 52" → 38']);

  // A document with no marker at all logs nothing: there is no denominator to report and the line
  // would say only that the pages had no page breaks.
  events.length = 0;
  await runAssembly(ctx, [frag(1, "acir-p001.png", "<h1>Report</h1><p>One page.</p>")]);
  assert.deepEqual(events.filter((e) => e.type === "page_markers"), [], "a document with no markers logged a line");
});
