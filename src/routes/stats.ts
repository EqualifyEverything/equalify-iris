import { Router } from "express";
import type { Store } from "../store/db.ts";

// How long a computed tally is served before it is recomputed. The number is a
// celebration, not a control surface: nobody is worse off seeing a count that is
// up to a minute stale, and the cache is what keeps an unauthenticated endpoint
// from turning a scripted refresh into a full table scan per request.
const TTL_MS = 60_000;

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
 * { "pages_processed": 1284, "documents_processed": 212, "since": "2026-05-22T18:00:00.000Z" }
 * ```
 *
 * `since` is when the earliest counted document finished (null before anything
 * has), so a client can say "since May 2026" without inventing a launch date.
 */
export function statsRouter(store: Store): Router {
  const r = Router();
  let cached: { at: number; body: Record<string, unknown> } | null = null;

  r.get("/", (_req, res) => {
    const now = Date.now();
    if (!cached || now - cached.at >= TTL_MS) {
      const s = store.publicStats();
      cached = {
        at: now,
        body: { pages_processed: s.pages, documents_processed: s.documents, since: s.since },
      };
    }
    // Let shared caches help too, with the same lifetime the in-process cache
    // uses — a stale-by-a-minute tally is the whole contract here.
    res.set("Cache-Control", `public, max-age=${Math.floor(TTL_MS / 1000)}`);
    res.json(cached.body);
  });

  return r;
}
