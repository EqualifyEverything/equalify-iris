// The review loop's stopping rule, and what it costs to get it wrong.
//
// Reader -> Editor -> Reader is the loop, and the editor call is the most expensive
// thing in a run: the whole body goes in and a whole corrected body comes back, up to
// max_tokens. Some issues are unresolvable HERE by design and the Reader is told to
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
// always finds the same issue, which is the shape under test: nothing the loop can fix.
async function loop(editorReply: (body: string) => string, maxReviewIterations = 3): Promise<Round> {
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
            return { text: JSON.stringify({ issues: ISSUES }) };
          }
          editors++;
          // The body the editor was actually handed, read back out of its own prompt, so
          // an "unchanged" reply is the document this round was given rather than a
          // constant that happens to match.
          const prompt = messages.map((m) => m.content).join("\n");
          const given = prompt.match(/## Current document \(body content\)\n([\s\S]*?)\n\n## Issues to fix/);
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
  // The editor answers, and answers with the document it was given. At a cap of 3 the
  // old loop spent two more editor calls and two more full re-reads on the same request.
  const round = await loop((body) => JSON.stringify({ html: body }));
  assert.equal(round.editors, 1, "one editor call, not three");
  assert.equal(round.readers, 1, "and no re-read of a document that did not change");

  const converged = typed(round, "review_converged");
  assert.equal(converged.length, 1);
  assert.deepEqual(converged[0].data, { iteration: 1, issues: 1, rounds_left: 2 });
});

test("what a converged round delivers is what the cap would have delivered", async () => {
  const round = await loop((body) => JSON.stringify({ html: body }));
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
  const round = await loop(() => JSON.stringify({ html: `<p>edit ${n++}</p>` }));
  assert.equal(round.editors, 3, "the cap, not convergence, is what stopped this");
  assert.equal(typed(round, "review_converged").length, 0);
  assert.equal(round.result.iterationsCompleted, 3);
});

test("each round says whether it changed the document", async () => {
  const changed = await loop(() => JSON.stringify({ html: "<p>edited</p>" }), 1);
  assert.deepEqual(typed(changed, "editor")[0].data, { iteration: 1, changed: true });
  const unchanged = await loop((body) => JSON.stringify({ html: body }), 1);
  assert.deepEqual(typed(unchanged, "editor")[0].data, { iteration: 1, changed: false });
});
