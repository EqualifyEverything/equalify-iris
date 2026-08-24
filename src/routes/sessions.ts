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
import { rasterizePdf, PdfTooLargeError, MAX_PDF_PAGES, type PageImage, type PdfLink } from "../util/pdf.ts";
import { outputBasenameFromUploads, convertedHtmlFilename } from "../util/outputNames.ts";
import { captureFixtures } from "../pipeline/regression.ts";
import type { Fragment } from "../pipeline/fragment.ts";
import { RunQueue } from "../util/queue.ts";
import {
  MAX_UPLOAD_FILES,
  meterUploadBody,
  requestSizeGate,
  uploadGate,
  uploadRateLimit,
} from "../util/requestLimits.ts";
import { RunLog } from "../store/runlog.ts";
import {
  IMAGE_MEDIA_TYPES,
  imageRejection,
  rasterizedPageRejection,
  resolveImageLimits,
} from "../providers/imageLimits.ts";
import { imageDimensions } from "../util/imageSize.ts";

// 50 MB is a memory bound, not the image limit. It stays well above what an image may
// be (see imageLimits.ts) because a PDF legitimately is: 25 pages of scans is a large
// file whose page images are small, and this ceiling has to admit it. Per-image size is
// checked in the handler instead, where the file's type is known.
//
// `files` bounds the OTHER half of that memory, which a per-file ceiling cannot: a
// multipart body may carry any number of parts, so 50 MB each with no count meant one
// request could buffer gigabytes before this handler ran. It cannot cost a real upload
// anything — a session is capped at 25 pages however they arrive, so 25 files is already
// more than an accepted request can use (see requestLimits.ts).
//
// Note what this pair is NOT: their product is 1.25 GB, so they are per-part backstops and
// never the total. What one request may buffer in all is enforced in two places that share
// one ceiling — `requestSizeGate`, which refuses a declared length before reading anything,
// and `meterUploadBody`, which counts an undeclared one as it arrives (requestLimits.ts).
// The numbers here only have to stay above any single legitimate part.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: MAX_UPLOAD_FILES },
});

// Wrap multer so its errors (e.g. file too large) become clean 400s.
function uploadImages(req: Request, res: Response, next: NextFunction): void {
  // The total-bytes ceiling for a body that declared no length, which multer's per-part
  // limits are not (see requestLimits.ts). Called here rather than mounted as its own
  // middleware because it counts bytes off the request stream, and everything between it
  // and multer's `req.pipe()` has to be synchronous — one statement is as close as that
  // gets. It answers the request itself if the body overruns, and multer then never calls
  // back at all.
  meterUploadBody(req, res);
  upload.array("images")(req, res, (err: unknown) => {
    if (err) {
      // meterUploadBody above can have already answered 413 and unpiped this body mid-parse.
      // It does not expect multer to call back at all after that, but a second write to a
      // sent response would throw from in here, where nothing is listening.
      if (res.headersSent) return;
      // Multer says "Too many files" for the part count, which does not say how many are
      // too many. That cap is one Iris chose rather than a property of multipart, so the
      // refusal owes the caller the number and what to do about it.
      const message =
        (err as { code?: string }).code === "LIMIT_FILE_COUNT"
          ? `Upload failed: at most ${MAX_UPLOAD_FILES} file parts per request, since one session ` +
            `carries at most ${MAX_TOTAL_PAGES} pages however they arrive. Split a larger batch across sessions.`
          : `Upload failed: ${(err as Error).message}`;
      sendError(res, 400, "invalid_request", message);
      return;
    }
    next();
  });
}

// Built from the formats the vision model actually reads (providers/imageLimits.ts)
// rather than written out here, so this validator cannot go on accepting a format
// the model stopped supporting — or, as it did with TIFF, never supported.
const IMAGE_EXT = new RegExp(`(?:${Object.keys(IMAGE_MEDIA_TYPES).map((e) => `\\${e}`).join("|")})$`, "i");
const PDF_EXT = /\.pdf$/i;
const MAX_TOTAL_PAGES = MAX_PDF_PAGES; // overall cap across all uploaded files

// How the allowed types read in an error message: ".png,.jpg" -> "PNG, JPG".
const ALLOWED_TYPES = [...Object.keys(IMAGE_MEDIA_TYPES).map((e) => e.slice(1).toUpperCase()), "PDF"].join(", ");

