// What one caller may ask of this deployment at the HTTP layer.
//
// RunQueue (util/queue.ts) bounds pipeline COMPUTE and mapWithConcurrency bounds the
// model calls inside one run, so both of those describe work Iris has already accepted.
// Nothing bounded how much could be ASKED of it, and three consequences sit outside
// what the run cap can reach:
//
//   * The cheap endpoints never touch the queue. Every authenticated read goes to
//     SQLite through node:sqlite's SYNCHRONOUS DatabaseSync (store/db.ts), and there is
//     no connection pool to absorb a burst: each query occupies the event loop, so a
//     tight polling loop degrades every other request in the process — including the
//     ones driving a pipeline that is already running.
//   * `/v1/auth` is unauthenticated by design (§9.1) and its device-flow poll makes an
//     OUTBOUND call to GitHub per request. Unbounded, that makes Iris an amplifier: the
//     caller spends one cheap request, the deployment spends one of its GitHub rate
//     limit tokens, and the cost of exhausting that lands on every user's login rather
//     than on the caller.
//   * multer buffers the ENTIRE multipart body into memory before any handler — and
//     therefore before the run queue — runs. PRD §9.4 records that as a limit the queue
//     could not address; a gate that sits in front of multer is what addresses it, which
//     is what `uploadGate` and `requestSizeGate` below are.
//
// Infra-level limiting is not a substitute. Per §10.2 v1 is a single instance with
// SQLite and no load balancer in front of it, and even behind Caddy or nginx every
// request that gets through shares this one event loop.
//
// Each factory returns a pass-through when `server.rate_limits.enabled` is false, so
// the mounting code in index.ts and routes/sessions.ts reads the same either way and
// cannot accidentally leave a limiter out of one branch.

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import type { IrisConfig, RateLimitConfig } from "../config.ts";
import { resolveRateLimits } from "../config.ts";
import { isValidatedToken } from "../auth/middleware.ts";
import type { AuthedRequest } from "../auth/middleware.ts";
import { sendError } from "../routes/errors.ts";
import { formatBytes } from "../providers/imageLimits.ts";

// Files accepted in one multipart request, and bytes across all of its parts.
//
// Both are memory bounds rather than statements about documents, and they exist because
// multer's per-file `fileSize` is not one: a request may carry any number of parts, so
// 50 MB per file with no count meant one request could buffer gigabytes before a single
// line of the handler ran. The pair caps that at MAX_UPLOAD_BYTES per request, and
// `uploadGate` caps the bytes of upload in flight across all requests — so peak upload
// memory is a number an operator can compute instead of a function of what was sent.
//
// Neither can reject a convertible document. A session is capped at 25 pages
// (util/pdf.ts MAX_PDF_PAGES) whatever they arrive as, so 25 files is already the most
// an accepted upload can carry as images, and the heaviest legitimate request — 25
// images at the per-image cap of ~3.7 MB — comes to ~92 MB. 128 MB clears that and
// clears a large scanned PDF (multer's own 50 MB per-file ceiling) with room over.
export const MAX_UPLOAD_FILES = 25;
export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

// The per-request ceiling as the two halves that enforce it read it — the constant above,
// except while a test replaces it. Read from one place so a declared body and an undeclared
// one cannot end up being refused at different sizes.
let uploadCeiling = MAX_UPLOAD_BYTES;

// Test-only. The refusal that matters most is the one at the END of the upload stack, in
// front of multer and past the async rate limiter, and sending 128 MB into a test process
// to reach it is not a test that gets run — so the ceiling moves instead of the body.
export function __setUploadCeiling(bytes: number): void {
  uploadCeiling = bytes;
}

// How long the gate suggests waiting when uploads are at their in-flight cap. Unlike
// the rate limiters there is no window to expire here — the wait is however long
// somebody else's upload takes to arrive — so this is advice, not arithmetic.
const UPLOAD_GATE_RETRY_SECONDS = 10;

const WINDOW_MS = 60_000;

