import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type PipelineContext } from "./context.ts";
import { renderFragment, type Fragment } from "./fragment.ts";
import { runAssembly } from "./assembly.ts";
import { flatten } from "./flatten.ts";
import type { LintResult } from "./lint.ts";
import type { NoContentSignal } from "./extraction.ts";

export interface ReviewIssue {
  issue: string;
  source: string;
  severity: "low" | "medium" | "high";
  suggested_action: string;
}

export interface ReviewResult {
  html: string;
  fragments: Fragment[];
  iterationsCompleted: number;
  unresolved: ReviewIssue[];
  lint: LintResult; // final axe-core result, summarized into the PR description (§7.13)
}

const READER_SYSTEM = `You are the Reader Agent (PRD §7.8). You review assembled accessible HTML for reading-order
issues, semantic inconsistencies, and missed accessibility requirements. You do NOT see source
images — you read the document the way a screen-reader user consumes it.

You get two views of the same chunk: the HTML (structural reference) and a flattened text-only
view (what a screen reader announces, in order). Cross-check them. Also cross-check the listed
no-content signals and @suspected-continuation markers for likely triage/reconciliation misses.

Flag each issue against the @source reference of the offending block. Respond with ONLY JSON:
{ "issues": [ { "issue": "...", "source": "page-005.png#region-heading-2",
  "severity": "low|medium|high", "suggested_action": "..." } ] }
Return {"issues": []} when the document is clean.`;

const COPY_EDITOR_SYSTEM = `You are the Copy Editor Agent (PRD §7.9). Given a flagged HTML block, its source image, the
issue list, and surrounding HTML for context, propose a corrected, accessible replacement for
the block. Do not modify anything outside the block. Respond with ONLY JSON:
{ "html": "<corrected accessible HTML for this block, no provenance comments>" }`;

const CHUNK_BUDGET = 24000; // chars; ~comfortable fraction of context (§7.8)
const CHUNK_OVERLAP = 2000;

function chunk(html: string): string[] {
  if (html.length <= CHUNK_BUDGET) return [html];
  const chunks: string[] = [];
  let start = 0;
  while (start < html.length) {
    chunks.push(html.slice(start, start + CHUNK_BUDGET));
    start += CHUNK_BUDGET - CHUNK_OVERLAP;
  }
  return chunks;
}

