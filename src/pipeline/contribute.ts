import { readdirSync } from "node:fs";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import type { PipelineContext } from "./context.ts";
import type { SuggestionRow } from "../store/db.ts";

// The content types the general page pass covers itself. A
// suggestion naming one of these is declined rather than dispatched, and never
// recorded as a new agent to build (see extraction.ts).
//
// These were nine agent FILES until they were deleted as unreachable: every one of
// them was declined by name here before `loadAgent` was ever called, so no run
// could reach them. The list outlived the files because it was never really a
// mirror of the library — it is the boundary of what one whole-page vision call
// handles, which is exactly the question a suggestion asks. Keeping it as data
// rather than as a directory listing also makes the decline independent of what
// happens to be on disk: a deployment that drops a file into `agents/` named
// `table.md` still does not get a second rendering of a table spliced over the
// page's own.
export const STANDARD = new Set([
  "paragraph", "heading", "list", "table", "formField", "image", "quote", "caption", "footnote",
]);

const STANDARD_LOWER = new Set([...STANDARD].map((s) => s.toLowerCase()));

// The one way a suggestion's name is turned into a logical agent type, shared by both
// places that decide what to do with one (this file's contribution filter and
// extraction.ts's dispatch). It exists because the two used to normalize separately and
// drifted: trim-then-strip versus strip-then-trim disagreed on `"table.md "`.
//
// Trim before stripping the extension, not after — the other order leaves `"table.md "`
// as `"table.md"`, which is not a standard name, so a padded standard type gets past
// the filter. Then trim again, for `" table .md"`.
export function logicalType(name: string): string {
  return name.trim().replace(/\.md$/, "").trim();
}

// Whether a suggestion names a content type the general page pass already covers.
//
// Case-insensitive, because the name is free text a model wrote and the consequence of
// a miss is not symmetric. `STANDARD` spells one entry `formField`, so `"FormField"` or
// `"Table"` — spellings a model will produce, since these are prose descriptions of
// content types and not filenames — used to fall through and be filed as a public issue
// proposing a specialist for a type the page pass has always handled. A false decline
// costs one specialist that the page pass covers anyway; a false accept costs a spurious
// proposal on a public tracker.
//
// This used to be backstopped by `loadAgent` finding `agents/table.md` — on a
// case-insensitive volume, `agents/Table.md` too. Those nine files are gone (they
// were unreachable), so this predicate is the whole filter.
// Takes a name ALREADY through `logicalType`, and does not re-normalize. An earlier
// version called `logicalType` here as well, which was worse than redundant: both call
// sites pass a normalized name, so `"table.md "` got its extension stripped twice and
// arrived as `"table"` no matter what `logicalType` did — the double strip silently
// covered for a broken normalizer, and a sabotage of `logicalType` went undetected here
// while failing at the dispatch site. One normalization, at the call site, where it is
// visible.
export function isStandardType(logical: string): boolean {
  return STANDARD_LOWER.has(logical.toLowerCase());
}

// The key that groups spellings of one agent name: lowercase letters and digits, with a
// trailing "agent" or "specialist" dropped. `chartData`, `ChartDataAgent` and
// `chart-data-specialist` share one key. GET /v1/suggestions groups by it too.
export function suggestionKey(name: string): string {
  let k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (;;) {
    const next = k.replace(/(agent|specialist)$/, "");
    if (next === k || !next) return k;
    k = next;
  }
}

// The agent a suggestion names: the file of that exact name, or else the one library
// specialist whose name has the same key. The page agent wrote `chartData` while the file is
// chartDataAgent.md, and an exact match alone never ran it. Never resolves to page.md,
// feedback.md or a standard type.
export function findSpecialist(ctx: PipelineContext, logical: string): AgentSpec | null {
  const dirs = { agentsDir: ctx.paths.agentsDir, tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId) };
  const exact = loadAgent(logical, dirs);
  if (exact) return exact;
  const key = suggestionKey(logical);
  let files: string[];
  try {
    files = readdirSync(ctx.paths.agentsDir);
  } catch {
    return null;
  }
  const match = files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((n) => n !== "page" && n !== "feedback" && !isStandardType(n) && suggestionKey(n) === key);
  return match.length === 1 ? loadAgent(match[0], dirs) : null;
}

export interface Suggestion {
  name: string;
  reason: string;
  image: string;
}

// Record each genuinely new suggested agent type (#539). Iris only records; a scheduled
// workflow (.github/workflows/agent-suggestions.yml) reads GET /v1/suggestions, groups
// the names and files the issues.
export function recordSuggestions(ctx: PipelineContext, suggestions: Suggestion[]): void {
  if (!ctx.recordSuggestions || suggestions.length === 0) return;
  const rows: SuggestionRow[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    // Normalized and tested for standardness the same way dispatchSpecialist does it —
    // one shared pair of functions, because when the two normalized separately they
    // disagreed.
    const name = logicalType(s.name);
    const key = `${name.toLowerCase()}\0${s.image}`;
    if (!name || isStandardType(name) || seen.has(key)) continue;
    seen.add(key);
    // Skip if the library (or this session) already has the agent.
    if (findSpecialist(ctx, name)) continue;
    rows.push({ kind: "new_agent", agent: name, session_id: ctx.sessionId, page: s.image, reason: s.reason || null });
  }
  if (rows.length === 0) return;
  ctx.recordSuggestions(rows);
  ctx.log.event("suggestions_recorded", { agents: [...new Set(rows.map((r) => r.agent))], count: rows.length });
}
