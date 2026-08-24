// Distills a session's log.jsonl into a machine-readable health/timing summary
// for maintainers — human or AI. The key signal for "is it hung?" is
// `in_flight.waiting_ms`: a model call that started but has not finished.

interface LogEvent {
  ts?: string;
  type?: string;
  phase?: string;
  agent?: string;
  model?: string;
  provider?: string;
  capability?: string;
  duration_ms?: number;
  ok?: boolean;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

export interface Diagnostics {
  session_id: string;
  status: string;
  phase: string;
  started_at: string | null;
  last_event_at: string | null;
  elapsed_ms: number;
  // Non-null only while a model call is outstanding (likely culprit if hung).
  // When extraction runs pages in parallel, several calls can be open at once;
  // this reports the longest-waiting one.
  in_flight: null | {
    agent: string;
    model: string;
    provider: string;
    capability: string;
    since: string;
    waiting_ms: number;
  };
  // How many model calls are outstanding (0 unless running). > 1 means pages are
  // being extracted in parallel.
  in_flight_count: number;
  phase_durations_ms: Record<string, number>;
  // `total_ms` is the SUM of call durations, which exceeds wall-clock time when
  // calls overlap — that is the point of `concurrency_factor`
  // (total_ms / elapsed_ms, rounded to 2dp): ~1 means effectively serial, ~N
  // means N calls were typically in flight. Use elapsed_ms for wall-clock.
  model_calls: {
    count: number;
    failed: number;
    total_ms: number;
    avg_ms: number;
    max_ms: number;
    concurrency_factor: number;
  };
  // What the run consumed, in tokens. Deliberately not in dollars: the rate depends
  // on the provider, the region and the model, all of which are deployment config and
  // any of which can change without this file knowing — the same reason the limits
  // endpoint publishes sizes without naming the model behind them. Tokens are the
  // durable fact; whoever knows the price sheet does the multiplication.
  //
  // The four counts bill at four different rates, so they are reported separately
  // rather than as a total. `calls_reported` is how many of `model_calls.count`
  // carried any usage at all: when it is lower, these sums cover only part of the run
  // and a cost derived from them is a floor, not an estimate.
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    calls_reported: number;
  };
  // Per-agent totals are the attribution that matters for both halves of the bill:
  // which agent is slow, and which one is expensive. They are not the same agent.
  //
  // All four token counts, not just input and output: `input_tokens` excludes what was
  // read from the cache, so on a deployment that caches, a two-field split understates
  // an agent's prompt by exactly its cached share — and understates it worst for the
  // agent that caches best, which inverts the answer the split exists to give. Keyed as
  // the log line keys them, so the names that cross the adapter/diagnostics seam are the
  // same ones in both places.
  by_agent: Record<
    string,
    {
      count: number;
      total_ms: number;
      max_ms: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    }
  >;
  slowest_calls: { agent: string; model: string; capability: string; duration_ms: number; ok: boolean }[];
  errors: { ts: string | null; type: string; message: string }[];
  // Source pages whose own extraction threw, so the delivered document carries a
  // failure marker instead of that page's content (pipeline/extraction.ts
  // `failedPage`). Its own field because a run that ends `ready_for_review` with a
  // page missing is otherwise indistinguishable here from one that delivered the
  // whole document: the failed model call underneath shows up in `errors` exactly as
  // a retried-and-recovered one does, and `status` says the run succeeded — which it
  // did, on 24 of 25 pages.
  pages_failed: number[];
}

