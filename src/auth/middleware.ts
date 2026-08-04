import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser } from "./github.ts";
import { sendError } from "../routes/errors.ts";

// Request augmented with the resolved user + their GitHub token.
export interface AuthedRequest extends Request {
  user?: UserRecord;
  token?: string;
}

// Cache token -> user id so we don't hit GitHub's /user on every request.
//
// Keyed by the token itself, so it is a map of live credentials held in memory.
// That is what makes both bounds below matter more than they would for an ordinary
// memoization cache.
const tokenCache = new Map<string, { id: number; expires: number }>();

// How long a validation is trusted. This is also the window in which a token
// REVOKED at github.com still works here, which is the reason not to raise it: the
// only cost of a miss is one `GET /user`.
const TTL_MS = 5 * 60 * 1000;

// Hard ceiling on entries. Without one the map grows with every distinct token for
// the lifetime of the process — and distinct tokens are cheap to produce, since
// each is only a string in a header, so an unauthenticated caller sending random
// bearers could not fill it (those never reach `set`), but a rotating fleet of real
// clients would. 10k entries is far above any single-machine deployment's real
// concurrent user count (§10.1) and small enough to be bounded memory.
const MAX_ENTRIES = 10_000;

// Evict expired entries, then — if still over the ceiling — the oldest insertions.
// A Map iterates in insertion order, and every entry is written with the same TTL,
// so insertion order IS expiry order and the first keys are the nearest to expiring.
// That makes this FIFO rather than LRU: a hot token is not renewed on read, so it is
// dropped on schedule and re-validated. Deliberate — renewing on read would let a
// busy token outlive its revocation indefinitely, which is the failure the TTL
// exists to bound.
function evict(now: number): void {
  for (const [key, entry] of tokenCache) {
    if (entry.expires <= now) tokenCache.delete(key);
  }
  // Expiry alone can be insufficient: MAX_ENTRIES distinct tokens arriving inside
  // one TTL window leaves nothing expired to collect.
  if (tokenCache.size < MAX_ENTRIES) return;
  const excess = tokenCache.size - MAX_ENTRIES + 1; // +1: room for the caller's insert
  let dropped = 0;
  for (const key of tokenCache.keys()) {
    if (dropped >= excess) break;
    tokenCache.delete(key);
    dropped++;
  }
}

// Test-only: the cache is module-level state, so it survives between tests in one
// process and would otherwise let one test's token satisfy another's assertion.
export function __clearTokenCache(): void {
  tokenCache.clear();
}

export function makeAuthMiddleware(store: Store, cfg: IrisConfig) {
  const apiBase = cfg.github.api_base_url;
  const defaultMaxIter = cfg.defaults.max_review_iterations;
  return async function auth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      sendError(res, 401, "unauthorized", "Missing or malformed Authorization header");
      return;
    }
    const token = match[1].trim();

    try {
      const now = Date.now();
      const cached = tokenCache.get(token);
      let userId: number;
      if (cached && cached.expires > now) {
        // Nothing to write on a cache hit: the token is not persisted, so there is
        // no stored copy to keep fresh. (This branch used to re-`upsertUser` on
        // every cached request purely to refresh `users.github_token`.)
        userId = cached.id;
      } else {
        // GitHub identifies the caller; login provisions an account (§9.1).
        const ghUser = await fetchUser(token, apiBase);
        store.upsertUser({ github_user_id: ghUser.id, github_login: ghUser.login }, defaultMaxIter);
        userId = ghUser.id;
        // Evict before inserting, so the ceiling is a real bound rather than one
        // exceeded by however many requests arrive between sweeps. A stale entry for
        // this very token (expired, hence the miss) is collected here too.
        evict(now);
        tokenCache.set(token, { id: userId, expires: now + TTL_MS });
      }
      req.user = store.getUser(userId)!;
      req.token = token;
      next();
    } catch (e) {
      sendError(res, 401, "unauthorized", `Token validation failed: ${(e as Error).message}`);
    }
  };
}
