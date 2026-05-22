import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IrisConfig } from "../config.ts";
import { ProviderRouter } from "../providers/index.ts";
import type { Store } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import type { InputImage, PipelineContext } from "./context.ts";
import { runExtraction } from "./extraction.ts";
import { runAssembly, assembleBody, wrapDocument } from "./assembly.ts";
import { runReview, type ReviewResult } from "./review.ts";
import { runAxe } from "./lint.ts";
import { proposeAgentUpdatesFromFeedback } from "./feedback.ts";
import { runContribution } from "./contribute.ts";
import type { Fragment } from "./fragment.ts";

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
  githubToken?: string;
}): Promise<void> {
  const { cfg, store, sessionId } = args;
  const paths = new Paths(cfg);
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
    githubToken: args.githubToken,
  };

  try {
    store.updateSession(sessionId, { status: "running", phase: "extraction", error: null });
    log.event("phase", { phase: "extraction" });

    // Feedback re-runs are logged separately and preserve the prior output so it
    // can be reverted to (PRD §7.12). The previous output.html is snapshotted to
    // history/ before this run overwrites it.
    if (args.feedback) {
      const prevOutput = paths.sessionOutput(sessionId);
      if (existsSync(prevOutput)) {
        const historyDir = paths.sessionHistory(sessionId);
        mkdirSync(historyDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        copyFileSync(prevOutput, join(historyDir, `output-${stamp}.html`));
        log.event("feedback_rerun", { feedback: args.feedback, prior_output: `history/output-${stamp}.html` });
      } else {
        log.event("feedback_rerun", { feedback: args.feedback, prior_output: null });
      }
    }

    // Iterative feedback (PRD §7.12): when feedback arrives and a prior run's
    // final state exists, refine the EXISTING reviewed document — re-lint the saved
    // body and run the feedback-aware Reader/Editor loop on it — instead of
    // regenerating it from the source images. This builds on the current output and
    // converges across rounds. First runs (no saved state) run the full pipeline.
    const finalFragmentsPath = paths.sessionFinalFragments(sessionId);
    const iterative = Boolean(args.feedback) && existsSync(finalFragmentsPath);

    let fragments: Fragment[];
    let beforeBody = "";
    let review: ReviewResult;
    // Specialist-agent suggestions are produced by the full extraction pass only;
    // an iterative feedback re-run reuses the prior fragments and makes none.
    let suggestions: { name: string; reason: string; image: string }[] = [];

    if (iterative) {
      log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode: "feedback_iterative" });
      const saved = JSON.parse(readFileSync(finalFragmentsPath, "utf8")) as {
        fragments?: Fragment[];
        body?: string;
      };
      fragments = saved.fragments ?? [];
      beforeBody = (saved.body ?? assembleBody(fragments)).trim();

      setPhase("review");
      // Re-lint the existing reviewed body (no model call), then let the
      // feedback-aware review loop refine it in place.
      const lint = await runAxe(wrapDocument(beforeBody));
      review = await runReview(ctx, { body: beforeBody, lint });
    } else {
      log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode: "full" });

      // Single coherent extraction: one accessible-HTML pass per page.
      const extraction = await runExtraction(ctx);
      fragments = extraction.fragments;
      suggestions = extraction.suggestions;

      setPhase("assembly");
      const assembled = await runAssembly(ctx, fragments);

      setPhase("review");
      review = await runReview(ctx, { body: assembled.body, lint: assembled.lint });
    }

    writeFileSync(paths.sessionOutput(sessionId), review.html);
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

    // Persist the final state so the next feedback round can refine the reviewed
    // body iteratively, and so regression fixtures (the page agent's per-page
    // output keyed to its source image) can be captured on accept (close handler).
    writeFileSync(
      finalFragmentsPath,
      JSON.stringify({ fragments, body: review.body }, null, 2),
    );

    // Feedback -> agent training (PRD §7.12/§7.13): turn the document-level
    // correction this feedback run produced into a proposed improvement to the
    // page agent, recorded (gated by its regression fixtures) for review; or
    // in-place training if a session-built page agent is in use.
    if (args.feedback) {
      await proposeAgentUpdatesFromFeedback(ctx, {
        agentFile: "page.md",
        before: beforeBody,
        after: review.body,
        feedback: args.feedback,
      });
    }

    store.updateSession(sessionId, {
      status: "ready_for_review",
      phase: "done",
      iterations_completed: review.iterationsCompleted,
    });
    log.event("run_complete", {
      iterations: review.iterationsCompleted,
      unresolved: review.unresolved.length,
      mode: iterative ? "feedback_iterative" : "full",
    });

    // After the user has their output, auto-file agent-suggestion issues
    // (no-op unless a token is available). Never blocks the result.
    await runContribution(ctx, suggestions);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.updateSession(sessionId, { status: "failed", error: message });
    log.event("run_failed", { error: message });
  }
}
