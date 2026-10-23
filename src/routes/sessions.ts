import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { readFileSync, existsSync, rmSync, statSync } from "node:fs";
import type { IrisConfig } from "../config.ts";
import type { Store, SessionRecord } from "../store/db.ts";
import { encodeCursor, pageSessions, parseCursor } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { runPipeline } from "../pipeline/orchestrator.ts";
import { sendError } from "./errors.ts";
import { summarizeRun } from "../diagnostics.ts";
import { PdfTooLargeError } from "../util/pdf.ts";
import { convertedHtmlFilename, titledAs } from "../util/outputNames.ts";
import { keptFields, readableFieldNames } from "../pipeline/fields.ts";
import { captureFixtures } from "../pipeline/regression.ts";
import { MAX_TOTAL_PAGES, renderUploads, stageSession, UploadRejectedError, uploadRejection } from "../pipeline/stage.ts";
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
import { resolveImageLimits } from "../providers/imageLimits.ts";
import { createdFields, readFields, tagPdf, taggedPdfCommand, tagTimeoutSeconds, TaggedPdfError, type PdfField, type TagInput } from "../util/taggedPdf.ts";

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

// One row of `GET /v1/sessions` (see its handler below). Deliberately no lint result and no
// document: a list is for finding a session, and everything about its output is on the session
// itself.
function sessionSummary(s: SessionRecord) {
  return {
    session_id: s.session_id,
    status: s.status,
    image_count: s.image_count,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// Set `key` as the newest entry, and drop the oldest past `max`. A Map keeps insertion order.
export function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

// A session whose files the retention rule deleted (store/retention.ts): 410, rather than a
// failure on missing files.
function expired(res: Response, s: SessionRecord): boolean {
  if (!s.files_deleted_at) return false;
  sendError(res, 410, "session_expired", "This session's files were deleted after the retention period.");
  return true;
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

  // GET /v1/sessions — list THIS DEPLOYMENT's sessions, newest first.
  //
  // Not one caller's: every session belongs to the deployment, so this lists all of them, and
  // a visitor can page through the ids of documents other visitors uploaded. A single id is
  // not guessable (`ses_` + a ULID is 80 random bits). A deployment that must not leak the
  // list sets `server.api_token` so strangers cannot reach this route at all.
  //
  // Paged by keyset on (created_at, session_id), not by created_at alone: that is not unique
  // — a burst of uploads shares a millisecond — and paging on it drops and repeats rows at
  // tie boundaries (see store.listSessions). The cursor is therefore compound, and an
  // unparseable one is a 400 rather than being compared as a string, which used to silently
  // hand back page one forever.
  r.get("/", (req, res) => {
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
    const rows = store.listSessions({
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
  // rasterized to one image per page, expanded in submitted order.
  //
  // Three gates run BEFORE `uploadImages`, and the order is the point: multer buffers the
  // whole body into memory as it parses, so anything that runs after it has already paid
  // for the request it was going to refuse. So the size the caller declares is checked
  // first (free), then how many bytes of upload are already arriving, then the caller's
  // upload budget for the minute — and only then is a byte of this body read.
  r.post("/", requestSizeGate(), inFlightUploads, uploadBudget, uploadImages, async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      sendError(res, 400, "invalid_request", "At least one file part named 'images' is required (image or PDF)");
      return;
    }
    const rejected = uploadRejection(files, imageLimits);
    if (rejected) {
      sendError(res, 400, "invalid_request", rejected);
      return;
    }

    // The review cap is the deployment's `defaults.max_review_iterations`. A per-request `config`
    // JSON part used to override it; it was removed because it asked the caller
    // for a number they are not positioned to choose — how many rounds a
    // document needs is a property of the document, discovered by the loop, and
    // the only thing the knob could usefully express was "spend fewer rounds
    // than this deployment budgeted", i.e. ask for a worse document. It was also
    // unvalidated: any number was accepted, including `0` (one reader pass, no
    // fix ever applied) and negatives (review skipped outright). A `config` part
    // on the request is now ignored rather than rejected, so an older client
    // still sending one keeps working, at the deployment's cap.
    const maxIter = cfg.defaults.max_review_iterations;

    let rendered: Awaited<ReturnType<typeof renderUploads>>;
    try {
      rendered = await renderUploads(files, imageLimits);
    } catch (e) {
      if (e instanceof UploadRejectedError || e instanceof PdfTooLargeError) {
        sendError(res, 400, "invalid_request", e.message);
      } else {
        sendError(res, 422, "pdf_conversion_failed", `Could not process a PDF: ${(e as Error).message}`);
      }
      return;
    }
    const record = await stageSession(cfg, store, paths, files, rendered.pages, rendered.refits);
    const sessionId = record.session_id;

    // Queue the pipeline; clients poll GET /v1/sessions/{id}. The session stays
    // in the `queued` status it was created with until a slot frees up, so a
    // client polling sees queued -> running -> ready_for_review.
    enqueueRun({
      cfg,
      store,
      sessionId,
      maxReviewIterations: maxIter,
    });

    res.status(201).json({
      session_id: record.session_id,
      status: record.status,
      image_count: record.image_count,
      created_at: record.created_at,
    });
  });

  // GET /v1/sessions/{id} — status.
  r.get("/:id", (req, res) => {
    const s = store.getSession(req.params.id);
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
    if (s.files_deleted_at) body.expired_at = s.files_deleted_at;
    res.json(body);
  });

  // GET /v1/sessions/{id}/output — the HTML document.
  r.get("/:id/output", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (expired(res, s)) return;
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
    const html = readableFieldNames(titledAs(readFileSync(outPath, "utf8"), base), keptFields(paths, s.session_id));
    res.setHeader("Content-Disposition", `inline; filename="${convertedHtmlFilename(base)}"`);
    res.type("text/html").send(html);
  });

  // ----- Tagged PDF (optional; util/taggedPdf.ts) -----
  // The session's source PDF, or the reason it has none. Sends that error itself.
  function sourcePdf(req: Request<Record<string, string>>, res: Response): { s: SessionRecord; command: string; pdf: string } | null {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return null;
    }
    if (expired(res, s)) return null;
    const command = taggedPdfCommand(cfg);
    if (!command) {
      sendError(res, 404, "tagged_pdf_unavailable", "This deployment does not make tagged PDFs.");
      return null;
    }
    const pdf = paths.sessionSourcePdf(s.session_id);
    if (!existsSync(pdf)) {
      sendError(res, 409, "no_source_pdf", "Only a session made from one uploaded PDF can be tagged.");
      return null;
    }
    return { s, command, pdf };
  }
  // Express 4 does not catch a rejected async handler, so every error is answered here.
  function taggerError(res: Response, e: unknown): void {
    if (!(e instanceof TaggedPdfError)) {
      sendError(res, 500, "tagger_failed", "Could not tag the PDF.");
      return;
    }
    const status = e.code === "timeout" ? 504 : e.exit === 3 ? 400 : 422;
    // A locked PDF cannot be fixed by trying again, so say what can be done (#593).
    const notes = new Map([
      ["permissions_denied", " Iris cannot tag it. Ask whoever made the PDF for a copy without change restrictions. The HTML version is not affected."],
      ["values_not_permitted", " Leave the form empty to get a tagged copy."],
    ]);
    const note = notes.get(e.code) ?? "";
    sendError(res, status, e.code, e.message + note);
  }

  // Each tagger run is a child process with seconds of CPU. Two at once, across both
  // routes, is enough.
  let tagging = 0;
  function tooBusy(res: Response): boolean {
    if (tagging < 2) return false;
    res.setHeader("Retry-After", "10");
    sendError(res, 503, "busy", "Other PDFs are being tagged. Try again in a few seconds.");
    return true;
  }

  function readyToTag(s: SessionRecord): boolean {
    return (s.status === "ready_for_review" || s.status === "closed") && existsSync(paths.sessionFinalFragments(s.session_id));
  }
  // The download's name, and the pages as extracted, for the tagger. Order is the PDF's page
  // number, because the session is one PDF. A page that failed extraction holds only its
  // `@page-failed` note, so it is left out and the tagger reports it untagged.
  function tagInput(s: SessionRecord): { base: string; input: TagInput } {
    const finalPath = paths.sessionFinalFragments(s.session_id);
    const base = existsSync(paths.sessionSourceName(s.session_id))
      ? readFileSync(paths.sessionSourceName(s.session_id), "utf8").trim() || "document"
      : "document";
    const { fragments = [] } = JSON.parse(readFileSync(finalPath, "utf8")) as { fragments?: Fragment[] };
    const outPath = paths.sessionOutput(s.session_id);
    const output = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    return {
      base,
      input: {
        lang: output.match(/<html\b[^>]*\blang="([^"]+)"/i)?.[1],
        title: base,
        pages: [...fragments]
          .filter((f) => !f.innerHtml.trimStart().startsWith("<!-- @page-failed"))
          .sort((a, b) => a.order - b.order)
          .map((f) => ({ sourcePage: f.order, html: f.innerHtml })),
      },
    };
  }

  // A flat form's created fields, per session. The tagger names them the same way on every
  // run, so a list holds until the extracted pages change. A failure (null) holds a minute,
  // so a failing form cannot keep the tagger busy. A run in progress is shared. The oldest
  // of more than 200 sessions is dropped.
  type Created = (PdfField & { created: true })[];
  const createdCache = new Map<string, { mtimeMs: number; until: number; fields: Promise<Created | null> }>();
  const FAILURE_KEPT_MS = 60_000;
  const CACHED_SESSIONS = 200;

  async function makeFields(src: { s: SessionRecord; command: string; pdf: string }): Promise<Created | null> {
    const id = src.s.session_id;
    const started = Date.now();
    // An unwritable log must not cost the list it describes.
    const note = (write: (log: RunLog) => void) => {
      try {
        write(new RunLog(paths.sessionLog(id)));
      } catch {
        // the list is the answer; its log line is not
      }
    };
    try {
      const { input } = tagInput(src.s);
      if (!input.pages.some((p) => /<(input|select|textarea)\b/i.test(p.html))) return [];
      const made = await createdFields(src.command, {
        pdfPath: src.pdf,
        input,
        scratchRoot: paths.pdfScratchRoot(),
        timeoutSeconds: tagTimeoutSeconds(cfg),
      });
      note((log) => log.event("tagged_pdf_fields", { ms: Date.now() - started, created: made.length }));
      return made.map((f) => ({ ...f, created: true as const }));
    } catch (e) {
      const code = e instanceof TaggedPdfError ? e.code : "tagger_failed";
      note((log) => log.event("tagged_pdf_fields_failed", { ms: Date.now() - started, code }));
      return null;
    }
  }

  // GET /v1/sessions/{id}/fields — the source PDF's form fields, for a fill-in form.
  r.get("/:id/fields", async (req, res) => {
    const src = sourcePdf(req, res);
    if (!src) return;
    if (tooBusy(res)) return;
    tagging++;
    try {
      const fields: PdfField[] = await readFields(src.command, src.pdf);
      // A PDF with no fields, whose HTML has form controls: a flat form. Tagging gives it
      // fields, so list those, marked `created`. If that fails, list none; the download
      // says why.
      if (!fields.length && readyToTag(src.s)) {
        const id = src.s.session_id;
        const mtimeMs = statSync(paths.sessionFinalFragments(id)).mtimeMs;
        let hit = createdCache.get(id);
        if (!hit || hit.mtimeMs !== mtimeMs || Date.now() >= hit.until) {
          const entry = { mtimeMs, until: Infinity, fields: makeFields(src) };
          remember(createdCache, id, entry, CACHED_SESSIONS);
          void entry.fields.then((f) => {
            if (f === null) entry.until = Date.now() + FAILURE_KEPT_MS;
          });
          hit = entry;
        }
        res.json({ fields: (await hit.fields) ?? [] });
        return;
      }
      res.json({ fields });
    } catch (e) {
      taggerError(res, e);
    } finally {
      tagging--;
    }
  });

  // POST /v1/sessions/{id}/pdf — the source PDF, tagged from the extracted pages, with
  // `values` filled in. The PDF is the answer and nothing is kept, so neither the values
  // nor the filled PDF is ever stored.
  r.post("/:id/pdf", async (req, res) => {
    const src = sourcePdf(req, res);
    if (!src) return;
    const { s } = src;
    if (!readyToTag(s)) {
      sendError(res, 409, "invalid_state", "The PDF can be tagged once the session is ready_for_review.");
      return;
    }
    const values: unknown = (req.body ?? {}).values ?? {};
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      sendError(res, 400, "invalid_request", "`values` must be an object of field name to value.");
      return;
    }
    if (tooBusy(res)) return;
    const log = new RunLog(paths.sessionLog(s.session_id));
    const started = Date.now();
    tagging++;
    try {
      const { base, input } = tagInput(s);
      const { pdf, report } = await tagPdf(src.command, {
        pdfPath: src.pdf,
        input,
        values: values as Record<string, unknown>,
        scratchRoot: paths.pdfScratchRoot(),
        timeoutSeconds: tagTimeoutSeconds(cfg),
      });
      // Field names only. A value is never logged.
      log.event("tagged_pdf", { ms: Date.now() - started, fields_given: Object.keys(values) });
      res.json({ filename: `${base}_tagged.pdf`, pdf: pdf.toString("base64"), report });
    } catch (e) {
      // iris-pdf's own messages name fields and options, never values. Its
      // `internal_error` passes on any exception's text, which could hold one, so that
      // message is not logged.
      const code = e instanceof TaggedPdfError ? e.code : "tagger_failed";
      log.event("tagged_pdf_failed", {
        ms: Date.now() - started,
        code,
        error: code === "internal_error" ? "(not logged: it may quote a value)" : (e as Error).message,
      });
      taggerError(res, e);
    } finally {
      tagging--;
    }
  });

  // GET /v1/sessions/{id}/logs — the run log as ndjson.
  r.get("/:id/logs", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (expired(res, s)) return;
    const logPath = paths.sessionLog(s.session_id);
    res.type("application/x-ndjson").send(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  });

  // GET /v1/sessions/{id}/diagnostics — machine-readable timing/health summary
  // for maintainers (human or AI): phase + per-call durations, the slowest
  // calls, and any in-flight call (the likely culprit when a run seems hung).
  r.get("/:id/diagnostics", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (expired(res, s)) return;
    const logPath = paths.sessionLog(s.session_id);
    const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    res.json(summarizeRun(text, { sessionId: s.session_id, status: s.status, phase: s.phase, now: Date.now() }));
  });

  // POST /v1/sessions/{id}/feedback — re-run within the same session.
  r.post("/:id/feedback", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (expired(res, s)) return;
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

  // POST /v1/sessions/{id}/close — finalize the session and clean tmp.
  r.post("/:id/close", (req, res) => {
    const s = store.getSession(req.params.id);
    if (!s) {
      sendError(res, 404, "session_not_found", "No such session");
      return;
    }
    if (expired(res, s)) return;
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
    // Auto-capture regression fixtures from the accepted output: the
    // page agent's per-page output + its source image, used to gate future agent
    // updates so a change can't break a use it already handled. Best-effort —
    // never block closing a session on fixture capture.
    try {
      const finalPath = paths.sessionFinalFragments(s.session_id);
      if (existsSync(finalPath)) {
        const saved = JSON.parse(readFileSync(finalPath, "utf8")) as {
          fragments?: Fragment[];
          failedPages?: number[];
          uncorrectedPages?: number[];
        };
        // A page whose extraction failed is excluded. Its fragment is a `@page-failed`
        // comment, and a fixture is an assertion that this HTML is the RIGHT output for
        // this image — capturing one would gate every future page-agent update on
        // reproducing a failure, and the first page of a document is exactly the
        // representative image the fixture is keyed to. Read from the recorded set
        // rather than sniffed out of the HTML: the run already knows which pages those
        // are (pipeline/orchestrator.ts).
        //
        // And a page the fidelity check REJECTED, on the same argument carried one step
        // further (#328). That page's markup is not a marker, it is content — content Iris's
        // own verifier named problems in and the correction pass did not replace — so it
        // would be captured as though it were right, and `captureFixtures` keys the fixture
        // to the first fragment it is given. Every future page-agent update would then be
        // gated on reproducing markup this run had already declared wrong. Accepting the
        // session is a human saying the DOCUMENT is good enough to close, which is not the
        // same claim as this page being the correct output for its image; before the set was
        // recorded there was no way to tell them apart here, since the verdict is nowhere in
        // the markup.
        const excluded = new Set([...(saved.failedPages ?? []), ...(saved.uncorrectedPages ?? [])]);
        captureFixtures(paths, s.session_id, (saved.fragments ?? []).filter((f) => !excluded.has(f.order)));
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
    // `data_dir/tmp/<id>` is orphaned anyway (nothing else touches tmpDir after close:
    // tagged PDFs use tmp/pdf-*, and failStaleSessions only rewrites statuses). Swallowing keeps the leak a leak
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
