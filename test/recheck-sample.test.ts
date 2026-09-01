// Issue #288: the sample behind "does a correction actually clear the complaint" was one draw
// per run, taken from whichever corrected page finished first, and it was read as a rate.
//
// Two separate defects, and this file pins them apart.
//
//   * SIZE. One slot per run, compiled in. A 100-page document supplied four verdicts, so the
//     only number Iris publishes about whether correction converges could not be read as a
//     percentage of anything — and it was: 4 draws split 2/2 was quoted as "half". On the two
//     100-page bench rounds the same instrument read 50% on one model's four draws and 25% on
//     the other's, over one corpus. The census that answered it (26% of corrected pages pass,
//     against a 2% floor for re-asking about the page as it was, n=57, p=0.000) had to be
//     replayed off persisted replies in a bench harness, because no setting could buy it here.
//     So the count is `defaults.recheck_sample_size` now, default 1, and 0 turns it off.
//
//   * SELECTION. `left`-counting handed the slot to the first corrected page to ARRIVE, and
//     pages are corrected concurrently, so that is one of the batch's opening pages: on
//     `runs-extract100-1` all 8 slots across 8 batches landed on p001, p027, p028, p051, p076
//     or p077. Accumulating draws like that over a week does not widen the population, it asks
//     about page 1 of every document. Slots now sit at thresholds spread across the batch, so
//     which page answers depends on the document's length and on which of its pages needed
//     correcting.
//
// What the tests below do NOT claim: that a threshold picks a representative page. It is a
// deterministic rule, not a random draw — deliberately, because this measurement's corpus is
// replayed off persisted replies — and the only setting with no selection left in it is a
// census. On issue #288's own 57 pages the first three positions of a batch clear 35% against
// 24.5% for the rest, which reverses at a five-page cut and is 20 draws either way, so no
// corpus available here says which direction the old rule was wrong in. It says it was not a
// sample of corrected pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recheckSampler, claimRecheck } from "../src/pipeline/correction.ts";
import { runExtraction } from "../src/pipeline/extraction.ts";
import { normalizeRecheckSampleSize, DEFAULT_RECHECK_SAMPLE_SIZE } from "../src/config.ts";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

// --- the sampler itself --------------------------------------------------------------

const orders = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

test("one slot on a 25-page run sits mid-batch, and page 1 can no longer take it", () => {
  const s = recheckSampler(orders(25), 1);
  assert.deepEqual(s.thresholds, [13]);
  // The old rule, stated as the assertion it now fails: the first corrected page took the slot
  // whatever its order was. Every page before the threshold is refused, and refusing costs
  // nothing — the page is delivered exactly as it would have been.
  for (const page of [1, 2, 5, 12]) {
    assert.equal(claimRecheck(s, page), false, `page ${page} took the slot`);
  }
  assert.equal(claimRecheck(s, 13), true);
  assert.equal(claimRecheck(s, 14), false, "the slot was already spent");
  assert.deepEqual(s.thresholds, []);
});

test("two slots sit on the quarters, and a page takes one of them rather than both", () => {
  const s = recheckSampler(orders(100), 2);
  assert.deepEqual(s.thresholds, [25, 75]);
  // A page past both unspent thresholds consumes the LOWER one, so the sample stays a page
  // count: two draws mean two pages, never one page counted twice. What makes this the right
  // choice rather than an arbitrary one is that pages arrive out of order — consuming the
  // higher would strand the lower band with nothing able to reach it.
  assert.equal(claimRecheck(s, 90), true);
  assert.deepEqual(s.thresholds, [75]);
  assert.equal(claimRecheck(s, 30), false, "page 30 is below the only threshold left");
  assert.equal(claimRecheck(s, 76), true);
  assert.deepEqual(s.thresholds, []);
});

test("a size at or above the page count is a census, and 0 is the measurement off", () => {
  const census = recheckSampler(orders(4), 4);
  assert.deepEqual(census.thresholds, [1, 2, 3, 4]);
  for (const page of [1, 2, 3, 4]) assert.equal(claimRecheck(census, page), true);
  assert.equal(claimRecheck(census, 4), false);

  // Above the count is the same thing and not an error: an operator who wants every corrected
  // page measured should not have to know how long the document is.
  assert.deepEqual(recheckSampler(orders(4), 9999).thresholds, [1, 2, 3, 4]);

  const off = recheckSampler(orders(25), 0);
  assert.deepEqual(off.thresholds, []);
  for (const page of [1, 13, 25]) assert.equal(claimRecheck(off, page), false);
});

