import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { verifyAgentOutput } from "./feedback.ts";
import { examplesForPrompt } from "./memory.ts";
import { STANDARD as STANDARD_AGENTS } from "./contribute.ts";
import type { Fragment } from "./fragment.ts";

const PAGE_AGENT = "page";

// Single coherent extraction: one vision call converts the WHOLE page into one
// accessible-HTML fragment. This replaces fanning the page out to many
// content agents that each re-rendered it (which produced duplicated output for
// nested structures like forms). The specialist agents in agents/ remain in the
// repo for the contribution/refinement story; this is the primary path.
//
// The prompt now lives in agents/page.md so the page agent is a first-class,
// loadable, trainable, contributable agent (verified at build time, trained from
// feedback). This DEFAULT is used only when that file is absent, so the service
// still runs against a bare checkout. It also asks the model to flag a page that
// would benefit from a dedicated specialist agent (collected as `suggestions`).
const DEFAULT_PAGE_PROMPT = `You convert an ENTIRE document page (provided as an image) into a single, coherent,
accessible HTML fragment that meets WCAG 2.2 AA. You see the whole page and produce ONE
faithful representation of it. NEVER duplicate content or render the same thing two ways
(for example, do not output both a <form> and a <table> for the same fields) — choose the
single structure that best matches the source.

Output ONLY the body content (no <html>, <head>, or <body> wrapper). Use the most appropriate
semantic structure for what the page actually is: headings in correct nesting order,
paragraphs, lists, tables with <caption>/<thead>/<th scope>, forms with
<label>/<fieldset>/<legend>, figures with <figcaption>, footnotes, etc. Transcribe visible
text faithfully and do not invent content. If content is cut off at a page edge, note it in
the "log" field.

If — and only if — this page contains a content type that a DEDICATED specialist agent would
handle clearly better than this general pass (something beyond the common types: paragraph,
heading, list, table, form field, image, quote, caption, footnote), include a
"suggested_agent". Suggest sparingly; omit it (or null) otherwise.

Respond with ONLY this JSON:
{ "html": "<accessible HTML for the whole page — body content only, no duplication>",
  "log": "notes, e.g. content cut off at an edge",
  "suggested_agent": { "name": "lowerCamelCase", "reason": "why a specialist is warranted" } }`;

export interface ExtractionResult {
  fragments: Fragment[];
  suggestions: { name: string; reason: string; image: string }[];
}

