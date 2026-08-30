// The review loop's stopping rule, and what it costs to get it wrong.
//
// Reader -> Editor -> Reader is the loop, and the editor call is the most expensive
// thing in a run: the whole body goes in, and what comes back is every block the editor
// changed (#250). Some issues are unresolvable HERE by design and the Reader is told to
// report them anyway — an undecidable pair of same-worded headings (EDITOR_SYSTEM:
// "leave both headings exactly as they are"), a [page not fully transcribed] marker that
// only re-extraction can settle. A document whose remaining issues are those gets the
// same answer from the editor every round, so running to the cap buys a full re-read and
// another whole-body rewrite per round, to deliver the document already in hand.
//
// So the loop stops when a round changes nothing — but only when the editor ANSWERED. A
// reply that could not be parsed also leaves the body untouched, for the opposite reason,
// and the next round is a real retry. These tests hold both halves, and hold what is
// delivered: the same body, with the same issues written to @unresolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

const BODY = "<h2>Operation</h2><p>Fill the hopper.</p><h2>Operation</h2><p>Press start.</p>";

// The issue this loop is designed not to resolve: the editor is told to leave an
// undecidable heading pair alone, so it hands the document straight back.
const ISSUES = [
  {
    issue: "two [Heading 2] Operation headings, and the excerpts do not say which case it is",
    severity: "medium",
    suggested_action: "leave both headings alone unless the pages decide it",
    pages: [],
  },
];

interface Round {
  readers: number;
  editors: number;
  events: { type: string; data: Record<string, unknown> }[];
  result: Awaited<ReturnType<typeof runReview>>;
}

