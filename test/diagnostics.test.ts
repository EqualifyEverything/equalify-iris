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
  // And specifically not when the log has an open call and no terminal line, which is
  // what a run killed mid-flight leaves behind: `failStaleSessions` rewrites the status
  // of a process that can no longer append to its own log, so "no run_failed" must not
  // be read as "still working".
});

test("a call still open after the document was delivered is still in flight", () => {
  // A feedback round trains the page agent AFTER marking the session ready_for_review
  // (pipeline/orchestrator.ts): the document is delivered, but the run is not over and
  // still holds its max_concurrent_runs slot. A provider hanging in there delays every
  // upload behind it, and the status alone would report the run as finished — which is
  // the one question this field exists to answer.
  const text = log({ ts: T(0), type: "run_start" }, start(T(1), "feedback"));
  const ready = { sessionId: "ses_1", status: "ready_for_review", phase: "done", now: Date.parse(T(300)) };
  const d = summarizeRun(text, ready);
  assert.ok(d.in_flight, "the training call never returned");
  assert.equal(d.in_flight.agent, "feedback");
  assert.equal(d.in_flight_count, 1);

  // Once the round writes its terminal line the run really is over, open call or not.
  const done = log({ ts: T(0), type: "run_start" }, start(T(1), "feedback"), { ts: T(2), type: "run_complete" });
  const after = summarizeRun(done, ready);
  assert.equal(after.in_flight, null, "run_complete ends the run whatever the log's last call did");
  assert.equal(after.in_flight_count, 0);
});

test("a feedback round is read against its OWN terminal line, not the first run's", () => {
  // The shape this actually happens in, and the one a single-run fixture cannot produce:
  // a session's log is one append-only file across every round, and a feedback round is
  // only accepted on a session that already reached ready_for_review — so run 1's
  // `run_complete` is always in the file by the time run 2 exists. Reading the file's
  // FIRST terminal event answers "did run 1 finish?", which is always yes, and every
  // question asked of it is then about the wrong run.
  const twoRounds = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"),
    end(T(2), "page", 1000),
    { ts: T(3), type: "run_complete" },
    { ts: T(100), type: "run_start" },
    start(T(101), "feedback"), // the training call, still open
  );
  const d = summarizeRun(twoRounds, {
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(400)),
  });
  assert.ok(d.in_flight, "the second round's open call is what this session is stuck on");
  assert.equal(d.in_flight.agent, "feedback");
  assert.equal(d.in_flight_count, 1);
  // And the round's own elapsed time keeps running, rather than having stopped at the
  // first round's completion.
  assert.ok(d.elapsed_ms > 300_000, `elapsed_ms=${d.elapsed_ms} stopped at the first run`);
});

test("a run whose process died stops claiming to be stuck", () => {
  // The status sweep at boot rewrites `running` and `queued` rows, and deliberately not
  // `ready_for_review` ones — the document is delivered and that status is right. So a
  // process killed inside the post-delivery window leaves a row nobody will correct, and
  // "no terminal line" alone would report its abandoned call as hanging for ever. What
  // bounds the claim is what a call can actually do: past an hour open it is not a slow
  // call, it is a process that is gone.
  const killed = log({ ts: T(0), type: "run_start" }, start(T(1), "feedback"));
  const ready = (nowSeconds: number) => ({
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(nowSeconds)),
  });

  const soon = summarizeRun(killed, ready(600)); // ten minutes in — a slow call
  assert.ok(soon.in_flight, "a call open for ten minutes is still a call");

  const later = summarizeRun(killed, ready(2 * 60 * 60)); // two hours in — a dead process
  assert.equal(later.in_flight, null, "an hour past the adapters' own ceiling, nothing is running");
  assert.equal(later.in_flight_count, 0);
  // And the clock stops with it, rather than counting up from a run that ended when its
  // process did.
  assert.ok(later.elapsed_ms < 60_000, `elapsed_ms=${later.elapsed_ms} is still counting`);
});

test("a round killed between calls does not count the clock up for ever", () => {
  // The other shape of a dead process, and the one the open-call ceiling cannot bound:
  // killed in the post-delivery window between model calls, so the round never
  // terminates, nothing is open to age out, and no sweep rewrites a ready_for_review
  // status. Measuring that to `now` reads an idle, delivered session as one that has
  // been working since the day it died.
  const killedBetweenCalls = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "feedback"),
    end(T(2), "feedback", 1000), // the call returned; the process died after it
  );
  const d = summarizeRun(killedBetweenCalls, {
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(3 * 24 * 60 * 60)), // three days later
  });
  assert.equal(d.in_flight, null, "nothing was open when it died");
  assert.ok(d.elapsed_ms <= 2000, `elapsed_ms=${d.elapsed_ms} is measured to now, not to its last event`);

  // But a run that is merely BETWEEN calls is still working, and it is the one holding a
  // slot: the longest step in this window can be the GitHub filing, which logs nothing
  // while it runs. Keying this on an open model call would freeze the clock on exactly
  // that run.
  const live = summarizeRun(killedBetweenCalls, {
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(600)), // ten minutes after its last event
  });
  assert.ok(live.elapsed_ms > 500_000, `elapsed_ms=${live.elapsed_ms} stopped while the run was still going`);
});