function stripFences(t: string): string {
  const m = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

// Load the page agent, preferring a session-built/trained copy (tmp/), then the
// committed agents/page.md, and finally the built-in default. Whatever is loaded
// is also what build-time verification and feedback-driven training operate on.
function loadPageAgent(ctx: PipelineContext): AgentSpec {
  const loaded = loadAgent(PAGE_AGENT, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (loaded) return loaded;
  return {
    name: PAGE_AGENT,
    file: "page.md",
    content: DEFAULT_PAGE_PROMPT,
    capabilities: ["vision"],
    sha: null,
    sessionBuilt: false,
  };
}

interface PageRender {
  html: string;
  log: string;
  suggestion?: { name: string; reason: string };
}

async function renderPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  lessons: string,
  // On a feedback re-extraction, the HTML this page produced last time. Shown so
  // the agent corrects what the feedback names and carries everything else over,
  // rather than re-deriving the page from scratch and drifting elsewhere.
  previous?: string,
): Promise<PageRender> {
  const priorSection = previous
    ? `\n\n## Your previous output for this page\n\`\`\`html\n${previous}\n\`\`\`\n` +
      `Apply the user feedback above to this page. Keep everything the feedback does NOT ` +
      `concern exactly as it was, and re-check the affected content against the source image.\n`
    : "";
  const user =
    `Convert this document page image (filename: ${img.name}, page ${img.order} of ${ctx.images.length}) ` +
    `to accessible HTML.\n\n${ACCESSIBILITY_REQUIREMENTS}${feedbackPreamble(ctx)}${lessons}${priorSection}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      { role: "system", content: agent.content },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string; log?: string; suggested_agent?: { name?: string; reason?: string } }>(res.text);
  const sa = parsed?.suggested_agent;
  return {
    html: parsed?.html ?? stripFences(res.text),
    log: parsed?.log ?? "",
    suggestion: sa?.name ? { name: sa.name, reason: sa.reason ?? "" } : undefined,
  };
}

// Re-run the page agent with the fidelity problems it was told about, so it can
// fix them against the source image. Used only when verification fails.
async function correctPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  previous: string,
  problems: string[],
): Promise<string | null> {
  const user =
    `Your previous accessible-HTML output for this page had fidelity/accessibility problems:\n` +
    `${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
    `## Your previous output\n\`\`\`html\n${previous}\n\`\`\`\n\n` +
    `Look at the source image again and return a corrected version that resolves every problem.\n\n` +
    `${ACCESSIBILITY_REQUIREMENTS}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      { role: "system", content: agent.content },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string }>(res.text);
  const corrected = (parsed?.html ?? stripFences(res.text)).trim();
  return corrected || null;
}

// Merge instruction for splicing a specialist fragment into the page output.
const MERGE_SYSTEM = `You merge a higher-fidelity HTML fragment, produced by a specialist agent, into an
existing accessible HTML page. Replace the page's weaker representation of that SAME content
with the specialist fragment and change nothing else — keep all other content, order,
headings, and structure exactly, and never leave both representations (no duplication).
Output body content only (no <html>/<head>/<body> wrapper).
Respond with ONLY this JSON: { "html": "<merged body content>" }`;

// Run a library specialist agent against the whole page image, asking it to
// extract only the content its contract covers. Returns its HTML fragment, or
// null when it finds nothing.
async function runSpecialist(ctx: PipelineContext, agent: AgentSpec, img: InputImage): Promise<string | null> {
  const system = `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}`;
  const user =
    `Extract ONLY the content your contract covers from this page image (filename: ${img.name}). ` +
    `If none is present, return {"no_content": true}. Otherwise respond with ONLY this JSON: ` +
    `{ "no_content": false, "html": "<your accessible HTML fragment>" }`;
  const capability = agent.capabilities.includes("vision") ? "vision" : "text";
  const res = await ctx.router.complete(
    agent.name,
    capability,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ no_content?: boolean; html?: string }>(res.text);
  if (!parsed || parsed.no_content || !parsed.html?.trim()) return null;
  return parsed.html.trim();
}

// Splice a specialist fragment into the page body, replacing the page's own
// (weaker) representation of that content. Returns the merged body, or null on
// failure (caller keeps the original page output).
async function mergeSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  specialistName: string,
  reason: string,
  fragment: string,
): Promise<string | null> {
  const user =
    `## Current page (body HTML)\n\`\`\`html\n${pageHtml}\n\`\`\`\n\n` +
    `## Specialist (${specialistName}) fragment for the ${reason || "flagged"} content on this page\n` +
    `\`\`\`html\n${fragment}\n\`\`\`\n\n` +
    `Replace the page's existing representation of that content with this specialist fragment; ` +
    `keep everything else unchanged.`;
  const res = await ctx.router.complete(PAGE_AGENT, "text", [
    { role: "system", content: MERGE_SYSTEM },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({
    agent: { name: PAGE_AGENT, file: "page.md", content: MERGE_SYSTEM, capabilities: ["text"], sha: null, sessionBuilt: false },
    phase: "extraction",
    image: img.name,
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  return parsed?.html?.trim() || null;
}

// If a page flagged a content type that an EXISTING library agent handles, run
// that specialist on the page and merge its higher-fidelity fragment into the
// page output. Non-blocking: any failure leaves the page output unchanged.
// dispatched=true means a library specialist ran (so the suggestion is already
// covered and should not be re-filed as a new-agent issue).
async function dispatchSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  suggestion: { name: string; reason: string },
): Promise<{ html: string; dispatched: boolean }> {
  const logical = suggestion.name.replace(/\.md$/, "");
  if (STANDARD_AGENTS.has(logical)) return { html: pageHtml, dispatched: false };
  const specialist = loadAgent(logical, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (!specialist) return { html: pageHtml, dispatched: false };
  try {
    const fragment = await runSpecialist(ctx, specialist, img);
    if (!fragment) {
      ctx.log.event("specialist_no_content", { agent: specialist.file, image: img.name });
      return { html: pageHtml, dispatched: true };
    }
    const merged = await mergeSpecialist(ctx, img, pageHtml, specialist.name, suggestion.reason, fragment);
    ctx.log.event("specialist_dispatched", { agent: specialist.file, image: img.name, merged: Boolean(merged) });
    return { html: merged ?? pageHtml, dispatched: true };
  } catch (e) {
    ctx.log.event("specialist_dispatch_failed", { agent: specialist.file, image: img.name, error: (e as Error).message });
    return { html: pageHtml, dispatched: true };
  }
}

interface PageOutcome {
  fragment: Fragment;
  // A genuinely-new content type to file for contribution, if any. A suggestion
  // already covered by a dispatched library specialist is not reported.
  suggestion?: { name: string; reason: string; image: string };
}

// Everything one page needs: render -> optional specialist merge -> verify ->
// optional self-correction. Pages share no mutable state, so this is safe to run
// concurrently for several pages at once (see runExtraction).
async function extractPage(
  ctx: PipelineContext,
  pageAgent: AgentSpec,
  img: InputImage,
  lessons: string,
  previous?: string,
): Promise<PageOutcome> {
  const { html, log, suggestion } = await renderPage(ctx, pageAgent, img, lessons, previous);
  let innerHtml = html;
  let logNote = log;
  let dispatched = false;

  // Specialist dispatch: if the page flagged a content type that an existing
  // library agent handles (e.g. a chart), run that agent and merge its
  // higher-fidelity fragment into the page BEFORE the fidelity check.
  if (suggestion?.name) {
    const result = await dispatchSpecialist(ctx, img, innerHtml, suggestion);
    dispatched = result.dispatched;
    if (result.html !== innerHtml) {
      innerHtml = result.html;
      logNote = logNote ? `${logNote}; merged ${suggestion.name}` : `merged ${suggestion.name}`;
    }
  }

  const verdict = await verifyAgentOutput(ctx, pageAgent, img, [{ html: innerHtml }]);
  if (!verdict.ok && verdict.problems.length) {
    ctx.log.event("page_verify_failed", { image: img.name, problems: verdict.problems });
    const corrected = await correctPage(ctx, pageAgent, img, innerHtml, verdict.problems);
    if (corrected && corrected !== innerHtml.trim()) {
      innerHtml = corrected;
      logNote = logNote
        ? `${logNote}; self-corrected after fidelity check`
        : "self-corrected after fidelity check";
    }
  } else {
    ctx.log.event("page_verify_ok", { image: img.name });
  }

  return {
    fragment: {
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml,
      edges: [],
      log: logNote,
    },
    suggestion:
      suggestion?.name && !dispatched
        ? { name: suggestion.name, reason: suggestion.reason, image: img.name }
        : undefined,
  };
}

// One fragment per page, in submitted order. Each page is verified for source
// fidelity at build time (PRD §7.5/§7.12); a page that fails gets one self-
// correction pass. Verification is non-blocking — a run never fails because the
// Feedback Agent is unavailable or unsure. When a page flags a content type that an
// existing library agent handles, that specialist is dispatched and merged in;
// otherwise the suggestion is collected for the contribution step.
//
// Pages are extracted CONCURRENTLY (defaults.extraction_concurrency), which is
// the dominant latency term for a multi-page document: each page costs up to
// several sequential model calls, and pages are fully independent. Document order
// is preserved by mapWithConcurrency returning results in input order — never
// rely on completion order here.
export async function runExtraction(ctx: PipelineContext): Promise<ExtractionResult> {
  const pageAgent = loadPageAgent(ctx);
  // Inject corroborated lessons learned from past feedback into the page agent
  // prompt (#1), so it improves without rewriting agents/page.md.
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  const limit = ctx.extractionConcurrency;
  ctx.log.event("extraction_start", { pages: ctx.images.length, concurrency: limit });

  const outcomes = await mapWithConcurrency(ctx.images, limit, (img) =>
    extractPage(ctx, pageAgent, img, lessons),
  );

  // Results come back in input order, so fragments are already in page order.
  const fragments = outcomes.map((o) => o.fragment);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments, suggestions };
}

// Re-extract only the pages a piece of feedback actually concerns (PRD §7.12),
// leaving every other page's prior fragment untouched.
//
// This is the path for feedback the review loop structurally cannot serve: the
// Reader only ever sees the assembled HTML (by design, §7.8), so a misreading of
// the source raises no issue and the loop has nothing to act on. "You misread the
// table on page 3" can only be fixed by putting page 3's IMAGE back in front of
// the page agent. Each targeted page goes through the same
// render -> verify -> correct path as a first run, with its previous output shown
// so untouched content carries over.
//
// Returns fragments for the WHOLE document in page order — re-extracted pages
// replaced, the rest as they were.
export async function reExtractPages(
  ctx: PipelineContext,
  priorFragments: Fragment[],
  pages: number[],
): Promise<ExtractionResult> {
  const targets = new Set(pages);
  const pageAgent = loadPageAgent(ctx);
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  // Only re-extract a targeted page we still have BOTH the source image and a
  // prior fragment for.
  const priorByOrder = new Map(priorFragments.map((f) => [f.order, f]));
  const toRun = ctx.images.filter((img) => targets.has(img.order) && priorByOrder.has(img.order));
  const missing = [...targets].filter((p) => !toRun.some((img) => img.order === p));
  if (missing.length) ctx.log.event("reextract_skipped", { pages: missing, reason: "no source image or prior fragment" });

  ctx.log.event("reextract_start", {
    pages: toRun.map((i) => i.order),
    of: priorFragments.length,
    concurrency: ctx.extractionConcurrency,
  });

  const outcomes = await mapWithConcurrency(toRun, ctx.extractionConcurrency, (img) =>
    extractPage(ctx, pageAgent, img, lessons, priorByOrder.get(img.order)?.innerHtml),
  );

  const replaced = new Map(outcomes.map((o) => [o.fragment.order, o.fragment]));
  const fragments = [...priorFragments]
    .sort((a, b) => a.order - b.order)
    .map((f) => replaced.get(f.order) ?? f);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  ctx.log.event("reextract_complete", { pages: [...replaced.keys()].sort((a, b) => a - b) });
  return { fragments, suggestions };
}