function bearerToken(req: Request): string | undefined {
  const match = (req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Who a request counts against.
 *
 * Per credential when the credential is one this process has already validated,
 * otherwise per source address. Both halves of that matter:
 *
 *   * Per credential, because per-IP alone is wrong for exactly the deployments Iris
 *     targets. A campus or office NAT puts every user behind one address, and a reverse
 *     proxy does the same unless `server.trust_proxy` is set correctly — so an IP bucket
 *     is shared by people who have nothing to do with each other, and the second user
 *     to poll a session pays for the first. A GitHub token identifies one user no matter
 *     how many hops it arrived over.
 *   * Only when ALREADY VALIDATED, because a bearer token is just a string in a header.
 *     Keying on any token presented would hand an attacker a fresh budget per random
 *     string — and each of those strings also costs an outbound `GET /user` (an unknown
 *     token is a cache miss by definition, see auth/middleware.ts), so it would make the
 *     most expensive path the one with no limit on it. Unvalidated bearers therefore
 *     share the caller's IP bucket, where rotation buys nothing.
 *
 * The key is a truncated SHA-256 of the token, never the token: buckets live in memory
 * beside a hit count and 16 hex characters are ample to separate users, so there is no
 * reason for a second copy of a live credential to exist (the same rule the token cache
 * follows — nothing persists it, nothing logs it).
 *
 * `ipKeyGenerator` rather than `req.ip` for the fallback: it groups IPv6 addresses by
 * /56, since a single host is routinely handed a /64 and per-address buckets would mean
 * no limit at all for anyone on IPv6.
 */
export function clientKey(req: Request): string {
  const token = bearerToken(req);
  if (token && isValidatedToken(token)) {
    return `t:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

// The upload limiter sits behind the auth middleware, so the user is resolved and there
// is no need to infer them from the header. Falls back to clientKey for the same reason
// it exists — a router mounted without auth in a test must still get a key.
function userKey(req: Request): string {
  const user = (req as AuthedRequest).user;
  return user ? `u:${user.github_user_id}` : clientKey(req);
}

const passThrough: RequestHandler = (_req, _res, next) => next();

// One warning, once, for the misconfiguration that would quietly turn per-IP limiting
// into a deployment-wide limit: requests arriving with `X-Forwarded-For` while Express
// is not configured to trust anything. Every caller then presents as the proxy's
// address, so they share one bucket and a busy afternoon looks like an attack.
//
// express-rate-limit has its own check for this; it is switched off in favour of this
// one (see `validate` below) because a message that names `server.trust_proxy` and the
// hop count to set is worth more than a link to a wiki page.
let warnedAboutProxy = false;
function warnIfProxied(req: Request): void {
  if (warnedAboutProxy) return;
  if (!req.headers["x-forwarded-for"]) return;
  if (req.app?.get("trust proxy") !== false) return;
  warnedAboutProxy = true;
  console.warn(
    `WARNING: a request arrived with an X-Forwarded-For header while server.trust_proxy is unset, so ` +
      `Iris sees the proxy's address for every caller and rate limits them as one client. Set ` +
      `server.trust_proxy to the number of proxies in front of this deployment (1 for a single ` +
      `Caddy/nginx), which makes the real client address available.`,
  );
}

// Test-only: the flag above is module state, so one test's warning would suppress
// another's assertion.
export function __resetProxyWarning(): void {
  warnedAboutProxy = false;
}

// Seconds until the caller's window resets: taken from the header express-rate-limit has
// already set, and written back, so the number in the message, the number in `details`,
// and the number in `Retry-After` are one number rather than three that agree by
// coincidence. Writing it back is what closes the last gap — express-rate-limit derives
// the header from `Math.max(0, delta)`, so a refusal landing exactly on a window boundary
// sends `Retry-After: 0`, where the honest advice is "a second" and not the whole window
// the fallback below would have claimed.
function retryAfterSeconds(res: Response): number {
  const header = Number(res.getHeader("Retry-After"));
  const seconds = Number.isFinite(header) ? Math.max(1, Math.ceil(header)) : Math.ceil(WINDOW_MS / 1000);
  res.set("Retry-After", String(seconds));
  return seconds;
}

// One rate limiter, built the same way three times over. The pieces that must not
// differ between them live here: the error shape (sendError, so a 429 looks like every
// other error — PRD §9.3), the `RateLimit`/`RateLimit-Policy` headers a client can read
// its remaining budget from, and the absence of the long-deprecated `X-RateLimit-*`
// pair.
function limiter(opts: {
  limit: number;
  key: (req: Request) => string;
  message: (limit: number, retryAfter: number) => string;
}): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      warnIfProxied(req);
      return opts.key(req);
    },
    handler: (_req, res) => {
      const retryAfter = retryAfterSeconds(res);
      sendError(res, 429, "rate_limited", opts.message(opts.limit, retryAfter), {
        limit: opts.limit,
        window_seconds: WINDOW_MS / 1000,
        retry_after_seconds: retryAfter,
      });
    },
    // Handled by warnIfProxied above, with a message that names the config key.
    validate: { xForwardedForHeader: false },
  });
}

