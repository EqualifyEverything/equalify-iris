// The duplicate-heading defect (issues #111, #119) is the one heading problem the page
// agent cannot see. It is handed one page and no other, so a section title reprinted where
// the section continues looks exactly like a new section starting, and three <h2>Operation</h2>
// headings arrive one per call with nothing to compare them against. The defect only exists
// in the assembled document — which the Reader Agent is given, but a chunk at a time:
// `runReader` sends the body in CHUNK_BUDGET windows, and a reprinted title is a full page
// of extracted HTML away from its twin, so at some offsets the pair straddles a cut and
// neither call sees both headings. So finding the pairs is done in code over the whole body
// (`sameWordedHeadingRuns`) and handed to the Reader, which is left with the part that needs
// judgement: which of the two cases a pair is, and which pages it is on.
//
// Nothing else in the pipeline reaches it either. axe (src/pipeline/lint.ts) reports a
// SKIPPED level and says nothing about two headings at the same level with the same words,
// since that is valid markup. So the rule is split across three prompts and each third is
// useless without the others: the page prompt handles what one page shows (pinned in
// test/page-prompt.test.ts), READER_SYSTEM detects the pair across pages and classifies it,
// EDITOR_SYSTEM applies the resolution the Reader named. This test holds the two halves that
// live in src/pipeline/review.ts, and holds them to each other: if the Reader reports a case
// the editor has no instruction for, the finding survives to `unresolved` and the document
// ships with the defect the user reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READER_SYSTEM, EDITOR_SYSTEM, runReview } from "../src/pipeline/review.ts";
import { sameWordedHeadingNote, sameWordedHeadingRuns } from "../src/pipeline/headings.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// The prompts wrap for reading, so the clauses are matched on words rather than bytes —
// reflowing a paragraph must not fail a test whose subject is what the paragraph says.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const reader = normalize(READER_SYSTEM);
const editor = normalize(EDITOR_SYSTEM);

