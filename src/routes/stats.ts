import { Router } from "express";
import type { Store } from "../store/db.ts";

// How long a computed tally is served before it is recomputed. The number is a
// celebration, not a control surface: nobody is worse off seeing a count that is
// up to a minute stale, and the cache is what keeps an unauthenticated endpoint
// from turning a scripted refresh into a full table scan per request.
export const DEFAULT_TTL_MS = 60_000;

/**
 * `GET /v1/stats` — the public tally of what Iris has converted.
 *
 * Unauthenticated on purpose: it exists so the browser app (and anyone else who
 * wants to say it) can report how many document pages have been made accessible
 * without asking a visitor to sign in first. Every field is a deployment-wide
 * aggregate — see `Store.publicStats` for what is deliberately absent, which is
 * the part of this endpoint that needs guarding as it changes.
 *
 * ```json
 * { "pages_processed": 1284, "documents_processed": 212, "since": "2026-05-22T18:00:00.000Z",
 *   "quality": { "window_days": 30, "documents": 212, "clean_rate": 0.93, "mean_rounds": 1.8 } }
 * ```
 *
 * `since` is when the earliest counted document finished (null before anything
 * has), so a client can say "since May 2026" without inventing a launch date.
 *
 * `quality` is how *well* it has been going rather than how much of it there was —
 * two numbers from the same signals `GET /v1/quality` aggregates, which
 * is otherwise readable only with that endpoint's shared secret. It is **null** until
 * the window holds `PUBLIC_QUALITY_MIN_DOCUMENTS` documents, and the floor lives in
 * `Store.publicQuality` rather than here on purpose: on a quiet deployment a rate over
 * a handful of documents is a statement about identifiable people's uploads, so this
 * route must not be able to publish one by reading the fields it wants. Volume is
 * all-time and quality is windowed, which is not an inconsistency — an all-time rate
 * converges and stops responding to a fix, while an all-time page count is the
 * achievement being reported.
 *
 * `ttlMs` exists so the cache is testable in less than a minute. The cache is the
 * stated defence for letting an unauthenticated caller trigger a full scan, so
 * "does a second request inside the window reuse the first answer, and does one
 * after it recompute" needs to be asserted rather than assumed — see
 * test/stats-route.test.ts. Production uses the default.
 */
export function statsRouter(store: Store, opts: { ttlMs?: number } = {}): Router {
  const r = Router();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { at: number; body: Record<string, unknown> } | null = null;

  r.get("/", (_req, res) => {
    const now = Date.now();
    if (!cached || now - cached.at >= ttlMs) {
      const s = store.publicStats();
      // Named fields, not a spread of `publicQuality()`'s return: a field added to
      // `PublicQuality` should have to be added here too, in front of whoever reviews
      // this route, rather than appearing on a public endpoint by inheritance.
      const q = store.publicQuality();
      cached = {
        at: now,
        body: {
          pages_processed: s.pages,
          documents_processed: s.documents,
          since: s.since,
          quality: q
            ? {
                window_days: q.window_days,
                documents: q.documents,
                clean_rate: q.clean_rate,
                mean_rounds: q.mean_rounds,
              }
            : null,
        },
      };
    }
    // Let shared caches help too, with the same lifetime the in-process cache
    // uses — a stale-by-a-minute tally is the whole contract here.
    res.set("Cache-Control", `public, max-age=${Math.floor(ttlMs / 1000)}`);
    res.json(cached.body);
  });

  return r;
}