/**
 * The general `/v1` limiter — mounted once, above every route that is not the liveness
 * probe. Sized to sit well above what a working client does: the demo page polls a
 * running session every 2.5s (24 requests/minute) and a browser may have more than one
 * tab open, so the default 240/minute leaves an order of magnitude of headroom while
 * still bounding a loop that has come off its leash.
 */
export function generalRateLimit(cfg: IrisConfig): RequestHandler {
  const limits = resolveRateLimits(cfg.server.rate_limits);
  if (!limits.enabled) return passThrough;
  return limiter({
    limit: limits.general_per_minute,
    key: clientKey,
    message: (limit, retryAfter) =>
      `Too many requests: this deployment allows ${limit} per minute per client. Retry in ${retryAfter}s.`,
  });
}

/**
 * The stricter `/v1/auth` limiter. Authentication is unauthenticated by definition, so
 * this one can only key on the address — there is no credential yet to count against.
 *
 * That is also why the default (60/minute) is not the 10-20 that "brute force" suggests.
 * There is nothing here to brute force: no password, and the device code is entered at
 * github.com rather than here. What the limit protects is the outbound call each poll
 * makes, and the traffic it must not break is a device-flow login, which polls every 5
 * seconds (12/minute) for as long as it takes the user to approve it — behind one NAT,
 * that is several concurrent logins in the same bucket. A limit that made logging in
 * unreliable would be a worse outage than the flood it prevents.
 */
export function authRateLimit(cfg: IrisConfig): RequestHandler {
  const limits = resolveRateLimits(cfg.server.rate_limits);
  if (!limits.enabled) return passThrough;
  return limiter({
    limit: limits.auth_per_minute,
    key: (req) => `ip:${ipKeyGenerator(req.ip ?? "")}`,
    message: (limit, retryAfter) =>
      `Too many authentication requests: this deployment allows ${limit} per minute per address. ` +
      `Retry in ${retryAfter}s.`,
  });
}

/**
 * The session-creation limiter, mounted in front of multer so a request over budget is
 * refused before its body is buffered.
 *
 * Lower than the general limit by two orders of magnitude, and it costs a real client
 * nothing: a conversion takes minutes, `max_concurrent_runs` is 2 by default, and
 * everything past that waits in `queued` — so the twelfth upload inside one minute is
 * already queued behind the first eleven. This is the one limiter whose budget the
 * caller cannot spend usefully.
 */
export function uploadRateLimit(cfg: IrisConfig): RequestHandler {
  const limits = resolveRateLimits(cfg.server.rate_limits);
  if (!limits.enabled) return passThrough;
  return limiter({
    limit: limits.upload_per_minute,
    key: userKey,
    message: (limit, retryAfter) =>
      `Too many uploads: this deployment accepts ${limit} per minute. A conversion takes minutes and ` +
      `runs are queued, so uploads past that only wait on each other. Retry in ${retryAfter}s.`,
  });
}

