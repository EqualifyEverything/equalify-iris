import { Router } from "express";
import type { IrisConfig } from "../config.ts";
import { imageLimitsHint, resolveImageLimits } from "../providers/imageLimits.ts";
import { MAX_PDF_PAGES } from "../util/pdf.ts";
import { MAX_UPLOAD_FILES, publishedRateLimits, uploadCeilingBytes } from "../util/requestLimits.ts";

/**
 * `GET /v1/limits` — what this deployment accepts for an upload.
 *
 * Exists so the limits are stated in exactly one place and read from there. They are
 * facts about the configured vision model (see providers/imageLimits.ts), and this
 * project switches models; a hint hardcoded into the demo page or the API docs would
 * keep confidently naming last month's numbers. The demo renders `image.hint`
 * verbatim for that reason, and `POST /v1/sessions` rejects an upload by the same
 * `max_image_bytes` served here — so "what the page told me" and "what the API did"
 * cannot disagree.
 *
 * ```json
 * { "max_pages": 25,
 *   "image": { "max_bytes": 3932160, "max_long_edge_px": 1568, "max_dimension_px": 8000,
 *              "media_types": ["image/png", "..."], "extensions": [".png", "..."],
 *              "hint": "Each image must be under 3.7 MB and in one of PNG, ... format. …" },
 *   "pdf": { "max_pages": 25 },
 *   "upload": { "max_files": 25, "max_request_bytes": 134217728 },
 *   "rate_limits": { "general_per_minute": 240, "auth_per_minute": 60, "upload_per_minute": 12,
 *                    "max_upload_memory_mb": 256, "window_seconds": 60 } }
 * ```
 *
 * Unauthenticated, like `GET /v1/stats`: a visitor deciding whether to prepare a file
 * has not signed in yet, and the answer is the same for everyone. Deliberately NOT
 * naming the model or provider that produced the numbers — a public endpoint that
 * announces the deployment's model id would be publishing infrastructure to answer a
 * question about file sizes. The authenticated 400 from `POST /v1/sessions` is where
 * a caller with an actual rejected upload gets the detail.
 *
 * Computed once at construction: config does not hot-reload in v1, so there is
 * nothing here that can change between requests.
 */
export function limitsRouter(cfg: IrisConfig): Router {
  const r = Router();
  const limits = resolveImageLimits(cfg);
  const body = {
    // Total pages across all parts of one upload, whether they arrived as images or
    // as the pages of a PDF.
    max_pages: MAX_PDF_PAGES,
    image: {
      max_bytes: limits.max_image_bytes,
      max_long_edge_px: limits.max_long_edge_px,
      max_dimension_px: limits.max_dimension_px,
      media_types: limits.media_types,
      extensions: limits.extensions,
      hint: imageLimitsHint(limits),
    },
    pdf: { max_pages: MAX_PDF_PAGES },
    // What one request may carry, as opposed to what one image may be. Both are memory
    // bounds rather than facts about documents (util/requestLimits.ts), and both are
    // enforced in front of multer rather than inside the handler, so a client that
    // batches uploads can see the shape of the request it should send.
    upload: { max_files: MAX_UPLOAD_FILES, max_request_bytes: uploadCeilingBytes() },
    // How often it may be asked, or null when this deployment does not limit request
    // volume in the app. Same rationale as the upload limits: a budget a client can read
    // is one it can pace itself against, instead of discovering it by being refused.
    rate_limits: publishedRateLimits(cfg),
  };

  r.get("/", (_req, res) => {
    // Cacheable for a long while by anything in front of this deployment: the answer
    // changes only when an operator edits config and restarts.
    res.set("Cache-Control", "public, max-age=3600");
    res.json(body);
  });

  return r;
}