test("the Reader is told to find the duplicate-heading pair and say which case it is", () => {
  for (const [what, re] of [
    // #119: three same-level headings reading "Operation", which tells a reader navigating by
    // heading that the second section is the same subject as the first.
    ["adjacent same-level headings with the same words are a defect to report",
      /The same words announced twice in a row at the same level — \[Heading 2\] Operation, then another \[Heading 2\] Operation/],
    // #111: the same defect assembled from per-page extractions, which is why the Reader is
    // told where it comes from — it must not assume a duplicate means one page was extracted
    // twice.
    ["a title reprinted per page is named as the same defect arriving one page at a time",
      /a section title reprinted at the top of every page it continues on is that defect arriving one page at a time/],
    // The Copy Editor fetches page images by attribution, and this is the one issue where the
    // images ARE the evidence: only the source pages say whether the title was reprinted.
    ["the pages both headings are on are reported, since the editor resolves it from the images",
      /Report both, with the pages both headings are on/],
    // Two resolutions with opposite effects — merge, or keep both and extend — so the Reader
    // has to name which, or the editor is guessing.
    ["the report says which of the two cases it looks like",
      /say which of the two it looks like/],
    ["the one-section case is described as content moving under the first heading",
      /one section whose title repeats, where the second heading goes and what followed it belongs under the first/],
    ["the two-section case keeps the label and adds words from that section's own content",
      /each heading keeps the label and gains the words that tell it apart — words already in that section's own content, never a phrase of your own/],
    // Over-correction guards. Without these the Reader reports every <h2> that shares a level
    // with another <h2>, and the editor spends a round merging sections that were never
    // ambiguous.
    ["headings that merely share a level are not reported",
      /Do not report two same-level headings that merely share a level/],
    ["identical headings with other sections between them are not reported",
      /identical headings with other sections in between/],
    // The prompt has to describe the computed section the code sends, or the Reader treats
    // a list of headings it cannot find in its own excerpt as noise.
    ["the computed list is announced, and announced as covering the whole document",
      /a section below lists them, computed from the WHOLE document rather than from the HTML you were given/],
    ["a heading the list names but the excerpt does not contain is still reported",
      /a heading it names may sit outside your excerpt, and is to be reported anyway/],
    ["entries are not argued with, and a pair the list missed is still worth reporting",
      /no entry is a false positive to be argued with, and finding a pair the list missed is still worth reporting/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

test("the Copy Editor is told how to resolve each case the Reader reports", () => {
  for (const [what, re] of [
    // The Reader can report a pair that is a page apart, because the reprinted title has that
    // page's content between the two headings. An editor told only about ADJACENT headings has
    // no instruction for the case #111 reported.
    ["the pair may be adjacent or a page apart, which is what a reprinted title looks like",
      /whether they sit next to each other or with one page's worth of content between them, which is what a title reprinted where its section continued looks like once the pages are joined/],
    ["the source images decide which case it is",
      /The source images say which way it goes/],
    ["the reprinted-title case drops the repeat and relevels what followed it",
      /drop the repeat and put what followed it under the first, at the level its content calls for/],
    ["two sections the document labels alike keep the label and gain distinguishing words",
      /two sections the document really does label alike keep the label and each gain the words that distinguish them/],
    // This prompt also says "do not invent content", and adding words to a heading is adding
    // words. The exception has to be stated and bounded, or the editor either ignores the
    // instruction or writes a subtitle of its own.
    ["the added words are bounded to that section's own content, and named as the only text it may add",
      /Those words come from that section's own content, which is the one text you may add here/],
    ["a subtitle of the editor's own is forbidden", /never write a subtitle of your own/],
    ["sections that are merely named alike are not merged",
      /never merge two sections that are merely named alike/],
    // The Reader has a third answer — it is told to say so where the excerpts do not tell
    // it which case a pair is, and with a 200-char page excerpt that happens for any pair
    // away from a page's top. Without an instruction for it the editor still has "resolve
    // every issue you can", and the resolution it can always reach is the destructive one.
    // This is also the state of the size-refusal retry, which carries no images at all.
    ["an undecidable pair is left alone rather than resolved on a guess",
      /where nothing you were given decides it — the reviewer says it could not tell, or the pages those headings are on were not attached — leave both headings exactly as they are/],
    ["the asymmetry is stated: a repeated label is recoverable, a merged section is not",
      /an issue left alone comes back next round or is reported as unresolved, while content you removed on a guess is gone from the document/],
  ] as [string, RegExp][]) {
    assert.match(editor, re, `EDITOR_SYSTEM no longer says: ${what}`);
  }
});

// The two prompts are one rule in two halves, and the halves are written by different
// hands at different times. What follows is the seam: every case the Reader is told to
// report has to be a case the editor is told to resolve. A Reader that reports what the
// editor cannot act on does not produce a wrong document — it produces one where the issue
// comes back as `unresolved` round after round, spending review iterations on a finding
// that could never be fixed.
test("every answer the Reader can give is one the editor has an instruction for", () => {
  for (const [what, inReader, inEditor] of [
    ["the reprinted-title case: one section", /one section whose title repeats/, /is ONE heading/],
    ["the labelled-alike case: two sections", /two sections the document labels alike/, /really does label alike/],
    ["the words added come from the section's own content", /that section's own content/, /that section's own content/],
    ["the case where the Reader cannot tell which of the two it is",
      /where the excerpts do not tell you, say that instead of choosing/,
      /the reviewer says it could not tell.*leave both headings exactly as they are/],
  ] as [string, RegExp, RegExp][]) {
    assert.match(reader, inReader, `READER_SYSTEM stopped reporting ${what}`);
    assert.match(editor, inEditor, `EDITOR_SYSTEM stopped resolving ${what} — the Reader still reports it`);
  }
});

// --- the finding half, in code -----------------------------------------------

const runs = (body: string) =>
  sameWordedHeadingRuns(body).map((r) => `h${r.level}:${r.text}:${r.count}`);

// Same, plus where the run starts in the outline — the field that keeps two runs of the
// same words at the same level from rendering as one line.
const placed = (body: string) =>
  sameWordedHeadingRuns(body).map(
    (r) => `h${r.level}:${r.text}:${r.count} after ${r.after ? `h${r.after.level}:${r.after.text}` : "-"}`,
  );

// The rendered lines, which is what the Reader actually acts on. Two runs it cannot tell
// apart cost one of them a report, whatever the objects behind them look like.
const lines = (body: string) => (sameWordedHeadingNote(sameWordedHeadingRuns(body)) ?? "").split("\n");

test("two same-level headings with the same words and only their own content between them", () => {
  // #119 as reported, in miniature: the second [Heading 2] Operation tells a reader
  // navigating by heading that the same subject follows.
  assert.deepEqual(
    runs("<h2>Operation</h2><p>Fill the hopper.</p><h2>Operation</h2><p>Press start.</p>"),
    ["h2:Operation:2"],
  );
});

test("a subsection between them is their own content, not another section", () => {
  // This is what a reprinted title looks like once the pages are joined (#111): the
  // page's own subsections sit under the first heading, then the title comes again.
  assert.deepEqual(
    runs("<h2>Controls</h2><h3>Top</h3><p>a</p><h2>Controls</h2><h3>Rear</h3><p>b</p>"),
    ["h2:Controls:2"],
  );
});

test("a run of three is reported once, with its length", () => {
  // The user's report was three <h2>Operation</h2> headings. Two overlapping pairs
  // would have the Reader raise the same defect twice and the editor resolve it in two
  // rounds, out of a budget of a few.
  assert.deepEqual(runs("<h2>Op</h2><p>a</p><h2>Op</h2><p>b</p><h2>Op</h2><p>c</p>"), ["h2:Op:3"]);
});

test("another section in between is not the ambiguous case", () => {
  // Deliberate bound, and the guard READER_SYSTEM states: the intervening section tells
  // a reader the two headings are different places in the document. Widening this to
  // every same-worded heading in a manual would send the editor merging or renaming
  // sections that were never ambiguous.
  assert.deepEqual(runs("<h2>Op</h2><p>a</p><h2>Care</h2><p>b</p><h2>Op</h2><p>c</p>"), []);
});

test("headings at different levels are not a pair, however alike their words", () => {
  // <h1>Operation</h1> followed by <h2>Operation</h2> is a section and its first
  // subsection sharing a name — read in order it is unambiguous, and it is also what
  // the page prompt's own "step one level down" rule produces.
  assert.deepEqual(runs("<h1>Operation</h1><h2>Operation</h2><p>a</p>"), []);
});

test("case and trailing punctuation do not make two headings different", () => {
  // A page that sets a running title in capitals and reprints it in title case is
  // reprinting it, and a colon is a typographic choice about the same words.
  assert.deepEqual(
    runs("<h2>OPERATION:</h2><p>a</p><h2>Operation</h2><p>b</p>"),
    ["h2:OPERATION::2"],
    "reported with the text as first printed, since that is what is matched against page excerpts",
  );
});

test("markup inside a heading is read as the words it announces", () => {
  assert.deepEqual(
    runs("<h2>Care <em>and</em> cleaning</h2><p>a</p><h2>Care and cleaning</h2><p>b</p>"),
    ["h2:Care and cleaning:2"],
  );
});

test("two empty headings are a different defect and are not reported as a pair", () => {
  // An <h2></h2> announces nothing; two of them are not two sections a reader confuses,
  // they are markup axe already reports (empty-heading). Reporting them here would put
  // an entry in the list the Reader is told is never a false positive.
  assert.deepEqual(runs("<h2></h2><p>a</p><h2>  </h2><p>b</p>"), []);
});

test("a body with no headings, and one with no repeats, produce no list at all", () => {
  assert.deepEqual(runs("<p>Just prose.</p>"), []);
  assert.deepEqual(runs("<h2>One</h2><p>a</p><h2>Two</h2><p>b</p>"), []);
  assert.equal(sameWordedHeadingNote([]), null, "the section is omitted rather than asserting an absence");
});

test("the list quotes the heading and says how many, and says when it is truncated", () => {
  const note = sameWordedHeadingNote([
    { level: 2, text: "Operation", count: 3, after: null, opening: "Fill the hopper." },
    { level: 3, text: "Cleaning", count: 2, after: { level: 2, text: "Care" }, opening: "" },
  ])!;
  assert.match(
    note,
    /1\. \[Heading 2\] "Operation" \(3 of them\), at the start of the document, opening "Fill the hopper\."/,
  );
  assert.match(
    note,
    /2\. \[Heading 3\] "Cleaning", the first of them after \[Heading 2\] "Care", with nothing under it$/m,
    "a plain pair needs no count, but still needs placing",
  );

  // A silent cap reads as "these are all of them" to whoever acts on the list.
  const many = Array.from({ length: 20 }, (_, i) => ({
    level: 2,
    text: `Section ${i}`,
    count: 2,
    after: null,
    opening: "",
  }));
  const capped = sameWordedHeadingNote(many)!;
  assert.match(capped, /and 8 more, not listed here/);
});

test("a body that cannot be parsed costs the list, not the review", () => {
  // The list is an aid to a rule the Reader has anyway. Returning [] here keeps a
  // pathological body from ending a review that would otherwise have run.
  assert.deepEqual(runs(""), []);
});

// --- the seam between the code and the prompt --------------------------------

// The list is computed over the whole body but the Reader is called per chunk, so two
// things have to be true at once and neither is visible from the prompt text: the section
// has to reach the Reader, and it has to reach it ONCE. Chunk calls are independent, so a
// list given to all of them yields the same finding two or three times — carried to
// `unresolved` that many times if no editor round clears it.
async function readerPrompts(body: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-headings-"));
  try {
    const prompts: string[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 0,
      extractionConcurrency: 4,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent === "reader") prompts.push(messages.map((m) => m.content).join("\n"));
          return { text: JSON.stringify({ issues: [] }) };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return prompts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the Reader is handed the computed list, once, however many chunks the body takes", async () => {
  // Two same-worded <h2>s a long way apart: 40k of filler between them puts them in
  // different CHUNK_BUDGET (24000) windows, which is the case that was previously
  // undetectable no matter what the prompt said.
  const filler = "<p>Fill the hopper and press start.</p>".repeat(1100);
  const prompts = await readerPrompts(`<h2>Operation</h2>${filler}<h2>Operation</h2><p>end</p>`);
  assert.ok(prompts.length > 1, "the body must actually span more than one chunk for this to prove anything");
  const withList = prompts.filter((p) => /Headings with the same words at the same level/.test(p));
  assert.equal(withList.length, 1, "the list belongs to exactly one call, or the same finding arrives twice");
  assert.match(withList[0], /\[Heading 2\] "Operation"/);
});

test("a clean document is not sent a section saying there is nothing", async () => {
  const prompts = await readerPrompts("<h1>Report</h1><h2>One</h2><p>a</p><h2>Two</h2><p>b</p>");
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /Headings with the same words/);
});

test("a pair nested inside an outer pair is in the list too", () => {
  // #111's own shape: the page reprints the running title AND the header of the
  // subsection that continues under it, so the <h3> pair sits inside the <h2> run.
  // Reporting the run by advancing the cursor to its last heading would jump the whole
  // interval between the two <h2>s and lose the inner pair.
  assert.deepEqual(
    runs("<h2>Op</h2><h3>X</h3><p>a</p><h3>X</h3><p>b</p><h2>Op</h2><h3>Y</h3><p>c</p><h3>Y</h3><p>d</p>"),
    ["h2:Op:2", "h3:X:2", "h3:Y:2"],
  );
});

test("a heading is a member of one run only", () => {
  // The dedupe the cursor jump was there for: three consecutive <h2>Op</h2> are one run
  // of three, not a run of three plus a run of two starting at the second.
  assert.deepEqual(runs("<h2>Op</h2><p>a</p><h2>Op</h2><p>b</p><h2>Op</h2><p>c</p>"), ["h2:Op:3"]);
});

test("an empty heading between the pair ends the run, as any other section would", () => {
  // It names nothing, but it opens a section — so the two headings around it are no
  // longer the pair with nothing but their own content between them. Stated because the
  // opposite reading is tempting: an empty heading announces nothing to a reader.
  assert.deepEqual(runs("<h2>Op</h2><p>a</p><h2></h2><h2>Op</h2><p>b</p>"), []);
});

test("two runs of the same words at the same level are two distinguishable entries", () => {
  // The list the Reader is told never contains a false positive must not contain two
  // lines it cannot tell apart either: read as a restatement, the second pair goes
  // unreported. Each entry is placed by the heading it follows.
  const body =
    "<h2>Op</h2><p>a</p><h2>Op</h2><p>b</p>" +
    "<h2>Other</h2><p>c</p>" +
    "<h2>Op</h2><p>d</p><h2>Op</h2><p>e</p>";
  assert.deepEqual(placed(body), [
    "h2:Op:2 after -",
    "h2:Op:2 after h2:Other",
  ]);
  const note = sameWordedHeadingNote(sameWordedHeadingRuns(body))!;
  assert.equal(new Set(note.split("\n")).size, 2, "the two lines must differ, not just the runs behind them");
});

test("a run is placed by the heading before it whatever that heading's level", () => {
  // The preceding heading is the run's position in the outline, not its parent: after a
  // deeper subsection, that heading is the one the reader last passed.
  assert.deepEqual(
    placed("<h1>Manual</h1><h2>Care</h2><h3>Deep</h3><p>a</p><h2>Op</h2><p>b</p><h2>Op</h2><p>c</p>"),
    ["h2:Op:2 after h3:Deep"],
  );
});

test("two runs whose preceding headings are also alike are still two distinct lines", () => {
  // #111's shape doubled: the page reprints its running title AND the header of the
  // subsection continuing under it, twice over — so both <h3> runs follow an <h2> with the
  // same words, and the heading before them cannot tell them apart. What differs is the
  // content under them, and past that, the numbering.
  const body =
    "<h2>Op</h2><h3>X</h3><p>Fill the hopper.</p><h3>X</h3><p>Press start.</p>" +
    "<h2>Op</h2><h3>X</h3><p>Empty the tray.</p><h3>X</h3><p>Wipe the plate.</p>";
  const out = lines(body);
  assert.equal(out.length, 3, `expected the outer pair and both inner pairs: ${out.join(" / ")}`);
  assert.equal(new Set(out).size, 3, `every line must be distinct: ${out.join(" / ")}`);
  assert.match(out[1], /opening "Fill the hopper\."/);
  assert.match(out[2], /opening "Empty the tray\."/);
});

test("even an outline that repeats exactly leaves the entries numbered apart", () => {
  // Two runs where the preceding heading AND the words underneath match — a page
  // duplicated wholesale. Nothing observable distinguishes them, so the numbering is what
  // is left, and it is enough for the Reader to report two pairs rather than one.
  const body =
    "<h2>Op</h2><h3>X</h3><p>Same words.</p><h3>X</h3><p>Same words.</p>" +
    "<h2>Op</h2><h3>X</h3><p>Same words.</p><h3>X</h3><p>Same words.</p>";
  const out = lines(body);
  assert.equal(new Set(out).size, out.length, `every line must be distinct: ${out.join(" / ")}`);
  assert.match(out[1], /^2\. /);
  assert.match(out[2], /^3\. /);
});

test("the words quoted under a heading stop at the next heading and at its own section", () => {
  // The opening exists to tell two entries apart, so it must be the run's OWN content: a
  // heading with an empty section that borrowed the next section's words would read as
  // distinct when it is not, and as describing content it does not have.
  const empty = sameWordedHeadingRuns("<h2>Op</h2><h3>X</h3><h3>X</h3><p>Under the second.</p>");
  assert.equal(empty.find((r) => r.level === 3)!.opening, "", "the first X has nothing under it");
  const wrapped = sameWordedHeadingRuns(
    "<section><h2>Op</h2><p>Inside.</p></section><section><h2>Op</h2><p>Also inside.</p></section>",
  );
  assert.equal(wrapped.length, 1, "a heading wrapped in its own <section> is still found");
  assert.equal(wrapped[0].opening, "Inside.", "and its opening is its own section's words");
});
