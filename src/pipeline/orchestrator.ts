import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IrisConfig } from "../config.ts";
import { ProviderRouter } from "../providers/index.ts";
import {
  SIGNAL_LINKS_DROPPED,
  SIGNAL_LINT_ERROR,
  SIGNAL_ROUNDS,
  SIGNAL_UNRESOLVED,
  type Store,
} from "../store/db.ts";
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
    // Pages the delivered document has no content for (extraction.ts `failedPage`). A run
    // can now finish with some, which is the point — but it has finished with a document
    // that is not what was asked for, so it is reported on the run's own completion line
    // rather than only in the per-page events above it, and re-stated in the document
    // itself once the review loop can no longer edit it (assembly.ts wrapDocument).
    //
    // A property of the DOCUMENT, not of the run that lost the page, which is why it is
    // persisted to final.json and read back on a feedback round. The in-fragment marker
    // travels with the fragment on its own, but it is the one report a Copy Editor round
    // can delete — so a second round on a session that lost page 7 would deliver a
    // document free to claim it is whole, which is what the durable marker exists to
    // prevent. Only re-extracting the page removes it from the set.
    //
    // A run where EVERY page failed does not reach here at all: runExtraction re-raises
    // instead, because a document containing none of the source's words is not a partial
    // success.
    let failedPages: number[] = [];
    // Pages this run filled in that the document had no content for. Logged only once the
    // new state is on disk (below), because that is when it becomes true: diagnostics
    // folds `page_recovered` straight into `pages_failed`, so a line written when the
    // re-extraction returned would answer "the document is whole" for a round that then
    // threw in review — leaving the client with the document that still has the hole.
    let recovered: number[] = [];
    let mode: string;

    if (iterative) {
      const saved = JSON.parse(readFileSync(finalFragmentsPath, "utf8")) as {
        fragments?: Fragment[];
        body?: string;
        failedPages?: number[];
      };
      const priorFragments = saved.fragments ?? [];
      // Absent in state written before this was recorded, which reads as "no page is
      // missing" — the same answer that state implied when it was written.
      failedPages = saved.failedPages ?? [];
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

        // A page that failed earlier is exactly the kind of page feedback names, and
        // re-extracting it successfully is the one thing that fills the hole — so the
        // prior set goes in and the updated one comes out.
        const extraction = await reExtractPages(ctx, priorFragments, scope.pages, failedPages);
        fragments = extraction.fragments;
        suggestions = extraction.suggestions;
        failedPages = extraction.failedPages;
        recovered = extraction.recovered ?? [];

        setPhase("assembly");
        const assembled = await runAssembly(ctx, fragments);

        setPhase("review");
        review = await runReview(ctx, {
          body: assembled.body,
          lint: assembled.lint,
          pages: fragments,
          failedPages,
        });
      } else {
        mode = "feedback_iterative";
        log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode });
        fragments = priorFragments;

        setPhase("review");
        // Re-lint the existing reviewed body (no model call), then let the
        // feedback-aware review loop refine it in place.
        const lint = await runAxe(wrapDocument(beforeBody));
        review = await runReview(ctx, { body: beforeBody, lint, pages: fragments, failedPages });
      }
    } else {
      mode = "full";
      log.event("run_start", { images: images.length, feedback: args.feedback ?? null, mode });

      // Single coherent extraction: one accessible-HTML pass per page.
      const extraction = await runExtraction(ctx);
      fragments = extraction.fragments;
      suggestions = extraction.suggestions;
      failedPages = extraction.failedPages;

      setPhase("assembly");
      const assembled = await runAssembly(ctx, fragments);

      setPhase("review");
      review = await runReview(ctx, {
        body: assembled.body,
        lint: assembled.lint,
        pages: fragments,
        failedPages,
      });
    }

    writeFileSync(paths.sessionOutput(sessionId), review.html);
    // Final accessibility lint result, summarized into the PR description on close (§7.13).
    writeFileSync(paths.sessionLint(sessionId), JSON.stringify(review.lint, null, 2));
    if (review.unresolved.length) {
      writeFileSync(
        paths.sessionUnresolved(sessionId),
        // Not "at the iteration cap": the loop also stops on a round that changed
        // nothing, which is precisely how a document whose remaining issues cannot be
        // fixed here ends up with a list (pipeline/review.ts `review_converged`). This
        // file is what a human reads on close (§7.13), so it says what is true of both.
        `# Unresolved issues when the review loop stopped\n\n` +
          review.unresolved
            .map(
              (i) =>
                `- **[${i.severity}]**${i.pages?.length ? ` (page ${i.pages.join(", ")})` : ""} ${i.issue}` +
                `\n  - suggested: ${i.suggested_action}`,
            )
            .join("\n"),
      );
    }

    // Record what this document cost us, for the deployment-wide quality tally
    // behind GET /v1/quality (PRD §7.16). Counts and axe rule ids only — never the
    // unresolved issues' text or the dropped URLs, both of which are content from
    // the user's own document and would end up in a public GitHub issue.
    //
    // Recorded HERE rather than in a `finally`, so only a run that actually
    // delivered a document is counted: the tally measures the quality of output
    // people received, and a run that threw produced none. A failure is already
    // visible as `sessions.status = 'failed'`.
    //
    // Failing to record must not fail a document the user has already paid for, so
    // this is soft — same reasoning as the contribution filing below. But it is
    // logged loudly, because the silent version of this failure is a quality tally
    // that reads BETTER over time as recording breaks: fewer signals recorded looks
    // exactly like fewer problems found.
    try {
      store.recordRunSignals(sessionId, [
        // Always, including for a flawless document: this is the denominator every
        // rate divides by (see SIGNAL_ROUNDS).
        { code: SIGNAL_ROUNDS, count: review.iterationsCompleted },
        ...(review.unresolved.length ? [{ code: SIGNAL_UNRESOLVED, count: review.unresolved.length }] : []),
        ...(review.droppedLinks ? [{ code: SIGNAL_LINKS_DROPPED, count: review.droppedLinks }] : []),
        // A linter that could not run reports zero violations, which is why its
        // failure is recorded as a signal rather than inferred from an empty list.
        ...(review.lint.error ? [{ code: SIGNAL_LINT_ERROR, count: 1 }] : []),
        // The final lint, i.e. what survived the whole review loop. `nodes` is the
        // offending-element count, kept apart from the per-document tally.
        ...review.lint.violations.map((v) => ({ code: v.id, impact: v.impact, count: v.nodes })),
      ]);
    } catch (e) {
      log.event("run_signals_failed", { error: e instanceof Error ? e.message : String(e) });
    }

    // Persist the final state so the next feedback round can refine the reviewed
    // body iteratively, and so regression fixtures (the page agent's per-page
    // output keyed to its source image) can be captured on accept (close handler).
    writeFileSync(
      finalFragmentsPath,
      JSON.stringify({ fragments, body: review.body, failedPages }, null, 2),
    );
    // Now that the document that HAS these pages is the persisted one (see `recovered`).
    if (recovered.length) log.event("page_recovered", { pages: recovered });

    store.updateSession(sessionId, {
      status: "ready_for_review",
      phase: "done",
      iterations_completed: review.iterationsCompleted,
    });

    // Feedback -> agent training (PRD §7.12/§7.13): turn the document-level
    // correction this feedback run produced into a proposed improvement to the
    // page agent, recorded (gated by its regression fixtures) for review; or
    // in-place training if a session-built page agent is in use.
    //
    // AFTER the status is set, which is what the caller polls. None of this can change
    // the document — it has been written, linted and persisted above — and it is not
    // cheap: a classify call, a train call, and then the candidate prompt run against
    // the agent's fixtures twice over (pipeline/feedback.ts). On a feedback round the
    // user was waiting through all of it for work about a FUTURE document, and so was
    // every upload behind them in the queue. This is the same principle the contribution
    // step below already states — never block the result — applied to the other side
    // effect that was blocking it.
    //
    // Contained, because after this point a throw would be reported as a failed run over
    // a document the user already has. That was true before this moved, and worse: a
    // provider error in training marked a session `failed` whose output.html was on disk
    // and whose Reader had signed it off. Training is best-effort; the delivered document
    // is not its to revoke.
    //
    // What this ordering admits is a client acting on `ready_for_review` while the run is
    // still here. `POST /close` deletes the session's tmp tree, and `POST /feedback`
    // claims the session and starts a second run — neither waits for this one, because
    // the run queue's cap is global rather than per session. Both windows existed already
    // (`runContribution` below has always run past the status), and this widens them from
    // a moment to a training round. What is in them:
    //
    //   - A close can pull `tmp/<id>/agents` out from under a session-built agent's
    //     in-place training. Forward-looking rather than live: nothing seeds a
    //     session-built `page.md` today, so the only writer of that path never runs for
    //     the agent this trains.
    //   - Two runs can touch the shared lesson bank at once. That is not new — the bank
    //     is keyed by agent rather than by session, so any two concurrent runs already
    //     could — and it is why writing it is atomic (pipeline/memory.ts).
    //   - A throw after the status is set must not re-fail a delivered session, which is
    //     what the containment here and around `runContribution` below is for.
    //
    // The alternative is making every feedback round wait minutes for work about a future
    // document, which is what this is fixing.
    if (args.feedback) {
      const learnArgs = { agentFile: "page.md", before: beforeBody, after: review.body, feedback: args.feedback };
      try {
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
      } catch (e) {
        log.event("feedback_training_failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Logged after the training above rather than before it, even though the session is
    // already `ready_for_review`: this is the run's own terminal marker, and diagnostics
    // measures a finished run's duration up to it (src/diagnostics.ts). The run holds its
    // `max_concurrent_runs` slot until this function returns, so a `run_complete` written
    // before the training would report a run as shorter than the time it actually
    // occupied the machine.
    log.event("run_complete", {
      iterations: review.iterationsCompleted,
      unresolved: review.unresolved.length,
      mode,
      // Only when there were any: a `failed_pages` of [] on every successful run would
      // read as a field about failure on lines that have none.
      ...(failedPages.length ? { failed_pages: failedPages } : {}),
    });

    // After the user has their output, auto-file agent-suggestion issues
    // (no-op unless a token is available). Never blocks the result — and now cannot fail
    // it either. Both of its own failure paths are already contained (contribute.ts
    // catches the draft call and the filing separately), but what is left outside them is
    // still an fs read, and the outer catch below would answer it by writing `failed`
    // over a session whose document was delivered — the same wrong answer the training
    // above used to give. A second feedback round can even have started by then, since
    // the status has been `ready_for_review` since well before this line.
    try {
      await runContribution(ctx, suggestions);
    } catch (e) {
      log.event("contribution_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.updateSession(sessionId, { status: "failed", error: message });
    log.event("run_failed", { error: message });
  }
}
