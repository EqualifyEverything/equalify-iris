import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "../store/paths.ts";

export interface NewAgentContribution {
  agent_name: string; // e.g. "scientificNotation"
  file: string; // e.g. "scientificNotation.md"
  summary: string;
  triggered_by: string;
  content: string; // full agent file content
}

export interface AgentUpdateContribution {
  agent_name: string; // e.g. "table.md"
  summary: string;
  diff_preview: string;
  content: string; // full updated agent file content
}

// Parse a "## <name>" section out of new-agents.md for its summary/trigger.
function parseNewAgentMeta(md: string, name: string): { summary: string; triggered_by: string } {
  const section = md.split(/^##\s+/m).find((s) => s.trimStart().startsWith(name));
  const summary = section?.match(/\*\*Summary\*\*:\s*(.+)/)?.[1]?.trim() ?? `Session-built agent for ${name}`;
  const triggered_by = section?.match(/\*\*Triggered by\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
  return { summary, triggered_by };
}

// Gather session-built agents that still live in tmp/<id>/agents (PRD §7.13).
export function gatherNewAgents(paths: Paths, sessionId: string): NewAgentContribution[] {
  const dir = paths.tmpAgentsDir(sessionId);
  if (!existsSync(dir)) return [];
  const newAgentsMd = existsSync(paths.sessionNewAgents(sessionId))
    ? readFileSync(paths.sessionNewAgents(sessionId), "utf8")
    : "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const agent_name = file.replace(/\.md$/, "");
      const meta = parseNewAgentMeta(newAgentsMd, agent_name);
      return {
        agent_name,
        file,
        summary: meta.summary,
        triggered_by: meta.triggered_by,
        content: readFileSync(join(dir, file), "utf8"),
      };
    });
}

// Resolve the on-disk path + bytes of a triggering input image by its display
// name (input files are stored with an order prefix, e.g. "0001__page-001.png").
export function readInputImage(
  paths: Paths,
  sessionId: string,
  imageName: string,
): { name: string; content: Buffer } | null {
  if (!imageName) return null;
  const dir = paths.sessionInput(sessionId);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith(`__${imageName}`));
  if (!file) return null;
  return { name: imageName, content: readFileSync(join(dir, file)) };
}

// Gather proposed updates to existing agents (PRD §7.13). v1 has no automated
// producer for these; the close flow honors agent-updates.md if a deployment or
// future pipeline step writes one.
export function gatherAgentUpdates(paths: Paths, sessionId: string): AgentUpdateContribution[] {
  const path = paths.sessionAgentUpdates(sessionId);
  if (!existsSync(path)) return [];
  // Expected as a JSON array when present; tolerate absence/garbage.
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentUpdateContribution[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
