// A correction round asks the Copy Editor for the whole document, so the length of its answer
// is a property of the DOCUMENT rather than of how much is wrong with it — and a 25-page
// document's body is longer than one response may be. Since #143 that costs the round rather
// than the document, which was the right trade and not a fix: on the bench round that provoked
// issue #165, two documents of four were delivered whole and entirely uncorrected, carrying 83
// of the round's 106 unresolved issues between them. Under a fixed ceiling this scales the
// wrong way — the bigger the document, the more certain it is that its corrections cannot be
// applied, which is the opposite of where corrections matter most.
//
// So a round that cannot be answered whole is asked again a section at a time, and the response
// length becomes a property of the SECTION, which is a size this code chooses. Two halves are
// pinned here: the cut (pipeline/sections.ts — it must never cut inside an element, and a
// section nobody corrects must come back byte for byte) and the round (pipeline/review.ts — what
// is rescued, what is reported, and the fact that this is still the loop's last round).
//
// The discard path this replaces is not gone: it is what happens when nothing can be rescued,
// and test/review-truncation.test.ts still pins it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutPoints, joinSections, splitSections } from "../src/pipeline/sections.ts";
import {
  runReview,
  EDITOR_SECTION_SYSTEM,
  EDITOR_SYSTEM,
  MAX_SECTIONS,
  MIN_SECTION_BUDGET,
  SECTION_HEADROOM,
  type ReviewIssue,
} from "../src/pipeline/review.ts";
import { TruncatedResponseError } from "../src/providers/types.ts";
import type { InputImage, PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- the cut ---

test("the sections put the body back together character for character", () => {
  // The property every other one rests on. A section the editor did not answer is put back as
  // it was, so the join has to be exact: reserializing it (which parsing and re-emitting the
  // HTML would do) would rewrite parts of the delivered document that nothing asked to change,
  // which is what anchors.ts declines to risk on a page it cannot rewrite safely.
  const body = `<h1>Report</h1>\n\n<p>One.</p>\n<ul><li>a</li><li>b</li></ul>\n\n<table><tr><td>1</td></tr></table>\n`;
  for (const budget of [1, 8, 20, 40, 1_000]) {
    const sections = splitSections(body, budget);
    assert.equal(
      joinSections(sections, sections.map(() => null)),
      body,
      `budget ${budget} lost or moved characters`,
    );
  }
});

test("a cut is only ever between top-level elements", () => {
  const body = `<h1>T</h1><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table><p>End.</p>`;
  // Small enough that the packer would cut inside the table if anything let it.
  const sections = splitSections(body, 10);
  assert.deepEqual(sections.map((s) => s.html), [
    `<h1>T</h1>`,
    `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`,
    `<p>End.</p>`,
  ]);
  // The table is over budget and stands alone rather than being divided: a section can be
  // bigger than the budget only when one top-level element is, which is the case the caller
  // contains by keeping the original text if that section truncates in its turn.
  assert.ok(sections[1].html.length > 10);
});

test("an end tag the document leaves out does not swallow the rest of it", () => {
  // HTML permits the omission and page agents take it up: `<p>one<p>two` and `<ul><li>a<li>b`
  // are four balanced elements to a browser and one element that never ends to a depth
  // counter. Without the implied-end rules a single missing `</p>` anywhere in a 25-page
  // document would leave it with no cut points at all, and a round that could have been
  // corrected a section at a time would decline on a perfectly ordinary body.
  const body = `<p>one<p>two<ul><li>a<li>b</ul><dl><dt>t<dd>d</dl><h2>End</h2>`;
  // A budget of 6 so the packing does not put two of these back together — the point here is
  // that the boundaries were FOUND, and `<p>one<p>two` is one legitimate section at any budget
  // that fits both.
  const sections = splitSections(body, 6);
  assert.deepEqual(sections.map((s) => s.html), [
    `<p>one`,
    `<p>two`,
    `<ul><li>a<li>b</ul>`,
    `<dl><dt>t<dd>d</dl>`,
    `<h2>End</h2>`,
  ]);
  // A tag that opens nothing can still close something: `<hr>` ends an open `<p>`, and the
  // paragraph before it is a section that can be corrected on its own.
  assert.deepEqual(splitSections(`<p>one<hr><p>two</p>`, 6).map((s) => s.html), [`<p>one`, `<hr>`, `<p>two</p>`]);
  // A table written the same way, where the omissions nest three deep.
  assert.deepEqual(
    splitSections(`<table><tr><td>1<td>2<tr><td>3</table><p>after</p>`, 12).map((s) => s.html),
    [`<table><tr><td>1<td>2<tr><td>3</table>`, `<p>after</p>`],
  );
});

test("a `>` inside an attribute value is not the end of a tag", () => {
  // Model output does not always escape one, and cutting at the first `>` would read the rest
  // of the attribute as markup — the same allowance correction.ts's TAG makes on the same
  // output.
  const body = `<p><img src="a.png" alt="revenue > 2019 and <b> as text"></p><p>next</p>`;
  assert.deepEqual(splitSections(body, 10).map((s) => s.html), [
    `<p><img src="a.png" alt="revenue > 2019 and <b> as text"></p>`,
    `<p>next</p>`,
  ]);
});

test("what cannot be cut is one section, not a bad cut", () => {
  // One enormous table is the case a section-size bound genuinely does not solve. It comes back
  // whole, and `correctBySection` declines rather than asking for it again in one piece.
  const huge = `<table>${`<tr><td>cell</td></tr>`.repeat(200)}</table>`;
  assert.equal(splitSections(huge, 100).length, 1);
  assert.equal(splitSections("", 100).length, 0);
  assert.deepEqual(splitSections(`text with no elements at all`, 5).map((s) => s.html), [
    `text with no elements at all`,
  ]);
});

test("comments, void elements and raw text are nodes like any other", () => {
  const body = `<!-- a note with <p> and > in it --><hr><br/><p>after</p>`;
  assert.deepEqual(splitSections(body, 5).map((s) => s.html), [
    `<!-- a note with <p> and > in it -->`,
    `<hr>`,
    `<br/>`,
    `<p>after</p>`,
  ]);
  // A `<` inside a raw-text element opens nothing, so the rest of the document is still
  // divisible after one. None of these should be in an extracted body (flatten.ts SILENT names
  // the same set) — the point is that one cannot unbalance the scan.
  assert.deepEqual(
    splitSections(`<style>p { content: "<b>" }</style><p>after</p>`, 5).map((s) => s.html),
    [`<style>p { content: "<b>" }</style>`, `<p>after</p>`],
  );
  // An unclosed comment runs to the end of the document, which is how a parser reads it too.
  assert.equal(splitSections(`<p>a</p><!-- never closed <p>b</p>`, 5).length, 2);
});

test("the whitespace between elements belongs to nobody's section", () => {
  // It is held in `pre` and re-attached by the join, so a section the editor rewrote does not
  // arrive glued to its neighbour and one it left alone keeps the spacing assembly gave it.
  const body = `<h1>A</h1>\n\n<p>B</p>\n\n<p>C</p>`;
  const sections = splitSections(body, 12);
  assert.deepEqual(sections.map((s) => s.pre), ["", "\n\n", "\n\n"]);
  assert.deepEqual(sections.map((s) => s.html), [`<h1>A</h1>`, `<p>B</p>`, `<p>C</p>`]);
  assert.equal(joinSections(sections, [`<h1>A!</h1>`, null, null]), `<h1>A!</h1>\n\n<p>B</p>\n\n<p>C</p>`);
});

test("a cut point is a place where nothing is open", () => {
  // Read directly, because reaching an interesting one through `splitSections` tests the
  // packing rather than the scan: every offset is one where the prefix is complete HTML.
  const body = `<h1>A</h1><div><p>x</p></div><hr>`;
  // After `</h1>` and after `</div>` — not after the inner `</p>`, where the div is still open.
  assert.deepEqual(cutPoints(body), [10, 29]);
  assert.equal(body.slice(0, 10), `<h1>A</h1>`);
  assert.equal(body.slice(10, 29), `<div><p>x</p></div>`);
  // And nothing is reported at the very end of the body, which would open an empty section.
  assert.ok(!cutPoints(body).includes(body.length));
});

// --- the round ---

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-sections-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ISSUES: ReviewIssue[] = [
  { issue: "table headers missing", severity: "high", suggested_action: "add th", pages: [2] },
  { issue: "reading order", severity: "medium", suggested_action: "reorder", pages: [1] },
];

const PAGES = [
  { order: 1, innerHtml: "<h1>Quarterly Report</h1>" },
  { order: 2, innerHtml: "<p>Revenue.</p>" },
];

// A body that has to be cut: 24 top-level paragraphs, ~1kB each. Long enough that the budget
// below (half of what the truncated response returned) makes three sections of it, and every
// paragraph is identifiable so a lost or reordered section is visible in the delivered body.
const PARAS = Array.from({ length: 24 }, (_, i) => `<p id="p${i + 1}">${`word${i + 1} `.repeat(140)}</p>`);
const LONG = PARAS.join("\n\n");
// 20,000 chars came back before the ceiling cut it, so a section may be 10,000.
const CHARS = 20_000;
const BUDGET = Math.floor(CHARS * SECTION_HEADROOM);
const truncated = (chars = CHARS): TruncatedResponseError =>
  new TruncatedResponseError("bedrock", "sonnet", 32_000, chars);

interface Call {
  agent: string;
  imageCount: number;
  system: string;
  user: string;
}
interface Recorded {
  calls: Call[];
  events: { type: string; data: Record<string, unknown> }[];
}

// The section the editor is being asked about, read out of its own prompt — so the fixture
// answers with a correction to THAT section and the join can be checked against the request.
function askedSection(user: string): { index: number; of: number; html: string } {
  const m = /^## Section (\d+) of (\d+) \(body content\)\n([\s\S]*?)\n\n## Issues/.exec(user);
  assert.ok(m, `not a section prompt: ${user.slice(0, 200)}`);
  return { index: Number(m[1]), of: Number(m[2]), html: m[3] };
}

// `sectionAnswer` decides what one section call does: a string is the corrected HTML, an Error
// is thrown, and null is a reply with nothing usable in it. The whole-body call always
// truncates unless `wholeBody` says otherwise, since that is the state this file is about.
function ctxWith(
  dir: string,
  opts: {
    sectionAnswer?: (s: { index: number; of: number; html: string }) => string | Error | null;
    wholeBody?: () => Error | undefined;
    maxReviewIterations?: number;
    images?: boolean;
  } = {},
): { ctx: PipelineContext; rec: Recorded } {
  const inputDir = join(dir, "input");
  mkdirSync(inputDir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const images: InputImage[] = [];
  if (opts.images !== false) {
    for (let order = 1; order <= 2; order++) {
      const path = join(inputDir, `page-00${order}.png`);
      writeFileSync(path, png);
      images.push({ name: `page-00${order}.png`, order, path });
    }
  }

  const rec: Recorded = { calls: [], events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    maxReviewIterations: opts.maxReviewIterations ?? 3,
    extractionConcurrency: 4,
    paths: {
      agentsDir: join(dir, "agents"),
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: () => join(dir, "memory", "page.json"),
    } as unknown as Paths,
    router: {
      complete: async (
        agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        o: { images?: unknown[] } = {},
      ) => {
        const system = messages[0]?.content ?? "";
        const user = messages[messages.length - 1]?.content ?? "";
        rec.calls.push({ agent, imageCount: o.images?.length ?? 0, system, user });
        // The Reader never runs out of issues, so the loop always reaches the editor.
        if (agent === "reader") return { text: JSON.stringify({ issues: ISSUES }) };
        if (system !== EDITOR_SECTION_SYSTEM) {
          const failure = opts.wholeBody ? opts.wholeBody() : truncated();
          if (failure) throw failure;
          return { text: JSON.stringify({ html: "<h1>Whole body edited</h1>" }) };
        }
        const answer = (opts.sectionAnswer ?? ((s) => `${s.html}\n<p class="fix">fixed ${s.index}</p>`))(
          askedSection(user),
        );
        if (answer instanceof Error) throw answer;
        return { text: JSON.stringify(answer === null ? {} : { html: answer }) };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

const review = (ctx: PipelineContext, body = LONG) =>
  runReview(ctx, { body, lint: { ok: true, violations: [] }, pages: PAGES });

test("a round that did not fit is made again a section at a time, and the corrections are kept", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir);
    const result = await review(ctx);

    const sections = rec.calls.filter((c) => c.system === EDITOR_SECTION_SYSTEM);
    assert.equal(sections.length, 3, "the body was not cut into the sections the budget allows");
    // Every section's correction is in the delivered body, in document order, and every
    // paragraph that went in came back — the join is what carries the sections nobody changed.
    for (let i = 1; i <= 3; i++) assert.match(result.body, new RegExp(`fixed ${i}`));
    assert.ok(
      result.body.indexOf("fixed 1") < result.body.indexOf("fixed 2") &&
        result.body.indexOf("fixed 2") < result.body.indexOf("fixed 3"),
      "the sections were joined out of order",
    );
    for (const p of PARAS) assert.ok(result.body.includes(p), `${p.slice(0, 14)} is missing from the document`);
    // The ceiling was still hit — that is the deployment's signal and it is unchanged (#143's
    // `editor_truncated_rate` counts documents, not lost corrections).
    assert.equal(result.editorTruncated, true);
    // And nothing was lost by it: every section came back, so this document is the reason
    // `editor_truncated_rate` cannot carry a threshold and `editor_truncated_lost_rate` can (#159).
    assert.equal(result.editorTruncatedLost, false);
    const start = rec.events.find((e) => e.type === "editor_sections");
    assert.equal(start?.data.sections, 3);
    assert.equal(start?.data.budget, BUDGET, "the budget is measured from the response that did not fit");
    assert.equal(start?.data.chars, LONG.length);
    // And the round reports itself as a round that ran, with what it reached.
    const editor = rec.events.find((e) => e.type === "editor");
    assert.equal(editor?.data.changed, true);
    assert.equal(editor?.data.sections, 3);
    assert.equal(editor?.data.corrected, 3);
    // The round's sizes are the WHOLE body's, on a round answered piece by piece as on one
    // answered whole (#174). A section reply is a fraction of the body it belongs to because it IS
    // one section — 0.016 to 0.379 of it on the bench rounds — so anything reading these numbers as
    // one distribution would read every sectioned round as a catastrophe. `sections` on this same
    // line is what separates the two populations, and it is why these two assertions are here.
    assert.equal(editor?.data.chars_before, LONG.length);
    assert.ok(
      (editor?.data.chars_after as number) > LONG.length,
      "three sections each gained a paragraph, so the body grew",
    );
  });
});

test("the document says its corrections were made a section at a time", async () => {
  await withTemp(async (dir) => {
    const { ctx } = ctxWith(dir);
    const { html } = await review(ctx);
    assert.match(html, /@editor-truncated sections 3 of 3/);
    assert.match(html, /made\n  again a section at a time/);
    // The two things a reader of this document cannot work out for themselves: a problem
    // spanning two sections may be untouched, and the @unresolved list below was taken before
    // the corrections and never taken again.
    assert.match(html, /a\n  problem spanning two of them may be untouched/);
    assert.match(html, /some may already be fixed/);
    assert.match(html, /editor_sections/, "the log line to look up is named");
    // Placed like the other wrapper statements: outside <main>, so it is not content.
    assert.ok(html.indexOf("@editor-truncated") > html.indexOf("</main>"));
    // The discarded-round wording is NOT what this document gets — it has corrections in it,
    // and a reader told the round was abandoned would go looking for them elsewhere.
    assert.doesNotMatch(html, /that round was\n  discarded/);
  });
});

test("a section that cannot be returned either costs that section and nothing else", async () => {
  await withTemp(async (dir) => {
    // Per-section containment, the same shape as a page that could not be extracted: the
    // section keeps the text it went in with, the rest of the document keeps its corrections.
    const { ctx, rec } = ctxWith(dir, {
      sectionAnswer: (s) => (s.index === 2 ? truncated(9_000) : `${s.html}\n<p class="fix">fixed ${s.index}</p>`),
    });
    const result = await review(ctx);

    assert.match(result.body, /fixed 1/);
    assert.doesNotMatch(result.body, /fixed 2/);
    assert.match(result.body, /fixed 3/);
    for (const p of PARAS) assert.ok(result.body.includes(p), `${p.slice(0, 14)} is missing from the document`);
    const failed = rec.events.find((e) => e.type === "editor_section_failed");
    assert.equal(failed?.data.section, 2);
    assert.equal(failed?.data.of, 3);
    assert.equal(failed?.data.reason, "truncated");
    assert.equal(failed?.data.chars, 9_000, "the numbers that say whether a smaller section would have fitted");
    const editor = rec.events.find((e) => e.type === "editor");
    assert.equal(editor?.data.corrected, 2, "the count must say how much of the document was reached");
    // Section 2 kept the text it went in with, so its issues had no editor pass at all and no
    // later round looks for them: the quality tally must count this document as a loss and not
    // only as a ceiling that was hit (#159).
    assert.equal(result.editorTruncated, true);
    assert.equal(result.editorTruncatedLost, true);
    assert.match((await review(ctxWith(dir, {
      sectionAnswer: (s) => (s.index === 2 ? null : `${s.html}\n<p class="fix">fixed ${s.index}</p>`),
    }).ctx)).body, /fixed 3/, "a reply with nothing usable in it is contained the same way");
  });
});

test("a section that came back as a sentence about itself keeps the text it went in with", async () => {
  await withTemp(async (dir) => {
    // #174's floor at this unit. The section prompt asks for one section and nothing compares the
    // reply against it, so a model that answers with a summary of the section, or with its first
    // paragraph, returns markup that parses — and until now that would have replaced the section.
    // The containment it needs already existed for the truncated and the unusable reply, so this
    // is the same outcome reached from a third reason: the section keeps its own text, the rest of
    // the document keeps its corrections, and the round is a round that did not come back whole.
    //
    // The sectioned rounds are part of what places the number: 13 section calls across three bench
    // rounds, every one answered, and the joined bodies land at 0.998–1.006 of their input. A
    // section that had returned under half its own prose would have moved a five-section join by
    // about a tenth, and none of them moved by more than 0.6%.
    const { ctx, rec } = ctxWith(dir, {
      sectionAnswer: (s) =>
        s.index === 2 ? `<p>This section has been reviewed and reads correctly.</p>` : `${s.html}\n<p class="fix">fixed ${s.index}</p>`,
    });
    const result = await review(ctx);

    const failed = rec.events.find((e) => e.type === "editor_section_failed");
    assert.equal(failed?.data.section, 2);
    assert.equal(failed?.data.reason, "shrank");
    assert.equal(failed?.data.floor, 2);
    assert.ok(
      (failed?.data.text_chars_after as number) * 2 < (failed?.data.text_chars_before as number),
      "the two numbers on the line have to be the ones that tripped it",
    );
    assert.match(result.body, /fixed 1/);
    assert.doesNotMatch(result.body, /fixed 3.*reviewed and reads correctly/s);
    assert.doesNotMatch(result.body, /reviewed and reads correctly/);
    for (const p of PARAS) assert.ok(result.body.includes(p), `${p.slice(0, 14)} is missing from the document`);
    // Reported as a round that did not come back whole, because that is what it is: section 2's
    // issues had no editor pass and no later round looks for them (#159).
    assert.equal(result.editorTruncatedLost, true);
    assert.equal(rec.events.find((e) => e.type === "editor")?.data.corrected, 2);
  });
});

test("a round where no section came back is exactly the round that used to be discarded", async () => {
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir, { sectionAnswer: () => truncated(9_000) });
    const result = await review(ctx);
    assert.equal(result.body, LONG, "the body that entered the round is what is delivered");
    assert.equal(result.editorTruncated, true);
    assert.equal(result.editorTruncatedLost, true, "a round that rescued nothing is the whole round lost");
    assert.deepEqual(result.unresolved.map((i) => i.issue), ISSUES.map((i) => i.issue));
    // No `editor` line, which is how the log tells a round that produced nothing from one that
    // ran, and the discarded-round wording in the document.
    assert.equal(rec.events.find((e) => e.type === "editor"), undefined);
    assert.match(result.html, /that round was\n  discarded/);
    assert.doesNotMatch(result.html, /sections \d+ of/);
  });
});