test("rounds are counted, so an interleaved second round is not read as finished", () => {
  // A client can POST /feedback during a round's post-delivery window, and with
  // max_concurrent_runs above 1 the second round's run_start is appended BEFORE the
  // first round's run_complete. Slicing from the last run_start then hands the slice a
  // trailing terminal line that belongs to the other round.
  const interleaved = log(
    { ts: T(0), type: "run_start" }, // round 1
    { ts: T(100), type: "run_start" }, // round 2 claims the session mid-window
    start(T(101), "feedback"), // round 2's training call, still open
    { ts: T(102), type: "run_complete" }, // round 1 finishing, after round 2 began
  );
  const d = summarizeRun(interleaved, {
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(300)),
  });
  assert.ok(d.in_flight, "two rounds started and one finished, so one is still working");
  assert.equal(d.in_flight.agent, "feedback");
});

test("an earlier round's abandoned call is not what this run is stuck on", () => {
  // A process killed mid-round leaves a start with no end. That call belongs to a run
  // that is over; attributing it to the current one is the phantom hang by another route.
  const orphaned = log(
    { ts: T(0), type: "run_start" },
    start(T(1), "page"), // never closed — the process died here
    { ts: T(100), type: "run_start" },
    start(T(101), "feedback"),
    end(T(102), "feedback", 1000),
  );
  const d = summarizeRun(orphaned, {
    sessionId: "ses_1",
    status: "ready_for_review",
    phase: "done",
    now: Date.parse(T(400)),
  });
  assert.equal(d.in_flight, null, "the current round has no open call");
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

test("per-agent attribution carries all four counts, not just input and output", () => {
  // `input_tokens` excludes what came from the cache, so a two-field per-agent split
  // understates an agent's prompt by exactly its cached share — worst for the agent
  // that caches BEST, which inverts the answer "which agent is expensive". Here the
  // page agent's prompt is 30_000 tokens of which 24_000 were cache reads: on input
  // alone it looks like the cheaper of the two, and it is not.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(4), type: "model_call", agent: "page", model: "m", capability: "vision", provider: "p",
      duration_ms: 4000, ok: true, input_tokens: 6000, output_tokens: 900,
      cache_read_input_tokens: 24_000, cache_creation_input_tokens: 30_000 },
    { ts: T(8), type: "model_call", agent: "copy_editor", model: "m", capability: "text", provider: "p",
      duration_ms: 4000, ok: true, input_tokens: 9000, output_tokens: 5000 },
    { ts: T(8), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(8)) });
  assert.deepEqual(d.by_agent.page, {
    count: 1,
    total_ms: 4000,
    max_ms: 4000,
    input_tokens: 6000,
    output_tokens: 900,
    cache_read_input_tokens: 24_000,
    cache_creation_input_tokens: 30_000,
    models: ["m"],
  });
  // An agent whose calls reported no cache counts gets zeros, not missing keys: the
  // shape is the same for every agent so a consumer can add them up without checking.
  assert.equal(d.by_agent.copy_editor.cache_read_input_tokens, 0);
  assert.equal(d.by_agent.copy_editor.cache_creation_input_tokens, 0);
  // And the per-agent counts still add up to the run's.
  const agents = Object.values(d.by_agent);
  assert.equal(agents.reduce((n, a) => n + a.cache_read_input_tokens, 0), d.tokens.cache_read);
  assert.equal(agents.reduce((n, a) => n + a.cache_creation_input_tokens, 0), d.tokens.cache_write);
});

test("by_agent names the model each agent ran on, so a swap that did not happen is visible", () => {
  // The failure this exists for: `providers.per_agent` is the whole model-selection surface,
  // and a key that names no dispatched agent is IGNORED — the call falls through to the
  // provider's own model and the run succeeds at the price it would have cost anyway. So a
  // cheaper model that saved nothing and a swap that never took effect produced the same
  // seven numbers. Here `page` was swapped and `feedback` deliberately left on the incumbent,
  // which is what a `page`-only swap looks like, and the rows say so.
  const text = log(
    { ts: T(0), type: "run_start" },
    end(T(2), "page", 2000, "moonshotai.kimi-k2.5"),
    end(T(4), "page", 2000, "moonshotai.kimi-k2.5"),
    // A failed call counts too: a model id that is valid for one provider and named to
    // another resolves happily and then fails on every call, and that row's model is the
    // whole diagnosis. Excluding failures would blank exactly the case worth reading.
    { ts: T(5), type: "model_call", agent: "page", model: "moonshotai.kimi-k2.5", capability: "vision",
      provider: "p", duration_ms: 300, ok: false, error: "model not found" },
    end(T(6), "feedback", 1000, "us.anthropic.claude-sonnet-4-6"),
    { ts: T(6), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(6)) });
  // Deduplicated: three calls to one model is one entry, not three.
  assert.deepEqual(d.by_agent.page.models, ["moonshotai.kimi-k2.5"]);
  assert.equal(d.by_agent.page.count, 3);
  assert.deepEqual(d.by_agent.feedback.models, ["us.anthropic.claude-sonnet-4-6"]);
  // And the same calls keyed by step carry it, since a step is what a bucket of spend is.
  assert.deepEqual(d.by_step["?"].models, ["moonshotai.kimi-k2.5", "us.anthropic.claude-sonnet-4-6"]);
});

