import { readdirSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { IrisConfig } from "../config.ts";
import { ProviderRouter } from "../providers/index.ts";
import type { Store } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import { htmlToFilledPdf } from "../util/filledPdf.ts";
import { filledPdfFilename } from "../util/outputNames.ts";
import type { InputImage, PipelineContext } from "./context.ts";
import { runExtraction } from "./extraction.ts";
import { runAssembly } from "./assembly.ts";
import { runReview } from "./review.ts";

// Input files are stored as "<0001>__<original-name>" so submitted order
// (significant per PRD §9.2) survives, independent of filename.
export function enumerateInputs(paths: Paths, sessionId: string): InputImage[] {
  const dir = paths.sessionInput(sessionId);
  return readdirSync(dir)
    .filter((f) => f.includes("__"))
    .map((f) => {
      const [prefix, ...rest] = f.split("__");
      return { order: parseInt(prefix, 10), name: rest.join("__"), path: join(dir, f) };
    })
    .sort((a, b) => a.order - b.order);
}

// Runs phases 1–5 (PRD §6) for a session and persists status transitions.
// Designed to be invoked in the background; failures move the session to
// "failed" with the error recorded.
export async function runPipeline(args: {
  cfg: IrisConfig;
  store: Store;
  sessionId: string;
  maxReviewIterations: number;
  feedback?: string;
}): Promise<void> {
  const { cfg, store, sessionId } = args;
  const paths = new Paths(cfg);
  const session = store.getSession(sessionId);
  const outputBasename = session?.output_basename ?? null;
  const log = new RunLog(paths.sessionLog(sessionId));
  // Route every model call's timing into the run log for diagnostics.
  const router = new ProviderRouter(cfg, (type, data) => log.event(type, data));
  const images = enumerateInputs(paths, sessionId);

  // Update the session phase and record a phase marker for timing diagnostics.
  const setPhase = (phase: Parameters<typeof store.updateSession>[1]["phase"]) => {
    store.updateSession(sessionId, { phase });
    log.event("phase", { phase });
  };

  const ctx: PipelineContext = {
    sessionId,
    cfg,
    paths,
    router,
    log,
    images,
    feedback: args.feedback,
    maxReviewIterations: args.maxReviewIterations,
  };

  try {
    store.updateSession(sessionId, { status: "running", phase: "extraction", error: null, filled_filename: null });
    log.event("phase", { phase: "extraction" });

    // Feedback re-runs preserve the prior converted HTML in history/ before overwrite.
    if (args.feedback) {
      const prevOutput = paths.sessionOutput(sessionId, outputBasename);
      if (existsSync(prevOutput)) {
        const historyDir = paths.sessionHistory(sessionId);
        mkdirSync(historyDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const histName = outputBasename
          ? `${outputBasename}_converted-${stamp}.html`
          : `output-${stamp}.html`;
        copyFileSync(prevOutput, join(historyDir, histName));
        log.event("feedback_rerun", { feedback: args.feedback, prior_output: `history/${histName}` });
      } else {
        log.event("feedback_rerun", { feedback: args.feedback, prior_output: null });
      }
    }

    log.event("run_start", { images: images.length, feedback: args.feedback ?? null });

    // Single coherent extraction: one accessible-HTML pass per page.
    const { fragments } = await runExtraction(ctx);

    setPhase("assembly");
    const assembled = await runAssembly(ctx, fragments);

    setPhase("review");
    const review = await runReview(ctx, { body: assembled.body, lint: assembled.lint });

    writeFileSync(paths.sessionOutput(sessionId, outputBasename), review.html);

    let filledName: string | null = null;
    if (outputBasename) {
      const title = basename(outputBasename);
      const pdfBytes = await htmlToFilledPdf(review.html, title);
      if (pdfBytes) {
        filledName = filledPdfFilename(outputBasename);
        writeFileSync(paths.sessionFilledOutput(sessionId, outputBasename), pdfBytes);
        log.event("filled_pdf", { filename: filledName, bytes: pdfBytes.length });
      }
    }

    // Final accessibility lint result, summarized into the PR description on close (§7.13).
    writeFileSync(paths.sessionLint(sessionId), JSON.stringify(review.lint, null, 2));
    if (review.unresolved.length) {
      writeFileSync(
        paths.sessionUnresolved(sessionId),
        `# Unresolved issues at iteration cap\n\n` +
          review.unresolved
            .map((i) => `- **[${i.severity}]** ${i.issue}\n  - suggested: ${i.suggested_action}`)
            .join("\n"),
      );
    }

    store.updateSession(sessionId, {
      status: "ready_for_review",
      phase: "done",
      iterations_completed: review.iterationsCompleted,
      filled_filename: filledName,
    });
    log.event("run_complete", { iterations: review.iterationsCompleted, unresolved: review.unresolved.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.updateSession(sessionId, { status: "failed", error: message });
    log.event("run_failed", { error: message });
  }
}