test("the section calls carry no images", async () => {
  await withTemp(async (dir) => {
    // The images are what made the failed whole-body call expensive, and re-sending the same
    // pages with every section would multiply that by the number of sections on a round that
    // has already paid for one ceiling of output. The cost is the corrections only a page image
    // can settle — a [not legible] marker stays put, which is what the editor is told to do
    // when the page is not attached — and it is the same trade `editor_images_refused` makes.
    const { ctx, rec } = ctxWith(dir);
    await review(ctx);
    const editorCalls = rec.calls.filter((c) => c.agent === "copy_editor");
    assert.equal(editorCalls[0].imageCount, 2, "the whole-body call is unchanged");
    for (const c of editorCalls.slice(1)) assert.equal(c.imageCount, 0);
  });
});

test("a size refusal that then truncates is salvaged the same way", async () => {
  await withTemp(async (dir) => {
    // The images-refused retry (#134) can truncate in its turn, and that path arrives already
    // text-only. It gets the same sections rather than a second discard.
    let call = 0;
    const { ctx, rec } = ctxWith(dir, {
      wholeBody: () =>
        ++call === 1 ? new Error("ValidationException: Input is too long for requested model.") : truncated(),
    });
    const result = await review(ctx);
    assert.ok(rec.events.some((e) => e.type === "editor_images_refused"));
    assert.equal(rec.events.find((e) => e.type === "editor_truncated")?.data.after, "images_refused");
    assert.equal(rec.events.find((e) => e.type === "editor_sections")?.data.sections, 3);
    assert.match(result.body, /fixed 1/);
  });
});

