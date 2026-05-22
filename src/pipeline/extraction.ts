import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { extractJson } from "../util/json.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { buildAgent } from "./builder.ts";
import type { Fragment } from "./fragment.ts";
import type { TriageNotes } from "./triage.ts";

export interface NoContentSignal {
  agent: string;
  image: string;
}

export interface ExtractionResult {
  fragments: Fragment[];
  noContent: NoContentSignal[];
}

interface AgentJson {
  no_content?: boolean;
  fragments?: { html?: string; fragment_edges?: string[]; log?: string }[];
}

function outputInstruction(notes: TriageNotes): string {
  // Per PRD §7.4 the content agent receives the full source image plus the
  // notes file for that image — we pass the notes markdown verbatim from disk.
  const notesFile = readFileSync(notes.notesPath, "utf8");
  return `You are processing source image "${notes.image}". Its triage notes file:

\`\`\`markdown
${notesFile}
\`\`\`

Extract ONLY content matching your declared content type from the full image. If none is
present, return {"no_content": true}. Otherwise respond with ONLY this JSON:
{
  "no_content": false,
  "fragments": [
    { "html": "<accessible HTML for this block, no provenance comments>",
      "fragment_edges": ["bottom-edge"],
      "log": "note any cut-off edges with enough context for reconciliation" }
  ]
}`;
}

// PRD §7.3 + §7.4: read each notes file, dispatch the listed content agents
// against the full source image, build missing agents, and collect fragments.
export async function runExtraction(
  ctx: PipelineContext,
  triage: TriageNotes[],
): Promise<ExtractionResult> {
  const fragments: Fragment[] = [];
  const noContent: NoContentSignal[] = [];
  // Cache built agents so the same type is reused for later images (§7.5).
  const builtCache = new Map<string, AgentSpec>();

  for (const notes of triage) {
    const img = ctx.images.find((i) => i.name === notes.image)!;
    const regionCounters = new Map<string, number>();

    for (const agentFile of notes.agentCalls) {
      const logical = agentFile.replace(/\.md$/, "");
      let agent =
        loadAgent(agentFile, {
          agentsDir: ctx.paths.agentsDir,
          tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
        }) ?? builtCache.get(logical) ?? null;

      // No matching agent file -> invoke the Builder Agent and resume (§7.3).
      if (!agent) {
        agent = await buildAgent(ctx, logical, img);
        builtCache.set(logical, agent);
      }

      const system = `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}`;
      const user = outputInstruction(notes) + feedbackPreamble(ctx);
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

      const parsed = extractJson<AgentJson>(res.text);
      if (!parsed || parsed.no_content || !parsed.fragments?.length) {
        // no-content signal: logged and surfaced to the Reader later (§7.3).
        noContent.push({ agent: agent.file, image: img.name });
        ctx.log.event("no_content", { agent: agent.file, image: img.name });
        continue;
      }

      for (const fr of parsed.fragments) {
        if (!fr.html) continue;
        const n = (regionCounters.get(logical) ?? 0) + 1;
        regionCounters.set(logical, n);
        fragments.push({
          image: img.name,
          order: img.order,
          agent: agent.file,
          region: `region-${logical}-${n}`,
          innerHtml: fr.html,
          edges: fr.fragment_edges ?? [],
          log: fr.log ?? "",
        });
      }
    }
  }

  // Persist the fragment log (PRD §8.1 fragments/).
  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments, noContent };
}