function parse(logText: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

const ms = (a?: string, b?: string): number =>
  a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : 0;

export function summarizeRun(
  logText: string,
  ctx: { sessionId: string; status: string; phase: string; now: number },
): Diagnostics {
  const events = parse(logText);
  const running = ctx.status === "running" || ctx.status === "queued";
  const nowIso = new Date(ctx.now).toISOString();

  const startedAt = events[0]?.ts ?? null;
  const lastEventAt = events.length ? events[events.length - 1].ts ?? null : null;
  const terminal = events.find((e) => e.type === "run_complete" || e.type === "run_failed");
  const endRef = running ? nowIso : terminal?.ts ?? lastEventAt ?? nowIso;

  // In-flight detection. Extraction runs several pages concurrently, so more
  // than one call can be open at once and start/end events interleave. Match
  // them by identity (agent+model+capability) rather than position: each end
  // event closes the OLDEST matching open start, which is the same pairing a
  // FIFO queue would produce. `in_flight` reports the longest-waiting open call
  // — the best single answer to "what is this run stuck on?" — and
  // `in_flight_count` shows how many are outstanding.
  const openCalls: LogEvent[] = [];
  const callKey = (e: LogEvent): string =>
    `${e.agent ?? "?"}|${e.model ?? "?"}|${e.capability ?? "?"}`;
  for (const e of events) {
    if (e.type === "model_call_start") {
      openCalls.push(e);
    } else if (e.type === "model_call") {
      const i = openCalls.findIndex((o) => callKey(o) === callKey(e));
      // Fall back to dropping the oldest open call if no identity match: an end
      // event always closes something, and leaving it open would report a
      // phantom hang.
      openCalls.splice(i === -1 ? 0 : i, 1);
    }
  }
  // Longest-waiting first (oldest start timestamp).
  openCalls.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  const oldest = openCalls[0];
  const inFlight =
    running && oldest
      ? {
          agent: oldest.agent ?? "?",
          model: oldest.model ?? "?",
          provider: oldest.provider ?? "?",
          capability: oldest.capability ?? "?",
          since: oldest.ts ?? nowIso,
          waiting_ms: ms(oldest.ts, nowIso),
        }
      : null;
  const inFlightCount = running ? openCalls.length : 0;

  // Completed model calls (the `model_call` end events carry duration_ms).
  const calls = events.filter((e) => e.type === "model_call");
  const durations = calls.map((c) => c.duration_ms ?? 0);
  const failed = calls.filter((c) => c.ok === false).length;
  const total = durations.reduce((a, b) => a + b, 0);

  // Token totals, and how many calls contributed any. Counted over the same `calls`
  // as the timings, which includes the failed ones: a truncated call paid for a full
  // ceiling of output and a stalled one paid for its prompt, so excluding them would
  // under-report the bill on exactly the documents that cost the most.
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, calls_reported: 0 };

  const byAgent: Diagnostics["by_agent"] = {};
  for (const c of calls) {
    const k = c.agent ?? "?";
    const cur =
      byAgent[k] ??
      {
        count: 0,
        total_ms: 0,
        max_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
    cur.count += 1;
    cur.total_ms += c.duration_ms ?? 0;
    cur.max_ms = Math.max(cur.max_ms, c.duration_ms ?? 0);
    cur.input_tokens += c.input_tokens ?? 0;
    cur.output_tokens += c.output_tokens ?? 0;
    cur.cache_read_input_tokens += c.cache_read_input_tokens ?? 0;
    cur.cache_creation_input_tokens += c.cache_creation_input_tokens ?? 0;
    byAgent[k] = cur;

    const reported =
      c.input_tokens != null ||
      c.output_tokens != null ||
      c.cache_read_input_tokens != null ||
      c.cache_creation_input_tokens != null;
    if (reported) tokens.calls_reported += 1;
    tokens.input += c.input_tokens ?? 0;
    tokens.output += c.output_tokens ?? 0;
    tokens.cache_read += c.cache_read_input_tokens ?? 0;
    tokens.cache_write += c.cache_creation_input_tokens ?? 0;
  }

  const slowest = [...calls]
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, 5)
    .map((c) => ({
      agent: c.agent ?? "?",
      model: c.model ?? "?",
      capability: c.capability ?? "?",
      duration_ms: c.duration_ms ?? 0,
      ok: c.ok !== false,
    }));

  // Phase durations from explicit `phase` events (diff to next, last to end).
  const phaseEvents = events.filter((e) => e.type === "phase" && e.phase);
  const phaseDurations: Record<string, number> = {};
  for (let i = 0; i < phaseEvents.length; i++) {
    const cur = phaseEvents[i];
    const next = phaseEvents[i + 1];
    phaseDurations[cur.phase as string] = ms(cur.ts, next ? next.ts : endRef);
  }

  const errors = events
    .filter((e) => e.type === "run_failed" || e.ok === false)
    .map((e) => ({ ts: e.ts ?? null, type: e.type ?? "error", message: e.error ?? "unknown" }));

  // Which pages the document has no content for — a set, and a set that changes over
  // the life of one session's log, because a feedback round can re-extract a page that
  // failed earlier and fill the hole. So this is a fold over the events in order rather
  // than a filter: `page_extraction_failed` adds, `page_recovered` removes, and what the
  // log says LAST about a page is what is true of the document.
  //
  // `kept: "prior"` is excluded, because that event reports the opposite outcome under
  // the same name: a re-extraction that threw left the page's earlier content in place,
  // so the document is whole and naming the page here would send a client looking for a
  // hole that isn't there (pipeline/extraction.ts reExtractPages). Which is also why a
  // recovered page stays recovered: after the hole is filled, the page HAS content, so
  // every later failure on it is one of these.
  const failedSet = new Set<number>();
  for (const e of events) {
    if (e.type === "page_extraction_failed" && typeof e.page === "number" && e.kept !== "prior") {
      failedSet.add(e.page);
    } else if (e.type === "page_recovered" && Array.isArray(e.pages)) {
      for (const p of e.pages) if (typeof p === "number") failedSet.delete(p);
    }
  }
  const pagesFailed = [...failedSet].sort((a, b) => a - b);

  const elapsed = ms(startedAt ?? undefined, endRef);

  return {
    session_id: ctx.sessionId,
    status: ctx.status,
    phase: ctx.phase,
    started_at: startedAt,
    last_event_at: lastEventAt,
    elapsed_ms: elapsed,
    in_flight: inFlight,
    in_flight_count: inFlightCount,
    phase_durations_ms: phaseDurations,
    model_calls: {
      count: calls.length,
      failed,
      total_ms: total,
      avg_ms: calls.length ? Math.round(total / calls.length) : 0,
      max_ms: durations.length ? Math.max(...durations) : 0,
      concurrency_factor: elapsed > 0 ? Math.round((total / elapsed) * 100) / 100 : 0,
    },
    tokens,
    by_agent: byAgent,
    slowest_calls: slowest,
    errors,
    pages_failed: pagesFailed,
  };
}