/**
 * How much upload may be arriving at once — the piece the rate limiter cannot cover.
 *
 * A rate limit counts requests over a window; memory is spent by requests that OVERLAP.
 * Twelve uploads a minute is a fine budget and twelve simultaneous 128 MB uploads is
 * 1.5 GB of buffered body on a machine PRD §10.1 says may be a laptop.
 *
 * So this gate meters BYTES, not requests. Each request is charged what its
 * `Content-Length` says it is about to send, and admitted while the total in flight fits
 * in `max_upload_memory_mb`. Counting requests instead would have been simpler and worse:
 * a cap of four would refuse a fifth 40 KB upload — a pattern a batch client or a browser
 * with several tabs produces routinely — while still permitting four 128 MB ones, so it
 * would inconvenience the traffic it should allow and barely bound the traffic it exists
 * for. Bytes are what is scarce, and the client states them before sending any.
 *
 * A request that declares no length (chunked) is charged the per-request ceiling, since
 * the alternative is a bound any client can opt out of by not mentioning its size. That
 * is conservative in the safe direction — at most two undeclared uploads at the default —
 * and rare: browsers and curl both send `Content-Length` for a multipart body.
 *
 * Every charge is an upper bound on what its request can actually spend, which is what
 * makes the total mean anything. A declared request cannot exceed its declaration — Node
 * reads at most `Content-Length` bytes of body, so the charge is a bound and not a
 * courtesy — and an undeclared one is metered as it arrives and cut off at the same ceiling
 * by `meterUploadBody` below. The total here is therefore the peak, not an estimate a
 * chunked sender can walk past.
 *
 * Refusal rather than waiting — the opposite of what RunQueue does one step later, and
 * for the reason RunQueue gives for waiting: by the time the queue is consulted the
 * upload is received and on disk, so rejecting would discard work already done. Here
 * nothing has been received yet. Holding the request instead would mean holding the
 * socket open while the body streams into the memory this exists to protect, which is
 * the cost it is trying not to pay.
 *
 * Global rather than per user, like the run cap: memory is global, so a per-user budget
 * would let four users each fill theirs and exhaust it anyway.
 */
export function uploadGate(cfg: IrisConfig): RequestHandler {
  const limits = resolveRateLimits(cfg.server.rate_limits);
  if (!limits.enabled) return passThrough;
  const budget = limits.max_upload_memory_mb * 1024 * 1024;
  let inFlight = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.header("content-length"));
    const charge =
      Number.isFinite(declared) && declared > 0 ? Math.min(declared, MAX_UPLOAD_BYTES) : MAX_UPLOAD_BYTES;
    // `inFlight > 0` guards the case where one request alone is bigger than the whole
    // budget: an operator who sets max_upload_memory_mb below the per-request ceiling
    // should get a deployment that accepts uploads one at a time, not one that refuses
    // every upload forever with a message about congestion.
    if (inFlight > 0 && inFlight + charge > budget) {
      res.set("Retry-After", String(UPLOAD_GATE_RETRY_SECONDS));
      sendError(
        res,
        429,
        "rate_limited",
        `Too many large uploads in progress: this deployment receives ${formatBytes(budget)} of upload at ` +
          `once, ${formatBytes(inFlight)} of that is already arriving, and each is held in memory until ` +
          `its pages are written to disk. Retry in a few seconds.`,
        {
          max_upload_memory_bytes: budget,
          in_flight_bytes: inFlight,
          request_bytes: charge,
          retry_after_seconds: UPLOAD_GATE_RETRY_SECONDS,
        },
      );
      return;
    }
    inFlight += charge;
    // The charge must come back exactly once, on every way this response can end. A leak
    // here is the worst failure available to this gate: the total never returns to zero
    // and uploads are refused for the lifetime of the process, with nothing anywhere to
    // say why — so it is released idempotently and from both events rather than trusting
    // one of them to fire (`close` covers a client that hung up mid-upload, `finish` a
    // response that completed).
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= charge;
    };
    res.once("close", release);
    res.once("finish", release);
    next();
  };
}

// The one refusal, worded once. Both halves of the gate below are the same answer — this
// request is bigger than one upload may be — and they differ only in how that was found
// out, so only that clause is theirs to fill in.
function refuseTooLarge(
  res: Response,
  maxBytes: number,
  cause: string,
  details: Record<string, number>,
): void {
  sendError(
    res,
    413,
    "upload_too_large",
    `Upload too large: this request ${cause} and one request may carry at most ` +
      `${formatBytes(maxBytes)} across all of its parts. A document of up to ${MAX_UPLOAD_FILES} pages ` +
      `fits inside that; split a larger batch across sessions.`,
    { max_bytes: maxBytes, ...details },
  );
}

