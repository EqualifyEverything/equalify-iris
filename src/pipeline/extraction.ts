import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import type { Fragment } from "./fragment.ts";

const PAGE_AGENT = "page";

// Single coherent extraction: one vision call converts the WHOLE page into one
// accessible-HTML fragment. This replaces fanning the page out to many
// content agents that each re-rendered it (which produced duplicated output for
// nested structures like forms). The specialist agents in agents/ remain in the
// repo for the contribution/refinement story; this is the primary path.
const SYSTEM_PROMPT = `You convert an ENTIRE document page (provided as an image) into a single, coherent,
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

Respond with ONLY this JSON:
{ "html": "<accessible HTML for the whole page — body content only, no duplication>",
  "log": "notes, e.g. content cut off at an edge" }`;

export interface ExtractionResult {
  fragments: Fragment[];
}

function stripFences(t: string): string {
  const m = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

// One fragment per page, in submitted order.
export async function runExtraction(ctx: PipelineContext): Promise<ExtractionResult> {
  const fragments: Fragment[] = [];
  for (const img of ctx.images) {
    const user =
      `Convert this document page image (filename: ${img.name}, page ${img.order} of ${ctx.images.length}) ` +
      `to accessible HTML.\n\n${ACCESSIBILITY_REQUIREMENTS}${feedbackPreamble(ctx)}`;
    const res = await ctx.router.complete(
      PAGE_AGENT,
      "vision",
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { images: [loadImage(img)] },
    );
    ctx.log.agentCall({
      agent: { name: PAGE_AGENT, file: "page.md", content: SYSTEM_PROMPT, capabilities: ["vision"], sha: null, sessionBuilt: false },
      phase: "extraction",
      image: img.name,
      output: res.text,
    });
    const parsed = extractJson<{ html?: string; log?: string }>(res.text);
    fragments.push({
      image: img.name,
      order: img.order,
      agent: "page.md",
      region: "page",
      innerHtml: parsed?.html ?? stripFences(res.text),
      edges: [],
      log: parsed?.log ?? "",
    });
  }

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments };
}