test("a feedback round's thresholds are spread over the pages it re-extracts, not over a count", () => {
  // Pages 7, 12 and 20 of a longer document, which is what a feedback round runs. Three pages,
  // so a threshold expressed as a fraction of the COUNT would be page 2 — below all of them,
  // which hands the slot back to whichever arrived first and reinstates the defect. Spread over
  // the orders themselves, the middle one answers.
  const s = recheckSampler([7, 12, 20], 1);
  assert.deepEqual(s.thresholds, [12]);
  assert.equal(claimRecheck(s, 7), false);
  assert.equal(claimRecheck(s, 12), true);
});

test("thresholds are strictly increasing and exactly k, for every batch size and every sample size", () => {
  // The claim `recheckSampler` makes instead of de-duplicating. Consecutive band midpoints are
  // n/k pages apart and k <= n, so no two can round onto the same page — which matters because
  // two thresholds on one page would let that page report two draws from one measurement. A
  // property this cheap to check exhaustively should not be an argument in a comment.
  for (let n = 1; n <= 200; n += 1) {
    const batch = orders(n);
    for (let k = 0; k <= n; k += 1) {
      const { thresholds } = recheckSampler(batch, k);
      assert.equal(thresholds.length, k, `n=${n} k=${k}`);
      for (let i = 1; i < thresholds.length; i += 1) {
        assert.ok(thresholds[i] > thresholds[i - 1], `n=${n} k=${k} ${thresholds.join(",")}`);
      }
      assert.ok(thresholds.every((t) => t >= 1 && t <= n), `n=${n} k=${k}`);
    }
  }
});

test("a page count the sampler cannot use leaves it with nothing rather than sampling everything", () => {
  // `recheck_sample_size` is normalized by loadConfig, so these are the shapes a hand-built
  // context can still produce. The failure to avoid is the opposite of the usual one: a garbled
  // size that read as "unbounded" would put a Feedback Agent call on every corrected page of a
  // production run, so an unusable number resolves to no measurement, not to a census.
  assert.deepEqual(recheckSampler(orders(10), Number.NaN).thresholds, []);
  assert.deepEqual(recheckSampler(orders(10), -3).thresholds, []);
  assert.deepEqual(recheckSampler(orders(10), 0.5).thresholds, []);
  assert.deepEqual(recheckSampler([], 1).thresholds, []);
});

// --- the config knob ----------------------------------------------------------------

test("recheck_sample_size: absent is the default, 0 is honoured, garbage is the default", () => {
  assert.equal(DEFAULT_RECHECK_SAMPLE_SIZE, 1);
  // The trap every normalizer in config.ts guards: YAML parses a valueless key as null, and
  // Number(null) is 0 — which for THIS knob is a legal value, so obeying it would turn a typo
  // into a deployment that silently stopped collecting the number.
  assert.equal(normalizeRecheckSampleSize(null), 1);
  assert.equal(normalizeRecheckSampleSize(undefined), 1);
  assert.equal(normalizeRecheckSampleSize(""), 1);
  assert.equal(normalizeRecheckSampleSize("  "), 1);
  assert.equal(normalizeRecheckSampleSize("not a number"), 1);
  // 0 is off, and a deliberate 0 must survive normalization — this is the one knob in
  // `defaults` where zero is a setting rather than an accident.
  assert.equal(normalizeRecheckSampleSize(0), 0);
  assert.equal(normalizeRecheckSampleSize("0"), 0);
  assert.equal(normalizeRecheckSampleSize(-4), 0, "a negative is off, the nearest thing meant");
  // No upper clamp: the run bounds the cost at one call per corrected page, so a large number
  // is a census and not a runaway.
  assert.equal(normalizeRecheckSampleSize(9999), 9999);
  assert.equal(normalizeRecheckSampleSize(2.7), 2);
});

// --- through the pipeline -----------------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

