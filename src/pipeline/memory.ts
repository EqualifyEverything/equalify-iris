import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Paths } from "../store/paths.ts";

// Agent memory (PRD §7.12, extended): instead of rewriting an agent's prompt when
// it makes a mistake, we accumulate generalized "lessons" learned from real user
// feedback and inject the corroborated ones into the agent's prompt at run time.
// Examples are easy to add, audit, and remove — and they don't rot the prompt.

export type LessonKind = "generalizable" | "a11y_policy";

export interface CorrectionExample {
  agent: string; // agent file, e.g. "page.md"
  kind: LessonKind;
  instruction: string; // the generalized lesson (one sentence)
  before: string; // localized wrong output this targets (may be "")
  after: string; // localized corrected output (may be "")
  feedback: string; // the user feedback that produced it
  sessions: string[]; // distinct sessions that surfaced this lesson
  count: number; // = sessions.length (denormalized for convenience)
  created_at: string;
  updated_at: string;
}

const MAX_EXAMPLES_PER_AGENT = 20;
// How many examples to inject into a single prompt at most.
const MAX_INJECTED = 6;
// A "generalizable" lesson must be seen in at least this many distinct sessions
// before it is injected or proposed — one user's idiosyncratic correction should
// not steer a shared agent (corroboration). Accessibility-policy lessons are
// exempt: a WCAG rule shouldn't need to recur to be worth applying.
export const CORROBORATION_THRESHOLD = 2;
// Keep injected before/after snippets short so the prompt stays lean.
const SNIPPET_CAP = 280;

function normKey(instruction: string): string {
  return instruction.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// How many words / characters of a lesson go into its slug. Long enough that two
// unrelated lessons rarely share one, short enough to sit in an issue title next to
// the agent name.
const SLUG_WORDS = 8;
const SLUG_CHARS = 60;
// Words that read as truncation damage when the cut lands after them ("…from the source
// document including"). Trimmed off the tail only — inside the slug they carry meaning,
// and dropping them there would make two different lessons more likely to collide.
const TRAILING_FILLER = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "including", "into",
  "of", "on", "or", "so", "than", "that", "the", "to", "when", "which", "with",
]);

/**
 * A short, stable identifier for a lesson — the discriminator in the title of the
 * issue that proposes it (`Agent update proposal: page — preserve all hyperlinks…`).
 *
 * It exists because that title is the only dedupe key those issues have, and without a
 * discriminator the key had exactly one possible value. `agentFile` on the feedback
 * path is hardcoded to `page.md` (pipeline/orchestrator.ts), so every proposal from
 * every user computed the same title, `Agent update proposal: page` — and a dedupe that
 * skips when an open issue with that title exists could then never do anything but
 * skip. One open issue silently swallowed every later lesson from every user for as
 * long as it stayed open. Seen on the UIC deployment: one issue blocked the path for a
 * day, and the three filed before it only got through because GitHub's search index
 * lagged behind the filing.
 *
 * Built on `normKey` deliberately, so the slug agrees with the bank's own notion of
 * lesson identity: two instructions `recordExample` folds into ONE entry slug
 * identically, and so dedupe to one issue. Derive it from a recorded lesson's
 * `instruction` rather than from a model-written summary wherever possible — the
 * instruction is what gets corroborated across sessions and is therefore stable, while
 * a summary is re-worded on every run and would slip past the match every time.
 *
 * Two distinct lessons whose first several words coincide collide onto one issue. That
 * is the accepted direction to fail in: an extra comment on a related issue is
 * recoverable, and silence is what this whole function exists to stop.
 */
export function lessonSlug(instruction: string): string {
  const kept: string[] = [];
  let chars = 0;
  for (const w of normKey(instruction).split(" ").filter(Boolean).slice(0, SLUG_WORDS)) {
    const next = chars + w.length + (kept.length ? 1 : 0); // +1 for the joining space
    // Never emit a partial word, and never emit nothing when the first word alone is
    // over the cap — a one-word slug still discriminates, an empty one does not.
    if (kept.length && next > SLUG_CHARS) break;
    kept.push(w);
    chars = next;
  }
  while (kept.length > 1 && TRAILING_FILLER.has(kept[kept.length - 1])) kept.pop();
  return kept.join(" ");
}

