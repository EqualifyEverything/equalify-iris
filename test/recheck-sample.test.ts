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
  // A page past both unspent thresholds consumes ONE of them, so the sample stays a page
  // count: two draws mean two pages, never one page counted twice.
  assert.equal(claimRecheck(s, 90), true);
  // And it consumes the HIGHER one, which is what makes out-of-order arrival survivable:
  // page 30 can only ever fill the band at 25, while page 90 could have filled either, so
  // spending 25 on page 90 would have cost this run a draw it goes on to take.
  assert.deepEqual(s.thresholds, [25]);
  assert.equal(claimRecheck(s, 30), true);
  assert.deepEqual(s.thresholds, []);
  assert.equal(claimRecheck(s, 99), false, "both slots are spent");
});

test("corrections arriving back to front still fill every band: a census stays a census", () => {
  // The failure this rule is chosen against, and it is not a corner: corrections run
  // concurrently up to `extraction_concurrency` (default 5), so the order they come back in
  // is the order the model answered, not page order. Under "consume the lowest", page 3
  // would take the band at 1 and page 2 the band at 2, and page 1 would be refused — two
  // draws from a setting documented as re-verifying every corrected page, with nothing in
  // the log to say the census came up short.
  const s = recheckSampler(orders(3), 3);
  assert.deepEqual(s.thresholds, [1, 2, 3]);
  for (const page of [3, 2, 1]) {
    assert.equal(claimRecheck(s, page), true, `page ${page} was refused its own band`);
  }
  assert.deepEqual(s.thresholds, []);

  // Same thing below a census, where the loss would be a silently smaller sample rather
  // than a broken promise: two slots on 3 pages, the late page arriving first.
  const t = recheckSampler(orders(3), 2);
  assert.deepEqual(t.thresholds, [1, 2]);
  assert.equal(claimRecheck(t, 3), true);
  assert.equal(claimRecheck(t, 1), true, "the band page 1 is the only candidate for is still there");
  assert.deepEqual(t.thresholds, []);
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
  // A belt, not the rule a deployment gets: `loadConfig` runs first on every production path and
  // resolves an unreadable value to the default (`normalizeRecheckSampleSize`, asserted above), so
  // these are the shapes only a hand-built `PipelineContext` still reaches — this file's own
  // harness, and `src/tools/calibrate.ts` if it ever stopped reading config. The two directions
  // are deliberate and not a disagreement: config asks what the operator meant, where a typo means
  // they did not set it, and the sampler asks what to do with a number it cannot use, where the
  // one reading that must never happen is "unbounded" — that would put a Feedback Agent call on
  // every corrected page of a production run.
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
  // This is a count of pages, so a fraction below one is none — the one input here that looks
  // like it asks for a little measuring and turns it off. Documented in config.example.yaml
  // rather than special-cased: every count in `defaults` floors, and a rule that floored 2.7 to
  // 2 while raising 0.5 to 1 would be a third behaviour to know about rather than one fewer.
  assert.equal(normalizeRecheckSampleSize(0.5), 0);
});

// --- through the pipeline -----------------------------------------------------------

interface Event {
  type: string;
  [k: string]: unknown;
}

// A run of `pages` pages where the pages in `fails` come back with a fidelity problem and are
// corrected into something different, so each of them reaches the sampled re-check. Serial by
// default (`extractionConcurrency: 1`), so that which page claims a slot is decided by page
// order and not by which model call happened to return first.
//
// `opts.backToFront` is the other half of that, and the one a real deployment runs: pages are
// corrected concurrently, so it makes each correction call slower the earlier its page is and
// the corrections therefore land in reverse page order. The concurrency this measurement lives
// under is the reason the old rule always picked the front of the batch, so a harness that only
// ever ran serially could not have caught a sampler that lost draws to arrival order.
function makeCtx(
  dir: string,
  events: Event[],
  pages: number,
  fails: number[],
  size: number,
  opts: { backToFront?: boolean } = {},
): PipelineContext {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  const names = Array.from({ length: pages }, (_, i) => `page-${String(i + 1).padStart(3, "0")}.png`);
  for (const n of names) writeFileSync(join(inputDir, n), "not-a-real-png");
  // Which page a prompt is about. The extract and verify prompts name the image file, but a
  // CORRECTION is handed the previous fragment and the image bytes and never the file's name, so
  // that page is read back out of the heading the first pass wrote. Worth being exact about,
  // because a helper that answered 0 for every correction would make every correction identical
  // and quietly defeat any test that depends on which page's correction is which.
  const orderOf = (user: string): number => {
    const byName = names.findIndex((n) => user.includes(n)) + 1;
    if (byName > 0) return byName;
    const inHtml = /<h2>Page (\d+)<\/h2>/.exec(user);
    return inHtml ? Number(inHtml[1]) : 0;
  };
  const verifies = new Map<number, number>();

  return {
    sessionId: "ses_test",
    images: names.map((name, i) => ({ name, order: i + 1, path: join(inputDir, name), links: [] })),
    extractionConcurrency: opts.backToFront ? pages : 1,
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
          if (opts.backToFront) {
            // The earlier the page, the slower its correction, so the LAST page's claim is the
            // first one the sampler sees.
            await new Promise((r) => setTimeout(r, (pages - order + 1) * 50));
          }
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

test("a census holds when the corrections come back in reverse page order", async () => {
  await withTemp(async (dir) => {
    const events: Event[] = [];
    // The same census, run the way a deployment runs it: four pages corrected concurrently,
    // landing back to front. Nothing about the setting changes, so the assertion is the same
    // one — every corrected page measured — and it is a different code path only because the
    // claims arrive as 4, 3, 2, 1. A sampler that spent its lowest band on the first claim
    // would report three draws here and call itself a census.
    await runExtraction(makeCtx(dir, events, 4, [1, 2, 3, 4], 4, { backToFront: true }));
    const rechecks = of(events, "page_correction_recheck");
    assert.equal(rechecks.length, 4, "a census must measure every corrected page");
    assert.deepEqual(
      rechecks.map((r) => r.page).sort((a, b) => Number(a) - Number(b)),
      [1, 2, 3, 4],
    );
    // And the arrival order really was reversed, so this test would still be testing something
    // if the delays stopped working. The two ENDS only, not the whole permutation: the ordering
    // comes from timers 50 ms apart with a mock call and an event write between each firing and
    // its event, so on a loaded runner two adjacent pages can swap with nothing wrong — and that
    // would fail a test whose regression is carried by the order-independent count above. Page 4
    // before page 1 is 150 ms of spacing and is the whole of what this guard needs to say.
    const order = of(events, "page_corrected").map((e) => e.page);
    assert.ok(
      order.indexOf(4) < order.indexOf(1),
      `the corrections did not arrive back to front (${order.join(", ")})`,
    );
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
