import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../src/util/concurrency.ts";
import { normalizeConcurrency, DEFAULT_EXTRACTION_CONCURRENCY, MAX_EXTRACTION_CONCURRENCY } from "../src/config.ts";

// mapWithConcurrency backs parallel page extraction. The two properties that
// matter there: results stay in INPUT order (document order — pages must not be
// reordered by completion time), and no more than `limit` calls run at once.

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("results are returned in input order, not completion order", async () => {
  const items = [1, 2, 3, 4, 5];
  // Deliberately finish in reverse: item 1 waits the longest.
  const out = await mapWithConcurrency(items, 5, async (n) => {
    for (let i = 0; i < (6 - n) * 3; i++) await tick();
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
});

test("never exceeds the concurrency limit, and does use it", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    active++;
    peak = Math.max(peak, active);
    for (let i = 0; i < 3; i++) await tick();
    active--;
    return null;
  });
  assert.equal(peak, 4, `expected peak concurrency 4, got ${peak}`);
  assert.equal(active, 0, "all work settled");
});

test("a limit of 1 runs strictly serially", async () => {
  const order: number[] = [];
  await mapWithConcurrency([1, 2, 3], 1, async (n) => {
    order.push(n);
    for (let i = 0; i < (4 - n) * 2; i++) await tick();
    order.push(-n); // completion marker
    return n;
  });
  // Serial => each page starts only after the previous one finished.
  assert.deepEqual(order, [1, -1, 2, -2, 3, -3]);
});

test("a rejecting item rejects the whole map (matching a serial loop)", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("page 2 failed");
      return n;
    }),
    /page 2 failed/,
  );
});

test("an empty input list does no work", async () => {
  let calls = 0;
  const out = await mapWithConcurrency([], 5, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("a limit above the item count does not over-spawn workers", async () => {
  let peak = 0;
  let active = 0;
  await mapWithConcurrency([1, 2], 16, async () => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    return null;
  });
  assert.equal(peak, 2, "at most one worker per item");
});

// normalizeConcurrency is what makes ctx.extractionConcurrency safe to use
// without a fallback at the call site.

test("extraction concurrency: missing or non-numeric falls back to the default", () => {
  assert.equal(normalizeConcurrency(undefined), DEFAULT_EXTRACTION_CONCURRENCY);
  assert.equal(normalizeConcurrency("banana"), DEFAULT_EXTRACTION_CONCURRENCY);
  assert.equal(normalizeConcurrency(NaN), DEFAULT_EXTRACTION_CONCURRENCY);
});

test("extraction concurrency: a valueless YAML key means default, not serial", () => {
  // `extraction_concurrency:` with nothing after it parses as null. Number(null)
  // is 0, which is finite — so without an explicit guard this would clamp to 1
  // and silently turn parallel extraction off.
  assert.equal(normalizeConcurrency(null), DEFAULT_EXTRACTION_CONCURRENCY);
  assert.equal(normalizeConcurrency(""), DEFAULT_EXTRACTION_CONCURRENCY);
  assert.equal(normalizeConcurrency("   "), DEFAULT_EXTRACTION_CONCURRENCY);
});

test("extraction concurrency: clamped to a usable range", () => {
  assert.equal(normalizeConcurrency(0), 1, "0 means don't parallelize");
  assert.equal(normalizeConcurrency(-5), 1);
  assert.equal(normalizeConcurrency(1000), MAX_EXTRACTION_CONCURRENCY);
  assert.equal(normalizeConcurrency(4), 4, "a sane value passes through");
  assert.equal(normalizeConcurrency(3.7), 3, "floored, not rounded");
  assert.equal(normalizeConcurrency("6"), 6, "numeric strings from YAML are accepted");
});
