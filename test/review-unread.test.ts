// Issue #186: what the review loop concludes when the reviewer's reply cannot be used.
//
// The demo page published "8% of documents finished with the reviewer finding nothing left to
// fix, averaging 0.9 editor passes" and its own maintainer did not believe it. The two numbers
// agree with each other — 8% at zero rounds and 92% at one gives 0.92 — so nothing was being
// mis-derived; what was in question was what "clean" counted. It counted the ABSENCE of an
// `iris:unresolved` signal, and that signal is written only when the reviewer left issues open.
//
// So every way of leaving `unresolved` empty other than the reviewer having looked and found
// nothing landed in the clean share. One of them is a reply this code cannot read: `extractJson`
// returns nothing usable, `parsed?.issues ?? []` becomes `[]`, and an empty issue list is the
// one thing that ends the loop clean. Measured before the fix, on the loop below: a Reader
// answering "I could not review this document." delivered a document with 0 rounds, no
// `@unresolved` comment and no signal — indistinguishable in the store from a flawless one.
//
// Two shapes of the same reply were worse than that. `{"issues": "none"}` and `{"issues":
// [null]}` threw a TypeError out of `runReview` into the orchestrator's outer catch: extraction
// and assembly paid for, the document sitting in a local variable, and the user handed a failed
// session because a model wrote a string where an array goes. Both are pinned here.
//
// What replaces the clean verdict is deliberately not an invented issue. There is nothing for an
// editor to fix and nothing honest to put in `@unresolved`, so the document is delivered with
// `@review-unread` saying which part of it has no verdict, and the run records
// `unreviewedWindows` so the deployment's clean rate stops counting it (src/store/db.ts,
// SIGNAL_REVIEW_UNREAD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

const BODY = "<h2>Operation</h2><p>Fill the hopper.</p>";

// Long enough to be read in two windows (CHUNK_BUDGET is 24000 characters), so a test can be
// about ONE window failing while the other answers — which is the case the count exists for and
// the one a single-window test cannot show.
const TWO_WINDOWS = "<h2>A</h2>" + "<p>filler filler filler</p>".repeat(1400);

const ISSUE = { issue: "the table has no header row", severity: "medium", suggested_action: "add <th>", pages: [] };

interface Round {
  readers: number;
  editors: number;
  events: { type: string; data: Record<string, unknown> }[];
  result: Awaited<ReturnType<typeof runReview>>;
}

