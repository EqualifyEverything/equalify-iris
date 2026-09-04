import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  // git blob SHA of the prompt text this spec carries — how a run says which prompt
  // version it used — or
  // null for a spec whose content is a literal in this codebase rather than a file —
  // those are versioned by the application's own commit and have no blob of their own.
  // Computed from `content`, so it is the SHA of what was SENT and not of what a
  // checkout has committed; see `blobSha`.
  sha: string | null;
  // True when this agent lives in tmp/<session>/agents (session-built).
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

// The git blob SHA of a prompt, computed from the text rather than asked of git.
//
// The number is identical to `git hash-object <file>` and to the `sha` GitHub's contents API
// returns for the same file, because that is what a blob SHA is: sha1 over the bytes
// `blob <length>\0` and then the content. What it no longer needs is a checkout.
//
// The old answer was `git -C <agentsDir> rev-parse HEAD:./<file>`, and it returns null wherever
// the deployment does not ship a `.git` directory — which is the container Iris runs in. So
// every deployed round on file records `agent_sha: null`, and #349 is what that costs: four
// deployed rounds of the same PDF moved one defect from 0 to 28 pages in 100, and no log among
// them can say which prompt each round ran. A field that is null exactly where the question
// gets asked is not a pinned version.
//
// It also stops being wrong in the one case where the old answer was available: a modified
// working copy RAN its own text, and `HEAD:./<file>` named the committed blob instead — so a
// round measured against an edited prompt was recorded under the SHA of a prompt that did not
// run. `src/tools/calibrate.ts` recovers a session's contract with `git cat-file blob <sha>`
// and already says what it does when the blob is not in this checkout, so an uncommitted prompt
// now announces itself there instead of judging those pages against a contract they were never
// written to.
function blobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// Loads an agent by name, preferring a session-built agent in tmp/ over the
// upstream library: a session-built agent is used for the rest of that
// session. Returns null when no agent exists for the type.
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
      // A session-built agent has no upstream blob, and it still has a prompt worth
      // identifying: two rounds of one session can run two different builds of the same
      // agent, and grouping their calls needs a key. `agent_content` on the log line carries
      // the whole text for these (store/runlog.ts), so this is a short name for something the
      // log already holds rather than a claim that the file is in a checkout — `sessionBuilt`
      // is what says which.
      sha: blobSha(content),
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
      sha: blobSha(content),
      sessionBuilt: false,
    };
  }

  return null;
}
