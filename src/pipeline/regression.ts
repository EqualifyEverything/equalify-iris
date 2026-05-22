import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import type { Paths } from "../store/paths.ts";
import type { Fragment } from "./fragment.ts";

const MAX_FIXTURES_PER_AGENT = 5;

// One captured regression case: an agent's accepted output for a real source
// image. Re-checked before any update/merge to that agent (see the regression
// gate in feedback.ts) so the change can't break a use the agent already handled.
export interface FixtureCase {
  agent: string; // agent file, e.g. "table.md"
  image_file: string; // fixture image filename within the agent's fixtures dir
  source_image: string; // original source image name
  accepted_html: string; // the agent's accepted output for that image
  captured_at: string;
  session: string;
}

// Resolve the on-disk input file for a source image name. Inputs are stored as
// "<0001>__<original-name>" (see orchestrator.enumerateInputs).
function inputFileFor(inputFiles: string[], imageName: string): string | null {
  return (
    inputFiles.find((fn) => fn.includes("__") && fn.split("__").slice(1).join("__") === imageName) ?? null
  );
}

// Keep only the most recent MAX_FIXTURES_PER_AGENT cases (by filename, which is
// timestamp-ordered); delete older case json + their image files. Best-effort.
function pruneFixtures(dir: string): void {
  const cases = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const excess = cases.slice(0, Math.max(0, cases.length - MAX_FIXTURES_PER_AGENT));
  for (const caseFile of excess) {
    try {
      const c = JSON.parse(readFileSync(join(dir, caseFile), "utf8")) as FixtureCase;
      if (c.image_file && existsSync(join(dir, c.image_file))) rmSync(join(dir, c.image_file), { force: true });
      rmSync(join(dir, caseFile), { force: true });
    } catch {
      // ignore a malformed/locked fixture during pruning
    }
  }
}

// PRD §7.12 (auto-capture on accept): when a session is accepted (closed), save a
// regression fixture for each agent that produced accepted output — the
// triggering source image plus the agent's accepted HTML for it. File-only; no
// model calls.
export function captureFixtures(paths: Paths, sessionId: string, fragments: Fragment[]): void {
  const byAgent = new Map<string, Fragment[]>();
  for (const f of fragments) {
    if (!f.agent) continue;
    const list = byAgent.get(f.agent) ?? [];
    list.push(f);
    byAgent.set(f.agent, list);
  }

  const inputDir = paths.sessionInput(sessionId);
  const inputFiles = existsSync(inputDir) ? readdirSync(inputDir) : [];

  for (const [agentFile, frs] of byAgent) {
    const rep = frs[0]; // representative source image for this agent
    const inputFile = inputFileFor(inputFiles, rep.image);
    if (!inputFile) continue;

    const dir = paths.agentFixtures(agentFile);
    mkdirSync(dir, { recursive: true });

    // Accepted HTML = this agent's fragments on the representative image, in order.
    const acceptedHtml = frs.filter((f) => f.image === rep.image).map((f) => f.innerHtml).join("\n\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const imageOut = `case-${stamp}${extname(rep.image) || ".png"}`;
    try {
      copyFileSync(join(inputDir, inputFile), join(dir, imageOut));
    } catch {
      continue; // could not copy the source image; skip this fixture
    }
    const caseObj: FixtureCase = {
      agent: agentFile,
      image_file: imageOut,
      source_image: rep.image,
      accepted_html: acceptedHtml,
      captured_at: new Date().toISOString(),
      session: sessionId,
    };
    writeFileSync(join(dir, `case-${stamp}.json`), JSON.stringify(caseObj, null, 2));
    pruneFixtures(dir);
  }
}
