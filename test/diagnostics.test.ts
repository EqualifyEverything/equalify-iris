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
  assert.deepEqual(d.verification.triggers, { verify: 2, links: 1, both: 0 });
  assert.deepEqual(d.verification.rechecks, {
    sampled: 1, sampled_ok: 1, sampled_problems_before: 1, sampled_problems_after: 0,
    binding: 0, binding_ok: 0,
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
      problems: ["a heading level was lost"], problems_before: 1, problems_after: 1, binding: true },
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
  assert.deepEqual(d.verification.triggers, { verify: 3, links: 1, both: 1 });
  // The links path's re-verification is `binding`, and stays out of the sample it would
  // otherwise outnumber: this page had PASSED its check and was rewritten for a link, so
  // its failure says nothing about whether correcting a FAILED page converges. Its problem
  // counts stay out too — a binding verdict decides whether the rewrite ships rather than
  // measuring how far a kept one got, and its before-count is mostly missing links.
  assert.deepEqual(d.verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 1, binding_ok: 0,
  });
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
  assert.deepEqual(d.verification.triggers, { verify: 0, links: 0, both: 0 });
  assert.deepEqual(d.verification.effects, {
    alt_only: 0, text: 0, attrs: 0, structure: 0, text_grew: 0, text_shrank: 0,
  });
  assert.deepEqual(d.verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0,
  });
  assert.deepEqual(summarizeRun("", done(Date.parse(T(0)))).verification.rechecks, {
    sampled: 0, sampled_ok: 0, sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0,
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
  assert.deepEqual(d.verification.rechecks, {
    sampled: 1, sampled_ok: 0, sampled_problems_before: 0, sampled_problems_after: 0,
    binding: 0, binding_ok: 0,
  });
});