test("a salvaged round is still the loop's last round", async () => {
  await withTemp(async (dir) => {
    // The next round would send the same body, whole, and hit the same ceiling before any
    // section call was made. So the loop ends here as it did when the round was discarded —
    // with three rounds left unspent and the corrections in the body.
    const { ctx, rec } = ctxWith(dir, { maxReviewIterations: 3 });
    const result = await review(ctx);
    assert.equal(rec.calls.filter((c) => c.agent === "reader").length, 1, "a Reader pass was spent again");
    assert.equal(
      rec.calls.filter((c) => c.agent === "copy_editor").length,
      4,
      "one whole-body call and three sections, and nothing after them",
    );
    assert.equal(result.iterationsCompleted, 1);
    // Which is why the issues are reported: nothing re-read the document, so what the Reader
    // found before the corrections is all that is known about it.
    assert.deepEqual(result.unresolved.map((i) => i.issue), ISSUES.map((i) => i.issue));
    assert.match(result.html, /@unresolved/);
  });
});

test("the round is measured like any other before the loop ends on it", async () => {
  await withTemp(async (dir) => {
    // The checks that compare the body before and after a round — its lint, the hrefs it
    // dropped, the markers it moved — are exactly the disclosures a section call makes more
    // likely, because it sees less of the document than a whole-body round does. Ending the
    // loop before them would deliver a corrected document with none of them recorded.
    // Both in the first top-level node, so both are in section 1 — the section whose answer
    // below takes them out. A round that ends before the diffs are taken would record neither.
    const first = `<p><a href="https://example.com/a">a</a> [not legible] the rest of it</p>`;
    const { ctx, rec } = ctxWith(dir, {
      sectionAnswer: (s) => (s.index === 1 ? s.html.replace(first, `<p>a the rest of it</p>`) : s.html),
    });
    const result = await review(ctx, `${first}\n\n${LONG}`);
    const dropped = rec.events.find((e) => e.type === "editor_links_dropped");
    assert.deepEqual(dropped?.data.hrefs, ["https://example.com/a"]);
    assert.equal(dropped?.data.iteration, 1);
    assert.equal(result.droppedLinks, 1);
    assert.ok(rec.events.some((e) => e.type === "editor_markers_changed"), "a marker the round dropped");
  });
});

