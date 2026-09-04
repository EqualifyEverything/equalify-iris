import { test } from "node:test";
import assert from "node:assert/strict";
import { RunQueue } from "../src/util/queue.ts";
import {
  normalizeMaxConcurrentRuns,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_CONCURRENT_RUNS_CEILING,
} from "../src/config.ts";

// RunQueue bounds how many pipelines run at once ACROSS sessions. Before it,
// every upload started a pipeline immediately, so N simultaneous uploads meant N
// unthrottled runs (N jsdom+axe instances, N × extraction_concurrency model
// calls) on what may well be a laptop.
//
// The properties that actually matter here are the ones whose failure is silent:
// a task that throws must not leak its slot (the queue would wedge at capacity
// and every later session would sit in `queued` forever with nothing logged), and
// submit() must never reject (every call site is `void queue.submit(...)`, which
// attaches no rejection handler — a rejection there takes the process down).

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// A task that stays pending until released, so concurrency is observable.
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

test("never runs more than `limit` tasks at once, and does use the whole limit", async () => {
  let active = 0;
  let peak = 0;
  const q = new RunQueue(2);
  const gates = Array.from({ length: 6 }, () => gate());
  const done = gates.map((g) =>
    q.submit(async () => {
      active++;
      peak = Math.max(peak, active);
      await g.promise;
      active--;
    }),
  );
  await tick();
  assert.equal(peak, 2, `expected at most 2 concurrent, saw ${peak}`);
  assert.equal(q.stats().running, 2);
  assert.equal(q.stats().waiting, 4);
  for (const g of gates) g.release();
  await Promise.all(done);
  assert.equal(peak, 2, "peak never exceeded the limit across the whole drain");
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, limit: 2 });
});

