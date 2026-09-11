import type { Request, Response, NextFunction } from "express";
import type { IrisConfig } from "../config.ts";
import { apiToken, githubToken } from "../config.ts";
import type { Store, UserRecord } from "../store/db.ts";
import { fetchUser, type GitHubUser } from "./github.ts";
import { sendError } from "../routes/errors.ts";

// Request augmented with the deployment's resolved identity + the token it authenticates
// with. Both are the same on every request: this deployment has one GitHub account, so
// `user` is that account and `token` is `github.token`.
//
// They stay on the request rather than becoming module-level reads because every route and
// every pipeline stage already takes them from here, and because a test can then drive a
// route with a chosen identity without reaching into this module's memo.
export interface AuthedRequest extends Request {
  user?: UserRecord;
  token?: string;
}

// How long a failed identity lookup is remembered before GitHub is asked again.
//
// Short on purpose, and the reason is asymmetric: a lookup that SUCCEEDS is cached for the
// life of the process, because a token's account cannot change and config does not
// hot-reload. A lookup that fails may be failing for a reason that is already over — a 500,
// a dropped connection, GitHub briefly answering `Bad credentials` for a good token — so the
// window has to be short enough that recovery is invisible to a caller and long enough that
// an outage does not cost one `GET /user` per request. 30 seconds is that.
//
// Nothing here distinguishes a 401 from a 500, which is a simplification the collapse to one
// identity paid for. It used to matter: with per-user tokens a cached rejection ALSO switched
// off a guard that separated anonymous callers from each other, so caching a non-answer had a
// cost beyond a delayed retry. There is no such guard now — the only consequence of backing
// off is that this deployment answers 401 until the window passes, which is what it would
// answer anyway while GitHub cannot identify it.
const FAILURE_BACKOFF_MS = 30 * 1000;

// The resolved GitHub user id for `github.token`, and when to stop refusing after a failed
// lookup. Module-level rather than per-middleware so a process has one identity even if
// something builds the middleware twice.
let identity: number | undefined;
let retryAfter = 0;

// The lookup itself while it is in flight, shared by every request that arrives before it
// settles.
//
// Memoizing the resolved id alone is not enough, and the gap is only visible at a cold
// start: `identity` is assigned AFTER the await, so N requests arriving in one tick all see
// `undefined` and all call `GET /user`. Sequential pins cannot show it — the second request
// finds the first already finished — so a client opening 20 parallel requests against a
// fresh process spent 20 lookups against this deployment's GitHub rate limit. Once per
// process, and the gate still runs first, so no stranger can trigger it; cheap to close
// anyway, and the pin for it has to be concurrent.
let inFlight: Promise<GitHubUser> | undefined;

// Test-only: the memo above outlives a test, so one test's resolved identity would
// otherwise satisfy the next test's assertion — including tests whose whole subject is what
// happens before it resolves.
export function __resetIdentity(): void {
  identity = undefined;
  retryAfter = 0;
  inFlight = undefined;
}

// Test-only introspection, so a test can assert that a SECOND request did not ask GitHub
// again without having to count network calls from outside.
export function __identityResolved(): boolean {
  return identity !== undefined;
}

export function makeAuthMiddleware(store: Store, cfg: IrisConfig) {
  const apiBase = cfg.github.api_base_url;
  const defaultMaxIter = cfg.defaults.max_review_iterations;
  // Read once: config does not hot-reload. `validateConfig` has already refused an unset
  // `github.token`, so the non-null assertion holds for any config that booted — but a
  // hand-built config in a test can still omit it, which is why the request path checks.
  const token = githubToken(cfg);
  // The optional shared secret gating `/v1`, or undefined on an open deployment.
  const gate = apiToken(cfg);

  return async function auth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    // Question one: may this caller use the API at all? Only asked when the operator set a
    // gate; an open deployment has no credential to check and this is where a public demo
    // gets served. It is a different question from "who is this caller", which has one
    // answer below, and the two are checked separately so neither can be mistaken for the
    // other: a caller who presents the gate token is not thereby anybody.
    if (gate !== undefined) {
      const header = req.header("authorization") ?? "";
      const match = header.match(/^Bearer\s+(.+)$/i);
      // Compared after trimming, because `apiToken` trims what it read from config: a
      // configured `"  s3cret  "` must not be a gate that only an untrimmed copy opens.
      if (!match || match[1].trim() !== gate) {
        // Deliberately the same message for absent, malformed and wrong. A caller learns
        // whether this deployment is gated (it says so) and nothing about the secret.
        sendError(res, 401, "unauthorized", "This deployment requires a shared API token.");
        return;
      }
    }

    if (token === undefined) {
      // Only reachable from a config that never went through `validateConfig`. Answered
      // rather than thrown so a misbuilt test config fails as a 401 with a reason instead of
      // an unhandled rejection inside Express.
      sendError(res, 500, "server_error", "github.token is not configured on this deployment.");
      return;
    }

    if (identity === undefined) {
      const now = Date.now();
      if (now < retryAfter) {
        // A failure GitHub already gave us, inside its window, answers this without asking
        // again. The reply says nothing about which credential failed: it is the operator's
        // token, not the caller's, so naming it would tell a stranger about this
        // deployment's configuration. The operator's signal is the boot line plus a log.
        sendError(res, 401, "unauthorized", "This deployment could not authenticate to GitHub.");
        return;
      }
      // GitHub identifies the account. Nothing here trusts the token because it came from
      // config — a revoked or mistyped PAT has to fail at the same place a bad one would.
      let ghUser: GitHubUser;
      try {
        inFlight ??= fetchUser(token, apiBase);
        ghUser = await inFlight;
      } catch (e) {
        // Cleared, or every later request would await a promise that has already rejected
        // and the backoff window could never end.
        inFlight = undefined;
        retryAfter = Date.now() + FAILURE_BACKOFF_MS;
        sendError(
          res,
          401,
          "unauthorized",
          `This deployment could not authenticate to GitHub: ${(e as Error).message}`,
        );
        return;
      }

      // Provisioning the row every session is owned by, and deliberately NOT inside the
      // catch above: a failed WRITE is not a failed authentication. Reporting it as one puts
      // a SQLite message in a 401 saying GitHub refused us — which is the exact confusion
      // `rejectLegacyUsersTable` was written to prevent, and it lists that symptom as the
      // thing that points an operator away from the real cause (store/db.ts). It also must
      // not set the GitHub backoff: a store fault does not become less true in 30 seconds.
      try {
        store.upsertUser({ github_user_id: ghUser.id, github_login: ghUser.login }, defaultMaxIter);
      } catch (e) {
        // The detail goes to the server log rather than to the caller: on an open
        // deployment this response is public, and a driver's message can carry a path.
        console.error(`ERROR: could not record the deployment's identity: ${(e as Error).message}`);
        sendError(res, 500, "server_error", "This deployment could not record its own identity. See the server log.");
        return;
      }

      // Last, because `req.user` below reads the row through this id with a non-null
      // assertion: setting it before the write succeeded would hand a route an undefined
      // user instead of an error.
      identity = ghUser.id;
    }

    req.user = store.getUser(identity)!;
    req.token = token;
    next();
  };
}