test("a round answered piece by piece is not a round that converged", async () => {
  await withTemp(async (dir) => {
    // `review_converged` claims the editor read the whole document, decided it was better left
    // alone, and left rounds unspent. Here it was never shown the whole document and there are
    // no rounds to spend, so the same body means something else entirely.
    const { ctx, rec } = ctxWith(dir, { sectionAnswer: (s) => s.html });
    const result = await review(ctx);
    assert.equal(result.body, LONG);
    assert.equal(rec.events.find((e) => e.type === "review_converged"), undefined);
    assert.equal(rec.events.find((e) => e.type === "editor")?.data.corrected, 3);
    assert.equal(result.editorTruncated, true);
    assert.match(result.html, /@editor-truncated sections 3 of 3/);
  });
});

test("anything but a size failure in a section still ends the run", async () => {
  await withTemp(async (dir) => {
    // A stall, a stream error or a bad key is not a section that did not fit — it is a
    // deployment that is not working, and swallowing it here would deliver a partly corrected
    // document while reporting nothing wrong.
    const { ctx } = ctxWith(dir, {
      sectionAnswer: (s) => (s.index === 2 ? new Error("bedrock: stream error: boom") : s.html),
    });
    await assert.rejects(review(ctx), /stream error: boom/);
  });
});