test("one agent can be two models, because resolution keys on capability as well", () => {
  // `page` extracts with `vision` and merges a specialist fragment with `text`; a provider's
  // `per_capability` block can therefore put one agent on two models on purpose. A row
  // reporting the first or the last would be a claim the config does not make — and sorted,
  // not first-seen, because which page finished first is an accident.
  const text = log(
    { ts: T(0), type: "run_start" },
    end(T(2), "page", 2000, "z-vision-model", "vision"),
    end(T(4), "page", 1000, "a-text-model", "text"),
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(4)) });
  assert.deepEqual(d.by_agent.page.models, ["a-text-model", "z-vision-model"]);
});

test("models covers the whole session, not the current round, so a restart between rounds shows both", () => {
  // Folded over every `model_call` in the log, exactly as the seven numbers beside it are — and a
  // session's log is one append-only file across its feedback rounds (store/runlog.ts). Config is
  // read at boot, so a session extracted before a restart and given feedback after one really did
  // run on two models, and reporting one of them would be the lie. It is pinned because the
  // docs turn this field into a verdict on a config edit (docs/models.md §1, docs/API.md §7b):
  // that reading holds on a session that has only run since the edit, which is why both say so.
  const text = log(
    { ts: T(0), type: "run_start" },
    end(T(2), "page", 2000, "before-restart", "vision"),
    { ts: T(2), type: "run_complete" },
    { ts: T(6), type: "run_start" },
    end(T(8), "page", 2000, "after-restart", "vision"),
    { ts: T(8), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(8)) });
  assert.deepEqual(d.by_agent.page.models, ["after-restart", "before-restart"]);
  // And the same set under the other key, since one fold serves both.
  assert.deepEqual(d.by_step["?"].models, ["after-restart", "before-restart"]);
  assert.equal(d.by_agent.page.count, 2);
});

test("a call whose line carries no model leaves the list empty rather than naming a placeholder", () => {
  // Unlike `by_step`'s `?` key, which has to exist so old logs still add up, this field is
  // read to answer "which model" — a `"?"` in it would answer, and wrongly. Empty with a
  // non-zero count is readable as "this log predates the field".
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(2), type: "model_call", agent: "page", capability: "vision", provider: "p", duration_ms: 2000, ok: true },
    { ts: T(2), type: "run_complete" },
  );
  const d = summarizeRun(text, { sessionId: "s", status: "ready_for_review", phase: "done", now: Date.parse(T(2)) });
  assert.equal(d.by_agent.page.count, 1);
  assert.deepEqual(d.by_agent.page.models, []);
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

// --- the verify/correct tally (issue #137) ----------------------------------
//
// A run's page-call count is `pages + corrections`, and on three real runs the verify
// failure rate was 77% — so the optional correction pass is in practice mandatory, and
// none of what it bought was visible. These fields are that measurement, folded out of
// the same log everything else here comes from.

const done = (now: number) => ({ sessionId: "s", status: "ready_for_review", phase: "done", now });

test("the verification tally counts what was checked, corrected and re-checked", () => {
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_failed", image: "page-001.png", problems: ["the alt text is thin"] },
    { ts: T(1), type: "page_verify_ok", image: "page-002.png" },
    { ts: T(2), type: "page_verify_failed", image: "page-003.png", problems: ["a table row is missing"] },
    // An alt-only refinement: a page call spent on an image description.
    { ts: T(3), type: "page_corrected", image: "page-001.png", page: 1, trigger: "verify", problems: 1,
      result: "kept", chars_before: 900, chars_after: 940,
      text_changed: false, alt_changed: true, attrs_changed: false, structure_changed: false },
    // Content coming back: text and structure both, and both counted. The reader's share of
    // it grew too, which is what says the correction restored content rather than adding
    // markup to a page that already had it (issue #166).
    { ts: T(3), type: "page_corrected", image: "page-003.png", page: 3, trigger: "verify", problems: 1,
      result: "kept", chars_before: 1200, chars_after: 1600,
      text_chars_before: 800, text_chars_after: 1010,
      text_changed: true, alt_changed: false, attrs_changed: false, structure_changed: true },
    // And the cheap real fix: a page that passed its check, lost a link, and came back with
    // the URL re-typed. No word on it moves, and it is not a correction that bought nothing.
    { ts: T(3), type: "page_corrected", image: "page-002.png", page: 2, trigger: "links", problems: 1,
      result: "kept", chars_before: 700, chars_after: 702,
      text_changed: false, alt_changed: false, attrs_changed: true, structure_changed: false },
    { ts: T(4), type: "page_correction_recheck", image: "page-001.png", page: 1, ok: true, problems: [],
      problems_before: 1, problems_after: 0, binding: false },
    { ts: T(5), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(5))));
  assert.equal(d.verification.pages_verified, 3);
  assert.equal(d.verification.verify_failed, 2);
  assert.equal(d.verification.corrections, 3);
  assert.deepEqual(d.verification.results, { kept: 3, rejected: 0, identical: 0, empty: 0, failed: 0 });
  // `text` and `structure` are not exclusive — one re-render is both — while `alt_only`
  // is the count of corrections that moved nothing but a description. `text_grew` is the
  // subset of `text` that added prose: the alt-only and attribute-only passes moved no
  // words, so neither is in either direction.
  assert.deepEqual(d.verification.effects, {
    alt_only: 1, text: 1, attrs: 1, structure: 1, text_grew: 1, text_shrank: 0,
  });
  assert.deepEqual(d.verification.triggers, { verify: 2, links: 1, alt: 0, both: 0 });
  assert.deepEqual(d.verification.rechecks, {
    sampled: 1, sampled_ok: 1, sampled_unjudged: 0,
    sampled_problems_before: 1, sampled_problems_after: 0,
    binding: 0, binding_ok: 0, binding_unjudged: 0, binding_error: 0,
    // The sample cleared, so there is no verdict to carry: this list holds the failing ones.
    failures: [],
    verdicts_omitted: 0,
  });
  assert.equal(d.verification.pages_unjudged, 0, "every page here carried a real verdict");
});

