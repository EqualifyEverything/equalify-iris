import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRun } from "../src/diagnostics.ts";

// Diagnostics answers "is this run stuck, and on what?" from log.jsonl. Parallel
// page extraction means several model calls are open at once and their
// start/end events interleave, so start/end pairing must be by identity rather
// than position.

const T = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

function log(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const start = (ts: string, agent: string, model = "m", capability = "vision") =>
  ({ ts, type: "model_call_start", agent, model, capability, provider: "p" });
const end = (ts: string, agent: string, duration_ms: number, model = "m", capability = "vision") =>
  ({ ts, type: "model_call", agent, model, capability, provider: "p", duration_ms, ok: true });

const running = (now: number) => ({ sessionId: "ses_1", status: "running", phase: "extraction", now });

test("interleaved starts and ends across parallel pages leave nothing falsely open", () => {
  // Three page calls open, then all three close — out of order, as happens when
  // pages finish at different times.
  const text = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"),
    start(T(2), "page"),
    start(T(3), "page"),
    end(T(4), "page", 3000),
    end(T(5), "page", 3000),
    end(T(6), "page", 3000),
  );
  const d = summarizeRun(text, running(Date.parse(T(7))));
  assert.equal(d.in_flight, null, "all calls closed -> not hung");
  assert.equal(d.in_flight_count, 0);
  assert.equal(d.model_calls.count, 3);
});

test("in_flight reports the longest-waiting call and counts the rest", () => {
  // Two open (page at T(1) is the oldest), one already closed.
  const text = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"),
    start(T(2), "page"),
    start(T(3), "feedback"),
    end(T(4), "feedback", 1000),
  );
  const d = summarizeRun(text, running(Date.parse(T(11))));
  assert.ok(d.in_flight, "two calls still open");
  assert.equal(d.in_flight.agent, "page");
  assert.equal(d.in_flight.since, T(1), "oldest open call is reported");
  assert.equal(d.in_flight.waiting_ms, 10_000);
  assert.equal(d.in_flight_count, 2);
});

test("an end event closes a matching start, not merely the most recent one", () => {
  // The `feedback` end must not close the older `page` start.
  const text = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"),
    start(T(2), "feedback"),
    end(T(3), "feedback", 1000),
  );
  const d = summarizeRun(text, running(Date.parse(T(5))));
  assert.ok(d.in_flight);
  assert.equal(d.in_flight.agent, "page", "the page call is still the open one");
  assert.equal(d.in_flight_count, 1);
});

test("a genuinely hung parallel run surfaces the stuck call", () => {
  const text = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"),
    start(T(2), "page"),
    end(T(3), "page", 2000), // one finished; one is stuck
  );
  const d = summarizeRun(text, running(Date.parse(T(300))));
  assert.ok(d.in_flight, "one call never returned");
  assert.equal(d.in_flight_count, 1);
  assert.ok(d.in_flight.waiting_ms > 250_000, `waiting_ms=${d.in_flight.waiting_ms}`);
});

test("in_flight is null once the run is no longer running", () => {
  const text = log({ ts: T(0), type: "run_start" }, start(T(1), "page"));
  const d = summarizeRun(text, { sessionId: "ses_1", status: "failed", phase: "extraction", now: Date.parse(T(9)) });
  assert.equal(d.in_flight, null, "a finished run is not 'hung'");
  assert.equal(d.in_flight_count, 0);
});

test("token totals are summed per run and attributed per agent", () => {
  // The two attributions answer different questions and pick different culprits:
  // by_agent.total_ms says which agent is slow, by_agent.input_tokens says which is
  // expensive. A vision agent sending page images can be cheap in time and dominant
  // in cost.
  const text = log(
    { ts: T(0), type: "run_start" },
    start(T(0), "page"),
    {
      ts: T(4), type: "model_call", agent: "page", model: "m", capability: "vision", provider: "p",
      duration_ms: 4000, ok: true, input_tokens: 4200, output_tokens: 800, cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 0,
    },
    start(T(4), "copy_editor"),
    {
      ts: T(9), type: "model_call", agent: "copy_editor", model: "m", capability: "text", provider: "p",
      duration_ms: 5000, ok: true, input_tokens: 11_000, output_tokens: 6400,
    },
    { ts: T(9), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(9)) });
  assert.deepEqual(d.tokens, {
    input: 15_200,
    output: 7200,
    cache_read: 1024,
    cache_write: 0,
    calls_reported: 2,
  });
  assert.equal(d.by_agent.page.input_tokens, 4200);
  assert.equal(d.by_agent.copy_editor.output_tokens, 6400);
});

test("calls_reported shows when a token sum covers only part of a run", () => {
  // A provider that reports nothing, or an older log written before usage was
  // recorded, produces sums that look authoritative and are not. calls_reported
  // against model_calls.count is the only thing that distinguishes a complete
  // accounting from a floor.
  const text = log(
    { ts: T(0), type: "run_start" },
    end(T(2), "page", 2000),
    { ts: T(4), type: "model_call", agent: "page", model: "m", capability: "vision", provider: "p",
      duration_ms: 2000, ok: true, input_tokens: 500, output_tokens: 100 },
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(4)) });
  assert.equal(d.model_calls.count, 2);
  assert.equal(d.tokens.calls_reported, 1, "one of the two calls reported nothing");
  // The call that reported nothing contributes nothing rather than breaking the sum.
  assert.equal(d.tokens.input, 500);
  // And it is not silently credited with zero cost in its agent's totals either.
  assert.equal(d.by_agent.page.count, 2);
  assert.equal(d.by_agent.page.input_tokens, 500);
});

test("a failed call's tokens are counted, not discarded", () => {
  // A truncation paid for a full ceiling of output and a stall paid for its prompt.
  // Dropping them would under-report the bill on exactly the documents that cost the
  // most — the ones that go wrong.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(3), type: "model_call", agent: "copy_editor", model: "m", capability: "text", provider: "p",
      duration_ms: 3000, ok: false, error: "response hit the 32000-token output ceiling",
      input_tokens: 9100, output_tokens: 32_000 },
    { ts: T(3), type: "run_failed", error: "truncated" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "failed", phase: "review", now: Date.parse(T(3)) });
  assert.equal(d.model_calls.failed, 1);
  assert.equal(d.tokens.output, 32_000);
  assert.equal(d.tokens.calls_reported, 1);
});

test("concurrency_factor shows overlap: ~1 serial, ~N parallel", () => {
  // Serial: two 2s calls over 4s wall-clock -> ~1.
  const serial = log(
    { ts: T(0), type: "run_start" },
    start(T(0), "page"),
    end(T(2), "page", 2000),
    start(T(2), "page"),
    end(T(4), "page", 2000),
    { ts: T(4), type: "run_complete" },
  );
  const s = summarizeRun(serial, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(4)) });
  assert.equal(s.model_calls.concurrency_factor, 1);

  // Parallel: four 2s calls inside the same 2s window -> ~4.
  const par = log(
    { ts: T(0), type: "run_start" },
    start(T(0), "page"),
    start(T(0), "page"),
    start(T(0), "page"),
    start(T(0), "page"),
    end(T(2), "page", 2000),
    end(T(2), "page", 2000),
    end(T(2), "page", 2000),
    end(T(2), "page", 2000),
    { ts: T(2), type: "run_complete" },
  );
  const p = summarizeRun(par, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(2)) });
  assert.equal(p.model_calls.concurrency_factor, 4);
});
