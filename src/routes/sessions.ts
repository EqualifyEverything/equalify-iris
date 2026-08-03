import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { IrisConfig } from "../config.ts";
import type { Store, SessionRecord } from "../store/db.ts";
import { encodeCursor, pageSessions, parseCursor } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { runPipeline } from "../pipeline/orchestrator.ts";
import type { AuthedRequest } from "../auth/middleware.ts";
import { sendError } from "./errors.ts";
import { summarizeRun } from "../diagnostics.ts";
import { rasterizePdf, PdfTooLargeError, MAX_PDF_PAGES } from "../util/pdf.ts";
import { outputBasenameFromUploads, convertedHtmlFilename } from "../util/outputNames.ts";
import { captureFixtures } from "../pipeline/regression.ts";
import type { Fragment } from "../pipeline/fragment.ts";
import { RunQueue } from "../util/queue.ts";
import { RunLog } from "../store/runlog.ts";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Wrap multer so its errors (e.g. file too large) become clean 400s.
function uploadImages(req: Request, res: Response, next: NextFunction): void {
  upload.array("images")(req, res, (err: unknown) => {
    if (err) {
      sendError(res, 400, "invalid_request", `Upload failed: ${(err as Error).message}`);
      return;
    }
    next();
  });
}

const IMAGE_EXT = /\.(png|jpe?g|tiff?|webp)$/i;
const PDF_EXT = /\.pdf$/i;
const MAX_TOTAL_PAGES = MAX_PDF_PAGES; // overall cap across all uploaded files