test("a page nothing judged is counted apart from a page that passed", () => {
  // Verification is non-blocking: with no Feedback Agent, nothing to verify, or a reply that
  // will not parse, `verifyAgentOutput` answers ok=true and the page costs nothing — so "the
  // verifier looked and was satisfied" and "nobody looked" both write `page_verify_ok`. A run
  // that lost its Feedback Agent halfway through would read here as a run with an unusually
  // good pass rate, and the rejection rate this tally exists to support would be computed over
  // pages that were never judged (issue #211).
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "page-001.png" },
    { ts: T(2), type: "page_verify_ok", image: "page-002.png", unjudged: true },
    { ts: T(3), type: "page_verify_ok", image: "page-003.png", unjudged: true },
    { ts: T(4), type: "page_verify_failed", image: "page-004.png", problems: ["a table row is missing"] },
    { ts: T(5), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(5))));
  // A subset, not a deduction: `pages_verified` counts what it has always counted, because it
  // is compared across runs and rounds and moving it silently would move every number already
  // published against it. 1 of 2 is the rejection rate here, not 1 of 4.
  assert.equal(d.verification.pages_verified, 4);
  assert.equal(d.verification.pages_unjudged, 2);
  assert.equal(d.verification.verify_failed, 1);

  // An old log cannot say — before the flag existed, a run with no Feedback Agent wrote the
  // same lines as a passing one — so silence is a judged page rather than a guess.
  const old = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "page-001.png" },
    { ts: T(2), type: "run_complete" },
  );
  assert.equal(summarizeRun(old, done(Date.parse(T(2)))).verification.pages_unjudged, 0);

  // And a flag that is not the boolean is not a flag. This reader trusts nothing on a log
  // line: a page subtracted from the rejection rate on the strength of a string would be the
  // same trap `result` and `kinds` are matched against closed lists for.
  const sloppy = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "page-001.png", unjudged: "true" },
    { ts: T(2), type: "page_verify_ok", image: "page-002.png", unjudged: 1 },
    { ts: T(3), type: "run_complete" },
  );
  assert.equal(summarizeRun(sloppy, done(Date.parse(T(3)))).verification.pages_unjudged, 0);
});

