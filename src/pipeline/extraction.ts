import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { verifyAgentOutput } from "./feedback.ts";
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

async function renderPage(ctx: PipelineContext, agent: AgentSpec, img: InputImage): Promise<PageRender> {
  const user =
    `Convert this document page image (filename: ${img.name}, page ${img.order} of ${ctx.images.length}) ` +
    `to accessible HTML.\n\n${ACCESSIBILITY_REQUIREMENTS}${feedbackPreamble(ctx)}`;
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

// One fragment per page, in submitted order. Each page is verified for source
// fidelity at build time (PRD §7.5/§7.12); a page that fails gets one self-
// correction pass. Verification is non-blocking — a run never fails because the
// Feedback Agent is unavailable or unsure. Pages may also flag a content type that
// warrants a specialist agent, collected as `suggestions` for the contribution step.
export async function runExtraction(ctx: PipelineContext): Promise<ExtractionResult> {
  const pageAgent = loadPageAgent(ctx);
  const fragments: Fragment[] = [];
  const suggestions: ExtractionResult["suggestions"] = [];

  for (const img of ctx.images) {
    const { html, log, suggestion } = await renderPage(ctx, pageAgent, img);
    let innerHtml = html;
    let logNote = log;

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

    fragments.push({
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml,
      edges: [],
      log: logNote,
    });

    if (suggestion?.name) suggestions.push({ name: suggestion.name, reason: suggestion.reason, image: img.name });
  }

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments, suggestions };
}