// Run the loop against an editor that answers with `editorReply` every time. The Reader
// answers with the same unfixable issue unless a test says otherwise — which only the
// stopping-reason tests below need, because the two exits that end a run BEFORE the editor
// is called are decided entirely by what the Reader said.
async function loop(
  editorReply: (body: string) => string,
  maxReviewIterations = 3,
  readerReply: () => string = () => JSON.stringify({ issues: ISSUES }),
): Promise<Round> {
  const dir = mkdtempSync(join(tmpdir(), "iris-converge-"));
  try {
    let readers = 0;
    let editors = 0;
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations,
      extractionConcurrency: 4,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent === "reader") {
            readers++;
            return { text: readerReply() };
          }
          editors++;
          // The document the editor was actually handed, read back out of its own prompt — the
          // numbered blocks, markers and all, so a reply about block 2 is a reply about the
          // document this round was given rather than about a constant that happens to match.
          const prompt = messages.map((m) => m.content).join("\n");
          const given = prompt.match(/## Current document \(body content, in numbered blocks\)\n([\s\S]*?)\n\n## Issues to fix/);
          assert.ok(given, "the editor prompt no longer carries the body where this test reads it");
          return { text: editorReply(given[1]) };
        },
      },
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;

    const result = await runReview(ctx, { body: BODY, lint: { ok: true, violations: [] } });
    return { readers, editors, events, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const typed = (round: Round, type: string) => round.events.filter((e) => e.type === type);

test("a round that changes nothing ends the loop", async () => {
  // The editor answers, and answers that there is nothing to change. At a cap of 3 the
  // old loop spent two more editor calls and two more full re-reads on the same request.
  const round = await loop(() => JSON.stringify({ edits: [] }));
  assert.equal(round.editors, 1, "one editor call, not three");
  assert.equal(round.readers, 1, "and no re-read of a document that did not change");

  const converged = typed(round, "review_converged");
  assert.equal(converged.length, 1);
  assert.deepEqual(converged[0].data, { iteration: 1, issues: 1, rounds_left: 2 });
});

test("an editor that answers with the whole document converges the same way", async () => {
  // The contract the editor used to be given, still read (#250): a model that hands back a
  // corrected body instead of a list of edits is answering, and a reply identical to its input
  // is the same fact about the round as an empty edits list. Pinned because the equivalence is
  // the whole reason the old shape is still accepted — a model that reverts to it under load
  // must not cost the loop its stopping rule as well.
  //
  // The reply is the body itself rather than what the prompt showed, and the difference is worth
  // naming: the numbered view puts each block on its own line, so a model that retypes what it
  // was shown returns a body that differs from the original in whitespace and is a CHANGED round
  // by every measure this loop has. That is a real cost of answering the old way and it belongs to
  // the model, not to this code — what is pinned here is that answering the old way still works.
  const round = await loop(() => JSON.stringify({ html: BODY }));
  assert.equal(round.editors, 1, "one editor call, not three");
  assert.equal(typed(round, "review_converged").length, 1);
  assert.equal(typed(round, "editor_whole_body").length, 1, "and the log says which contract it answered");
});

test("what a converged round delivers is what the cap would have delivered", async () => {
  const round = await loop(() => JSON.stringify({ edits: [] }));
  assert.equal(round.result.body, BODY, "the document is the one the editor handed back");
  assert.equal(round.result.unresolved.length, 1, "the issues it stopped on are reported");
  assert.match(round.result.html, /@unresolved/);
  assert.match(round.result.html, /two \[Heading 2\] Operation headings/);
  assert.equal(round.result.iterationsCompleted, 1, "the round that ran is counted, and no more");
});

test("an unusable reply is a retry, not a decision", async () => {
  // The body is unchanged here too, and for the opposite reason: the editor never said
  // anything. Stopping on it would turn one bad response into a skipped correction.
  const round = await loop(() => "not json at all");
  assert.equal(round.editors, 3, "every round the cap allows is still spent");
  assert.equal(typed(round, "review_converged").length, 0, "and none of them is a convergence");
  assert.equal(typed(round, "editor_no_output").length, 3, "each is recorded as a call that said nothing");
  assert.equal(round.result.body, BODY);
});

test("a round that changes something keeps the loop going", async () => {
  // The guard has to be about what changed, not about how many issues came back: the
  // Reader here keeps reporting, and the editor keeps editing, so the cap is what stops it.
  let n = 0;
  const round = await loop(() => JSON.stringify({ edits: [{ block: 0, html: `<p>edit ${n++}</p>` }] }));
  assert.equal(round.editors, 3, "the cap, not convergence, is what stopped this");
  assert.equal(typed(round, "review_converged").length, 0);
  assert.equal(round.result.iterationsCompleted, 3);
});

// Which exit the loop left by (#264). The tests above establish that the exits behave
// differently; these pin the word each one records, because from outside the loop two of
// them are the same document — issues open, nothing truncated — and they ask for opposite
// fixes. `cap` is the only one more rounds can help; `converged` means the editor was shown
// the issues and answered "no change", so the remedy is a prompt. A report that cannot tell
// them apart can only guess, which is how #264 came to lead with `max_review_iterations`
// against a mean of 0.886 rounds out of 3. The `truncated` exits are pinned where they are
// driven, in test/review-truncation.test.ts.
const CLEAN_READ = () => JSON.stringify({ issues: [] });

test("the loop records which of its exits ended the round", async () => {
  const converged = await loop(() => JSON.stringify({ edits: [] }));
  assert.equal(converged.result.stoppedAt, "converged");

  let n = 0;
  const cap = await loop(() => JSON.stringify({ edits: [{ block: 0, html: `<p>edit ${n++}</p>` }] }));
  assert.equal(cap.result.stoppedAt, "cap");

  // Both of these end before the editor is ever called, and only the Reader's answer
  // decides which: an empty issue list from a read that came back whole is `clean`, and the
  // same empty list from a read with a window it could not parse is `unread` — a document
  // nothing objected to and a document nothing finished reading.
  const clean = await loop(() => assert.fail("a clean read must not reach the editor"), 3, CLEAN_READ);
  assert.equal(clean.result.stoppedAt, "clean");
  assert.equal(clean.result.iterationsCompleted, 0);

  const unread = await loop(() => assert.fail("an unread window must not reach the editor"), 3, () => "not json at all");
  assert.equal(unread.result.stoppedAt, "unread");
  assert.equal(unread.result.unreviewedWindows, 1);
});

test("the cap and a round that changed nothing are one document with two remedies", async () => {
  // Everything else the report can see about these two runs agrees: the same body, the same
  // one issue left open, nothing truncated. `stoppedAt` is the only thing that distinguishes
  // a budget that ran out from an editor that declined.
  const converged = await loop(() => JSON.stringify({ edits: [] }));
  let n = 0;
  const cap = await loop(() => JSON.stringify({ edits: [{ block: 0, html: `<p>edit ${n++}</p>` }] }));
  for (const round of [converged, cap]) {
    assert.equal(round.result.unresolved.length, 1);
    assert.equal(round.result.editorTruncated, false);
    assert.equal(round.result.unreviewedWindows, 0);
  }
  assert.notEqual(converged.result.stoppedAt, cap.result.stoppedAt);
});

test("a run that spent every round on unusable replies reports the cap, not a convergence", async () => {
  // The body never changed, so this run looks converged from the body alone — and it is the
  // opposite: three rounds spent, none of them answered. Reporting it as `converged` would
  // attribute a broken editor to a prompt that the editor never disagreed with.
  const round = await loop(() => "not json at all");
  assert.equal(round.result.stoppedAt, "cap");
  assert.equal(round.result.iterationsCompleted, 3);
});

// The counts of an empty structure, so the two assertions below can say which of the thirteen the
// round moved and be read as the whole line at the same time.
const NO_STRUCTURE = {
  headings: 0, paragraphs: 0, lists: 0, items: 0, terms: 0, definitions: 0,
  tables: 0, captions: 0, rows: 0, header_cells: 0, cells: 0, images: 0, links: 0,
};

test("each round says whether it changed the document, and by how much", async () => {
  // The sizes and the structure counts are on the same line as `changed`, and they are the whole
  // line: nothing else about a round answered whole. Here a round replaced the body with something
  // a fifth of its size and both its headings with nothing, and it is delivered — this body holds
  // 49 characters of prose, which is under `EDITOR_FLOOR_MIN_TEXT`, and a proportion of 49
  // characters is not a measurement (#174). What the floor does above that size is pinned in
  // test/editor-round-size.test.ts; what this pins is that the numbers are reported either way.
  // Four blocks in, one replaced and three emptied — which is the patch contract's way of saying
  // what a whole-body reply of "<p>edited</p>" used to say, and it exercises the deletion path
  // while it is here.
  const changed = await loop(
    () =>
      JSON.stringify({
        edits: [
          { block: 0, html: "<p>edited</p>" },
          { block: 1, html: "" },
          { block: 2, html: "" },
          { block: 3, html: "" },
        ],
      }),
    1,
  );
  assert.deepEqual(typed(changed, "editor")[0].data, {
    iteration: 1,
    changed: true,
    chars_before: BODY.length,
    chars_after: "<p>edited</p>".length,
    text_chars_before: "Operation Fill the hopper. Operation Press start.".length,
    text_chars_after: "edited".length,
    structure_before: { ...NO_STRUCTURE, headings: 2, paragraphs: 2 },
    structure_after: { ...NO_STRUCTURE, paragraphs: 1 },
  });
  // A converged round handed the document back, so every one of these is a measurement of the body
  // it was given. Equal numbers do not say the round converged, though — a reply with nothing
  // usable in it reports the same ones, and `editor_no_output` is what tells those apart.
  const unchanged = await loop(() => JSON.stringify({ edits: [] }), 1);
  assert.deepEqual(typed(unchanged, "editor")[0].data, {
    iteration: 1,
    changed: false,
    chars_before: BODY.length,
    chars_after: BODY.length,
    text_chars_before: "Operation Fill the hopper. Operation Press start.".length,
    text_chars_after: "Operation Fill the hopper. Operation Press start.".length,
    structure_before: { ...NO_STRUCTURE, headings: 2, paragraphs: 2 },
    structure_after: { ...NO_STRUCTURE, headings: 2, paragraphs: 2 },
  });
});