test("a page the verifier described and passed is counted, and priced by kind", () => {
  // The verdict that names a defect and ticks the box: `ok` is the `faithful`/`accessible`
  // flags, and a correction needs a false flag AND a named problem, so a page whose verdict
  // describes a swapped pair of paragraphs with both flags true ships unchanged and its
  // sentence goes nowhere — `page_verify_ok` carries no `problems` (issue #210).
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "a.png" },
    { ts: T(1), type: "page_verify_inconsistent", image: "a.png", page: 1,
      problems: ["the first two paragraphs are in the reverse of the source order"],
      kinds: ["structure_wrong"], untagged: 0 },
    // A page whose only note is advice. Not this bug — the agent was asked for it, and a rule
    // that failed the page for it would buy a page call per suggestion — so it is in `pages`
    // and out of `content_or_structure`.
    { ts: T(2), type: "page_verify_ok", image: "b.png" },
    { ts: T(2), type: "page_verify_inconsistent", image: "b.png", page: 2,
      problems: ["the chart's description could name the units"],
      kinds: ["alt_quality"], untagged: 0 },
    // One page, two kinds, one of them content: counted in each bucket and once in the
    // pricing field, which is a page count and has to divide into `pages`.
    { ts: T(3), type: "page_verify_ok", image: "c.png" },
    { ts: T(3), type: "page_verify_inconsistent", image: "c.png", page: 3,
      problems: ["the total reads 1,240 and the image shows 1,420", "the alt text is thin"],
      kinds: ["content_wrong", "alt_quality"], untagged: 0 },
    // And the shape the measured corpus is entirely made of: prose with no kind, because the
    // kinds are newer than those runs. A kind-gated rule can act on it neither way, which is
    // what `undecided_pages` is here to say.
    { ts: T(4), type: "page_verify_ok", image: "d.png" },
    { ts: T(4), type: "page_verify_inconsistent", image: "d.png", page: 4,
      problems: ["the heading is marked <h4> among <h2> siblings"] },
    // A partly-tagged page, and the case that separates this fold's rule from the failure
    // fold's: one tagged `content_missing` and one problem in prose. The rule fails this page
    // on the tag it HAS, so it is decided — counting it as undecided too would double it in a
    // sum whose halves are meant to bracket the bill.
    { ts: T(5), type: "page_verify_ok", image: "f.png" },
    { ts: T(5), type: "page_verify_inconsistent", image: "f.png", page: 6,
      problems: ["the second table row is absent", "something is off about the footer"],
      kinds: ["content_missing"], untagged: 1 },
    // Where a partial tag leaves it undecided: the only kind named is advice, and the untagged
    // problem beside it could be anything.
    { ts: T(5), type: "page_verify_ok", image: "g.png" },
    { ts: T(5), type: "page_verify_inconsistent", image: "g.png", page: 7,
      problems: ["the alt text is thin", "the second column looks wrong"],
      kinds: ["alt_quality"], untagged: 1 },
    { ts: T(5), type: "page_verify_failed", image: "e.png", problems: ["a table row is missing"],
      kinds: ["content_missing"], untagged: 0 },
    { ts: T(6), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(6))));
  assert.deepEqual(d.verification.verify_inconsistent, {
    pages: 6,
    content_missing: 1,
    content_wrong: 1,
    structure_wrong: 1,
    a11y_only: 0,
    alt_quality: 3,
    content_or_structure: 3,
    undecided_pages: 2,
  });
  // The floor and the ceiling on what a kind-gated rule would cost this run: 3 pages it would
  // certainly fail, and 2 more it could not decide either way. Addable because neither
  // contains the other — page 6 is tagged `content_missing` AND carries an untagged problem,
  // and is in the first only.
  assert.equal(
    d.verification.verify_inconsistent.content_or_structure +
      d.verification.verify_inconsistent.undecided_pages,
    5,
    "and the sixth page's only note was advice, which such a rule would leave alone",
  );
  // Not folded as verified pages: each of these lines sits beside a `page_verify_ok` for the
  // same page, and counting both would make the denominator larger than the run.
  assert.equal(d.verification.pages_verified, 7);
  assert.equal(d.verification.verify_failed, 1);
  // The failure's own kinds are untouched by the new fold — two counts of two populations.
  assert.equal(d.verification.verify_kinds.content_missing, 1);
  assert.equal(d.verification.verify_kinds.structure_wrong, 0);

  // A log from before the event reports zeros, and a line whose `kinds` is not a list of
  // known kinds is a page in no bucket rather than a page added to a function.
  const old = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_verify_ok", image: "a.png" },
    { ts: T(2), type: "page_verify_inconsistent", image: "b.png", page: 2, problems: ["…"],
      kinds: ["constructor", "toString"], untagged: "some" },
    { ts: T(3), type: "run_complete" },
  );
  assert.deepEqual(summarizeRun(old, done(Date.parse(T(3)))).verification.verify_inconsistent, {
    pages: 1,
    content_missing: 0,
    content_wrong: 0,
    structure_wrong: 0,
    a11y_only: 0,
    alt_quality: 0,
    content_or_structure: 0,
    undecided_pages: 1,
  });
  assert.deepEqual(summarizeRun("", done(Date.parse(T(0)))).verification.verify_inconsistent, {
    pages: 0,
    content_missing: 0,
    content_wrong: 0,
    structure_wrong: 0,
    a11y_only: 0,
    alt_quality: 0,
    content_or_structure: 0,
    undecided_pages: 0,
  });
});

test("a correction that bought nothing is counted apart from one that was kept", () => {
  // The cost signal: `identical` and `empty` are page calls that were paid for and
  // produced no change, and `rejected` is one whose change was discarded.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_corrected", image: "a.png", page: 1, trigger: "verify", problems: 2, result: "identical" },
    { ts: T(1), type: "page_corrected", image: "b.png", page: 2, trigger: "verify", problems: 1, result: "empty" },
    // A correction whose model call never came back — the output ceiling, on the page the
    // run kept anyway (issue #171). Apart from `empty` because it is the expensive one: this
    // call paid for a full ceiling of output before failing.
    { ts: T(1), type: "page_correction_failed", image: "e.png", page: 5, trigger: "verify",
      problems: 2, error: "bedrock: response hit the 32000-token output ceiling and was truncated (93039 chars returned). Raise providers.bedrock.max_tokens.",
      truncated: true, chars_kept: 17721 },
    { ts: T(1), type: "page_corrected", image: "e.png", page: 5, trigger: "verify", problems: 2, result: "failed" },
    { ts: T(2), type: "page_corrected", image: "c.png", page: 3, trigger: "links", problems: 1, result: "rejected",
      chars_before: 500, chars_after: 480, text_chars_before: 300, text_chars_after: 240,
      text_changed: true, alt_changed: false,
      attrs_changed: false, structure_changed: true },
    // A rewrite that refined a description AND re-typed an attribute is not `alt_only`:
    // that bucket exists to name the run that pays a page call per page for image
    // descriptions and nothing else, so anything else disqualifies it.
    { ts: T(2), type: "page_corrected", image: "d.png", page: 4, trigger: "both", problems: 2, result: "kept",
      chars_before: 500, chars_after: 530, text_changed: false, alt_changed: true,
      attrs_changed: true, structure_changed: false },
    { ts: T(3), type: "page_correction_recheck", image: "c.png", page: 3, ok: false,
      // A binding line's `problems_before` is 0 by construction — the page had PASSED — so a
      // problem named here is a rewrite that lost something, and it must not be summed into a
      // convergence ratio for pages that had failed.
      problems: ["a heading level was lost"], problems_before: 0, links_before: 1,
      problems_after: 1, binding: true },
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(4))));
  assert.equal(d.verification.corrections, 5);
  assert.deepEqual(d.verification.results, { kept: 1, rejected: 1, identical: 1, empty: 1, failed: 1 });
  // A rejected correction's effect is still what it changed — it says what the rewrite
  // would have done to a page that had passed. Which here is drop prose, so it is the
  // `text_shrank` case: the direction is worth recording on a rewrite that was refused
  // precisely because the links path checked it.
  assert.deepEqual(d.verification.effects, {
    alt_only: 0, text: 1, attrs: 1, structure: 1, text_grew: 0, text_shrank: 1,
  });
  assert.deepEqual(d.verification.triggers, { verify: 3, links: 1, alt: 0, both: 1 });
  // The links path's re-verification is `binding`, and stays out of the sample it would
  // otherwise outnumber: this page had PASSED its check and was rewritten for a link, so
  // its failure says nothing about whether correcting a FAILED page converges. Its problem
  // counts stay out too — a binding verdict decides whether the rewrite ships rather than
  // measuring how far a kept one got, and its before-count is mostly missing links.
  assert.deepEqual(d.verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_unjudged: 0,
    sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 1, binding_ok: 0, binding_unjudged: 0, binding_error: 0,
    // What the refused rewrite lost, in the verifier's own words, which is the reading a
    // count of one cannot give. `binding: true` is what says the page shipped as it was
    // rather than shipping still wrong (issue #296).
    failures: [{ ts: T(3), page: 3, binding: true, message: "a heading level was lost" }],
    verdicts_omitted: 0,
  });
  // And out of `errors`, which is now failures only: this run had none. A verdict that names
  // a problem is a measurement, and the refusal it drove is the loop working.
  assert.deepEqual(d.errors, []);
});