/**
 * Count a body that would not say how big it is, and cut it off at the ceiling.
 *
 * Counted here rather than left to multer because multer has no total: its limits are per
 * part (`fileSize`) and per count (`files`), and their PRODUCT — 25 x 50 MB — is an order
 * of magnitude above the per-request ceiling `GET /v1/limits` publishes. Lowering
 * `fileSize` to a twenty-fifth of that ceiling would make the product come out right and
 * refuse the large scanned PDF this endpoint exists for, so the total has to be counted
 * where the total is known: off the request stream.
 *
 * WHERE THIS IS CALLED FROM IS PART OF IT. Attaching a `data` listener puts the stream in
 * flowing mode, so anything delivered before multer pipes it into busboy is a chunk missing
 * from a body nobody refused — which surfaces as a mangled multipart parse, i.e. a valid
 * upload rejected as malformed. So this is called from inside the multer wrapper
 * (routes/sessions.ts), two statements from `upload.array(...)`, and not from a middleware
 * of its own: express-rate-limit awaits its store, so "the middleware in front of multer
 * looks synchronous" is not something this can rest on.
 *
 * On refusal the response is written from here, mid-parse, while it is still ours to write:
 * multer has not answered and never will, because unpiping means busboy sees no more of the
 * body and never reaches its `close`. That is deliberate — the point is to stop parsing, not
 * to let multer finish and then complain.
 *
 * A body that DID declare a length is left alone: `requestSizeGate` has already refused it
 * if it declared too much, and Node reads no more of a declared body than it declared, so
 * there is nothing left for counting to discover.
 */
export function meterUploadBody(req: Request, res: Response): void {
  const declared = Number(req.header("content-length"));
  if (Number.isFinite(declared) && declared > 0) return;
  const maxBytes = uploadCeiling;
  let received = 0;
  const onData = (chunk: Buffer | string): void => {
    received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (received <= maxBytes) return;
    req.off("data", onData);
    req.unpipe();
    if (!res.headersSent) {
      // `Connection: close` rather than destroying the socket here: this connection has a
      // body on it that nothing will finish reading, so it cannot be reused anyway, and
      // Node's own close-after-response path flushes the refusal before the socket goes —
      // where hanging up by hand races the response and can leave the caller holding a
      // reset instead of a 413. It also ends the transfer, so an oversized sender does not
      // get to spend the rest of its gigabytes on a request already refused.
      res.set("Connection", "close");
      refuseTooLarge(res, maxBytes, `sent ${formatBytes(received)} without declaring a length`, {
        received_bytes: received,
      });
    }
    // Discard whatever else arrives before that close, rather than leaving it in the
    // socket's buffer. Draining costs bandwidth and no memory, which is the trade this
    // whole gate is about.
    req.resume();
  };
  req.on("data", onData);
}

/**
 * Refuse a request whose declared size is past what one upload may be, before multer reads
 * any of it.
 *
 * This is the cheap half of the per-request ceiling, and an exact one for the requests it
 * covers: Node reads at most `Content-Length` bytes of body, so a caller cannot declare 1 MB
 * and then send 500. It is worth having in front because it costs nothing — the alternative
 * is buffering 500 MB in order to discover it was 500 MB.
 *
 * The other half is `meterUploadBody` above, for a body that declares nothing. Without it
 * this ceiling would bind only the callers who mentioned their size, and the number
 * `GET /v1/limits` publishes would be one an operator on a small machine could not rely on.
 * The two are separate because they have to run in different places: this one as early in
 * the stack as possible, that one as late as possible.
 *
 * 413 rather than 429: the request is not over a rate budget, it is too big, and the
 * caller who retries it unchanged should be told that rather than told to wait.
 */
export function requestSizeGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.header("content-length"));
    if (Number.isFinite(declared) && declared > uploadCeiling) {
      refuseTooLarge(res, uploadCeiling, `declares ${formatBytes(declared)}`, { declared_bytes: declared });
      return;
    }
    next();
  };
}

/**
 * The budget as `GET /v1/limits` publishes it, or null when this deployment does not
 * limit request volume in the app.
 *
 * Published for the same reason the upload limits are: a client that can read the budget
 * can pace itself, and one that cannot discovers it by being refused. `null` is a real
 * answer rather than an omission — it says the app is not limiting, which a client
 * should not confuse with "the limits are unknown".
 */
export function publishedRateLimits(cfg: IrisConfig): PublishedRateLimits | null {
  const { enabled, ...limits } = resolveRateLimits(cfg.server.rate_limits);
  if (!enabled) return null;
  // `enabled` is dropped rather than published: null already says "not limiting", and a
  // body carrying `enabled: false` next to four numbers invites a client to read the
  // numbers.
  return { ...limits, window_seconds: WINDOW_MS / 1000 };
}

export type PublishedRateLimits = Omit<RateLimitConfig, "enabled"> & { window_seconds: number };
