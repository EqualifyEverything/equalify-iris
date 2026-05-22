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
  in_flight: null | {
    agent: string;
    model: string;
    provider: string;
    capability: string;
    since: string;
    waiting_ms: number;
  };
  phase_durations_ms: Record<string, number>;
  model_calls: { count: number; failed: number; total_ms: number; avg_ms: number; max_ms: number };
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

  // In-flight detection: pipeline is sequential, so at most one call is open.
  let openCall: LogEvent | null = null;
  for (const e of events) {
    if (e.type === "model_call_start") openCall = e;
    else if (e.type === "model_call") openCall = null;
  }
  const inFlight =
    running && openCall
      ? {
          agent: openCall.agent ?? "?",
          model: openCall.model ?? "?",
          provider: openCall.provider ?? "?",
          capability: openCall.capability ?? "?",
          since: openCall.ts ?? nowIso,
          waiting_ms: ms(openCall.ts, nowIso),
        }
      : null;

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

  return {
    session_id: ctx.sessionId,
    status: ctx.status,
    phase: ctx.phase,
    started_at: startedAt,
    last_event_at: lastEventAt,
    elapsed_ms: ms(startedAt ?? undefined, endRef),
    in_flight: inFlight,
    phase_durations_ms: phaseDurations,
    model_calls: {
      count: calls.length,
      failed,
      total_ms: total,
      avg_ms: calls.length ? Math.round(total / calls.length) : 0,
      max_ms: durations.length ? Math.max(...durations) : 0,
    },
    by_agent: byAgent,
    slowest_calls: slowest,
    errors,
  };
}
