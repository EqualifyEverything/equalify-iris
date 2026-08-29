// A `[not legible]` marker is the page agent's honest record that the marks on its page did
// not resolve into characters, and a `[page not fully transcribed]` marker its record that it
// could not return all of a page (issues #112, #117, #133, and the legibility half of #116; the
// page half of both is pinned in test/page-prompt.test.ts). Once one is in the document, two passes
// can meet it, and both of the obvious things they might do with it are worse than leaving
// it alone: replacing it with a plausible word puts something a reader will act on into the
// document with nothing behind it, and deleting it tells every later reader that the page
// was transcribed in full.
//
// The one pass that can honestly resolve `[not legible]` is the Copy Editor, because it is the
// only pass after extraction that is given source page images — which is also why the Reader is
// told to report every marker with its page rather than to leave them alone: attribution is what
// fetches the image. `[page not fully transcribed]` has no resolution inside this loop at all,
// and the two therefore need separate instructions. So the rule is split the same way the
// duplicate-heading rule is, and the halves have to agree; this test holds them to each other
// and to the reasons, and holds the code to the one thing a prompt cannot do — notice when a
// marker went missing anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READER_SYSTEM,
  EDITOR_SYSTEM,
  BODY_MARKERS,
  markerCounts,
  runReview,
} from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// Matched on words rather than bytes: reflowing a paragraph must not fail a test whose
// subject is what the paragraph says.
const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
const reader = normalize(READER_SYSTEM);
const editor = normalize(EDITOR_SYSTEM);