async function runReader(
  ctx: PipelineContext,
  html: string,
  extras: { noContent: NoContentSignal[]; lint: LintResult; fragments: Fragment[] },
): Promise<ReviewIssue[]> {
  const suspected = extras.fragments
    .filter((f) => f.suspectedContinuation)
    .map((f) => `${f.image}#${f.region}`);
  const signalsBlock =
    `# no-content signals\n${extras.noContent.map((s) => `- ${s.agent} found nothing on ${s.image}`).join("\n") || "- none"}\n\n` +
    `# @suspected-continuation markers\n${suspected.map((s) => `- ${s}`).join("\n") || "- none"}\n\n` +
    `# axe-core lint\n${extras.lint.violations.map((v) => `- ${v.id} (${v.impact}): ${v.description} [${v.nodes} nodes]`).join("\n") || (extras.lint.error ? `- (lint note: ${extras.lint.error})` : "- no violations")}`;

  const issues: ReviewIssue[] = [];
  for (const c of chunk(html)) {
    const user =
      `## HTML chunk\n\`\`\`html\n${c}\n\`\`\`\n\n## Flattened screen-reader view\n${flatten(c)}\n\n## Cross-check inputs\n${signalsBlock}` +
      feedbackPreamble(ctx);
    const res = await ctx.router.complete(
      "reader",
      "text",
      [
        { role: "system", content: READER_SYSTEM },
        { role: "user", content: user },
      ],
    );
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

// Match a Reader issue's @source reference to a fragment.
function fragmentForSource(fragments: Fragment[], source: string): Fragment | undefined {
  const region = source.includes("#") ? source.split("#")[1] : source;
  return (
    fragments.find((f) => `${f.image}#${f.region}` === source) ??
    fragments.find((f) => f.region === region) ??
    fragments.find((f) => region && f.region.includes(region)) ??
    fragments.find((f) => source.startsWith(f.image))
  );
}

async function runCopyEditor(
  ctx: PipelineContext,
  fragment: Fragment,
  issues: ReviewIssue[],
  surroundingHtml: string,
): Promise<string | null> {
  // Fetch the relevant source image(s) for the flagged block (§7.9).
  const imageNames = fragment.image.split("+");
  const images = imageNames
    .map((n) => ctx.images.find((im) => im.name === n))
    .filter((x) => x != null)
    .map((x) => loadImage(x!));

  const user =
    `## Flagged block (${fragment.image}#${fragment.region})\n${fragment.innerHtml}\n\n` +
    `## Issues\n${issues.map((i) => `- [${i.severity}] ${i.issue} — ${i.suggested_action}`).join("\n")}\n\n` +
    `## Surrounding HTML (context, read-only)\n${surroundingHtml.slice(0, 4000)}` +
    feedbackPreamble(ctx);

  const res = await ctx.router.complete(
    "copy_editor",
    images.length ? "vision" : "text",
    [
      { role: "system", content: COPY_EDITOR_SYSTEM },
      { role: "user", content: user },
    ],
    { images },
  );
  ctx.log.agentCall({
    agent: { name: "copy_editor", file: "copy_editor.md", content: COPY_EDITOR_SYSTEM, capabilities: ["vision"], sha: null, sessionBuilt: false },
    phase: "review",
    image: fragment.image,
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  return parsed?.html ?? null;
}

// PRD §7.11 review loop: Reader -> Copy Editor -> Assembler -> Reader, bounded
// by max_review_iterations. The Assembler step is the fragment mutation +
// re-assembly + re-lint performed inline here (PRD §7.10).
export async function runReview(
  ctx: PipelineContext,
  initial: { html: string; fragments: Fragment[]; lint: LintResult },
  noContent: NoContentSignal[],
): Promise<ReviewResult> {
  let { html, fragments, lint } = initial;
  let iterations = 0;
  let lastIssues: ReviewIssue[] = [];

  while (iterations < ctx.maxReviewIterations) {
    const issues = await runReader(ctx, html, { noContent, lint, fragments });
    lastIssues = issues;
    ctx.log.event("reader", { iteration: iterations + 1, issues: issues.length });
    if (issues.length === 0) {
      return { html, fragments, iterationsCompleted: iterations, unresolved: [], lint };
    }

    iterations++;

    // Copy Editor + Assembler: produce and apply corrections per flagged block.
    const byFragment = new Map<Fragment, ReviewIssue[]>();
    for (const issue of issues) {
      const f = fragmentForSource(fragments, issue.source);
      if (!f) continue;
      const list = byFragment.get(f) ?? [];
      list.push(issue);
      byFragment.set(f, list);
    }

    for (const [fragment, fIssues] of byFragment) {
      const surrounding = fragments.map(renderFragment).join("\n\n");
      const replacement = await runCopyEditor(ctx, fragment, fIssues, surrounding);
      if (replacement) {
        // Assembler applies the change, preserving provenance (§7.10).
        fragment.innerHtml = replacement;
        fragment.copyEdited = true;
      }
    }

    const reassembled = await runAssembly(ctx, fragments);
    html = reassembled.html;
    lint = reassembled.lint;
    ctx.log.event("assembler", { iteration: iterations });
  }

  // Iteration cap reached with issues remaining (§7.11): rebuild with an
  // @unresolved block appended.
  const finalAssembly = await runAssembly(ctx, fragments, {
    unresolved: lastIssues.map((i) => `${i.issue} (source: ${i.source}, severity: ${i.severity})`),
  });
  return {
    html: finalAssembly.html,
    fragments,
    iterationsCompleted: iterations,
    unresolved: lastIssues,
    lint: finalAssembly.lint,
  };
}
