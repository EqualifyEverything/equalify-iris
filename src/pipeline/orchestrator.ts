import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IrisConfig } from "../config.ts";
import { ProviderRouter } from "../providers/index.ts";
import {
  SIGNAL_LINKS_DROPPED,
  SIGNAL_LINKS_UNRESOLVED,
  SIGNAL_MARKUP_UNBALANCED,
  SIGNAL_TABLE_NO_BODY,
  SIGNAL_STRUCTURAL_DEFECT,
  SIGNAL_LINT_ERROR,
  lintErrorWhereSignal,
  SIGNAL_EDITOR_TRUNCATED,
  SIGNAL_EDITOR_TRUNCATED_LOST,
  SIGNAL_REVIEW_UNREAD,
  reviewStoppedSignal,
  SIGNAL_ROUNDS,
  SIGNAL_UNRESOLVED,
  SIGNAL_UNFINISHED_PAGE,
  unresolvedSeverity,
  unresolvedSeveritySignal,
  UNRESOLVED_SEVERITY,
  type Store,
} from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { RunLog } from "../store/runlog.ts";
import type { InputImage, PipelineContext } from "./context.ts";
import { runExtraction, reExtractPages } from "./extraction.ts";
import { runAssembly, assembleBody, wrapDocument } from "./assembly.ts";
import { stripDeprecatedRoles } from "./roles.ts";
import { stripNestedMain } from "./landmarks.ts";
import { markerCounts, MARKER_PAGE_INCOMPLETE, runReview, type ReviewResult } from "./review.ts";
import { runAxe, lintErrorFields, lintDebrisFields } from "./lint.ts";
import { learnFromFeedback, proposeAgentUpdatesFromFeedback, scopeFeedback } from "./feedback.ts";
import { runContribution } from "./contribute.ts";
import { unresolvedRefs } from "./links.ts";
import { markupReport } from "./markup.ts";
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
      // A deprecated role in a body this run did not produce (roles.ts, #187). Neither branch of
      // that `??` covers the other: the join strips, a body stored before this existed does not,
      // and this path runs no assembly at all — so a re-run whose Reader is satisfied, or that
      // converges on the first round, would deliver a role the pipeline no longer emits with no
      // correction round in it to catch one. Stripped before the re-lint below, so the gate is not
      // shown a violation that is about to be removed, and before the diff baseline, so a role
      // this pass took does not read as a change the loop made.
      const priorRoles = stripDeprecatedRoles(beforeBody);
      if (priorRoles.nodes > 0) {
        beforeBody = priorRoles.html;
        log.event("deprecated_roles_stripped", {
          stage: "feedback_prior_body",
          roles: [...new Set(priorRoles.stripped)].sort(),
          nodes: priorRoles.nodes,
        });
      }
      // And a `<main>` a page emitted for itself, on the same argument (landmarks.ts, #251):
      // `saved.body` was assembled by whatever build wrote it, so a body stored before this
      // existed still carries one, and this path never reaches the assembly that would now
      // remove it. Ahead of the re-lint and the diff baseline for the same two reasons as
      // above.
      const priorMains = stripNestedMain(beforeBody);
      if (priorMains.unwrapped > 0 || priorMains.downgraded > 0 || priorMains.dropped > 0 || priorMains.declined > 0) {
        beforeBody = priorMains.html;
        log.event("page_main_stripped", {
          stage: "feedback_prior_body",
          unwrapped: priorMains.unwrapped,
          downgraded: priorMains.downgraded,
          dropped: priorMains.dropped,
          declined: priorMains.declined,
        });
      }

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
        // This path runs no assembly, so there is no `assembly` line to carry a failure here,
        // and the loop's own re-lint only happens on a round that CHANGED something — a
        // feedback re-run whose Reader is satisfied, or that converges, would otherwise
        // record `iris:lint-error` and deliver `@lint-unavailable` with no error, stack or
        // step anywhere in the log to chase it by. Reachable on exactly #164's document: its
        // own feedback re-run.
        if (lint.error) log.event("lint_unavailable", { stage: "feedback_relint", ...lintErrorFields(lint) });
        // Same event and same shape as the review loop's, for the reason `lintErrorFields` is shared:
        // this path lints a body it did not extract, and debris that read differently here would be
        // debris nobody greps for (#257).
        if (lint.malformedAttributes) log.event("lint_debris", { stage: "feedback_relint", ...lintDebrisFields(lint) });
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
    // Whether this document's own navigation works (#234), measured on the bytes just
    // written rather than on `review.body` — every rename, every correction round and the
    // wrapper's markers are finished here, and this is the file the caller receives.
    //
    // Logged whenever anything does not land, and not otherwise: a document whose
    // references all resolve is the ordinary case and needs no line. `dangling` names the
    // ids, bounded, because the remedy depends on WHICH — `#page-53` in a 25-page chunk is
    // a reference to a part of the document this run never had, `#fn-3b` is a target no
    // page ever wrote. Ids are structural rather than content, and this log stays on the
    // deployment; the tally below gets counts only, because that one reaches a public
    // issue (see QualityStats).
    const internalLinks = unresolvedRefs(review.html);
    if (internalLinks.empty || internalLinks.dangling) {
      log.event("internal_links", {
        refs: internalLinks.refs,
        empty: internalLinks.empty,
        dangling: internalLinks.dangling,
        // Distinct ids, so this is shorter than `dangling` when one dead target is
        // linked repeatedly — which is the ordinary case for a table of contents.
        ids: internalLinks.ids.slice(0, 20),
      });
    }
    // And whether the document's own markup says what the model thought it said (#240),
    // measured on the same bytes and for the same reason: this is the file the caller gets.
    //
    // Two findings on one line, because they are one question asked either side of the parser.
    // `unbalanced` is the source's own tag counts — the only place an unclosed `<table>` is
    // still visible, since the parse that axe lints repairs it first — and `tables_without_body`
    // is what survives that repair: a caption and nine column headers with no rows under them.
    //
    // Logged only when something is wrong, `parse_error` included, since a check that could not
    // run must not read as a check that found nothing (#164).
    const markup = markupReport(review.html);
    if (markup.unbalanced.length || markup.tablesWithoutBody || markup.parseError) {
      log.event("delivered_markup", {
        // `element open/close`, e.g. `table 16/15`, which is what a maintainer needs in order
        // to know whether to care: the parser's recovery from an unclosed `<table>` costs a
        // reader nothing, an unclosed `<a>` swallows the text up to the next link.
        unbalanced: markup.unbalanced.map((u) => `${u.element} ${u.open}/${u.close}`),
        tables: markup.tables,
        tables_without_body: markup.tablesWithoutBody,
        // Captions, so the table can be found without diffing the document. Content from the
        // user's file, so it stays here and never reaches the tally (see QualityStats).
        empty_table_captions: markup.emptyTableCaptions.slice(0, 10),
        ...(markup.parseError ? { parse_error: markup.parseError } : {}),
      });
    }
    // And the four structural defects a script can prove are present, which the gate reports on
    // none of (#255). Its own line rather than more keys on the one above: those two are the
    // parser's two sides of one question, these four are separate classes, and a maintainer
    // reading either wants the other one's zeros out of the way.
    //
    // All four counts whenever any of them fired, zeros included, because on this line a zero is
    // a measurement: it says that class was looked for in this document and is not there. A
    // document with none of them logs nothing at all, which is the ordinary case.
    const structure = markup.structure;
    const found = [structure.danglingIdrefs, structure.dlWithoutDd, structure.langOnVoid, structure.emptyLandmarks];
    // Three of the four, summed, for the tally below. `langOnVoid` is not in it on purpose.
    const structuralDefects =
      structure.danglingIdrefs.count + structure.dlWithoutDd.count + structure.emptyLandmarks.count;
    if (found.some((f) => f.count)) {
      log.event("delivered_structure", {
        dangling_idrefs: structure.danglingIdrefs.count,
        dl_without_dd: structure.dlWithoutDd.count,
        lang_on_void: structure.langOnVoid.count,
        empty_landmarks: structure.emptyLandmarks.count,
        // Instances, only for the classes that have any. Ids and language tags out of the user's
        // own document, so they stay here and never reach the tally (see QualityStats).
        ...(structure.danglingIdrefs.count ? { dangling_idref_examples: structure.danglingIdrefs.examples } : {}),
        ...(structure.dlWithoutDd.count ? { dl_without_dd_examples: structure.dlWithoutDd.examples } : {}),
        ...(structure.langOnVoid.count ? { lang_on_void_examples: structure.langOnVoid.examples } : {}),
        ...(structure.emptyLandmarks.count ? { empty_landmark_elements: structure.emptyLandmarks.examples } : {}),
      });
    }
    // Final accessibility lint result, summarized into the PR description on close (§7.13).
    writeFileSync(paths.sessionLint(sessionId), JSON.stringify(review.lint, null, 2));
    if (review.unresolved.length) {
      writeFileSync(
        paths.sessionUnresolved(sessionId),
        // Not "at the iteration cap": the loop also stops on a round that changed
        // nothing, which is precisely how a document whose remaining issues cannot be
        // fixed here ends up with a list (pipeline/review.ts `review_converged`), and on
        // a round whose response hit the output ceiling, where no editor pass worked on
        // this list at all (`editor_truncated`). This file is what a human reads on close
        // (§7.13), so it says what is true of all three; which one it was is in the
        // delivered document and in the run log.
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

    // Pages the extractor could not return in full, as the delivered BODY still says it — not
    // as the wrapped document does. An unresolved issue about one of these markers quotes the
    // marker, and those lines are in `review.html`, so counting there would count the Reader's
    // report of a marker as a second marker (#264).
    const pageMarkers = markerCounts(review.body)[MARKER_PAGE_INCOMPLETE] ?? 0;

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
        // And how the Reader rated them, one row per severity that occurs (#264). The rate above
        // says a document shipped with something open; this says whether that something was a
        // barrier or a nit, which is the difference between a defect and the floor.
        //
        // Counted per severity, so a document with three low issues and one high contributes a
        // row to each — the rows are not a partition of `unresolved` and `Store.qualityStats`
        // says so. Bucketed through `unresolvedSeverity` rather than read off the issue,
        // because the field is model-written and unvalidated: whatever the Reader put there
        // that is not one of the three lands in `unrated` and no model-chosen string reaches
        // this table.
        ...UNRESOLVED_SEVERITY.flatMap((severity) => {
          const count = review.unresolved.filter((i) => unresolvedSeverity(i.severity) === severity).length;
          return count ? [{ code: unresolvedSeveritySignal(severity), count }] : [];
        }),
        // Which of the loop's exits ended this run, for every document including a clean one —
        // the five counts are meant to sum to the documents in the window, and that is what
        // makes a shortfall readable as an exit nobody attributed (#264). Written only when the
        // loop named one, for the reason the lint step above is: a missing reason is a fact and
        // a guessed one is not.
        ...(review.stoppedAt ? [{ code: reviewStoppedSignal(review.stoppedAt), count: 1 }] : []),
        // The delivered document still says a page was not returned in full, which means it
        // could not have finished the loop clean however many rounds it got: the Reader raises
        // the marker every round and the editor is forbidden to resolve it. Per marker, so a
        // document missing four pages is not one missing one — the floor under `unresolved_rate`
        // is a document count, but the size of the extraction problem behind it is not.
        //
        // Measured on the body that shipped rather than on the marker diff the loop already
        // logs, because the question is what the reader received: a marker the editor dropped
        // is a different failure (`editor_markers_changed`) and one this must not count.
        ...(pageMarkers ? [{ code: SIGNAL_UNFINISHED_PAGE, count: pageMarkers }] : []),
        ...(review.droppedLinks ? [{ code: SIGNAL_LINKS_DROPPED, count: review.droppedLinks }] : []),
        // References in the delivered document that do not land. Counted together here
        // even though the log splits them, because the rate answers one question — did
        // this document ship with navigation that does not navigate — and the split
        // between "written with no target" and "target absent" is a diagnosis a
        // maintainer reads on the deployment (see SIGNAL_LINKS_UNRESOLVED).
        ...(internalLinks.empty + internalLinks.dangling
          ? [{ code: SIGNAL_LINKS_UNRESOLVED, count: internalLinks.empty + internalLinks.dangling }]
          : []),
        // Markup that does not balance, counted per ELEMENT rather than per missing tag: the
        // scan compares totals, so `table 16/15` is one finding about one element name and how
        // many tags are missing is not something a count of counts can say.
        ...(markup.unbalanced.length ? [{ code: SIGNAL_MARKUP_UNBALANCED, count: markup.unbalanced.length }] : []),
        // Tables announced with a header block and nothing under it. Per table, so a document
        // that emitted the same continued header three times reads as three.
        ...(markup.tablesWithoutBody ? [{ code: SIGNAL_TABLE_NO_BODY, count: markup.tablesWithoutBody }] : []),
        // Structural promises the document does not keep, the three classes summed: a reference to
        // an absent id, a term list with no definitions, an empty landmark. Summed rather than
        // recorded apart for the reason given for the links above — the rate is about whether a
        // reader was promised something absent, and which class it was is on the log line. The
        // fourth check, a language tag on an element with no text, is out on purpose: wasted
        // output is not the same kind of finding (see SIGNAL_STRUCTURAL_DEFECT).
        ...(structuralDefects ? [{ code: SIGNAL_STRUCTURAL_DEFECT, count: structuralDefects }] : []),
        // A linter that could not run has no violations to report, which is why its
        // failure is recorded as a signal rather than inferred from an empty list.
        ...(review.lint.error ? [{ code: SIGNAL_LINT_ERROR, count: 1 }] : []),
        // And which step it failed at, as a second row on the same document (#263). Written
        // only when the result names a step, so the pair means what it says: the rate above
        // counts documents with no verdict, and this counts the ones that can say why. A
        // `LintResult` carrying an error and no `errorWhere` is not a shape `runAxe` produces
        // — every failure path there goes through `failure()`, which always sets it — so an
        // unattributed row means a result assembled somewhere else, and inventing a step for
        // it would be the one thing this field must not do.
        ...(review.lint.error && review.lint.errorWhere
          ? [{ code: lintErrorWhereSignal(review.lint.errorWhere), count: 1 }]
          : []),
        // A round whose whole-body answer was paid for in full and could not be used. Counted
        // per document, not per round: the loop stops at the first one, because the next
        // request would be the same length as the one that did not fit.
        ...(review.editorTruncated ? [{ code: SIGNAL_EDITOR_TRUNCATED, count: 1 }] : []),
        // And whether the sectioned retry left any of the document uncorrected. Two signals
        // rather than one because they answer different questions — the ceiling this deployment
        // is paying to work around, against the corrections its readers did not get — and
        // because a threshold can only be put on the second (see SIGNAL_EDITOR_TRUNCATED_LOST).
        ...(review.editorTruncatedLost ? [{ code: SIGNAL_EDITOR_TRUNCATED_LOST, count: 1 }] : []),
        // How much of the document the reviewer's last read did not answer about. The one
        // signal here that changes what `clean_rate` MEANS rather than adding a rate beside
        // it: without it, a document whose review said nothing is indistinguishable from one
        // whose review found nothing (see SIGNAL_REVIEW_UNREAD).
        ...(review.unreviewedWindows ? [{ code: SIGNAL_REVIEW_UNREAD, count: review.unreviewedWindows }] : []),
        // The final lint, i.e. what survived the whole review loop. `nodes` is the
        // offending-element count, kept apart from the per-document tally. Empty when the
        // lint could not run — and that document is NOT in any rule's numerator, which is
        // what `documents_linted` exists to divide by (see QualityStats).
        ...(review.lint.violations ?? []).map((v) => ({ code: v.id, impact: v.impact, count: v.nodes })),
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
