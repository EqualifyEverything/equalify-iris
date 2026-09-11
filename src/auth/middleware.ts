import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import { anonymousToken } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser, isRejectedCredential, userLookupError } from "./github.ts";
import { sendError } from "../routes/errors.ts";

// Request augmented with the resolved user + their GitHub token.
export interface AuthedRequest extends Request {
  user?: UserRecord;
  token?: string;
  // True when this request resolved to the deployment's shared demo identity — either
  // because it sent no credential and `github.anonymous_token` served it instead of
  // refusing it, or because it presented a credential for that same account. It is a
  // question about the IDENTITY reached, not about the shape of the request, because
  // ownership downstream is `github_user_id` and nothing else: a caller holding that
  // account's token is indistinguishable from an anonymous visitor to every check that
  // matters, so it must be indistinguishable here too.
  //
  // The flag exists because `user` and `token` cannot say this on their own, and two
  // places have to know — the session LIST (a shared owner cannot separate whose document
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

// CONFIGURED credentials GitHub answered 401 for, and when to ask again. A negative cache,
// with the same TTL as a positive validation above, so every staleness window in this file
// has one bound: a revoked token keeps working for up to TTL_MS, and a repaired one starts
// working within TTL_MS. Both directions cost one `GET /user`.
//
// Why a TTL rather than a flag that latches for the process, which is what this started as:
// a 401 is a final answer about the credential, but it is not a final answer about the
// DEPLOYMENT. GitHub's auth can degrade and answer `Bad credentials` for a token that is
// fine, and a latch would then serve 401 to every anonymous caller until someone restarted
// the service — trading a per-request lookup for an outage that needs a human. It also
// bounds the other direction: `req.anonymous` cannot be applied while the shared identity
// is unresolved, so the window in which that guard is off is this TTL and not the rest of
// the process.
//
// Only a value from config is ever recorded here — never a string that arrived in a header.
// That is what bounds this map: it holds at most one entry per configured credential, so it
// needs no ceiling and no eviction sweep, while a map keyed on whatever callers present
// would be the unbounded one `MAX_ENTRIES` exists to prevent. A caller's own bad token
// therefore still costs one lookup per request, which is the caller's own doing and is
// already rate limited by address.
const rejectedCredentials = new Map<string, number>();

// Record a configured credential as rejected. Callers must have checked
// `isRejectedCredential` first: anything other than a 401 means GitHub did not answer, and
// caching that would be caching an outage.
function markRejectedCredential(token: string, now: number): void {
  rejectedCredentials.set(token, now + TTL_MS);
}

// Whether GitHub's rejection of this configured credential is still current. Expired
// entries are dropped on read, so the map cannot accumulate them.
function isRejectedCredentialCached(token: string, now: number): boolean {
  const until = rejectedCredentials.get(token);
  if (until === undefined) return false;
  if (until <= now) {
    rejectedCredentials.delete(token);
    return false;
  }
  return true;
}

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

// Test-only: both caches are module-level state, so they survive between tests in one
// process and would otherwise let one test's token satisfy another's assertion. The
// negative cache is cleared here too — a rejection recorded by one test would otherwise
// make the next one's anonymous requests 401 with no lookup, which looks exactly like the
// feature being off.
export function __clearTokenCache(): void {
  tokenCache.clear();
  rejectedCredentials.clear();
}

// Test-only: the negative cache's TTL is five minutes, so the only way to assert that it
// EXPIRES is to write an entry that already has. Same device as `__seedTokenCache` above,
// for the same reason — see test/token-cache.test.ts, which seeds a stale positive entry
// rather than waiting for one.
export function __seedRejectedCredential(token: string, expires: number): void {
  rejectedCredentials.set(token, expires);
}
export function __rejectedCredentialUntil(token: string): number | undefined {
  return rejectedCredentials.get(token);
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
  // The GitHub user id the anonymous credential resolves to, memoized for the life of
  // the process. Identity, not the token string, is what `req.anonymous` has to mean:
  // the shared account still OWNS every anonymous session, so a caller who reaches that
  // identity by any other route — presenting this same token in a header, or a second
  // token belonging to the same account — must be treated the same way, or the session
  // list this deployment refuses to anonymous callers is served to them anyway.
  //
  // Memoized rather than re-resolved because a token's account cannot change and config
  // does not hot-reload, so this costs ONE extra `GET /user` per process (none at all on
  // a deployment with the key unset).
  //
  // When it CANNOT be resolved, the flag is simply not applied, and the two things that are
  // true then are worth separating, because an earlier version of this comment ran them
  // together and claimed more than the code does:
  //
  //   - While the credential is rejected, nothing new can reach the shared identity —
  //     the anonymous path calls the same `fetchUser` and 401s — so there is no session for
  //     the guard to have protected.
  //   - For sessions created BEFORE it broke, an unresolved id fails the comparison below
  //     however the failure was handled, so caching the rejection changes nothing about
  //     which list is served.
  //
  // What does NOT follow is that the two are equivalent across a RECOVERY: a rejection is
  // cached for a TTL, so if GitHub was answering `Bad credentials` for a good token, the
  // guard stays off for up to that window after it recovers, where re-asking every time
  // would have re-armed on the next request. That is the residual cost of not asking, it is
  // bounded by `rejectedCredentials`'s TTL rather than by the process, and it is why the
  // cache is a TTL rather than a latch.
  let anonUserId: number | undefined;
  return async function auth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    // No header at all is the only shape SERVED by the anonymous credential.
    //
    // A header that is present and malformed still 401s, and that asymmetry is the
    // point rather than an oversight: a client sending `Bearer <expired>` or
    // `Basic …` is TRYING to be someone, and serving it as the shared demo identity
    // would silently move it into another account's session space — its uploads
    // landing where it cannot list them and its feedback filed under a bot. The
    // failure it should see is its own broken credential.
    //
    // Being served this way is not the same question as being FLAGGED anonymous, and the
    // two are decided in different places for that reason: this one is about which
    // credential answers the request, and `req.anonymous` below is about which identity it
    // arrives at.
    const servedAnonymously = !header && anonToken !== undefined;
    if (!match && !servedAnonymously) {
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

    // One resolution path for every credential — the caller's, and the anonymous one
    // whose identity the flag below is compared against. Sharing it is what makes the
    // comparison cheap: the second call is a cache hit for the rest of the TTL.
    const resolveUserId = async (t: string): Promise<number> => {
      const now = Date.now();
      const cached = tokenCache.get(t);
      if (cached && cached.expires > now) {
        // Nothing to write on a cache hit: the token is not persisted, so there is
        // no stored copy to keep fresh. (This branch used to re-`upsertUser` on
        // every cached request purely to refresh `users.github_token`.)
        return cached.id;
      }
      // GitHub identifies the caller; login provisions an account.
      const ghUser = await fetchUser(t, apiBase);
      store.upsertUser({ github_user_id: ghUser.id, github_login: ghUser.login }, defaultMaxIter);
      // Evict before inserting, so the ceiling is a real bound rather than one
      // exceeded by however many requests arrive between sweeps. A stale entry for
      // this very token (expired, hence the miss) is collected here too.
      evict(now);
      tokenCache.set(t, { id: ghUser.id, expires: now + TTL_MS });
      return ghUser.id;
    };

    try {
      // A rejection GitHub already gave us, inside its TTL, answers this request without
      // asking again — and it has to be checked on BOTH halves, because the half an outside
      // caller drives is the anonymous one. Thrown rather than answered here so the reply is
      // produced by the one `catch` below: identical status, identical body, no way for a
      // caller to tell a cached rejection from a fresh one, and one place to change if that
      // wording ever does.
      if (servedAnonymously && isRejectedCredentialCached(token, Date.now())) {
        throw userLookupError(401);
      }
      const userId = await resolveUserId(token);
      req.user = store.getUser(userId)!;
      req.token = token;

      // `anonymous` means "this request arrives at the shared demo identity", which is a
      // superset of "this request was served anonymously". The extra members are the
      // reason it is asked as a question about identity: whoever holds the account behind
      // `github.anonymous_token` can present it as an ordinary Bearer token, and ownership
      // downstream is `github_user_id` alone — so without this, that one caller lists
      // every anonymous visitor's sessions, which is the guarantee the 403 exists to keep.
      if (anonToken !== undefined) {
        if (servedAnonymously) {
          // Free: this request just resolved the anonymous credential itself.
          anonUserId = userId;
          req.anonymous = true;
        } else if (anonUserId === undefined && isRejectedCredentialCached(anonToken, Date.now())) {
          // Known-rejected within the TTL, so no lookup and no flag. The guard cannot be
          // applied while the shared identity is unresolved — see `rejectedCredentials` for
          // why that window is bounded by the TTL rather than by the process.
        } else {
          try {
            anonUserId ??= await resolveUserId(anonToken);
          } catch (e) {
            // The deployment's own credential did not resolve (revoked, mistyped, GitHub
            // down). Swallowed here on purpose: it is not this caller's fault and must
            // not turn their working request into a 401. The operator's signal is that
            // every anonymous request 401s, plus the boot warning that the key is set.
            //
            // Recorded only for a 401 — a rejection is an answer, while a 403 rate limit, a
            // 5xx or a thrown fetch is GitHub failing to give one, and caching that would
            // switch this guard off over a blip.
            if (isRejectedCredential(e)) markRejectedCredential(anonToken, Date.now());
          }
          if (anonUserId === userId) req.anonymous = true;
        }
      }
      next();
    } catch (e) {
      // Where the anonymous half LEARNS the credential is rejected. This is the path an
      // outside caller drives, so it is the one that has to stop repeating the lookup:
      // without this, a mistyped config value cost one uncached `GET /user` per
      // unauthenticated request for the life of the process, which is the same cost the
      // signed-in half was fixed for. Only for a request being served anonymously — a
      // CALLER's bad token must never be recorded here (see `rejectedCredentials`), and it
      // is `servedAnonymously`, not `token === anonToken`, that distinguishes them: a
      // caller may present the deployment's own credential, and doing so must not let them
      // write to this map.
      if (servedAnonymously && isRejectedCredential(e)) markRejectedCredential(token, Date.now());
      // Same 401 either way. An anonymous credential that GitHub rejects is an
      // operator's problem, not the caller's, and saying which token failed here would
      // tell an anonymous caller about the deployment's credential; the boot warning
      // and this message's `github user lookup failed` are what the operator has.
      sendError(res, 401, "unauthorized", `Token validation failed: ${(e as Error).message}`);
    }
  };
}