test("a log from before these events reports zeros, not absences", () => {
  // Every field is present on every run, so "this deployment corrected nothing" and
  // "this log predates the measurement" are both readable rather than one being an
  // undefined a consumer has to guess at. A `page_corrected` line with a result this
  // version does not know still counts as a correction and lands in no bucket.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_corrected", image: "a.png", page: 1, result: "deferred", trigger: "policy" },
    // And a result that names something on Object.prototype, which a membership test
    // would answer "yes" to and then add 1 to a function.
    { ts: T(1), type: "page_corrected", image: "b.png", page: 2, result: "constructor", trigger: "toString" },
    // A recheck that does not say which population it belongs to lands in neither, rather
    // than being guessed into the one whose rate it would distort.
    { ts: T(1), type: "page_correction_recheck", image: "b.png", page: 2, ok: true },
    { ts: T(2), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(2))));
  assert.equal(d.verification.pages_verified, 0);
  assert.equal(d.verification.corrections, 2);
  for (const [k, v] of Object.entries({ ...d.verification.results, ...d.verification.triggers })) {
    assert.equal(typeof v, "number", `${k} is not a number`);
  }
  assert.deepEqual(d.verification.results, { kept: 0, rejected: 0, identical: 0, empty: 0, failed: 0 });
  assert.deepEqual(d.verification.triggers, { verify: 0, links: 0, alt: 0, both: 0 });
  assert.deepEqual(d.verification.effects, {
    alt_only: 0, text: 0, attrs: 0, structure: 0, text_grew: 0, text_shrank: 0,
  });
  assert.deepEqual(d.verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_unjudged: 0,
    sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0, binding_unjudged: 0, binding_error: 0,
    // Present and empty on a log that never wrote a verdict, like every count beside it: an
    // empty list is a run with no failing recheck, and an absent field is a consumer guessing.
    failures: [],
    verdicts_omitted: 0,
  });
  assert.deepEqual(summarizeRun("", done(Date.parse(T(0)))).verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_unjudged: 0,
    sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0, binding_unjudged: 0, binding_error: 0,
    failures: [],
    verdicts_omitted: 0,
  });
});

test("a log from before the prose sizes and the problem counts leaves both sums alone", () => {
  // The narrower version of the test above, for the two fields added for issue #166. Both
  // are read as absent rather than as zero, and the difference matters in opposite
  // directions: a missing `text_chars_after` read as 0 puts a productive correction in
  // `text_shrank`, reporting a page that lost every word it had, and a missing
  // `problems_before` read as 0 makes the recheck pair say the loop was correcting pages
  // that had nothing wrong with them.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_corrected", image: "a.png", page: 1, result: "kept", trigger: "verify",
      problems: 2, chars_before: 400, chars_after: 900, text_changed: true, alt_changed: false,
      attrs_changed: false, structure_changed: true },
    { ts: T(2), type: "page_correction_recheck", image: "a.png", page: 1, ok: false,
      problems: ["a table row is still missing"], binding: false },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  // Counted everywhere it always was.
  assert.deepEqual(d.verification.results, { kept: 1, rejected: 0, identical: 0, empty: 0, failed: 0 });
  assert.deepEqual(d.verification.effects, {
    alt_only: 0, text: 1, attrs: 0, structure: 1, text_grew: 0, text_shrank: 0,
  });
  // A sample was taken and it failed; how far it got is not in this log and is not invented.
  // What it FOUND is on the line either way, and a line too old to carry the counts still
  // carries the prose — which is the case that makes this list worth having beside them.
  assert.deepEqual(d.verification.rechecks, {
    sampled: 1, sampled_ok: 0, sampled_unjudged: 0,
    sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0, binding_unjudged: 0, binding_error: 0,
    failures: [{ ts: T(2), page: 1, binding: false, message: "a table row is still missing" }],
    verdicts_omitted: 0,
  });
});

