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
test("the Reader's two cases are both cases the editor can act on", () => {
  for (const [what, inReader, inEditor] of [
    ["the reprinted-title case: one section", /one section whose title repeats/, /is ONE heading/],
    ["the labelled-alike case: two sections", /two sections the document labels alike/, /really does label alike/],
    ["the words added come from the section's own content", /that section's own content/, /that section's own content/],
  ] as [string, RegExp, RegExp][]) {
    assert.match(reader, inReader, `READER_SYSTEM stopped reporting ${what}`);
    assert.match(editor, inEditor, `EDITOR_SYSTEM stopped resolving ${what} — the Reader still reports it`);
  }
});

// --- the finding half, in code -----------------------------------------------

const runs = (body: string) =>
  sameWordedHeadingRuns(body).map((r) => `h${r.level}:${r.text}:${r.count}`);

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
    { level: 2, text: "Operation", count: 3 },
    { level: 3, text: "Cleaning", count: 2 },
  ])!;
  assert.match(note, /\[Heading 2\] "Operation" \(3 of them\)/);
  assert.match(note, /\[Heading 3\] "Cleaning"$/m, "a plain pair needs no count");

  // A silent cap reads as "these are all of them" to whoever acts on the list.
  const many = Array.from({ length: 20 }, (_, i) => ({ level: 2, text: `Section ${i}`, count: 2 }));
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