// A rasterized PDF page the vision model cannot accept. Thrown from the expansion
// loop rather than returned, because the check sits inside an `await` over several
// files and the alternative is threading a rejection out through both branches; it
// lands in the same catch as the other PDF failures. It carries the finished message
// so the handler decides the status code and nothing else re-words the diagnosis.
class PageTooLargeError extends Error {}

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
  // What one page image may be, for the model this deployment runs. Resolved once:
  // config does not change without a restart, and the same numbers are published by
  // GET /v1/limits so a client can check before uploading.
  const imageLimits = resolveImageLimits(cfg);

  // One queue for the whole process, bounding how many pipelines run at once
  // across all sessions (see util/queue.ts for why global rather than per-user,
  // and why waiting rather than rejecting).
  const queue = new RunQueue(cfg.defaults.max_concurrent_runs);

  // What the queue cannot bound, because it is spent before a handler runs: upload bytes
  // held in memory at once, and uploads accepted from one user per minute. Built once per
  // router, since both hold the counters they enforce (util/requestLimits.ts).
  //
  // The in-flight gate is checked before the per-minute budget so a request refused for
  // congestion does not also spend a minute's allowance — it was told to retry in
  // seconds, and that advice has to still be true when it does.
  const inFlightUploads = uploadGate(cfg);
  const uploadBudget = uploadRateLimit(cfg);

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
  //
  // Three gates run BEFORE `uploadImages`, and the order is the point: multer buffers the
  // whole body into memory as it parses, so anything that runs after it has already paid
  // for the request it was going to refuse. So the size the caller declares is checked
  // first (free), then how many bytes of upload are already arriving, then the caller's
  // upload budget for the minute — and only then is a byte of this body read.
  r.post("/", requestSizeGate(), inFlightUploads, uploadBudget, uploadImages, async (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      sendError(res, 400, "invalid_request", "At least one file part named 'images' is required (image or PDF)");
      return;
    }
    for (const f of files) {
      if (!IMAGE_EXT.test(f.originalname) && !PDF_EXT.test(f.originalname)) {
        sendError(res, 400, "invalid_request", `Unsupported file type: ${f.originalname} (allowed: ${ALLOWED_TYPES})`);
        return;
      }
      // Too heavy for the vision model to accept, checked before anything is written
      // to disk or queued. Without this the upload succeeded, the run started, and
      // the first vision call ate the whole payload and then failed — reaching the
      // user two to four minutes later as a message about a stream that produced no
      // output, naming neither the file nor anything to do about it.
      //
      // A PDF is not measured here — the file the caller sent is not what reaches the
      // model. A 20 MB PDF of 25 light pages is a perfectly convertible document, so
      // the size that matters is the size of each page AFTER rasterizing, and that is
      // checked where the pages exist (below).
      if (!PDF_EXT.test(f.originalname)) {
        const size = imageDimensions(f.buffer);
        const why = imageRejection(
          {
            name: f.originalname,
            bytes: f.buffer.length,
            width: size?.width,
            height: size?.height,
          },
          imageLimits,
        );
        if (why) {
          sendError(res, 400, "invalid_request", why);
          return;
        }
      }
    }

    // The review cap is the caller's account default (seeded from the
    // deployment's `defaults.max_review_iterations`). A per-request `config`
    // JSON part used to override it; it was removed because it asked the caller
    // for a number they are not positioned to choose — how many rounds a
    // document needs is a property of the document, discovered by the loop, and
    // the only thing the knob could usefully express was "spend fewer rounds
    // than this deployment budgeted", i.e. ask for a worse document. It was also
    // unvalidated: any number was accepted, including `0` (one reader pass, no
    // fix ever applied) and negatives (review skipped outright). A `config` part
    // on the request is now ignored rather than rejected, so an older client
    // still sending one keeps working, at the deployment's cap.
    const maxIter = req.user!.max_review_iterations;

    // Expand uploads into ordered page images (PDF -> one PNG per page), each
    // carrying the link annotations on that page — the one part of a PDF that
    // rasterizing destroys, so it travels alongside the image (see pipeline/links.ts).
    const pages: PageImage[] = [];
    try {
      for (const f of files) {
        if (PDF_EXT.test(f.originalname)) {
          const rendered = await rasterizePdf(f.buffer, f.originalname);
          // The uploaded PDF was exempt from the per-image limits; its pages are not.
          // Rasterizing at a fixed DPI means the page image's size follows the
          // PHYSICAL page, so a large-format page (a drawing, a fold-out) renders past
          // what the model accepts — and the run would then die inside the first
          // vision call, minutes in, which is the failure this route exists to catch.
          for (const [i, p] of rendered.entries()) {
            const size = imageDimensions(p.buffer);
            const why = rasterizedPageRejection(
              f.originalname,
              i + 1,
              { bytes: p.buffer.length, width: size?.width, height: size?.height },
              imageLimits,
            );
            if (why) throw new PageTooLargeError(why);
          }
          pages.push(...rendered);
        } else {
          pages.push({ name: f.originalname, buffer: f.buffer, links: [] });
        }
      }
    } catch (e) {
      if (e instanceof PageTooLargeError || e instanceof PdfTooLargeError) {
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
    // …and the link annotations beside them, keyed by that same order. Only when
    // there are some, so a session of plain images gains no empty file.
    const linksByOrder: Record<string, PdfLink[]> = {};
    pages.forEach((p, i) => {
      if (p.links.length) linksByOrder[String(i + 1)] = p.links;
    });
    if (Object.keys(linksByOrder).length) {
      writeFileSync(paths.sessionLinks(sessionId), JSON.stringify(linksByOrder, null, 2));
    }

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
    if (!store.claimSession(s.session_id, "ready_for_review", { status: "queued", phase: "extraction", error: null })) {
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
    // saying "running" then would make a queued session look hung. Both report
    // `extraction` — the phase the run starts in; the queued branch used to say
    // `triage`, a phase the pipeline never enters, and this 202 was the one place
    // a client could actually observe it.
    res.status(202).json(
      started
        ? { session_id: s.session_id, status: "running", phase: "extraction" }
        : { session_id: s.session_id, status: "queued", phase: "extraction" },
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
        const saved = JSON.parse(readFileSync(finalPath, "utf8")) as {
          fragments?: Fragment[];
          failedPages?: number[];
        };
        // A page whose extraction failed is excluded. Its fragment is a `@page-failed`
        // comment, and a fixture is an assertion that this HTML is the RIGHT output for
        // this image — capturing one would gate every future page-agent update on
        // reproducing a failure, and the first page of a document is exactly the
        // representative image the fixture is keyed to. Read from the recorded set
        // rather than sniffed out of the HTML: the run already knows which pages those
        // are (pipeline/orchestrator.ts).
        const failed = new Set(saved.failedPages ?? []);
        captureFixtures(paths, s.session_id, (saved.fragments ?? []).filter((f) => !failed.has(f.order)));
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
