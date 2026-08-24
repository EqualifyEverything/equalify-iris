// The Reader reads the assembled document a CHUNK_BUDGET window at a time, and every
// round of the review loop re-reads all of it — the whole point of the loop is that the
// Reader confirms what the editor changed. On a long document that is several full text
// calls per round, up to max_review_iterations + 1 rounds, and they used to run strictly
// one after another: a 4-chunk body spent four call latencies per round waiting, for
// calls that share nothing and cannot affect each other.
//
// This pins the two properties that make sending them together safe. They overlap (or
// the change did nothing), and the issues still come back in CHUNK order rather than in
// whichever order the calls happened to finish — the second is what downstream depends
// on: `imagesForIssues` unions the attributions and `unresolved.md` is written in this
// order, so a document's reported issue list must not depend on provider timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/pipeline/review.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// CHUNK_BUDGET is 24000 with a 2000-char overlap, so chunks start every 22000
// characters. A marker at each stride is therefore the first marker inside its own
// chunk, which is what identifies the call.
const STRIDE = 22000;

function markedBody(chunks: number): string {
  let body = "";
  for (let i = 0; i < chunks; i++) {
    const marker = `<p>MARK${i}</p>`;
    body += marker + "<p>filler</p>".repeat(Math.ceil((STRIDE - marker.length) / 13));
    body = body.slice(0, (i + 1) * STRIDE);
  }
  return body;
}

function chunkOf(prompt: string): number {
  const m = prompt.match(/MARK(\d+)/);
  return m ? Number(m[1]) : -1;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ReaderRun {
  order: number[]; // chunk index of each issue reported, in the order returned
  maxInFlight: number;
  calls: number;
}

// Run one review round against a mock router that answers each chunk with an issue
// naming that chunk, after a delay chosen so completion order is the REVERSE of chunk
// order. `maxReviewIterations: 0` stops the loop after the first read, so the issues it
// returns as `unresolved` are exactly what runReader produced.
async function readerRound(chunks: number, concurrency: number, delayFor: (chunk: number) => number): Promise<ReaderRun> {
  const dir = mkdtempSync(join(tmpdir(), "iris-review-conc-"));
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const ctx = {
      sessionId: "ses_test",
      images: [],
      maxReviewIterations: 0,
      extractionConcurrency: concurrency,
      paths: {
        agentsDir: join(dir, "agents"),
        tmpAgentsDir: () => join(dir, "tmp-agents"),
        agentMemory: () => join(dir, "memory", "page.json"),
      } as unknown as Paths,
      router: {
        complete: async (agent: string, _cap: string, messages: { content: string }[]) => {
          if (agent !== "reader") return { text: JSON.stringify({ html: "" }) };
          calls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const which = chunkOf(messages.map((m) => m.content).join("\n"));
          await sleep(delayFor(which));
          inFlight--;
          return {
            text: JSON.stringify({
              issues: [{ issue: `chunk ${which}`, severity: "low", suggested_action: "none", pages: [] }],
            }),
          };
        },
      },
      log: { event: () => {}, agentCall: () => {} },
    } as unknown as PipelineContext;

    const result = await runReview(ctx, { body: markedBody(chunks), lint: { ok: true, violations: [] } });
    return {
      order: result.unresolved.map((i) => Number(i.issue.replace("chunk ", ""))),
      maxInFlight,
      calls,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the chunks of one read are in flight together", async () => {
  const run = await readerRound(3, 4, () => 5);
  assert.equal(run.calls, 3, "the body must actually span three chunks for this to prove anything");
  assert.equal(run.maxInFlight, 3, "all three chunk calls should be open at once under a limit of 4");
});

test("issues come back in chunk order, not in the order the calls finished", async () => {
  // The earliest chunk answers slowest, so a list built from completion order would read
  // 2, 1, 0 — which is what the document's unresolved list would then say.
  const run = await readerRound(3, 4, (c) => [40, 20, 1][c] ?? 1);
  assert.deepEqual(run.order, [0, 1, 2]);
});

test("the run's concurrency knob bounds the read as it bounds extraction", async () => {
  const run = await readerRound(4, 2, () => 5);
  assert.equal(run.calls, 4);
  assert.equal(run.maxInFlight, 2, "a deployment that set 2 must not get 4 calls in flight in the review phase");
});

test("a deployment set to 1 still reads strictly serially", async () => {
  const run = await readerRound(3, 1, () => 5);
  assert.equal(run.maxInFlight, 1);
  assert.deepEqual(run.order, [0, 1, 2]);
});

test("a short document is one call, as it was", async () => {
  const run = await readerRound(1, 4, () => 1);
  assert.equal(run.calls, 1);
  assert.equal(run.maxInFlight, 1);
});