test("every reason for not sectioning at all is logged with its number", async () => {
  await withTemp(async (dir) => {
    // A round that quietly declines to try reads in a log exactly like one that tried and
    // failed, and the reasons have different remedies.
    const declined = async (o: Parameters<typeof ctxWith>[1], body?: string) => {
      const { ctx, rec } = ctxWith(dir, o);
      const result = await review(ctx, body);
      assert.equal(result.body, body ?? LONG, "a declined round changed the body");
      assert.equal(rec.calls.filter((c) => c.system === EDITOR_SECTION_SYSTEM).length, 0);
      return rec.events.find((e) => e.type === "editor_sections_declined")!.data;
    };

    // No measurement: a truncation that lost its prototype at some boundary is recognised by
    // its message, but its `chars` are not on it, and inventing a budget would be the
    // pre-flight guess this deliberately is not (PRD §7.11 v1.3).
    assert.equal(
      (
        await declined({
          wholeBody: () =>
            new Error(
              "bedrock: response hit the 32000-token output ceiling and was truncated (78006 chars returned). " +
                "Raise providers.bedrock.max_tokens.",
            ),
        })
      ).reason,
      "unmeasured",
    );
    // A response cut off almost immediately says something went wrong with the call, not that
    // the document is long, and a budget that small would cut it into dozens of pieces.
    const small = await declined({ wholeBody: () => truncated(MIN_SECTION_BUDGET * 2 - 2) });
    assert.equal(small.reason, "budget_too_small");
    assert.equal(small.budget, MIN_SECTION_BUDGET - 1);
    // A response longer than the document it was correcting: the budget covers the whole body,
    // so a section call would be the same request at the same length. That is a reply that ran
    // away with itself, not a document too long to answer, and reporting it as "indivisible"
    // would send an operator looking for an enormous table in a document made of paragraphs.
    const short = `<p>one</p>\n\n<p>two</p>`;
    const runaway = await declined({ wholeBody: () => truncated(CHARS) }, short);
    assert.equal(runaway.reason, "budget_exceeds_body");
    assert.equal(runaway.body, short.length);
    assert.equal(runaway.chars, CHARS);
    assert.ok(Number(runaway.budget) >= short.length);
    // One indivisible node: the case a section-size bound does not solve.
    const huge = `<table>${`<tr><td>cell</td></tr>`.repeat(1_500)}</table>`;
    const indivisible = await declined({}, huge);
    assert.equal(indivisible.reason, "indivisible");
    assert.equal(indivisible.chars, huge.length);
    // And a document so far over the ceiling that salvaging it would take more calls than a
    // round should make. The bound is named in the line, because the honest remedy is the
    // deployment's: raise the ceiling, or lower max_pages.
    const many = await declined({ wholeBody: () => truncated(MIN_SECTION_BUDGET * 2) }, PARAS.join("\n\n").repeat(3));
    assert.equal(many.reason, "too_many_sections");
    assert.equal(many.max, MAX_SECTIONS);
    assert.ok(Number(many.sections) > MAX_SECTIONS);
  });
});