function cap(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET_CAP ? `${t.slice(0, SNIPPET_CAP)}…` : t;
}

export function loadExamples(paths: Paths, agentFile: string): CorrectionExample[] {
  const path = paths.agentMemory(agentFile);
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? (arr as CorrectionExample[]) : [];
  } catch {
    return [];
  }
}

// Written to a temporary file and renamed into place, so a reader never sees half of
// it. The bank is SHARED — it is keyed by agent file, not by session — and
// `defaults.max_concurrent_runs` allows more than one run at a time, so a page being
// extracted in one run can read this file while another run is recording a lesson to it.
// A plain write is not atomic, and `loadExamples` answers a partial read by returning
// `[]`: the page would be extracted with no lessons at all, including the
// accessibility-policy ones, and nothing would say so. Rename within a directory is
// atomic on POSIX and on Windows (ReplaceFile semantics), which makes that read either
// the old bank or the new one.
function saveExamples(paths: Paths, agentFile: string, examples: CorrectionExample[]): void {
  const path = paths.agentMemory(agentFile);
  mkdirSync(dirname(path), { recursive: true });
  // Same directory as the target, because rename is only atomic within a filesystem, and
  // named per process so two runs cannot collide on the temporary itself.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(examples, null, 2));
  renameSync(tmp, path);
}

export interface RecordInput {
  agent: string;
  kind: LessonKind;
  instruction: string;
  before: string;
  after: string;
  feedback: string;
  session: string;
}

// Record (or corroborate) a lesson. Dedupe by normalized instruction: a matching
// lesson bumps its distinct-session count (corroboration) and refreshes its
// example; a new lesson is appended. The bank is pruned to the most-corroborated,
// most-recent MAX_EXAMPLES_PER_AGENT entries. Returns the stored example.
export function recordExample(paths: Paths, input: RecordInput): CorrectionExample {
  const agent = input.agent.endsWith(".md") ? input.agent : `${input.agent}.md`;
  const examples = loadExamples(paths, agent);
  const key = normKey(input.instruction);
  const now = new Date().toISOString();

  let entry = examples.find((e) => normKey(e.instruction) === key);
  if (entry) {
    if (!entry.sessions.includes(input.session)) entry.sessions.push(input.session);
    entry.count = entry.sessions.length;
    entry.updated_at = now;
    entry.kind = input.kind;
    entry.before = input.before;
    entry.after = input.after;
    entry.feedback = input.feedback;
  } else {
    entry = {
      agent,
      kind: input.kind,
      instruction: input.instruction.trim(),
      before: input.before,
      after: input.after,
      feedback: input.feedback,
      sessions: [input.session],
      count: 1,
      created_at: now,
      updated_at: now,
    };
    examples.push(entry);
  }

  examples.sort((a, b) => b.count - a.count || b.updated_at.localeCompare(a.updated_at));
  saveExamples(paths, agent, examples.slice(0, MAX_EXAMPLES_PER_AGENT));
  return entry;
}

// The lessons eligible to act on: a11y-policy lessons always, generalizable
// lessons once corroborated across enough sessions.
export function eligibleExamples(paths: Paths, agentFile: string, kinds?: LessonKind[]): CorrectionExample[] {
  return loadExamples(paths, agentFile)
    .filter((e) => !kinds || kinds.includes(e.kind))
    .filter((e) => e.kind === "a11y_policy" || e.count >= CORROBORATION_THRESHOLD)
    .sort((a, b) => b.count - a.count || b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_INJECTED);
}

// Render the eligible lessons as a few-shot block to append to an agent prompt.
// Returns "" when there is nothing eligible (so callers can append unconditionally).
export function examplesForPrompt(paths: Paths, agentFile: string, kinds?: LessonKind[]): string {
  const eligible = eligibleExamples(paths, agentFile, kinds);
  if (eligible.length === 0) return "";
  const lines = eligible.map((e, i) => {
    const demo = e.before && e.after ? `\n   - was: ${cap(e.before)}\n   - fix: ${cap(e.after)}` : "";
    return `${i + 1}. ${e.instruction}${demo}`;
  });
  return (
    `\n\n## Lessons from past corrections (apply when they're relevant to THIS page)\n` +
    `${lines.join("\n")}\n`
  );
}