test("queued tasks run in FIFO order", async () => {
  const started: number[] = [];
  const q = new RunQueue(1);
  const gates = Array.from({ length: 4 }, () => gate());
  const done = gates.map((g, i) =>
    q.submit(async () => {
      started.push(i);
      await g.promise;
    }),
  );
  // Release one at a time so each release admits exactly the next in line.
  for (const g of gates) {
    await tick();
    g.release();
    await tick();
  }
  await Promise.all(done);
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test("a burst submitted in one tick fills every free slot immediately", async () => {
  // Three uploads arriving in the same tick must all be running before the event
  // loop turns — admission is synchronous, so none of them waits on a timer.
  let active = 0;
  const q = new RunQueue(3);
  const g = gate();
  for (let i = 0; i < 3; i++) {
    void q.submit(async () => {
      active++;
      await g.promise;
      active--;
    });
  }
  assert.equal(q.stats().running, 3, "all three slots claimed synchronously");
  await tick();
  assert.equal(active, 3);
  g.release();
});

test("a task that rejects releases its slot instead of wedging the queue", async () => {
  // The failure this guards against is silent and permanent: a leaked slot means
  // later sessions stay `queued` with no error recorded anywhere.
  const errors: unknown[] = [];
  const q = new RunQueue(1, (e) => errors.push(e));
  await q.submit(async () => {
    throw new Error("pipeline blew up");
  });
  assert.equal(q.stats().running, 0, "slot released after a rejection");
  let ran = false;
  await q.submit(async () => {
    ran = true;
  });
  assert.ok(ran, "the next task still runs");
  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /pipeline blew up/);
});

test("a task that throws synchronously also releases its slot", async () => {
  const errors: unknown[] = [];
  const q = new RunQueue(1, (e) => errors.push(e));
  await q.submit((() => {
    throw new Error("threw before returning a promise");
  }) as () => Promise<unknown>);
  assert.equal(q.stats().running, 0);
  assert.equal(errors.length, 1);
  let ran = false;
  await q.submit(async () => {
    ran = true;
  });
  assert.ok(ran);
});

test("submit() resolves rather than rejects, so `void submit(...)` is safe", async () => {
  // Every call site is `void queue.submit(...)`. `void` attaches no rejection
  // handler, so a rejecting promise here would be an unhandled rejection — fatal
  // by default in Node.
  const q = new RunQueue(1, () => {});
  await assert.doesNotReject(() => q.submit(async () => Promise.reject(new Error("boom"))));
});

test("the task's synchronous prefix runs before submit() returns", async () => {
  // runPipeline sets `status: "running"` synchronously. If the queue deferred
  // that by even a microtask, the create response could claim a run started while
  // the store still said `queued`.
  let marked = false;
  const q = new RunQueue(1);
  void q.submit(async () => {
    marked = true;
    await tick();
  });
  assert.ok(marked, "task body entered before submit() returned");
});

test("onStart fires when the job leaves the queue, not when it is admitted", async () => {
  const startOrder: string[] = [];
  const q = new RunQueue(1);
  const g1 = gate();
  const g2 = gate();
  const first = q.submit(() => g1.promise, () => startOrder.push("first"));
  const second = q.submit(() => g2.promise, () => startOrder.push("second"));
  assert.deepEqual(startOrder, ["first"], "the queued job has not started");
  g1.release();
  await first;
  assert.deepEqual(startOrder, ["first", "second"], "second started only after a slot freed");
  g2.release();
  await second;
});

test("a throwing onStart neither loses the run nor leaks the slot", async () => {
  // onStart is observability (a run-log append). It must not be able to stop a
  // run: a full disk would otherwise silently drop every upload.
  const errors: unknown[] = [];
  const q = new RunQueue(1, (e) => errors.push(e));
  let ran = false;
  await q.submit(
    async () => {
      ran = true;
    },
    () => {
      throw new Error("log write failed");
    },
  );
  assert.ok(ran, "the run still executed");
  assert.equal(q.stats().running, 0);
  assert.equal(errors.length, 1);
});

test("a limit below 1 is refused rather than accepting work it will never run", () => {
  // A queue with limit 0 is the worst failure mode available: it would accept
  // every session and start none. normalizeMaxConcurrentRuns should prevent this
  // reaching the constructor, but the constructor does not trust it.
  assert.equal(new RunQueue(0).limit, 1);
  assert.equal(new RunQueue(-3).limit, 1);
  assert.equal(new RunQueue(NaN).limit, 1);
  assert.equal(new RunQueue(2.9).limit, 2, "floored, not rounded");
});

// normalizeMaxConcurrentRuns is what makes cfg.defaults.max_concurrent_runs safe
// to hand straight to the constructor.

test("run cap: missing or non-numeric falls back to the default", () => {
  assert.equal(normalizeMaxConcurrentRuns(undefined), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(normalizeMaxConcurrentRuns("banana"), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(normalizeMaxConcurrentRuns(NaN), DEFAULT_MAX_CONCURRENT_RUNS);
});

test("run cap: a valueless YAML key means the default, not zero", () => {
  // `max_concurrent_runs:` with nothing after it parses as null, and Number(null)
  // is 0 — which is finite. Without the explicit guard the queue would accept
  // every session and run none.
  assert.equal(normalizeMaxConcurrentRuns(null), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(normalizeMaxConcurrentRuns(""), DEFAULT_MAX_CONCURRENT_RUNS);
  assert.equal(normalizeMaxConcurrentRuns("   "), DEFAULT_MAX_CONCURRENT_RUNS);
});

test("run cap: clamped to a usable range", () => {
  assert.equal(normalizeMaxConcurrentRuns(0), 1, "0 means one run at a time, not none");
  assert.equal(normalizeMaxConcurrentRuns(-5), 1);
  assert.equal(normalizeMaxConcurrentRuns(9999), MAX_CONCURRENT_RUNS_CEILING);
  assert.equal(normalizeMaxConcurrentRuns(4), 4, "a sane value passes through");
  assert.equal(normalizeMaxConcurrentRuns(3.7), 3, "floored, not rounded");
  assert.equal(normalizeMaxConcurrentRuns("6"), 6, "numeric strings from YAML are accepted");
});