// A run of `pages` pages where the pages in `fails` come back with a fidelity problem and are
// corrected into something different, so each of them reaches the sampled re-check. Serial
// (`extractionConcurrency: 1`) so that which page claims a slot is decided by page order and
// not by which model call happened to return first — the concurrency this measurement lives
// under is the reason the old rule always picked the front of the batch.
function makeCtx(dir: string, events: Event[], pages: number, fails: number[], size: number): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = Array.from({ length: pages }, (_, i) => `page-${String(i + 1).padStart(3, "0")}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  const orderOf = (user: string): number => names.findIndex((n) => user.includes(n)) + 1;
  const verifies = new Map<number, number>();

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name), links: [] })),
    extractionConcurrency: 1,
    recheckSampleSize: size,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (_agent: string, _cap: string, messages: { role: string; content: string }[]) => {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const order = orderOf(user);
        if (user.includes("TASK: verify")) {
          const n = (verifies.get(order) ?? 0) + 1;
          verifies.set(order, n);
          // First check fails for the chosen pages; the re-check of a corrected page passes, so
          // a sample that was taken is visible as `ok: true` rather than only as an event.
          const problems = n === 1 && fails.includes(order) ? ["the table has no header row"] : [];
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (user.includes("had fidelity/accessibility problems")) {
          return { text: JSON.stringify({ html: `<h2>Page ${order}</h2><table><tr><th>A</th></tr></table>` }) };
        }
        return { text: JSON.stringify({ html: `<h2>Page ${order}</h2><table><tr><td>A</td></tr></table>`, log: "" }) };
      },
    },
    log: {
      event: (type: string, fields: Record<string, unknown>) => events.push({ type, ...fields }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "iris-recheck-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const of = (events: Event[], type: string): Event[] => events.filter((e) => e.type === type);

test("the front page of a run no longer takes the slot: a later corrected page answers instead", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // Four pages, two of them corrected: page 1 and page 3. One slot, whose threshold is page 2
    // — so under the old rule page 1 answered, and under this one page 3 does. Both are
    // corrections and both are delivered; the only thing that changed is which one was measured.
    await runExtraction(makeCtx(dir, events, 4, [1, 3], 1));

    assert.equal(of(events, "page_corrected").length, 2, "two pages were corrected");
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 1, "one slot, so one measurement");
    assert.equal(rechecks[0].page, 3, "the slot went to a page past the threshold, not to page 1");
    assert.equal(rechecks[0].binding, false, "a sample still decides nothing");
    assert.equal(rechecks[0].ok, true);

    // And the run says what it was going to measure and where, so a log with one recheck in it
    // is not confusable with a log whose sample was never available.
    const [start] = of(events, "extraction_start");
    assert.equal(start.recheck_sample_size, 1);
    assert.deepEqual(start.recheck_thresholds, [2]);
  });
});

test("a run whose corrections all fall short of the threshold takes no sample, and says so", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The accepted cost of spreading the thresholds, asserted rather than left implicit: the old
    // rule always spent its slot, on the page it always spent it on. What makes the zero readable
    // is the pair on `extraction_start` — measurement off, no page corrected, and a sample that
    // went unspent are three different runs, and only the last one leaves a threshold behind.
    await runExtraction(makeCtx(dir, events, 4, [1], 1));

    assert.equal(of(events, "page_corrected").length, 1);
    assert.equal(of(events, "page_correction_recheck").length, 0);
    const [start] = of(events, "extraction_start");
    assert.equal(start.recheck_sample_size, 1);
    assert.deepEqual(start.recheck_thresholds, [2]);
  });
});

test("a census measures every corrected page, and 0 measures none", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The setting that answers #288's question from the product instead of from a bench replay:
    // every corrected page re-verified, so `sampled_ok / sampled` is a rate over corrected pages
    // with no selection in it. It costs a Feedback Agent call per correction, which is why it is
    // not the default.
    await runExtraction(makeCtx(dir, events, 4, [1, 2, 3, 4], 4));
    const rechecks = of(events, "page_correction_recheck");
    assert.deepEqual(
      rechecks.map((r) => r.page),
      [1, 2, 3, 4],
    );
    assert.ok(rechecks.every((r) => r.binding === false));
    const [start] = of(events, "extraction_start");
    assert.deepEqual(start.recheck_thresholds, [1, 2, 3, 4]);
  });
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(makeCtx(dir, events, 4, [1, 2, 3, 4], 0));
    assert.equal(of(events, "page_corrected").length, 4, "the corrections still happen");
    assert.equal(of(events, "page_correction_recheck").length, 0, "nothing was measured");
    const [start] = of(events, "extraction_start");
    assert.equal(start.recheck_sample_size, 0);
    assert.deepEqual(start.recheck_thresholds, []);
  });
});

test("two slots on an eight-page run land in different halves of it", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    await runExtraction(makeCtx(dir, events, 8, [1, 2, 3, 4, 5, 6, 7, 8], 2));
    const [start] = of(events, "extraction_start");
    assert.deepEqual(start.recheck_thresholds, [2, 6]);
    const rechecks = of(events, "page_correction_recheck");
    // Not "the first two corrected pages", which is what a bare count of slots gives and what
    // page 1 and page 2 would be here.
    assert.deepEqual(
      rechecks.map((r) => r.page),
      [2, 6],
    );
  });
});
