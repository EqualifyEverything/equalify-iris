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
  by_agent: Record<string, { count: number; total_ms: number; max_ms: number }>;
  slowest_calls: { agent: string; model: string; capability: string; duration_ms: number; ok: boolean }[];
  errors: { ts: string | null; type: string; message: string }[];
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

  const byAgent: Diagnostics["by_agent"] = {};
  for (const c of calls) {
    const k = c.agent ?? "?";
    const cur = byAgent[k] ?? { count: 0, total_ms: 0, max_ms: 0 };
    cur.count += 1;
    cur.total_ms += c.duration_ms ?? 0;
    cur.max_ms = Math.max(cur.max_ms, c.duration_ms ?? 0);
    byAgent[k] = cur;
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
    by_agent: byAgent,
    slowest_calls: slowest,
    errors,
  };
}
