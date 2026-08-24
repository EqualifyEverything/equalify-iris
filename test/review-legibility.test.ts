// A `[not legible]` marker is the page agent's honest record that the marks on its page did
// not resolve into characters (issues #112, #117, and the legibility half of #116; the page
// half is pinned in test/page-prompt.test.ts). Once it is in the document, two later passes
// can meet it, and both of the obvious things they might do with it are worse than leaving
// it alone: replacing it with a plausible word puts something a reader will act on into the
// document with nothing behind it, and deleting it tells every later reader that the page
// was transcribed in full.
//
// The one pass that can honestly resolve it is the Copy Editor, because it is the only pass
// after extraction that is given source page images — which is also why the Reader is told to
// report every marker with its page rather than to leave them alone: attribution is what
// fetches the image. So the rule is split the same way the duplicate-heading rule is, and the
// halves have to agree; this test holds them to each other and to the reasons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { READER_SYSTEM, EDITOR_SYSTEM } from "../src/pipeline/review.ts";

// Matched on words rather than bytes: reflowing a paragraph must not fail a test whose
// subject is what the paragraph says.
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const reader = normalize(READER_SYSTEM);
const editor = normalize(EDITOR_SYSTEM);

test("the Reader reports an unreadable region without trying to read it", () => {
  for (const [what, re] of [
    ["it says what the marker is, so it is not read as a defect in the markup",
      /A \[not legible\] marker is what the extractor wrote where the marks on its page did not resolve into characters/],
    // Attribution is the point: the editor is handed the images for the pages the issues name,
    // so an unattributed marker is one the only pass that could resolve it cannot look at.
    ["every marker is reported with its page, because that is what fetches the image",
      /Report every one of them with the page it is on/],
    ["the Reader does not guess the words, having never seen the page",
      /You do not see the source images, so never suggest what the marker stood for/],
    ["and does not ask for the marker to be dropped",
      /never ask for it to be deleted — a document that once said it could not read a word and now says nothing tells every reader that the page was fully transcribed/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

test("the editor may read the page again, and may do nothing else with the marker", () => {
  for (const [what, re] of [
    ["the marker is not content and not a markup defect",
      /A \[not legible\] marker is not content and not a defect in the markup/],
    // The resolution that is actually available: the editor has the image the extractor had.
    ["with the page attached, the region is looked at again",
      /Where that page's image IS attached, look at the region again/],
    // And it stays inside the fidelity bound the rest of this prompt keeps: the words come
    // from the page. The heading rule names its own added text the same way.
    ["the words it may add are the page's own",
      /replace the marker with the words the page shows, which is the other text you may add here because it comes from the page and not from you/],
    ["without the page, or without a reading, the marker stands",
      /If they do not resolve, or that page was not attached, leave the marker exactly where it stands/],
    ["neither a guess nor a deletion, and why each is worse than the marker",
      /Never replace it with a plausible word, and never simply delete it: a guess reaches a reader as something the page says, and a deletion tells every later reader that the page was read in full/],
    // The bound that matters on a manual: context can support a word and cannot support a
    // torque figure, and the figure is what someone will act on.
    ["a number or a code is the case to be strictest about",
      /A number, a part code or a measurement is the case to be strictest about — nothing in the surrounding sentence can confirm one/],
  ] as [string, RegExp][]) {
    assert.match(editor, re, `EDITOR_SYSTEM no longer says: ${what}`);
  }
});

test("every answer the Reader can give about a marker is one the editor can act on", () => {
  // The Reader has exactly one thing to say — this marker is on page N — and the editor's
  // instruction has to cover both of the states that leaves it in, or the issue survives to
  // `unresolved` round after round and the document ships with a guess or a hole instead.
  for (const [state, reported, instructed] of [
    ["the page image is attached and the marks resolve",
      /Report every one of them with the page it is on/,
      /if the marks resolve now, replace the marker with the words the page shows/],
    ["the page image is attached and they still do not resolve",
      /never suggest what the marker stood for/,
      /If they do not resolve, or that page was not attached, leave the marker exactly where it stands/],
    ["the page image was not attached at all",
      /the Copy Editor is given that page's image and can look again/,
      /or that page was not attached, leave the marker exactly where it stands/],
  ] as [string, RegExp, RegExp][]) {
    assert.match(reader, reported, `the Reader no longer reaches the case: ${state}`);
    assert.match(editor, instructed, `the editor has no instruction for the case: ${state}`);
  }
});
