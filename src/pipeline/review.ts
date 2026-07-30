import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { wrapDocument } from "./assembly.ts";
import { runAxe, type LintResult } from "./lint.ts";
import { flatten } from "./flatten.ts";
import { examplesForPrompt } from "./memory.ts";
import { knownPages, pageIndex, type IndexedPage } from "./pageindex.ts";

export interface ReviewIssue {
  issue: string;
  severity: "low" | "medium" | "high";
  suggested_action: string;
  // Source attribution (PRD §7.8, amended v1.1): the 1-based source pages this
  // issue is on. Empty when the Reader could not attribute it — the document is
  // delivered without provenance comments (§7.4 v1.1), so page numbers are the
  // only reference available, and the Reader is told not to guess.
  pages?: number[];
}

export interface ReviewResult {
  html: string; // full document
  body: string;
  iterationsCompleted: number;
  unresolved: ReviewIssue[];
  lint: LintResult;
}

// Exported so a test can assert the marker vocabulary it advertises is the one
// `flatten` actually emits: a marker the prompt promises but the code never produces
// teaches the Reader to expect something that will not appear.
export const READER_SYSTEM = `You are the Reader Agent. You review accessible HTML for reading-order problems, semantic
inconsistencies, duplicated/redundant content, and missed WCAG 2.2 AA requirements. You do NOT
see source images — you read the document the way a screen-reader user would.

You get two views of the same content: the HTML (structural reference) and a flattened
text-only view (what a screen reader announces, in order). Cross-check them, and also consider
the axe-core lint results provided.

In the flattened view, anything in square brackets is a structural annotation, not content:
[Heading 1-6], [List item], [Link], [Image], [Image alt], [Table], [Header row], [Row],
[Field input|textarea|select|button|summary], [Label], [Quote], [Caption], [Term],
[Definition], plus [N rows, M columns], [empty], [no caption], [spans N columns],
[spans N rows], [alt missing] and [decorative, alt empty]. A field's own announced name
follows its marker, so [Field input text] with nothing after it is a control with no
accessible name at all. Tables are expanded row by row with cells separated by " | ".

Treat a table that reports [0 rows], a [Field ...] with nothing announced after it, and an
[Image] [alt missing] as evidence of a real problem. Do NOT report these, which are correct
markup: [decorative, alt empty] (an empty alt is right for a decorative image); a row with
fewer cells than the table has columns, when some cell is marked [spans N columns] or
[spans N rows]; or a field whose name follows its marker but which has no separate [Label]
line, since the name may come from an attribute.

You are also given an index of the document's source pages (page number + an excerpt of the
HTML extracted from that page). For every issue, attribute it to the source "pages" it appears
on, by matching the offending content against those excerpts. This is what lets the Copy Editor
fetch the right page images. Name only pages you have concrete evidence for; if you cannot tell
which page an issue is on, return an empty "pages" list rather than guessing or listing them all.

Respond with ONLY JSON:
{ "issues": [ { "issue": "...", "pages": [3], "severity": "low|medium|high", "suggested_action": "..." } ] }
Return {"issues": []} when the document is clean.`;

const EDITOR_SYSTEM = `You are the Copy Editor Agent. You are given an accessible HTML document (body content only),
a list of issues found by the reviewer, and the source page image(s) for the pages those issues
were attributed to. Return a corrected version of the FULL body that resolves every issue you can.

You may do whatever it takes to fix the issues: remove duplicated or redundant content
(e.g. the same content rendered as both a form and a table — keep the best single
representation), reorder blocks, fix heading hierarchy, correct labels and table headers, etc.
Preserve all genuine content and transcribed text; do not invent content. Content on pages whose
image is NOT attached must be carried over unchanged unless an issue names it. Output ONLY the
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

// The page index is repeated on every Reader call (once per chunk per round), so
// excerpts are shorter here than the scoping call's — just enough to match content
// back to a page.
const READER_INDEX_EXCERPT_CHARS = 200;

async function runReader(
  ctx: PipelineContext,
  body: string,
  lint: LintResult,
  pages: IndexedPage[],
): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const index = pages.length ? pageIndex(pages, READER_INDEX_EXCERPT_CHARS) : "";
  for (const c of chunk(body)) {
    const user =
      `## HTML\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## axe-core lint\n${lintSummary(lint)}` +
      (index ? `\n\n## Source pages in this document (extracted HTML, truncated)\n${index}` : "") +
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
    const parsed = extractJson<{ issues?: (ReviewIssue & { pages?: unknown })[] }>(res.text);
    for (const i of parsed?.issues ?? []) {
      // Drop hallucinated page numbers here rather than downstream, so a bad
      // attribution degrades to "no attribution" (all images) instead of
      // silently sending the editor the wrong page.
      issues.push({ ...i, pages: knownPages(i.pages, pages) });
    }
  }
  return issues;
}

