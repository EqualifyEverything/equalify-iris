import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { IrisConfig } from "../config.ts";
import type { Store, SessionRecord } from "../store/db.ts";
import { Paths } from "../store/paths.ts";
import { runPipeline } from "../pipeline/orchestrator.ts";
import type { AuthedRequest } from "../auth/middleware.ts";
import { sendError } from "./errors.ts";
import { summarizeRun } from "../diagnostics.ts";
import { rasterizePdf, PdfTooLargeError, MAX_PDF_PAGES } from "../util/pdf.ts";

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

  // GET /v1/sessions — list this user's sessions, newest first.
  r.get("/", (req: AuthedRequest, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const status = req.query.status ? String(req.query.status) : undefined;
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const rows = store.listSessions(req.user!.github_user_id, { limit: limit + 1, status, cursor });
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? page[page.length - 1].created_at : null;
    res.json({ sessions: page.map(sessionSummary), next_cursor: next });
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

    // Kick off the pipeline asynchronously; clients poll GET /v1/sessions/{id}.
    void runPipeline({ cfg, store, sessionId, maxReviewIterations: maxIter });

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
    res.type("text/html").send(readFileSync(outPath, "utf8"));
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
    store.updateSession(s.session_id, { status: "running", phase: "extraction" });
    void runPipeline({
      cfg,
      store,
      sessionId: s.session_id,
      maxReviewIterations: s.iterations_max,
      feedback,
    });
    res.status(202).json({ session_id: s.session_id, status: "running", phase: "extraction" });
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
    const tmp = paths.tmpDir(s.session_id);
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    store.updateSession(s.session_id, { status: "closed" });
    res.json({ session_id: s.session_id, status: "closed" });
  });

  return r;
}
