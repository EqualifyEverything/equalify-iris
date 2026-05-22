import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";

const BUILDER_AGENT = "builder";

const SYSTEM_PROMPT = `You are the Builder Agent (PRD §7.5). The pipeline encountered a content type with no
matching agent file. Draft a NEW content-agent markdown file that follows the content-agent
contract (PRD §7.4). The file MUST contain these sections:

# <Type> Agent
## Purpose
## Required capability     (one or more of: text, vision, structured_output)
## System prompt           (specialist instructions; must demand semantic, accessible HTML and
                            a fragment log entry for cut-off edges; must forbid CSS/styling)
## Output contract         (HTML fragment wrapped in @source / @end-source comments + fragment log)

Return ONLY the markdown file content. Do not wrap it in code fences.`;

// Builds a session-scoped agent for an unknown content type, saves it to
// tmp/<session>/agents/<type>.md, and logs the creation to new-agents.md.
export async function buildAgent(
  ctx: PipelineContext,
  type: string,
  triggeredBy: InputImage,
): Promise<AgentSpec> {
  const fileName = type.endsWith(".md") ? type : `${type}.md`;
  const logical = fileName.replace(/\.md$/, "");

  const userMsg =
    `Create an agent for content type "${logical}", first seen on image "${triggeredBy.name}".\n` +
    `Reference the attached source image for what this content type looks like.\n\n` +
    ACCESSIBILITY_REQUIREMENTS +
    feedbackPreamble(ctx);

  const res = await ctx.router.complete(
    BUILDER_AGENT,
    "vision",
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ],
    { images: [loadImage(triggeredBy)] },
  );

  const content = res.text.trim();
  const tmpPath = join(ctx.paths.tmpAgentsDir(ctx.sessionId), fileName);
  writeFileSync(tmpPath, content);

  // Log the creation to runs new-agents.md (PRD §7.5).
  const newAgentsPath = ctx.paths.sessionNewAgents(ctx.sessionId);
  const summary = content.match(/##\s*Purpose\s*\n([^#]*)/i)?.[1]?.trim().split("\n")[0] ?? logical;
  if (!existsSync(newAgentsPath)) {
    writeFileSync(newAgentsPath, `# Session-built agents\n\n`);
  }
  appendFileSync(
    newAgentsPath,
    `## ${logical}\n- **Summary**: ${summary}\n- **Why created**: no existing agent covered "${logical}".\n- **Triggered by**: ${triggeredBy.name}\n\n`,
  );

  const spec: AgentSpec = {
    name: logical,
    file: fileName,
    content,
    capabilities: /\bvision\b/i.test(content) ? ["vision"] : ["text"],
    sha: null,
    sessionBuilt: true,
  };
  ctx.log.event("agent_built", { agent: fileName, triggered_by: triggeredBy.name });
  return spec;
}
