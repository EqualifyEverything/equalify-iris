import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import { anonymousToken } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser } from "./github.ts";
import { sendError } from "../routes/errors.ts";

// Request augmented with the resolved user + their GitHub token.
export interface AuthedRequest extends Request {
  user?: UserRecord;
  token?: string;
  // True when this request sent no credential and was served by
  // `github.anonymous_token` instead of refused. `user` and `token` are then the
  // deployment's shared demo identity rather than the caller's, which is why the flag
  // exists: the two are indistinguishable downstream otherwise, and two places have to
  // tell them apart — the session LIST (a shared owner cannot separate whose document
  // is whose) and the upload rate limiter (a shared user id is one bucket for everyone).
  //
  // Absent rather than `false` on an ordinary authenticated request, so a reader of
  // `req.anonymous` gets the same falsy answer whether this middleware ran or not.
  anonymous?: boolean;
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
// concurrent user count and small enough to be bounded memory.
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

/**
 * Whether this process has recently validated this exact token — i.e. whether the string
 * in an `Authorization` header is a credential or just a string.
 *
 * Read by the rate limiter (util/requestLimits.ts), which counts a request against its
 * credential rather than its source address wherever it can: one GitHub user is one
 * client no matter how many of them share a NAT or a reverse proxy. It needs this
 * predicate because it runs BEFORE this middleware — nothing has resolved `req.user`
 * yet — and because keying on any token presented would let a caller mint a fresh budget
 * per random string, on the path that costs a `GET /user` per miss.
 *
 * Deliberately no side effects: a cache HIT here must not extend the entry's life, or a
 * busy caller could hold a revoked token alive past its TTL. See `evict` on why this
 * cache is FIFO rather than LRU.
 */
export function isValidatedToken(token: string): boolean {
  const entry = tokenCache.get(token);
  return entry !== undefined && entry.expires > Date.now();
}

// Test-only: the cache is module-level state, so it survives between tests in one
// process and would otherwise let one test's token satisfy another's assertion.
export function __clearTokenCache(): void {
  tokenCache.clear();
}

// Test-only introspection. The bound is 10k entries, so asserting it through real
// HTTP requests would mean issuing 10,001 of them; seeding the map directly and then
// driving ONE real request through the middleware exercises the same `evict` call on
// the same state, in milliseconds. The properties worth pinning are invisible from
// outside — that the sweep runs before the insert, that expired entries go first, and
// that a cache hit does not renew `expires` (FIFO, not LRU) — so they need a window
// into the map rather than a behavioral proxy.
export const __MAX_ENTRIES = MAX_ENTRIES;
export function __tokenCacheSize(): number {
  return tokenCache.size;
}
export function __tokenCacheExpiry(token: string): number | undefined {
  return tokenCache.get(token)?.expires;
}
export function __seedTokenCache(token: string, id: number, expires: number): void {
  tokenCache.set(token, { id, expires });
}

export function makeAuthMiddleware(store: Store, cfg: IrisConfig) {
  const apiBase = cfg.github.api_base_url;
  const defaultMaxIter = cfg.defaults.max_review_iterations;
  // The deployment's own credential for callers who present none, or undefined when
  // this deployment requires a token on every call (the default). Read once: config
  // does not hot-reload.
  const anonToken = anonymousToken(cfg);
  return async function auth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    // No header at all is the only shape the anonymous credential answers for.
    //
    // A header that is present and malformed still 401s, and that asymmetry is the
    // point rather than an oversight: a client sending `Bearer <expired>` or
    // `Basic …` is TRYING to be someone, and serving it as the shared demo identity
    // would silently move it into another account's session space — its uploads
    // landing where it cannot list them and its feedback filed under a bot. The
    // failure it should see is its own broken credential.
    const anonymous = !header && anonToken !== undefined;
    if (!match && !anonymous) {
      sendError(
        res,
        401,
        "unauthorized",
        "Missing or malformed Authorization header",
      );
      return;
    }
    // Validated below exactly like a user's token — `GET /user`, same cache, same TTL.
    // Nothing here trusts it because it came from config: a revoked or mistyped
    // anonymous credential must fail the same way, at the same place, rather than
    // producing a user record with no GitHub account behind it.
    const token = match ? match[1].trim() : anonToken!;

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
        // GitHub identifies the caller; login provisions an account.
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
      if (anonymous) req.anonymous = true;
      next();
    } catch (e) {
      // Same 401 either way. An anonymous credential that GitHub rejects is an
      // operator's problem, not the caller's, and saying which token failed here would
      // tell an anonymous caller about the deployment's credential; the boot warning
      // and this message's `github user lookup failed` are what the operator has.
      sendError(res, 401, "unauthorized", `Token validation failed: ${(e as Error).message}`);
    }
  };
}
