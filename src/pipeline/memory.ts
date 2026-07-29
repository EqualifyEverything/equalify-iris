import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function saveExamples(paths: Paths, agentFile: string, examples: CorrectionExample[]): void {
  const path = paths.agentMemory(agentFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(examples, null, 2));
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
