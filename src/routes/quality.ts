import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { clampQualityWindow, type QualityStats, type Store } from "../store/db.ts";

// How long a computed tally is served before it is recomputed. Longer than
// `/v1/stats`' minute: the intended caller is a weekly CI job, nothing here changes
// faster than documents finish, and the cache is what keeps a stuck workflow (or a
// leaked token) from turning a poll loop into a scan of the signals table per
// request.
export const DEFAULT_QUALITY_TTL_MS = 300_000;

// Compare a presented token against the configured one without leaking its length or
// its matching prefix through timing. `timingSafeEqual` throws on a length mismatch,
// which would itself be the leak, so the lengths are equalized by hashing-free
// padding: both sides are compared at the configured token's length and a
// wrong-length presentation simply cannot match.
function tokenMatches(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) {
    // Still do a comparison of equal-length buffers, so the reject path costs the
    // same regardless of which way it failed.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// The bearer token on the request, if it presented one in the form the rest of the
// API uses.
function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? m[1].trim() : null;
}

/**
 * `GET /v1/quality` — the deployment-wide tally of how good the output has been
 * (PRD §7.16).
 *
 * Read by `.github/workflows/quality-report.yml`, which compares the numbers against
 * thresholds and files an issue when one is crossed. The thresholds live in the
 * workflow rather than here, so retuning "how bad is too bad" is a repo edit and not
 * a deploy.
 *
 * ```json
 * { "window_days": 30, "documents": 212, "mean_rounds": 1.8, "unresolved_rate": 0.07,
 *   "links_dropped_rate": 0.02, "links_unresolved_rate": 0.11,
 *   "markup_unbalanced_rate": 0.01, "table_no_body_rate": 0.005,
 *   "structural_defect_rate": 0.09, "lint_error_rate": 0.01,
 *   "lint_error_where": [ { "where": "parse", "documents": 0 },
 *                         { "where": "inject", "documents": 0 },
 *                         { "where": "run", "documents": 2 } ],
 *   "documents_linted": 210,
 *   "editor_truncated_rate": 0.01, "editor_truncated_lost_rate": 0.002,
 *   "rules": [ { "id": "heading-order", "impact": "moderate", "documents": 81,
 *                "share": 0.382, "nodes": 240 } ] }
 * ```
 *
 * **Nothing in the response can carry document content**, and that is the constraint
 * to hold as this endpoint grows. Its consumer copies values into a PUBLIC GitHub
 * issue, and the documents are whatever users uploaded — at the reference deployment,
 * student records. Rule ids come from axe-core's fixed vocabulary and are safe to
 * publish; the review loop's unresolved-issue descriptions are model-written prose
 * about one person's document, which is why `Store.qualityStats` exposes only their
 * count. Adding a field here that quotes a document would leak it to a public issue
 * through a path no reviewer of the workflow would think to check.
 *
 * `lint_error_where` is the shape a new field should follow: it answers "why did the
 * gate fail" out of a CLOSED vocabulary of three strings that the code names
 * (`LINT_ERROR_WHERE`), so no value of it can be text from a document. The version of
 * that field which would have been easier to write — the error message, or its stack —
 * is exactly the one that could not ship, because a jsdom parse error quotes the markup
 * it choked on.
 *
 * Guarded by `server.quality_token` rather than by the GitHub user auth every other
 * endpoint uses — see that field for why a per-user credential is the wrong shape for
 * data that belongs to no user. Unset means **404**: a deployment that has not opted
 * in does not acknowledge the endpoint at all, so scanning for it reveals nothing
 * about whether the operator merely forgot a token.
 *
 * `ttlMs` exists so the cache is testable in less than five minutes; production uses
 * the default.
 */
export function qualityRouter(
  store: Store,
  cfg: { quality_token?: string },
  opts: { ttlMs?: number } = {},
): Router {
  const r = Router();
  const ttlMs = opts.ttlMs ?? DEFAULT_QUALITY_TTL_MS;
  // Keyed by window, not a single slot. Two callers asking for different windows get
  // different answers, and a single-slot cache would serve whichever arrived first to
  // both — so a `?days=90` request could be answered with 30-day numbers, which is
  // wrong in a way nothing in the response would reveal.
  //
  // The key is the CLAMPED window, which is what bounds this map to one entry per
  // legal window rather than one per distinct query string: `?days=1000` and
  // `?days=1001` are the same 365-day answer, and caching them under their requested
  // values would let a caller grow the map without limit and never hit any of it.
  const cached = new Map<number, { at: number; body: QualityStats }>();

  r.get("/", (req, res) => {
    const configured = cfg.quality_token?.trim();
    if (!configured) {
      res.status(404).json({
        error: "not_found",
        message:
          "The quality tally is not enabled on this deployment. Set server.quality_token in config to enable it.",
      });
      return;
    }
    const presented = bearer(req.header("authorization"));
    if (!presented || !tokenMatches(presented, configured)) {
      res.status(401).json({ error: "unauthorized", message: "A valid bearer token is required." });
      return;
    }

    // Parsed leniently: `days` is a convenience for asking "has this moved?" over two
    // windows, and a garbled one falling back to the default is better than a 400 that
    // stops a weekly job over a typo. Clamped through the store's own helper rather
    // than re-derived here, so the cache key cannot disagree with the window the query
    // ran under. The window actually used is echoed back as `window_days`, so a caller
    // can see what it got rather than assume what it asked for.
    const days = clampQualityWindow(req.query.days);

    const now = Date.now();
    let hit = cached.get(days);
    if (!hit || now - hit.at >= ttlMs) {
      hit = { at: now, body: store.qualityStats({ days }) };
      cached.set(days, hit);
    }
    // No shared caching, unlike /v1/stats: this response is gated by a secret, and a
    // proxy that cached it would serve it to a request that presented no token.
    res.set("Cache-Control", "no-store");
    res.json(hit.body);
  });

  return r;
}
