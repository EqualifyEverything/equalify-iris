import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import type { Capability } from "../config.ts";

export interface AgentSpec {
  // Logical name without extension, e.g. "table".
  name: string;
  // File name as referenced in notes, e.g. "table.md".
  file: string;
  // Full markdown contents (system prompt + contract).
  content: string;
  // Capabilities declared in the "## Required capability" section.
  capabilities: Capability[];
  // git SHA of the file in the agents/ checkout, or null for session-built
  // agents that have no upstream object (PRD §7.3 version pinning).
  sha: string | null;
  // True when this agent lives in tmp/<session>/agents (session-built, §7.5).
  sessionBuilt: boolean;
}

const CAPABILITY_WORDS: Capability[] = ["text", "vision", "structured_output"];

function parseCapabilities(content: string): Capability[] {
  const m = content.match(/##\s*Required capability\s*\n([^#]*)/i);
  const found = new Set<Capability>();
  if (m) {
    for (const cap of CAPABILITY_WORDS) {
      if (new RegExp(`\\b${cap}\\b`).test(m[1])) found.add(cap);
    }
  }
  if (found.size === 0) found.add("vision");
  return [...found];
}

function gitSha(dir: string, file: string): string | null {
  try {
    // `:./` resolves the path relative to `dir`, so this works whether agents/
    // is its own checkout or a subdirectory of a larger repo.
    const out = execFileSync("git", ["-C", dir, "rev-parse", `HEAD:./${file}`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim() || null;
  } catch {
    return null; // not a git checkout, or file not committed
  }
}

// Loads an agent by name, preferring a session-built agent in tmp/ over the
// upstream library (PRD §7.3: built agents are used for the rest of the
// session). Returns null when no agent exists for the type.
export function loadAgent(
  name: string,
  opts: { agentsDir: string; tmpAgentsDir: string },
): AgentSpec | null {
  const file = name.endsWith(".md") ? name : `${name}.md`;
  const logical = basename(file, ".md");

  const sessionPath = join(opts.tmpAgentsDir, file);
  if (existsSync(sessionPath)) {
    const content = readFileSync(sessionPath, "utf8");
    return {
      name: logical,
      file,
      content,
      capabilities: parseCapabilities(content),
      sha: null,
      sessionBuilt: true,
    };
  }

  const libPath = join(opts.agentsDir, file);
  if (existsSync(libPath)) {
    const content = readFileSync(libPath, "utf8");
    return {
      name: logical,
      file,
      content,
      capabilities: parseCapabilities(content),
      sha: gitSha(opts.agentsDir, file),
      sessionBuilt: false,
    };
  }

  return null;
}
