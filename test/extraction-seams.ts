// A `PipelineContext` that drives the four seams of the extraction phase from a script, so a test can
// say what each model reply is and then read the events the phase wrote.
//
// Shared rather than copied because two issues now test the same four seams with different fixtures:
// #334's soft-hyphen strip (`soft-hyphens.test.ts`) and #374's style strip and digit-group repair
// (`printed-marks.test.ts`). A second copy of this would drift, and the thing it exists to hold — that
// a repair runs at EVERY seam and not once on the way out of the phase — is exactly what a drifted
// copy stops proving. Not a `.test.ts` file, so `npm test`'s `test/*.test.ts` glob does not run it as a
// suite of its own.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineContext } from "../src/pipeline/context.ts";
import type { Paths } from "../src/store/paths.ts";

export interface Recorded {
  events: { type: string; data: Record<string, unknown> }[];
}

export interface Spec {
  // The first render's fragment.
  render: string;
  // The reply's `log` and `blank` field, for the one test about a page the model says is empty.
  log?: string;
  blank?: boolean;
  // Present means the fidelity check rejects the page, which buys the one correction pass.
  problems?: string[];
  // What that pass answers with.
  correction?: string;
  // Present means the render asks for the chart specialist, which buys a specialist call and a
  // merge call.
  specialist?: { fragment: string; merged: string };
}

export const ORDINARY = `<h2>Page 1</h2><p>${"content ".repeat(20)}</p>`;
export const COMPANION = `<h2>Page 2</h2><p>${"other ".repeat(20)}</p>`;

// Page 1 behaves as `spec` says. `companion` adds an ordinary second page, which the one test whose
// page produces nothing needs: a run where NO page produced content throws by design rather than
// containing the failure, so a lost page can only be observed next to a page that worked.
//
// `feedback.md` is written only when the spec needs a verdict: without it `verifyAgentOutput`
// short-circuits to the unjudged verdict, no page is ever rejected, and no correction pass runs.
export function makeCtx(dir: string, spec: Spec, companion = false): { ctx: PipelineContext; rec: Recorded } {
  const agentsDir = join(dir, "agents");
  const fragDir = join(dir, "fragments");
  const inputDir = join(dir, "input");
  for (const d of [agentsDir, fragDir, inputDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentsDir, "page.md"), "# Page Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(agentsDir, "chartDataAgent.md"), "# Chart Agent\n\n## Required capability\nvision\n");
  if (spec.problems) writeFileSync(join(agentsDir, "feedback.md"), "# Feedback Agent\n\n## Required capability\nvision\n");
  writeFileSync(join(inputDir, "page-001.png"), "not-a-real-png");
  if (companion) writeFileSync(join(inputDir, "page-002.png"), "not-a-real-png");
  const images = [{ name: "page-001.png", order: 1, path: join(inputDir, "page-001.png") }];
  if (companion) images.push({ name: "page-002.png", order: 2, path: join(inputDir, "page-002.png") });

  const rec: Recorded = { events: [] };
  const ctx = {
    sessionId: "ses_test",
    images,
    extractionConcurrency: 1,
    recheckSampleSize: 1,
    maxReviewIterations: 1,
    paths: {
      agentsDir,
      tmpAgentsDir: () => join(dir, "tmp-agents"),
      agentMemory: (agent: string) => join(dir, `mem-${agent.replace(/\.md$/, "")}.json`),
      sessionFragments: () => fragDir,
    } as unknown as Paths,
    router: {
      complete: async (
        _agent: string,
        _cap: string,
        messages: { role: string; content: string }[],
        opts?: { step?: string },
      ) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        const prompt = messages.map((m) => m.content).join("\n");
        const step = opts?.step;
        if (prompt.includes("filename: page-002.png")) return { text: JSON.stringify({ html: COMPANION, log: "" }) };
        if (step === "verify" || step === "recheck_binding" || step === "recheck_sampled") {
          const problems = step === "verify" ? (spec.problems ?? []) : [];
          return { text: JSON.stringify({ faithful: problems.length === 0, accessible: true, problems }) };
        }
        if (step === "correct") return { text: JSON.stringify({ html: spec.correction ?? ORDINARY }) };
        if (step === "specialist") {
          return { text: JSON.stringify({ no_content: false, html: spec.specialist!.fragment }) };
        }
        if (sys.includes("You merge a higher-fidelity HTML fragment")) {
          return { text: JSON.stringify({ html: spec.specialist!.merged }) };
        }
        return {
          text: JSON.stringify({
            html: spec.render,
            log: spec.log ?? "",
            ...(spec.blank === undefined ? {} : { blank: spec.blank }),
            ...(spec.specialist ? { suggested_agent: { name: "chartDataAgent", reason: "a chart" } } : {}),
          }),
        };
      },
    },
    log: {
      event: (type: string, data: Record<string, unknown> = {}) => rec.events.push({ type, data }),
      agentCall: () => {},
    },
  } as unknown as PipelineContext;
  return { ctx, rec };
}

export async function withTemp<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const ev = (rec: Recorded, type: string) => rec.events.filter((e) => e.type === type);
