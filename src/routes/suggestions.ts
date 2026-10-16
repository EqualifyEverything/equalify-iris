import { Router } from "express";
import type { Store, SuggestionRow } from "../store/db.ts";
import { bearer, tokenMatches } from "./quality.ts";

// How many sample pages and reasons each group carries.
const SAMPLES = 10;

// The grouping key for a suggested agent name: lower case, letters and digits only,
// with a trailing "agent" or "specialist" dropped. `scientificFigureAgent` and
// `scientific-figure` share one key. The workflow merges keys that mean the same thing.
export function suggestionKey(name: string): string {
  let k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (;;) {
    const next = k.replace(/(agent|specialist)$/, "");
    if (next === k || !next) return k;
    k = next;
  }
}

interface NewAgentGroup {
  key: string;
  names: { name: string; count: number }[];
  count: number;
  sessions: number;
  first_seen: string;
  last_seen: string;
  pages: { session_id: string; page: string }[];
  reasons: string[];
}

interface AgentUpdateGroup {
  agent: string;
  lesson_slug: string | null;
  count: number;
  sessions: number;
  first_seen: string;
  last_seen: string;
  latest: unknown;
}

export interface SuggestionsReport {
  new_agents: NewAgentGroup[];
  agent_updates: AgentUpdateGroup[];
}

// Group every recorded suggestion. Rows arrive oldest first, so the samples kept are
// the most recent ones.
export function groupSuggestions(rows: SuggestionRow[]): SuggestionsReport {
  const agents = new Map<string, NewAgentGroup & { _names: Map<string, number>; _sessions: Set<string> }>();
  const updates = new Map<string, AgentUpdateGroup & { _sessions: Set<string> }>();
  for (const r of rows) {
    const at = r.recorded_at ?? "";
    if (r.kind === "new_agent") {
      const key = suggestionKey(r.agent);
      if (!key) continue;
      let g = agents.get(key);
      if (!g) {
        g = { key, names: [], count: 0, sessions: 0, first_seen: at, last_seen: at, pages: [], reasons: [],
          _names: new Map(), _sessions: new Set() };
        agents.set(key, g);
      }
      g.count++;
      g._names.set(r.agent, (g._names.get(r.agent) ?? 0) + 1);
      g._sessions.add(r.session_id);
      g.last_seen = at;
      g.pages.push({ session_id: r.session_id, page: r.page ?? "" });
      if (g.pages.length > SAMPLES) g.pages.shift();
      const reason = r.reason?.trim();
      if (reason && !g.reasons.includes(reason)) {
        g.reasons.push(reason);
        if (g.reasons.length > SAMPLES) g.reasons.shift();
      }
    } else {
      const detail = (r.detail ?? {}) as { lesson_slug?: string | null };
      const slug = detail.lesson_slug ?? null;
      const id = `${r.agent}\0${slug ?? ""}`;
      let g = updates.get(id);
      if (!g) {
        g = { agent: r.agent, lesson_slug: slug, count: 0, sessions: 0, first_seen: at, last_seen: at,
          latest: null, _sessions: new Set() };
        updates.set(id, g);
      }
      g.count++;
      g._sessions.add(r.session_id);
      g.last_seen = at;
      g.latest = { session_id: r.session_id, ...detail };
    }
  }
  const new_agents = [...agents.values()]
    .map(({ _names, _sessions, ...g }) => ({
      ...g,
      names: [..._names].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      sessions: _sessions.size,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const agent_updates = [...updates.values()]
    .map(({ _sessions, ...g }) => ({ ...g, sessions: _sessions.size }))
    .sort((a, b) => b.count - a.count);
  return { new_agents, agent_updates };
}

/**
 * `GET /v1/suggestions` — every agent suggestion this deployment has recorded, grouped
 * (#539). Read by `.github/workflows/agent-suggestions.yml`, which files the issues.
 *
 * Guarded by `server.quality_token`, the same token as `/v1/quality`, because the same
 * CI job holds it. Unset means 404.
 */
export function suggestionsRouter(store: Store, cfg: { quality_token?: string }): Router {
  const r = Router();
  r.get("/", (req, res) => {
    const configured = cfg.quality_token?.trim();
    if (!configured) {
      res.status(404).json({
        error: "not_found",
        message: "Suggestions are not enabled on this deployment. Set server.quality_token in config to enable them.",
      });
      return;
    }
    const presented = bearer(req.header("authorization"));
    if (!presented || !tokenMatches(presented, configured)) {
      res.status(401).json({ error: "unauthorized", message: "A valid bearer token is required." });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json(groupSuggestions(store.listSuggestions()));
  });
  return r;
}
