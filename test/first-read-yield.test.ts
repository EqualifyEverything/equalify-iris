// Issue #313: what the Reader FOUND, which nothing this pipeline returned could say.
//
// Every quality number a deployment publishes is taken after the editor has run. `unresolved` is
// what survived correction, `unresolved_severity` rates the survivors, `review_stopped` says why
// the loop let go. So the two facts that matter most to a Reader swap arrive identically: an
// editor that fixed everything and a Reader that found nothing both deliver a document with an
// empty `@unresolved` and a `clean` exit.
//
// That is not a hypothetical. The model-selection sprint's Reader recommendation is a priced
// trade — a cheaper model at 78% of the incumbent's own agreement floor, i.e. roughly one issue in
// five that would have been raised is not raised — and applying it makes `unresolved_rate` FALL,
// because a document with nothing found ships with nothing open. A tally in which a known quality
// loss reads as an improvement is worse than no tally.
//
// `ReviewResult.firstRead` is the fix, and the FIRST read specifically: every later round reads a
// body the editor has already rewritten, so a sum over rounds measures how many rounds ran as much
// as what the Reader found. The store half is in test/quality.test.ts
// (SIGNAL_FIRST_READ_ISSUES / SIGNAL_FIRST_READ_UNREAD); this file is the producer, because a
// signal recorded from a number the loop computes wrongly is a report that prints at 0%.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

const BODY = "<h2>Operation</h2><p>Fill the hopper.</p>";
// Two windows at CHUNK_BUDGET's 24,000 characters, so one window can fail while the other
// answers — the only shape that can show `unread` being about windows rather than rounds.
const TWO_WINDOWS = "<h2>A</h2>" + "<p>filler filler filler</p>".repeat(1400);

const issue = (n: number) => ({
  issue: `finding ${n}`,
  severity: "medium",
  suggested_action: "fix it",
  pages: [],
});
const found = (n: number) => JSON.stringify({ issues: Array.from({ length: n }, (_, i) => issue(i)) });

async function loop(
  readerReply: (n: number) => string,
  body = BODY,
  maxReviewIterations = 2,
): Promise<{ readers: number; editors: number; result: Awaited<ReturnType<typeof runReview>> }> {
  const dir = mkdtempSync(join(tmpdir(), "iris-first-read-"));
  try {
    let readers = 0;
    let editors = 0;
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
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;
    const result = await runReview(ctx, { body, lint: { ok: true, violations: [] } });
    return { readers, editors, result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a document the editor fixed and one the Reader never faulted are one unresolved list and two yields", () => {
  // The whole reason the field exists, as one assertion pair. Both of these deliver an empty
  // `unresolved` and stop `clean`; one of them had three problems and got them fixed.
  return Promise.all([
    loop((n) => found(n === 0 ? 3 : 0)),
    loop(() => found(0)),
  ]).then(([fixed, quiet]) => {
    assert.deepEqual(fixed.result.unresolved, [], "precondition: nothing shipped open");
    assert.deepEqual(quiet.result.unresolved, [], "precondition: nor here");
    assert.equal(fixed.result.stoppedAt, "clean");
    assert.equal(quiet.result.stoppedAt, "clean");
    // Everything downstream of the editor agrees these two runs went the same way.
    assert.equal(fixed.result.firstRead?.issues, 3, "and the first read is where they differ");
    assert.equal(quiet.result.firstRead?.issues, 0);
    assert.ok(fixed.editors >= 1, "precondition: the fixed document was corrected");
    assert.equal(quiet.editors, 0);
  });
});

test("the first read is the first one, not whichever read ended the loop", () => {
  // The mistake this is the pin against: reading the count off `lastIssues`, or off the round the
  // loop happened to stop on. Round 0 finds two, round 1 finds none and ends the loop, so a
  // last-read implementation reports 0 for a document the Reader found two problems in — which is
  // exactly the reading the field is meant to prevent, arriving from the other direction.
  return loop((n) => found(n === 0 ? 2 : 0)).then((round) => {
    assert.equal(round.readers, 2, "precondition: the loop read twice");
    assert.equal(round.result.unresolved.length, 0);
    assert.equal(round.result.firstRead?.issues, 2);
  });
});

test("a first read that could not answer part of the document says so, and keeps saying it", () => {
  // `unreviewedWindows` is the LAST read's answer, because what ships is one reading of the body
  // that shipped. `firstRead.unread` is the first read's, because it is the error bar on the first
  // read's count — the two are different questions and this document answers them differently.
  // Round 0: one window finds an issue, the other is unreadable. The editor rewrites the body to
  // something short, and round 1 reads all of it and finds nothing.
  return loop((n) => (n === 1 ? "I cannot answer that" : found(n === 0 ? 1 : 0)), TWO_WINDOWS).then((round) => {
    assert.equal(round.editors, 1, "precondition: one correction round ran");
    assert.equal(round.result.unreviewedWindows, 0, "the delivered document was fully judged");
    assert.equal(round.result.firstRead?.unread, 1, "and the first read's count is still a floor");
    assert.equal(round.result.firstRead?.issues, 1);
  });
});

test("a whole read reports no unread windows rather than omitting the number", () => {
  // Zero and absent have to be different here for the same reason they do in the store: an absent
  // measurement must not be read as a good one. A document read in full carries the 0.
  return loop(() => found(1), TWO_WINDOWS, 0).then((round) => {
    assert.equal(round.readers, 2, "precondition: two windows");
    assert.deepEqual(round.result.firstRead, { issues: 2, unread: 0 }, "both windows found their issue");
  });
});
