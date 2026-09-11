import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import { anonymousToken } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser, isRejectedCredential } from "./github.ts";
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
  let anonUserId: number | undefined;
  // A FAILURE to resolve it is memoized only when GitHub REJECTED the credential (401).
  // The two cases are not alike and the difference is not about how long they last:
  //
  //   - A 401 is a final answer about a configured value, and config does not hot-reload,
  //     so retrying it cannot produce a different result before the restart that would
  //     clear this flag anyway. Retrying forever is what the first version did, and its
  //     cost is not bounded by an outage: a mistyped or revoked token is a permanent
  //     state, so EVERY authenticated request paid an extra uncached `GET /user` (issued
  //     with no timeout) for the life of the process — including requests whose own token
  //     was a cache hit and would otherwise have made no outbound call at all.
  //   - A 403 (rate limit), a 5xx or a thrown fetch says GitHub could not answer, not
  //     that the answer is no. Latching on those would switch the guard off for the rest
  //     of the process over a blip, so they are retried.
  //
  // Latching is safe here in a way that is worth stating, because "stop applying a guard"
  // normally is not: a credential GitHub rejects cannot serve an anonymous request either
  // — that path calls the same `fetchUser` and 401s — so while this flag is set, no new
  // session can reach the shared identity. And it changes nothing for sessions created
  // BEFORE the token broke: an unresolved anonymous id fails the comparison below
  // whether the failure was memoized or retried, so both versions serve that account's
  // own list identically. The flag only stops re-asking a question with a fixed answer.
  let anonRejected = false;
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
        } else if (anonUserId === undefined && anonRejected) {
          // Already known to be unusable — no lookup, and no flag. See `anonRejected`.
        } else {
          try {
            anonUserId ??= await resolveUserId(anonToken);
          } catch (e) {
            // The deployment's own credential is unusable (revoked, mistyped, GitHub
            // down). Swallowed here on purpose: it is not this caller's fault and must
            // not turn their working request into a 401. The operator's signal is that
            // every anonymous request 401s, plus the boot warning that the key is set.
            if (isRejectedCredential(e)) anonRejected = true;
          }
          if (anonUserId === userId) req.anonymous = true;
        }
      }
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