test("a recheck nothing judged is counted apart from a rewrite that was checked", () => {
  // The same conflation one fold down, and the fold where it does the most damage: with no
  // Feedback Agent every page passes its first check, so every corrected page is corrected for
  // links and every recheck is the BINDING one — a whole run of "the rewrite was checked and
  // stayed good" for pages nobody looked at (issue #211, note 3 on PR #212).
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_correction_recheck", image: "a.png", page: 1, ok: true,
      problems: [], binding: true },
    { ts: T(2), type: "page_correction_recheck", image: "b.png", page: 2, ok: true,
      problems: [], binding: true, unjudged: true },
    // A sampled recheck can go unjudged too — the first verdict was real and failed, the
    // second reply would not parse — and its problem pair stays out of the convergence sums:
    // `problems_after: 0` here is "nothing was named", and summed in it would report this
    // page as a correction that fixed all two of the problems it was handed.
    { ts: T(3), type: "page_correction_recheck", image: "c.png", page: 3, ok: true,
      problems: [], problems_before: 2, problems_after: 0, binding: false, unjudged: true },
    // Same trust as everywhere else here: a flag that is not the boolean is not a flag.
    { ts: T(4), type: "page_correction_recheck", image: "d.png", page: 4, ok: true,
      problems: [], binding: true, unjudged: "true" },
    { ts: T(5), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(5))));
  // Subsets, as above: 2 of the 3 binding rechecks were judged, and both of them passed —
  // which is what makes the rate `(binding_ok - binding_unjudged) / (binding -
  // binding_unjudged)` and not `binding_ok / (binding - binding_unjudged)`. An unjudged
  // recheck logs `ok: true`, so it is inside `binding_ok` already and the second form reads
  // 3 of 2. The problem pair is the exception: it counts judged samples only.
  assert.deepEqual(d.verification.rechecks, {
    sampled: 1, sampled_ok: 1, sampled_unjudged: 1,
    sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 3, binding_ok: 3, binding_unjudged: 1, binding_error: 0,
    // An unjudged recheck is not a failing one: nothing looked, so it logs `ok: true` and
    // names nothing, and an entry here would be a page reported wrong on no evidence.
    failures: [],
    verdicts_omitted: 0,
  });
  assert.equal(
    d.verification.rechecks.binding_ok - d.verification.rechecks.binding_unjudged, 2,
    "two binding rechecks were judged and both passed",
  );
});

test("a measurement coming back negative is not one of the run's errors", () => {
  // Issue #296, both halves at once, on the shape the deployment actually produced: a sampled
  // recheck that failed on page 21 and a genuine provider failure in the same run. `errors`
  // used to hold both, and told them apart only by the recheck's `message` reading "unknown"
  // — it reads `error`, and this event carries its diagnosis under `problems`. So the run that
  // was sound and the run that lost a call were the same shape to anyone reading the field
  // that says whether a run is sound. 31 of 31 rechecks on disk were this case.
  const problem =
    "The alt text places Mississippi in the dotted-pattern category but the map shows it with" +
    " the solid-dark fill.";
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_corrected", image: "p21.png", page: 21, result: "kept", trigger: "verify",
      problems: 1 },
    { ts: T(2), type: "page_correction_recheck", image: "p21.png", page: 21, ok: false,
      problems: [problem], problems_before: 1, problems_after: 1, kinds_after: ["content_wrong"],
      binding: false },
    // The failure a reader of `errors` is looking for, in the same run.
    { ts: T(3), type: "model_call", agent: "copy_editor", step: "review", model: "m", provider: "p",
      capability: "text", duration_ms: 900, ok: false,
      error: "bedrock: response hit the 32000-token output ceiling and was truncated" },
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(4))));
  assert.deepEqual(d.errors, [
    { ts: T(3), type: "model_call", message: "bedrock: response hit the 32000-token output ceiling and was truncated" },
  ]);
  // Nothing in `errors` says "unknown" any more, and nothing in it is a measurement.
  assert.equal(d.errors.filter((x) => x.message === "unknown").length, 0);
  assert.equal(d.errors.filter((x) => x.type === "page_correction_recheck").length, 0);
  // And the diagnosis did not go with it. `page` is on the entry because a run can fail
  // several rechecks and the prose is about one page: a consumer matching on type alone
  // reported the first one's words for every page.
  assert.deepEqual(d.verification.rechecks.failures, [
    { ts: T(2), page: 21, binding: false, message: problem },
  ]);
  // The counts are untouched by the move — this is still one sample that did not clear.
  assert.equal(d.verification.rechecks.sampled, 1);
  assert.equal(d.verification.rechecks.sampled_ok, 0);
});

test("a verdict with several problems says how many, and one the log garbled says so", () => {
  // The message is the problems in FULL, because no order is claimed among them and the
  // dropped one is as likely as any to be why the page is wrong — with a count in front, so
  // "a correction left one problem behind" and "it left four" are not the same-looking string.
  //
  // And the shapes a hand-edited or older log can present. `problems` missing entirely, and
  // `problems` holding something that is not a string, both have to produce a sentence: the
  // point of this field is that a reader never has to open log.jsonl to find out what a page
  // failed on, and `message: undefined` would send them there for the worst reason.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_correction_recheck", image: "a.png", page: 1, ok: false,
      problems: ["the table lost its header row", "the caption is gone", "  "], binding: false },
    { ts: T(2), type: "page_correction_recheck", image: "b.png", page: 2, ok: false, binding: true },
    { ts: T(3), type: "page_correction_recheck", image: "c.png", page: 3, ok: false,
      problems: [{ text: "a heading level was lost" }], binding: true },
    { ts: T(4), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(4))));
  assert.deepEqual(d.verification.rechecks.failures.map((f) => f.message), [
    "2 problems: the table lost its header row | the caption is gone",
    "no problems on the line",
    "no problems on the line",
  ]);
  // Which is a different string from a verdict that named something, so a reader can tell a
  // page with no diagnosis from a page whose diagnosis was one blank entry.
  assert.equal(d.verification.rechecks.failures[0].message.startsWith("2 problems"), true);
});

