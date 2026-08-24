// The duplicate-heading defect (issues #111, #119) is the one heading problem the page
// agent cannot see. It is handed one page and no other, so a section title reprinted where
// the section continues looks exactly like a new section starting, and three <h2>Operation</h2>
// headings arrive one per call with nothing to compare them against. The defect only exists
// in the assembled document — which is precisely what the Reader Agent is given.
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
import { READER_SYSTEM, EDITOR_SYSTEM } from "../src/pipeline/review.ts";

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