// Which source images the Copy Editor needs this round: the union of the pages the
// Reader attributed its issues to — but ONLY when it attributed every issue.
//
// One unattributed issue re-broadens the whole round to every image. This follows
// the same asymmetric-cost bias as the rest of the pipeline: narrowing wrongly can
// leave an issue permanently unfixable, while broadening wrongly costs no more than
// the behaviour this optimization replaced.
//
// The tempting alternative — narrow to whatever WAS attributed and let the loop
// recover later — is worse than it looks. An unattributed issue is usually
// structural (duplication, reading order, heading levels) and fixable from the HTML
// alone, but it is also what you get when the editor has rewritten the body far
// enough that the Reader can no longer match it to a source excerpt. That drift
// grows every round, so a genuine content issue can go unattributed in exactly the
// late rounds where the iteration budget is thinnest. Recovery costs a full
// iteration (the leftover must become the ONLY issue before images come back), and
// at the cap it never happens — the issue is written to @unresolved having never
// been shown its own page.
//
// The cost of being generous is bounded: a chronically unattributable structural
// issue pins the document to all-images, which is precisely the status quo. The
// savings case — every issue attributed — is the common one and is preserved.
export function imagesForIssues(images: InputImage[], issues: ReviewIssue[]): InputImage[] {
  if (issues.some((i) => !i.pages?.length)) return images;
  const wanted = new Set(issues.flatMap((i) => i.pages ?? []));
  if (wanted.size === 0) return images;
  const selected = images.filter((img) => wanted.has(img.order));
  return selected.length ? selected : images;
}

// Document-level correction: the editor sees the whole body + all issues + the
// source images and returns a corrected document, so it can fix structural
// problems (dedup, reorder, heading hierarchy) that per-block editing cannot.
//
// It sees only the images for the pages the Reader attributed issues to. On a
// 25-page document that is the difference between re-uploading 25 base64 PNGs on
// every one of up to max_review_iterations rounds and uploading the one or two
// that are actually in question.
async function runEditor(ctx: PipelineContext, body: string, issues: ReviewIssue[]): Promise<string> {
  const selected = imagesForIssues(ctx.images, issues);
  const images = selected.map(loadImage);
  const pageList = selected.map((i) => i.order).join(", ");
  ctx.log.event("editor_images", { attached: selected.length, of: ctx.images.length, pages: selected.map((i) => i.order) });
  const user =
    `## Current document (body content)\n${body}\n\n` +
    `## Issues to fix\n${issues
      .map((i) => {
        const where = i.pages?.length ? ` (page ${i.pages.join(", ")})` : "";
        return `- [${i.severity}]${where} ${i.issue} — ${i.suggested_action}`;
      })
      .join("\n")}\n\n` +
    (images.length
      ? `The source image(s) for page ${pageList} are attached, in that order. ` +
        `Return the complete corrected body.`
      : `No source images are available. Return the complete corrected body.`) +
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
  initial: { body: string; lint: LintResult; pages?: IndexedPage[] },
): Promise<ReviewResult> {
  let body = initial.body;
  let lint = initial.lint;
  let iterations = 0;
  let lastIssues: ReviewIssue[] = [];
  // The page index is built from the fragments as they entered review. Pages are
  // deliberately NOT re-indexed as the editor rewrites the body: the index exists
  // to attribute content to a SOURCE page, and the source doesn't change.
  const pages = initial.pages ?? [];

  while (iterations <= ctx.maxReviewIterations) {
    const issues = await runReader(ctx, body, lint, pages);
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

  // Cap reached with issues remaining (§7.11): record them as a comment, with the
  // source page reference the Reader attributed (§7.8) so a human can find them.
  const unresolvedLines = lastIssues.map(
    (i) => `${i.issue} (severity: ${i.severity}${i.pages?.length ? `, page ${i.pages.join(", ")}` : ""})`,
  );
  return {
    html: wrapDocument(body, { unresolved: unresolvedLines }),
    body,
    iterationsCompleted: iterations,
    unresolved: lastIssues,
    lint,
  };
}