test("the Reader reports an unreadable region without trying to read it", () => {
  for (const [what, re] of [
    ["it says what each marker is, so neither is read as a defect in the markup",
      /A \[not legible\] marker is what the extractor wrote where the marks on its page did not resolve into characters, and a \[page not fully transcribed\] marker is what it wrote where it could not return the whole page/],
    // The flattened view's vocabulary sentence tells the Reader that anything in square brackets
    // is an annotation and not content. These two are content, so the exception belongs there and
    // not only in the paragraph 40 lines below it: a marker read as an annotation is one the
    // Reader does not attribute to a page, and attribution is what fetches the image.
    ["the bracket vocabulary excepts them, where the Reader meets brackets first",
      /Two bracketed tokens are the exception, because the extractor wrote them into the document rather than the flattener adding them: \[not legible\] and \[page not fully transcribed\] are content/],
    // Attribution is the point: the editor is handed the images for the pages the issues name,
    // so an unattributed marker is one the only pass that could resolve it cannot look at.
    ["every marker is reported with its page, because that is what fetches the image",
      /Report every one of them with the page it is on/],
    // And the Reader is told which of the two its report can actually settle, so it does not
    // spend rounds pressing for a resolution no pass in this loop is able to make.
    ["the second marker is reported and left standing, because nothing here can settle it",
      /the second is settled by re-extracting that page, which is nobody's job in this loop, so it is reported and left standing/],
    ["the Reader does not guess the words, having never seen the page",
      /You do not see the source images, so never suggest what a marker stood for/],
    ["and does not ask for a marker to be dropped",
      /never ask for one to be deleted — a document that once said a word could not be read, or a page not finished, and now says nothing tells every reader that the page arrived whole/],
  ] as [string, RegExp][]) {
    assert.match(reader, re, `READER_SYSTEM no longer says: ${what}`);
  }
});

test("the editor may read the page again, and may do nothing else with the marker", () => {
  for (const [what, re] of [
    ["the marker is not a markup defect",
      /A \[not legible\] marker is not a defect in the markup: it is the extractor saying the marks on that page did not resolve into characters/],
    // The resolution that is actually available: the editor has the image the extractor had.
    ["with the page attached, that region is looked at again",
      /Where that page's image IS attached, look at that region again/],
    // And it stays inside the fidelity bound the rest of this prompt keeps: the words come
    // from the page. The heading rule names its own added text the same way, and the two
    // clauses count each other so a third cannot be added without contradicting one of them.
    ["the words it may add are the page's own, and are the last such text",
      /put the words the page shows in the marker's place, which is the second and last text you may add here, because it comes from the page and not from you/],
    ["the heading rule's added words are counted against the same bound",
      /which is one of the two texts you may add here \(the other is under the markers below, and there is no third\)/],
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

test("the unfinished-page marker is nobody's to resolve in this loop, and the editor is told why", () => {
  // The asymmetry is the whole point of splitting the two paragraphs. Reading a smudge off an
  // attached image is a phrase the page shows in a marker's place; finishing a page is a page
  // transcribed, which is a different pass with different gates on what it returns. An editor
  // told only "resolve markers where the image is attached" would read this marker as its job.
  //
  // The reason given for it has changed with #250, and the old one is why this test names its
  // rows. Until then the argument was the output ceiling: filling the marker in meant returning
  // the rest of that page ON TOP of the complete corrected body, which was the one request in the
  // pipeline that could exceed what a response can hold. The editor is no longer asked for the
  // complete corrected body — it answers with the blocks it changed — so that argument is now
  // false where it used to be the strongest thing the paragraph had, and a prompt that kept it
  // would be telling the editor something it can check and find untrue. What remains is the
  // argument the [not legible] paragraph already runs on, and it never depended on a ceiling:
  // words the pipeline delivers as a page's own must come from a pass that transcribes pages.
  for (const [what, re] of [
    ["it is not the editor's to resolve even with the image in hand",
      /A \[page not fully transcribed\] marker is not yours to resolve at all, even with that page's image in front of you/],
    ["what filling it in would actually be: a page transcribed, which is another pass",
      /means transcribing the rest of that page from its image — a re-extraction, which is a pass with a whole response for that one page and its own gates on what came back, and not a correction to the markup around it/],
    // And the harm named as the reader receives it, which is the same harm the paragraph above
    // names for a guessed word: nothing downstream can tell a transcription from a plausible
    // paragraph, so the distinction has to hold here or nowhere.
    ["the harm is that nobody downstream can tell the two apart",
      /what this one would produce is a paragraph you wrote while looking at a page, delivered where nobody downstream can tell the two apart/],
    ["so it is left standing, and never deleted",
      /leave the marker exactly where it stands, resolve the other issues around it, and never delete it — an unfinished page that says so can be finished, and one that does not looks complete to everyone downstream/],
  ] as [string, RegExp][]) {
    assert.match(editor, re, `EDITOR_SYSTEM no longer says: ${what}`);
  }
});

test("every answer the Reader can give about a marker is one the editor can act on", () => {
  // The Reader has exactly one thing to say — this marker is on page N — and the editor's
  // instruction has to cover every state that leaves it in, or the issue survives to
  // `unresolved` round after round and the document ships with a guess or a hole instead.
  for (const [state, reported, instructed] of [
    ["[not legible], the page image is attached and the marks resolve",
      /Report every one of them with the page it is on/,
      /if the marks resolve for you, put the words the page shows in the marker's place/],
    ["[not legible], the page image is attached and they still do not resolve",
      /never suggest what a marker stood for/,
      /If they do not resolve, or that page was not attached, leave the marker exactly where it stands/],
    ["[not legible], the page image was not attached at all",
      /looking at that page again is the only thing that can settle the first marker/,
      /or that page was not attached, leave the marker exactly where it stands/],
    ["[page not fully transcribed], which no state of the images changes",
      /so it is reported and left standing/,
      /is not yours to resolve at all, even with that page's image in front of you/],
  ] as [string, RegExp, RegExp][]) {
    assert.match(reader, reported, `the Reader no longer reaches the case: ${state}`);
    assert.match(editor, instructed, `the editor has no instruction for the case: ${state}`);
  }
});

// --- what the prompt cannot do -----------------------------------------------

// Both markers sit INSIDE a fragment, which is the position assembly.ts keeps its own
// @page-failed marker out of, and the editor is asked for "the complete corrected body" every
// round. So a deletion is one token of drift in a rewritten document: `contentCoverage` strips
// [...] before comparing words, axe has nothing to say about a phrase, and the Reader cannot
// miss what is no longer there. `droppedHrefs` exists one file over for exactly this shape of
// loss. Counting is all that is available here — a [not legible] marker SHOULD sometimes go,
// which is why this is a record and not a gate.
test("the markers are counted, including more than one of the same kind", () => {
  assert.deepEqual(markerCounts("<p>clean</p>"), {
    "[not legible]": 0,
    "[page not fully transcribed]": 0,
  });
  assert.deepEqual(
    markerCounts("<td>[not legible]</td><td>4.5</td><td>[not legible]</td><p>[page not fully transcribed]</p>"),
    { "[not legible]": 2, "[page not fully transcribed]": 1 },
  );
  // The prompts name both, and the code counts what the prompts name: a marker added to one
  // side and not the other is a marker nothing measures.
  for (const marker of BODY_MARKERS) {
    assert.ok(reader.includes(marker), `READER_SYSTEM does not mention ${marker}`);
    assert.ok(editor.includes(marker), `EDITOR_SYSTEM does not mention ${marker}`);
  }
});

// One reader round that raises an issue, one editor round that returns `edited`, then a clean
// reader round to end the loop.
async function eventsForEditorRound(body: string, edited: string): Promise<{ name: string; data: Record<string, unknown> }[]> {
  const dir = mkdtempSync(join(tmpdir(), "iris-legibility-"));
  try {
    const events: { name: string; data: Record<string, unknown> }[] = [];
    let readerCalls = 0;
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 1,
      extractionConcurrency: 4,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string) => {
          if (agent === "reader") {
            readerCalls++;
            return {
              text: JSON.stringify({
                issues: readerCalls === 1
                  ? [{ issue: "a [not legible] marker on page 2", severity: "minor", pages: [2], suggested_action: "look again" }]
                  : [],
              }),
            };
          }
          return { text: JSON.stringify({ html: edited }) };
        },
      },
      log: {
        event: (name: string, data: Record<string, unknown>) => events.push({ name, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return events;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a marker the editor dropped is on the record, and one it kept is not", async () => {
  const withMarkers = "<p>Torque to [not legible] Nm.</p><p>[page not fully transcribed]</p>";

  const lost = await eventsForEditorRound(withMarkers, "<p>Torque to 40 Nm.</p><p>Done.</p>");
  const changed = lost.find((e) => e.name === "editor_markers_changed");
  assert.ok(changed, "a round that deleted both markers logged nothing");
  assert.deepEqual(changed.data.fewer, ["[not legible]", "[page not fully transcribed]"]);
  assert.equal(changed.data.more, undefined, "nothing was added, so the line does not say so");
  assert.equal(changed.data.iteration, 1);
  // Before and after both, so the line says how many went rather than only that some did:
  // a document with fourteen markers that comes back with one is not the same round as a
  // document with two that comes back with one.
  assert.deepEqual(changed.data.before, { "[not legible]": 1, "[page not fully transcribed]": 1 });
  assert.deepEqual(changed.data.after, { "[not legible]": 0, "[page not fully transcribed]": 0 });

  // The ordinary round. An editor that fixed the reported issue and left both markers alone
  // must not add a line, or the record is noise and the one round that matters is buried.
  const kept = await eventsForEditorRound(withMarkers, `<h2>Setup</h2>${withMarkers}`);
  assert.equal(kept.find((e) => e.name === "editor_markers_changed"), undefined);
});

test("a marker the editor ADDED is on the record too, which is the worse direction", async () => {
  // The page prompt spends a paragraph on this exact harm — "a placeholder standing for a
  // paragraph you could mostly read costs a reader the part you had" — and here it is words the
  // extractor DID read, replaced downstream by a pass that never saw the page's marks. It
  // reaches a reader as the source being illegible, which nothing that saw the source said.
  // Nothing else notices: contentCoverage strips [...] before comparing words, so the words
  // that went look like ordinary editor drift and what replaced them is not words at all.
  const readable = "<p>Torque to 40 Nm.</p>";
  const events = await eventsForEditorRound(readable, "<p>Torque to [not legible] Nm.</p>");
  const changed = events.find((e) => e.name === "editor_markers_changed");
  assert.ok(changed, "a round that invented a marker logged nothing");
  assert.deepEqual(changed.data.more, ["[not legible]"]);
  assert.equal(changed.data.fewer, undefined, "nothing was removed, so the line does not say so");
  assert.deepEqual(changed.data.after, { "[not legible]": 1, "[page not fully transcribed]": 0 });
});