// The loop against a Reader that answers `readerReply(n)` on its n-th call, and an editor that
// always edits. `maxReviewIterations` is 2 so a round that should not happen is visible as one
// that did.
async function loop(readerReply: (n: number) => string, body = BODY, maxReviewIterations = 2): Promise<Round> {
  const dir = mkdtempSync(join(tmpdir(), "iris-unread-"));
  try {
    let readers = 0;
    let editors = 0;
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations,
      extractionConcurrency: 4,
      recheckSampleSize: 1,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string) => {
          if (agent === "reader") return { text: readerReply(readers++) };
          editors++;
          return { text: JSON.stringify({ html: "<p>edited</p>" }) };
        },
      },
      log: {
        event: (type: string, data: Record<string, unknown> = {}) => events.push({ type, data }),
        agentCall: () => {},
      },
    } as unknown as PipelineContext;
    const result = await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return { readers, editors, events, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const typed = (round: Round, type: string) => round.events.filter((e) => e.type === type);

// Every shape of "the reviewer said nothing this code can read". The first three are what a
// model actually does when it declines, apologises or answers in prose; the last two are the
// ones that used to throw.
const UNUSABLE: [string, string][] = [
  ["prose instead of JSON", "I could not review this document."],
  ["no issues key at all", JSON.stringify({ notes: "looks fine to me" })],
  ["an empty response", ""],
  ["issues as a string", JSON.stringify({ issues: "none" })],
  ["issues as a list of nulls", JSON.stringify({ issues: [null, null] })],
  ["issues as a list of strings", JSON.stringify({ issues: ["the table has no header row"] })],
];

test("a reply the reviewer's own code cannot read is not a clean document", async () => {
  for (const [what, reply] of UNUSABLE) {
    const round = await loop(() => reply);
    assert.equal(round.result.unresolved.length, 0, `${what}: there is nothing honest to report`);
    assert.equal(round.result.unreviewedWindows, 1, `${what}: and the document says so instead`);
    assert.equal(round.editors, 0, `${what}: no editor round, because there is nothing to fix`);
    // The whole point of the field: the store's clean count keys off `unresolved` being empty,
    // so an empty one that is silence has to be distinguishable here or nowhere.
    assert.match(round.result.html, /@review-unread 1 of 1/, `${what}: the delivered document discloses it`);
    // The comment opener, not the bare word: `@review-unread`'s own text says what an empty
    // `@unresolved` list means, so a substring match here would pass on that sentence.
    assert.doesNotMatch(round.result.html, /<!-- @unresolved/, `${what}: and does not invent an issue to carry it`);
  }
});

test("an unreadable reply is recorded as a call that said nothing", async () => {
  for (const [what, reply] of UNUSABLE) {
    const round = await loop(() => reply);
    // One line per window with no verdict, however the reply failed — a reply with no list at
    // all and a list with nothing readable in it are both windows nobody got an answer about,
    // and `reason` is where the difference between them lives.
    const said = typed(round, "reader_no_output");
    assert.equal(said.length, 1, `${what}: an operator can find this in the run log`);
    assert.equal(said[0].data.window, 1, `${what}: which window it was`);
    assert.equal(said[0].data.of, 1);
    assert.match(String(said[0].data.reason), /^(no_issue_list|no_readable_issue)$/, `${what}: with a reason`);
    // And the round's own line carries it, so a run log reads the same way as the document.
    assert.deepEqual(typed(round, "reader")[0].data, { iteration: 0, issues: 0, unread: 1, windows: 1 });
  }
});

test("a malformed entry in the issue list is dropped, not fatal", async () => {
  // Half a usable answer is worth its usable half — the same rule the rest of the loop runs on.
  // The readable issue survives, the editor is called with it, and the window counts as read.
  const round = await loop(() => JSON.stringify({ issues: [null, ISSUE, "a string"] }));
  assert.equal(round.result.unresolved.length, 1, "the one readable issue is the one that was read");
  assert.equal(round.result.unresolved[0].issue, ISSUE.issue);
  assert.equal(round.result.unreviewedWindows, 0, "a window that answered is a window that answered");
  assert.ok(round.editors >= 1, "and the issue reached the editor");
  const dropped = typed(round, "reader_issues_dropped");
  assert.equal(dropped[0].data.dropped, 2);
  assert.equal(dropped[0].data.of_entries, 3);
});

test("an ordinary clean document is still clean, and says nothing extra", async () => {
  const round = await loop(() => JSON.stringify({ issues: [] }));
  assert.equal(round.result.unreviewedWindows, 0);
  assert.equal(round.result.iterationsCompleted, 0, "the loop still stops on the first look");
  assert.equal(round.editors, 0);
  assert.doesNotMatch(round.result.html, /@review-unread/, "a clean document carries no disclosure");
  assert.equal(typed(round, "reader_no_output").length, 0);
  // The `reader` line is the one it always was — no field appears on a round with nothing to say.
  assert.deepEqual(typed(round, "reader")[0].data, { iteration: 0, issues: 0 });
});

test("one unreadable window does not make a whole document read clean", async () => {
  // The case the count is for. The first window answers "nothing wrong"; the second says
  // nothing at all. Together that used to be a clean document, and half of it had no verdict.
  const round = await loop((n) => (n === 0 ? JSON.stringify({ issues: [] }) : "sorry, I cannot"), TWO_WINDOWS);
  assert.equal(round.readers, 2, "precondition: this body is read in two windows");
  assert.equal(round.result.unresolved.length, 0);
  assert.equal(round.result.unreviewedWindows, 1);
  assert.equal(round.editors, 0, "there is still nothing to fix");
  assert.match(round.result.html, /@review-unread 1 of 2/, "and the document says how much of it");
  assert.match(round.result.html, /nothing was FOUND, not that/, "which is what an empty issue list means here");
});

test("an unreadable window is reported beside the issues the other windows found", async () => {
  // Not clean either way — this document has issues — but the list is short by whatever the
  // unread window held, and a reader of `@unresolved` has no other way to know that. At a cap
  // of 0 there is one read and no correction round, which is what keeps this test about the two
  // windows of THIS body rather than about whatever the editor would have replaced it with.
  const round = await loop(
    (n) => (n === 0 ? JSON.stringify({ issues: [ISSUE] }) : "I cannot answer that"),
    TWO_WINDOWS,
    0,
  );
  assert.ok(round.result.unresolved.length >= 1, "the issues that were found are reported");
  assert.equal(round.result.unreviewedWindows, 1, "and so is the window that found nothing");
  assert.match(round.result.html, /@unresolved/);
  assert.match(round.result.html, /@review-unread 1 of/);
});

test("a later round that reads the whole document clears an earlier round's silence", async () => {
  // `unreviewedWindows` is the LAST read's answer, not a tally over the loop: what ships is one
  // reading of a body the editor has since rewritten, and an earlier round's unreadable window
  // says nothing about it. First read: an issue plus an unreadable window. The editor rewrites
  // the body to something short, and the second read answers in full.
  const round = await loop(
    (n) => (n === 1 ? "not json" : JSON.stringify({ issues: n === 0 ? [ISSUE] : [] })),
    TWO_WINDOWS,
  );
  assert.equal(round.editors, 1, "precondition: one correction round ran");
  assert.equal(round.result.unresolved.length, 0, "the second read found nothing");
  assert.equal(round.result.unreviewedWindows, 0, "and it found nothing having read all of it");
  assert.doesNotMatch(round.result.html, /@review-unread/, "so the delivered document is a clean one");
});