// One-line axe-core summary for the PR description (from sessions/<id>/lint.json).
function sessionSummary(s: SessionRecord) {
  return {
    session_id: s.session_id,
    status: s.status,
    image_count: s.image_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// Owned-by-caller lookup. Returns undefined (caller sends 404) when missing or
// owned by another user, so a token cannot probe others' sessions (§9.1).
function ownedSession(store: Store, id: string, userId: number): SessionRecord | undefined {
  const s = store.getSession(id);
  if (!s || s.github_user_id !== userId) return undefined;
  return s;
}

export function sessionsRouter(cfg: IrisConfig, store: Store): Router {
  const r = Router();
  const paths = new Paths(cfg);

  // One queue for the whole process, bounding how many pipelines run at once
  // across all sessions (see util/queue.ts for why global rather than per-user,
  // and why waiting rather than rejecting).
  const queue = new RunQueue(cfg.defaults.max_concurrent_runs);

  // Submit a run to the queue instead of starting it immediately.
  //
  // The queue wait is recorded in the session's own run log, at both ends: a
  // `run_queued` event when it is admitted and a `run_dequeued` event carrying
  // `waited_ms` when it actually starts. Without those, a session sitting in
  // `queued` behind someone else's 25-page PDF is indistinguishable from a hung
  // one — the operator sees a status that never changes and a log with nothing
  // in it. Logging is best-effort: a run must never fail to start because its
  // log could not be appended to.
  // Returns whether the run got a slot immediately, so the caller can report the
  // session's real state rather than assuming it started.
  const enqueueRun = (args: Parameters<typeof runPipeline>[0]): boolean => {
    const submittedAt = Date.now();
    const log = new RunLog(paths.sessionLog(args.sessionId));
    const stats = queue.stats();
    try {
      log.event("run_queued", { running: stats.running, waiting: stats.waiting, limit: stats.limit });
    } catch {
      // ignore — observability must not block the run
    }
    let startedImmediately = false;
    // `void` is safe: RunQueue.submit() always resolves, even when the task
    // throws (see its docblock), so this cannot become an unhandled rejection.
    // submit() pumps synchronously, so onStart has already fired by the time
    // this returns if a slot was free.
    void queue.submit(
      () => runPipeline(args),
      () => {
        startedImmediately = true;
        try {
          log.event("run_dequeued", { waited_ms: Date.now() - submittedAt });
        } catch {
          // ignore
        }
      },
    );
    return startedImmediately;
  };

  // GET /v1/sessions — list this user's sessions, newest first.
  //
  // Paged by keyset on (created_at, session_id), not by created_at alone: that is
  // not unique — a burst of uploads shares a millisecond — and paging on it drops
  // and repeats rows at tie boundaries (see store.listSessions). The cursor is
  // therefore compound, and an unparseable one is a 400 rather than being
  // compared as a string, which used to silently hand back page one forever.
  r.get("/", (req: AuthedRequest, res) => {
    // One rule for every unusable value: fall back to the default. Written as
    // `Math.max(parseInt(x) || 20, 1)` it was two rules — `?limit=0` is falsy so
    // it became 20, while `?limit=-1` clamped to 1 — so two equally invalid
    // inputs got different page sizes, neither of them documented.
    //
    // Clamping the low end at all matters because a negative limit is destructive
    // twice over: SQLite reads `LIMIT -4` as NO limit, so the whole table comes
    // back, and `slice(0, -5)` then trims rows off the end of the page while
    // still leaving an extra row held back — a short page carrying a next_cursor.
    // (`listSessions` and `pageSessions` clamp too; that symptom is invisible in
    // the response, so it should not depend on one caller getting this right.)
    const asked = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, 100) : 20;
    const status = req.query.status ? String(req.query.status) : undefined;
    const raw = req.query.cursor ? String(req.query.cursor) : undefined;
    const cursor = raw ? parseCursor(raw) : undefined;
    if (raw && !cursor) {
      // Echo the offending value — a 400 that doesn't say what it rejected is
      // undiagnosable from a client log — but truncated. The reflected input is
      // whatever the client sent, and a query string can be kilobytes; there is no
      // legible cursor longer than this, so a longer one is already the answer.
      const shown = raw.length > 80 ? `${raw.slice(0, 80)}… (${raw.length} chars)` : raw;
      sendError(
        res,
        400,
        "invalid_request",
        `Invalid cursor: ${shown}. Pass a next_cursor value from a previous response verbatim ` +
          `(<created_at>|<session_id>, where created_at is UTC ISO-8601 with milliseconds), ` +
          `percent-encoded in the query string.`,
      );
      return;
    }
    const rows = store.listSessions(req.user!.github_user_id, {
      limit: limit + 1,
      status,
      cursor: cursor ?? undefined,
    });
    // The slice-and-cursor decision lives with the query (pageSessions), not
    // here: the over-fetch above, the page boundary, and the cursor are one
    // contract, and a route that re-derives it can drift from the query silently.
    const { page, next } = pageSessions(rows, limit);
    res.json({
      sessions: page.map(sessionSummary),
      next_cursor: next ? encodeCursor(next) : null,
    });
  });

  // POST /v1/sessions — create a session. Accepts images and/or PDFs; PDFs are
  // rasterized to one image per page, expanded in submitted order (§9.2).
  r.post("/", uploadImages, async (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      sendError(res, 400, "invalid_request", "At least one file part named 'images' is required (image or PDF)");
      return;
    }
    for (const f of files) {
      if (!IMAGE_EXT.test(f.originalname) && !PDF_EXT.test(f.originalname)) {
        sendError(res, 400, "invalid_request", `Unsupported file type: ${f.originalname} (allowed: PNG, JPEG, TIFF, WebP, PDF)`);
        return;
      }
    }

    let maxIter = req.user!.max_review_iterations;
    const configPart = (req.body as { config?: string } | undefined)?.config;
    if (configPart) {
      try {
        const parsed = JSON.parse(configPart) as { max_review_iterations?: number };
        if (typeof parsed.max_review_iterations === "number") maxIter = parsed.max_review_iterations;
      } catch {
        sendError(res, 400, "invalid_request", "config part is not valid JSON");
        return;
      }
    }

    // Expand uploads into ordered page images (PDF -> one PNG per page).
    const pages: { name: string; buffer: Buffer }[] = [];
    try {
      for (const f of files) {
        if (PDF_EXT.test(f.originalname)) {
          pages.push(...(await rasterizePdf(f.buffer, f.originalname)));
        } else {
          pages.push({ name: f.originalname, buffer: f.buffer });
        }
      }
    } catch (e) {
      if (e instanceof PdfTooLargeError) {
        sendError(res, 400, "invalid_request", e.message);
      } else {
        sendError(res, 422, "pdf_conversion_failed", `Could not process a PDF: ${(e as Error).message}`);
      }
      return;
    }

    if (pages.length === 0) {
      sendError(res, 400, "invalid_request", "No pages found in the uploaded files");
      return;
    }
    if (pages.length > MAX_TOTAL_PAGES) {
      sendError(res, 400, "invalid_request", `Too many pages (${pages.length}); the maximum is ${MAX_TOTAL_PAGES}.`);
      return;
    }

    const sessionId = `ses_${ulid()}`;
    paths.initSession(sessionId);
    // Remember the source basename so the output title + download filename
    // mirror the upload (e.g. report.pdf -> report_converted.html).
    writeFileSync(paths.sessionSourceName(sessionId), outputBasenameFromUploads(files));
    // Persist page images with an order prefix so submitted order survives (§9.2).
    pages.forEach((p, i) => {
      const order = String(i + 1).padStart(4, "0");
      writeFileSync(join(paths.sessionInput(sessionId), `${order}__${p.name}`), p.buffer);
    });

    const record = store.createSession({
      session_id: sessionId,
      github_user_id: req.user!.github_user_id,
      image_count: pages.length,
      iterations_max: maxIter,
    });

    // Queue the pipeline; clients poll GET /v1/sessions/{id}. The session stays
    // in the `queued` status it was created with until a slot frees up, so a
    // client polling sees queued -> running -> ready_for_review.
    enqueueRun({ cfg, store, sessionId, maxReviewIterations: maxIter, githubToken: req.token });

    res.status(201).json({
      session_id: record.session_id,
      status: record.status,
      image_count: record.image_count,
      created_at: record.created_at,
    });
  });

  // GET /v1/sessions/{id} — status.
  r.get("/:id", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    const body: Record<string, unknown> = {
      session_id: s.session_id,
      status: s.status,
      phase: s.phase,
      iterations_completed: s.iterations_completed,
      iterations_max: s.iterations_max,
      image_count: s.image_count,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
    if (s.status === "failed" && s.error) body.error = s.error;
    res.json(body);
  });

  // GET /v1/sessions/{id}/output — the HTML document.
  r.get("/:id/output", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (s.status !== "ready_for_review" && s.status !== "closed") {
      sendError(res, 409, "invalid_state", "Output not available until session is ready_for_review");
      return;
    }
    const outPath = paths.sessionOutput(s.session_id);
    if (!existsSync(outPath)) {
      sendError(res, 409, "invalid_state", "Output not available");
      return;
    }
    // Title + download filename mirror the uploaded file's name.
    const base = existsSync(paths.sessionSourceName(s.session_id))
      ? readFileSync(paths.sessionSourceName(s.session_id), "utf8").trim() || "document"
      : "document";
    const html = readFileSync(outPath, "utf8").replace(
      /<title>[^<]*<\/title>/,
      `<title>${base.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>`,
    );
    res.setHeader("Content-Disposition", `inline; filename="${convertedHtmlFilename(base)}"`);
    res.type("text/html").send(html);
  });

  // GET /v1/sessions/{id}/logs — the run log as ndjson.
  r.get("/:id/logs", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    const logPath = paths.sessionLog(s.session_id);
    res.type("application/x-ndjson").send(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  });

  // GET /v1/sessions/{id}/diagnostics — machine-readable timing/health summary
  // for maintainers (human or AI): phase + per-call durations, the slowest
  // calls, and any in-flight call (the likely culprit when a run seems hung).
  r.get("/:id/diagnostics", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    const logPath = paths.sessionLog(s.session_id);
    const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    res.json(summarizeRun(text, { sessionId: s.session_id, status: s.status, phase: s.phase, now: Date.now() }));
  });

  // POST /v1/sessions/{id}/feedback — re-run within the same session (§7.12).
  r.post("/:id/feedback", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (s.status !== "ready_for_review") {
      sendError(res, 409, "invalid_state", "Feedback can only be submitted when ready_for_review");
      return;
    }
    const feedback = (req.body as { feedback?: string } | undefined)?.feedback;
    if (!feedback || typeof feedback !== "string") {
      sendError(res, 400, "invalid_request", "feedback (string) is required");
      return;
    }
    // Mark it non-terminal before enqueueing, both so a second feedback POST
    // hits the ready_for_review guard and so a client polling a waiting re-run
    // sees `queued` rather than a stale `ready_for_review` alongside a 202 that
    // promised a new run.
    //
    // The claim is what makes that guard a lock rather than a check: the status
    // test and the write are one statement, so of two concurrent callers exactly
    // one proceeds to enqueue. The validation above stays ahead of it so a request
    // with no feedback body still gets its 400 without disturbing the session.
    // Losing the claim means someone else moved the session out of
    // ready_for_review in between, which is the same condition the guard reports.
    if (!store.claimSession(s.session_id, "ready_for_review", { status: "queued", phase: "triage", error: null })) {
      sendError(res, 409, "invalid_state", "Feedback can only be submitted when ready_for_review");
      return;
    }
    const started = enqueueRun({
      cfg,
      store,
      sessionId: s.session_id,
      maxReviewIterations: s.iterations_max,
      feedback,
      githubToken: req.token,
    });
    // Report what actually happened. Under the run cap a re-run waits, and
    // saying "running" then would make a queued session look hung.
    res.status(202).json(
      started
        ? { session_id: s.session_id, status: "running", phase: "extraction" }
        : { session_id: s.session_id, status: "queued", phase: "triage" },
    );
  });

  // POST /v1/sessions/{id}/close — finalize the session and clean tmp (§9.2).
  // Agent contributions are auto-filed as GitHub issues during the run (see
  // pipeline/contribute.ts), so close no longer opens PRs.
  r.post("/:id/close", (req: AuthedRequest, res) => {
    const s = ownedSession(store, req.params.id, req.user!.github_user_id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (s.status !== "ready_for_review") {
      sendError(res, 409, "invalid_state", "Session is not ready_for_review");
      return;
    }
    // Claim the session BEFORE doing any of the work below, unlike the feedback
    // endpoint where the claim sits last. Everything after this point mutates
    // state outside the database — it captures fixtures into the shared agent
    // library and deletes the session's tmp tree — and a loser that discovers it
    // lost only afterwards has already done both. Two concurrent closes would
    // file the same fixtures twice, so the claim goes first and the work happens
    // only on the winning path.
    if (!store.claimSession(s.session_id, "ready_for_review", { status: "closed" })) {
      sendError(res, 409, "invalid_state", "Session is not ready_for_review");
      return;
    }
    // Auto-capture regression fixtures from the accepted output (PRD §7.12): the
    // page agent's per-page output + its source image, used to gate future agent
    // updates so a change can't break a use it already handled. Best-effort —
    // never block closing a session on fixture capture.
    try {
      const finalPath = paths.sessionFinalFragments(s.session_id);
      if (existsSync(finalPath)) {
        const saved = JSON.parse(readFileSync(finalPath, "utf8")) as { fragments?: Fragment[] };
        captureFixtures(paths, s.session_id, saved.fragments ?? []);
      }
    } catch {
      // ignore — fixture capture must not prevent accepting a session
    }
    // Best-effort for the same reason as the capture above, and newly REQUIRED by
    // the claim-first ordering: the row is already `closed`, so a throw here is
    // unrecoverable rather than transient. `force: true` suppresses ENOENT only —
    // an unwritable subdirectory still gives ENOTEMPTY. Previously the status write
    // came last, so a throw left the session at ready_for_review and the client's
    // retry re-ran the cleanup; now the retry would get a 409 while
    // `data_dir/tmp/<id>` is orphaned anyway (nothing else touches tmpDir, and
    // failStaleSessions only rewrites statuses). Swallowing keeps the leak a leak
    // instead of also stranding the session.
    try {
      const tmp = paths.tmpDir(s.session_id);
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore — the session is closed either way
    }
    res.json({ session_id: s.session_id, status: "closed" });
  });

  return r;
}
