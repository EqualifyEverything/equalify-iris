import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IrisConfig } from "../config.ts";
import { ProviderRouter } from "../providers/index.ts";
import type { Store } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import type { InputImage, PipelineContext } from "./context.ts";
import { runExtraction, reExtractPages } from "./extraction.ts";
import { runAssembly, assembleBody, wrapDocument } from "./assembly.ts";
import { runReview, type ReviewResult } from "./review.ts";
import { runAxe } from "./lint.ts";
import { learnFromFeedback, proposeAgentUpdatesFromFeedback, scopeFeedback } from "./feedback.ts";
import { runContribution } from "./contribute.ts";
import type { Fragment } from "./fragment.ts";
import type { PdfLink } from "../util/pdf.ts";

// The link annotations the upload extracted from its PDFs, keyed by page order
// (see Paths.sessionLinks). Absent for a session of plain images, for a PDF with no
// links, and for any session created before links were extracted at all — all of
// which mean the same thing here, so a missing or unreadable file is no links rather
// than an error. Links are additive: without them a run produces the document it
// always produced.
function readLinks(paths: Paths, sessionId: string): Record<string, PdfLink[]> {
  const path = paths.sessionLinks(sessionId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, PdfLink[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Input files are stored as "<0001>__<original-name>" so submitted order
// (significant per PRD §9.2) survives, independent of filename.
export function enumerateInputs(paths: Paths, sessionId: string): InputImage[] {
  const dir = paths.sessionInput(sessionId);
  const links = readLinks(paths, sessionId);
  return readdirSync(dir)
    .filter((f) => f.includes("__"))
    .map((f) => {
      const [prefix, ...rest] = f.split("__");
      const order = parseInt(prefix, 10);
      return { order, name: rest.join("__"), path: join(dir, f), links: links[String(order)] ?? [] };
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
    extractionConcurrency: cfg.defaults.extraction_concurrency,
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
    // final state exists, build on that state instead of regenerating the document
    // from scratch, so rounds converge. First runs (no saved state) run the full
    // pipeline.
    const finalFragmentsPath = paths.sessionFinalFragments(sessionId);
    const iterative = Boolean(args.feedback) && existsSync(finalFragmentsPath);

    let fragments: Fragment[];
    let beforeBody = "";
    let review: ReviewResult;
    // Specialist-agent suggestions come from a pass that actually looks at the
    // source images: a full extraction, or a targeted feedback re-extraction.
    let suggestions: { name: string; reason: string; image: string }[] = [];
    let mode: string;

    if (iterative) {
      const saved = JSON.parse(readFileSync(finalFragmentsPath, "utf8")) as {
        fragments?: Fragment[];
        body?: string;
      };
      const priorFragments = saved.fragments ?? [];
      beforeBody = (saved.body ?? assembleBody(priorFragments)).trim();

      // Route the feedback: content-level complaints ("you misread the table on
      // page 3") are unfixable by the review loop, which only ever sees the
      // assembled HTML — those pages must go back to the page agent WITH the
      // source image. Document-level feedback (tone, ordering, a11y policy) stays
      // on the cheap review-only path. Scoping resolves to "document" whenever it
      // is unsure, so this only ever adds work when there is evidence for it.
      const scope = await scopeFeedback(ctx, priorFragments);
      log.event("feedback_scoped", { target: scope.target, pages: scope.pages, reason: scope.reason });

      if (scope.target === "extraction") {
        mode = "feedback_reextract";
        log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode });

        const extraction = await reExtractPages(ctx, priorFragments, scope.pages);
        fragments = extraction.fragments;
        suggestions = extraction.suggestions;

        setPhase("assembly");
        const assembled = await runAssembly(ctx, fragments);

        setPhase("review");
        review = await runReview(ctx, { body: assembled.body, lint: assembled.lint, pages: fragments });
      } else {
        mode = "feedback_iterative";
        log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode });
        fragments = priorFragments;

        setPhase("review");
        // Re-lint the existing reviewed body (no model call), then let the
        // feedback-aware review loop refine it in place.
        const lint = await runAxe(wrapDocument(beforeBody));
        review = await runReview(ctx, { body: beforeBody, lint, pages: fragments });
      }
    } else {
      mode = "full";
      log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode });

      // Single coherent extraction: one accessible-HTML pass per page.
      const extraction = await runExtraction(ctx);
      fragments = extraction.fragments;
      suggestions = extraction.suggestions;

      setPhase("assembly");
      const assembled = await runAssembly(ctx, fragments);

      setPhase("review");
      review = await runReview(ctx, { body: assembled.body, lint: assembled.lint, pages: fragments });
    }

    writeFileSync(paths.sessionOutput(sessionId), review.html);
    // Final accessibility lint result, summarized into the PR description on close (§7.13).
    writeFileSync(paths.sessionLint(sessionId), JSON.stringify(review.lint, null, 2));
    if (review.unresolved.length) {
      writeFileSync(
        paths.sessionUnresolved(sessionId),
        `# Unresolved issues at iteration cap\n\n` +
          review.unresolved
            .map(
              (i) =>
                `- **[${i.severity}]**${i.pages?.length ? ` (page ${i.pages.join(", ")})` : ""} ${i.issue}` +
                `\n  - suggested: ${i.suggested_action}`,
            )
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
      const learnArgs = { agentFile: "page.md", before: beforeBody, after: review.body, feedback: args.feedback };
      // Primary: record a corroborated, generalized lesson to the agent's example
      // bank (injected into future runs). Secondary: a well-corroborated, higher-
      // impact lesson may also be proposed as a gated prompt change (issue).
      //
      // The lesson is threaded from the first into the second because the issue the
      // second files is titled and deduped by it. `agentFile` here is a constant, so
      // without the lesson every proposal ever made computes one identical title, and
      // the first open issue suppresses all of them (see memory.ts `lessonSlug`).
      const lesson = await learnFromFeedback(ctx, learnArgs);
      await proposeAgentUpdatesFromFeedback(ctx, { ...learnArgs, lesson });
    }

    store.updateSession(sessionId, {
      status: "ready_for_review",
      phase: "done",
      iterations_completed: review.iterationsCompleted,
    });
    log.event("run_complete", {
      iterations: review.iterationsCompleted,
      unresolved: review.unresolved.length,
      mode,
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