test("the section prompt keeps every rule of the whole-body one and adds the hazard of not seeing the rest", () => {
  // Built on EDITOR_SYSTEM rather than written beside it: a dropped href is just as lost in a
  // section, and two prompts that had to be kept in step would drift.
  assert.ok(EDITOR_SECTION_SYSTEM.startsWith(EDITOR_SYSTEM));
  assert.match(EDITOR_SECTION_SYSTEM, /return the corrected version of THIS SECTION whole/);
  assert.match(EDITOR_SECTION_SYSTEM, /and nothing from outside it/);
  // The failure mode that only exists here: the editor is asked to fix "the issues", some of
  // which are about content it cannot see, and the cheapest way to satisfy an issue about
  // duplicated content is to delete the copy in front of you — which may be the only one left.
  assert.match(EDITOR_SECTION_SYSTEM, /never remove content because it looks duplicated/);
  assert.match(EDITOR_SECTION_SYSTEM, /only when BOTH of them are in this section/);
  assert.match(EDITOR_SECTION_SYSTEM, /anything you leave out is simply gone/);
});

test("the section prompt says which of the first half's instructions do not apply", () => {
  // The half above it is now most of a page about naming blocks and returning only those (#250),
  // and a section request carries no block markers at all. Left to be inferred, the likeliest
  // reply to a section call is an edits list whose numbers name nothing — so the override says it
  // outright. The Reader's language clause took five review rounds on exactly this failure: a
  // prompt that is true about one request and silent about the other reads as true about both.
  assert.match(EDITOR_SECTION_SYSTEM, /there are no numbered blocks in this request and no edits list in its answer/);
  assert.match(EDITOR_SECTION_SYSTEM, /is about\nthe other kind of request/);
  // And the consequence that makes the difference matter, in the words a section call needs:
  // under the block contract an unnamed block is delivered as it stands, and here it is lost.
  assert.match(EDITOR_SECTION_SYSTEM, /Here, content you do not return is content nobody returns/);
  // The answer's shape, restated after the override rather than left as the first half's.
  assert.ok(EDITOR_SECTION_SYSTEM.trimEnd().endsWith(`Respond with ONLY JSON: { "html": "<corrected section>" }`));
});

test("a section call is not sent numbered blocks", async () => {
  // The other half of the same guarantee, and the half a prompt cannot make: the section text in
  // the request must carry no `<!-- @block N -->` markers, or the override above is telling the
  // editor something it can see is untrue about what is in front of it.
  await withTemp(async (dir) => {
    const { ctx, rec } = ctxWith(dir);
    await review(ctx);
    const editorCalls = rec.calls.filter((c) => c.agent === "copy_editor");
    assert.match(editorCalls[0].user, /<!-- @block 0 -->/, "the document-level call is numbered");
    for (const c of editorCalls.slice(1)) {
      assert.equal(c.system, EDITOR_SECTION_SYSTEM);
      assert.doesNotMatch(c.user, /@block/);
    }
  });
});
