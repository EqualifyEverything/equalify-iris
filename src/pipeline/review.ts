import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type PipelineContext } from "./context.ts";
import { wrapDocument } from "./assembly.ts";
import { runAxe, type LintResult } from "./lint.ts";
import { flatten } from "./flatten.ts";
import { examplesForPrompt } from "./memory.ts";

export interface ReviewIssue {
  issue: string;
  severity: "low" | "medium" | "high";
  suggested_action: string;
}

export interface ReviewResult {
  html: string; // full document
  body: string;
  iterationsCompleted: number;
  unresolved: ReviewIssue[];
  lint: LintResult;
}

const READER_SYSTEM = `You are the Reader Agent. You review accessible HTML for reading-order problems, semantic
inconsistencies, duplicated/redundant content, and missed WCAG 2.2 AA requirements. You do NOT
see source images — you read the document the way a screen-reader user would.

You get two views of the same content: the HTML (structural reference) and a flattened
text-only view (what a screen reader announces, in order). Cross-check them, and also consider
the axe-core lint results provided.

Respond with ONLY JSON:
{ "issues": [ { "issue": "...", "severity": "low|medium|high", "suggested_action": "..." } ] }
Return {"issues": []} when the document is clean.`;

const EDITOR_SYSTEM = `You are the Copy Editor Agent. You are given an accessible HTML document (body content only),
a list of issues found by the reviewer, and the source page image(s). Return a corrected
version of the FULL body that resolves every issue you can.

You may do whatever it takes to fix the issues: remove duplicated or redundant content
(e.g. the same content rendered as both a form and a table — keep the best single
representation), reorder blocks, fix heading hierarchy, correct labels and table headers, etc.
Preserve all genuine content and transcribed text; do not invent content. Output ONLY the
corrected body (no <html>/<head>/<body> wrapper).

Respond with ONLY JSON: { "html": "<corrected body content>" }`;

const CHUNK_BUDGET = 24000;
const CHUNK_OVERLAP = 2000;

function chunk(s: string): string[] {
  if (s.length <= CHUNK_BUDGET) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    out.push(s.slice(start, start + CHUNK_BUDGET));
    start += CHUNK_BUDGET - CHUNK_OVERLAP;
  }
  return out;
}

function lintSummary(lint: LintResult): string {
  if (lint.error) return `axe-core could not run (${lint.error})`;
  if (lint.ok) return "axe-core: no violations";
  return lint.violations.map((v) => `- ${v.id} (${v.impact}): ${v.description} [${v.nodes} nodes]`).join("\n");
}

async function runReader(ctx: PipelineContext, body: string, lint: LintResult): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  for (const c of chunk(body)) {
    const user =
      `## HTML\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## axe-core lint\n${lintSummary(lint)}` +
      feedbackPreamble(ctx) +
      examplesForPrompt(ctx.paths, "page.md", ["a11y_policy"]);
    const res = await ctx.router.complete("reader", "text", [
      { role: "system", content: READER_SYSTEM },
      { role: "user", content: user },
    ]);
    ctx.log.agentCall({
      agent: { name: "reader", file: "reader.md", content: READER_SYSTEM, capabilities: ["text"], sha: null, sessionBuilt: false },
      phase: "review",
      output: res.text,
    });
    const parsed = extractJson<{ issues?: ReviewIssue[] }>(res.text);
    if (parsed?.issues?.length) issues.push(...parsed.issues);
  }
  return issues;
}

// Document-level correction: the editor sees the whole body + all issues + the
// source images and returns a corrected document, so it can fix structural
// problems (dedup, reorder, heading hierarchy) that per-block editing cannot.
async function runEditor(ctx: PipelineContext, body: string, issues: ReviewIssue[]): Promise<string> {
  const images = ctx.images.map(loadImage);
  const user =
    `## Current document (body content)\n${body}\n\n` +
    `## Issues to fix\n${issues.map((i) => `- [${i.severity}] ${i.issue} — ${i.suggested_action}`).join("\n")}\n\n` +
    `The source page image(s) are attached in order. Return the complete corrected body.` +
    feedbackPreamble(ctx);
  const res = await ctx.router.complete(
    "copy_editor",
    images.length ? "vision" : "text",
    [
      { role: "system", content: EDITOR_SYSTEM },
      { role: "user", content: user },
    ],
    { images },
  );
  ctx.log.agentCall({
    agent: { name: "copy_editor", file: "copy_editor.md", content: EDITOR_SYSTEM, capabilities: ["vision"], sha: null, sessionBuilt: false },
    phase: "review",
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  // If the editor returns nothing usable, keep the current body unchanged.
  return parsed?.html?.trim() || body;
}

// Reader -> Editor -> re-verify, looping until the Reader reports zero issues or
// the iteration cap is reached. The loop only stops clean when the Reader has
// actually re-confirmed it, so reported issues are verified-fixed, not assumed.
export async function runReview(
  ctx: PipelineContext,
  initial: { body: string; lint: LintResult },
): Promise<ReviewResult> {
  let body = initial.body;
  let lint = initial.lint;
  let iterations = 0;
  let lastIssues: ReviewIssue[] = [];

  while (iterations <= ctx.maxReviewIterations) {
    const issues = await runReader(ctx, body, lint);
    lastIssues = issues;
    ctx.log.event("reader", { iteration: iterations, issues: issues.length });
    if (issues.length === 0) {
      return { html: wrapDocument(body), body, iterationsCompleted: iterations, unresolved: [], lint };
    }
    if (iterations === ctx.maxReviewIterations) break; // cap reached, issues remain

    iterations++;
    body = await runEditor(ctx, body, issues);
    lint = await runAxe(wrapDocument(body));
    ctx.log.event("editor", { iteration: iterations });
  }

  // Cap reached with issues remaining (§7.11): record them as a comment.
  const unresolvedLines = lastIssues.map((i) => `${i.issue} (severity: ${i.severity})`);
  return {
    html: wrapDocument(body, { unresolved: unresolvedLines }),
    body,
    iterationsCompleted: iterations,
    unresolved: lastIssues,
    lint,
  };
}