test("a recheck that does not say which population it belongs to still says what is wrong", () => {
  // The counts put a line with a non-boolean `binding` in neither bucket, deliberately:
  // guessing a population distorts a rate. What that line failed to say is which rate it
  // belongs in, though, and not what is wrong with the page — so the verdict is kept, marked
  // `binding: null`, rather than being the one failing recheck this file cannot report.
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_correction_recheck", image: "a.png", page: 1, ok: false,
      problems: ["a column of the table is missing"], binding: "false" },
    // And a line with no page on it at all, which is a fact about the verdict and not a
    // reason to drop it.
    { ts: T(2), type: "page_correction_recheck", image: "b.png", ok: false,
      problems: ["the figure has no description"], binding: false },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  assert.deepEqual(d.verification.rechecks.failures, [
    { ts: T(1), page: 1, binding: null, message: "a column of the table is missing" },
    { ts: T(2), page: null, binding: false, message: "the figure has no description" },
  ]);
  // The first is in neither count, as it always was: two failing verdicts, one sample.
  assert.equal(d.verification.rechecks.sampled, 1);
  assert.equal(d.verification.rechecks.binding, 0);
  assert.deepEqual(d.errors, []);
});

test("the verdict list is bounded, and says how much it left out", () => {
  // The one part of this payload that grows as model PROSE rather than as a count, so it is
  // the one part with a cap. Reachable on default config, and by the binding population rather
  // than the sampled one: `recheck_sample_size` is 1, but the binding recheck runs on every
  // page that passed and had a link or alt rewritten, so a link-heavy document can refuse more
  // than twenty rewrites in one round. Which is the run worth capping.
  //
  // Disclosed rather than silent: a list that quietly stopped growing would be read as the
  // run's complete account of what shipped wrong, which is the opposite of what it is.
  // So the fixture is that run: twenty-five binding refusals in one round, not twenty-five
  // sampled ones the default config could not produce.
  const events = [{ ts: T(0), type: "run_start" } as Record<string, unknown>];
  for (let p = 1; p <= 25; p++) {
    events.push({ ts: T(p), type: "page_correction_recheck", image: `p${p}.png`, page: p, ok: false,
      problems: [`page ${p} link rewrite dropped the destination`], binding: true });
  }
  events.push({ ts: T(26), type: "run_complete" });
  const d = summarizeRun(log(...events), done(Date.parse(T(26))));
  assert.equal(d.verification.rechecks.failures.length, 20);
  assert.equal(d.verification.rechecks.verdicts_omitted, 5);
  // The FIRST twenty: a session's early failures are the delivered document's own account of
  // itself, and its later rounds re-verify a handful of pages the user asked about — so a cap
  // that kept the tail would drop the former for the latter.
  assert.equal(d.verification.rechecks.failures[0].page, 1);
  assert.equal(d.verification.rechecks.failures[19].page, 20);
  // And the counts are untouched by the cap: 25 rechecks failed, whatever the list carries.
  assert.equal(d.verification.rechecks.binding, 25);
  assert.equal(d.verification.rechecks.binding_ok, 0);
  assert.equal(d.verification.rechecks.sampled, 0);
});

test("a verdict longer than the payload will carry is cut, and marked", () => {
  // How many problems the array holds is the model's to choose, so the JOIN is the unbounded
  // quantity — not any one sentence of it. Wide enough that the verdict which prompted #296
  // (250 characters) is carried whole, and a cut is visible rather than being a diagnosis that
  // happens to end mid-word.
  const short = "The alt text swaps two states: MISS. is shown with the solid-dark fill.";
  const text = log(
    { ts: T(0), type: "run_start" },
    { ts: T(1), type: "page_correction_recheck", image: "a.png", page: 1, ok: false,
      problems: [short], binding: false },
    { ts: T(2), type: "page_correction_recheck", image: "b.png", page: 2, ok: false,
      problems: Array.from({ length: 12 }, (_, i) => `problem ${i} ${"x".repeat(80)}`), binding: false },
    { ts: T(3), type: "run_complete" },
  );
  const d = summarizeRun(text, done(Date.parse(T(3))));
  const [a, b] = d.verification.rechecks.failures;
  assert.equal(a.message, short, "a real one-page verdict is carried whole");
  assert.equal(b.message.length, 601, "600 characters and the mark");
  assert.equal(b.message.endsWith("…"), true);
  // The count survives the cut, because it is the part that says how much was left behind.
  assert.equal(b.message.startsWith("12 problems: "), true);
  // Nothing was omitted from the LIST — both verdicts are reported, one of them abridged.
  assert.equal(d.verification.rechecks.verdicts_omitted, 0);
});
