import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { IrisConfig, RateLimitConfig } from "../src/config.ts";
import {
  DEFAULT_AUTH_PER_MINUTE,
  DEFAULT_GENERAL_PER_MINUTE,
  DEFAULT_MAX_UPLOAD_MEMORY_MB,
  DEFAULT_UPLOAD_PER_MINUTE,
  normalizeTrustProxy,
  resolveRateLimits,
  trustProxyWarning,
} from "../src/config.ts";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  __resetProxyWarning,
  authRateLimit,
  generalRateLimit,
  publishedRateLimits,
  requestSizeGate,
  uploadGate,
} from "../src/util/requestLimits.ts";
import { __clearTokenCache, __seedTokenCache } from "../src/auth/middleware.ts";
import type { AuthedRequest } from "../src/auth/middleware.ts";
import { limitsRouter } from "../src/routes/limits.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import { Store } from "../src/store/db.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The HTTP-layer request budget (issue #102). What is worth pinning here is not that a
// counter counts — express-rate-limit does that — but the decisions made around it, each of
// which is invisible in normal operation and expensive when wrong:
//
//   * A 429 is an Iris error (PRD §9.3 shape) carrying `Retry-After`, not the library's
//     default plain-text body. A client that cannot parse the refusal cannot pace itself.
//   * An address is only an address if the deployment can trust the header it came from:
//     unset, `X-Forwarded-For` is a claim, and a limiter that believed it would bound
//     nothing while still answering 200 to everything.
//   * A request counts against its CREDENTIAL where one has been validated, and against
//     its address otherwise. Both halves are load-bearing: per-address alone punishes
//     everyone behind a NAT for one user's polling, and per-credential-as-presented would
//     hand a caller a fresh budget per random bearer string — on the path that spends an
//     outbound `GET /user` per unknown token.
//   * The in-flight upload gate meters BYTES and returns what it charged on EVERY way a
//     response can end. Both halves are load-bearing: metering requests instead would
//     refuse a small upload that costs nothing, and a charge that is not returned refuses
//     uploads for the lifetime of the process with nothing to say why — a state no other
//     test in the suite would notice.
//   * The knobs default to something usable and cannot be turned into a service outage by
//     a valueless YAML key (`general_per_minute:` parses as null, and a limit of 0 means
//     "refuse everything").
//   * On the upload route the gates run in FRONT of multer. Mounted after it they would
//     all still pass their unit tests while the body they were meant to refuse had already
//     been buffered — so the last test here drives the real router over HTTP.

function cfg(rate_limits?: Partial<RateLimitConfig>): IrisConfig {
  return {
    server: { port: 3000, base_url: "http://localhost:3000", rate_limits },
    storage: { data_dir: "/tmp/iris-test", agents_dir: "agents", database: ":memory:" },
    github: {
      client_id: "Iv1.test",
      client_secret: "s",
      upstream_repo: "https://github.com/o/r",
      api_base_url: "https://api.github.com",
      oauth_base_url: "https://github.com",
    },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "anthropic/claude-sonnet-4.6" } },
    defaults: { max_review_iterations: 3, extraction_concurrency: 5, max_concurrent_runs: 2 },
  };
}

type Client = {
  get: (init?: RequestInit) => Promise<Response>;
  post: (init?: RequestInit) => Promise<Response>;
  url: string;
  close: () => void;
};

// A one-route app behind the middleware under test. Every request lands on 127.0.0.1, so
// address-keyed buckets are shared between calls in a test — which is what makes the
// credential-keyed cases below meaningful rather than accidental.
async function serve(...middleware: express.RequestHandler[]): Promise<Client> {
  const app = express();
  app.use("/v1/thing", ...middleware, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/thing`;
  return {
    url,
    get: (init) => fetch(url, init),
    post: (init) => fetch(url, { method: "POST", ...init }),
    close: () => server.close(),
  };
}

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

// A token this process has "already validated", i.e. one sitting in the auth
// middleware's cache. Seeded directly rather than by driving a login, because the point
// under test is what the limiter does with a token whose validity it did not establish.
function validated(token: string, id = 1): void {
  __seedTokenCache(token, id, Date.now() + 60_000);
}

afterEach(() => {
  __clearTokenCache();
  __resetProxyWarning();
});

test("a caller over the general budget gets an Iris-shaped 429 with a retry hint", async () => {
  const srv = await serve(generalRateLimit(cfg({ general_per_minute: 2 })));
  try {
    const first = await srv.get();
    assert.equal(first.status, 200);
    // The budget a client can pace itself against, on a response that was allowed.
    assert.match(first.headers.get("ratelimit") ?? "", /limit=2, remaining=1/);
    assert.equal(await srv.get().then((r) => r.status), 200);

    const over = await srv.get();
    assert.equal(over.status, 429);
    const retryAfter = Number(over.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After should be within the window, got ${retryAfter}`);
    const body = (await over.json()) as { error: { code: string; message: string; details: Record<string, unknown> } };
    assert.equal(body.error.code, "rate_limited");
    assert.match(body.error.message, /allows 2 per minute/);
    // The same numbers the headers carry, in the error's own `details` — a client reading
    // the documented error shape should not have to also parse a draft-spec header.
    assert.equal(body.error.details.limit, 2);
    assert.equal(body.error.details.window_seconds, 60);
    assert.equal(body.error.details.retry_after_seconds, retryAfter);
    // The deprecated pair stays gone; only the draft-7 headers are published.
    assert.equal(over.headers.get("x-ratelimit-limit"), null);
  } finally {
    srv.close();
  }
});

test("a validated credential is its own client, and an unvalidated one is not", async () => {
  validated("real-token-a", 1);
  validated("real-token-b", 2);
  const srv = await serve(generalRateLimit(cfg({ general_per_minute: 1 })));
  try {
    // Spend the address's budget with an unauthenticated request.
    assert.equal(await srv.get().then((r) => r.status), 200);
    assert.equal(await srv.get().then((r) => r.status), 429);

    // A user behind that same address still has their own budget — the case that makes
    // this deployment usable from a campus NAT or from behind a reverse proxy.
    assert.equal(await srv.get(bearer("real-token-a")).then((r) => r.status), 200);
    assert.equal(await srv.get(bearer("real-token-a")).then((r) => r.status), 429);
    // And one user exhausting theirs does not spend another's.
    assert.equal(await srv.get(bearer("real-token-b")).then((r) => r.status), 200);

    // A bearer nobody has validated is not a credential, so it cannot buy a fresh
    // bucket: it counts against the address, which is already spent. Rotating the string
    // is the cheapest attack available against per-credential keying, and it is also the
    // path that costs an outbound GET /user per distinct token.
    assert.equal(await srv.get(bearer("made-up-1")).then((r) => r.status), 429);
    assert.equal(await srv.get(bearer("made-up-2")).then((r) => r.status), 429);
  } finally {
    srv.close();
  }
});

test("the auth budget is per address even for a validated caller", async () => {
  validated("real-token-a", 1);
  const srv = await serve(authRateLimit(cfg({ auth_per_minute: 1 })));
  try {
    assert.equal(await srv.post().then((r) => r.status), 200);
    // Presenting a token cannot widen the budget on the endpoints that ISSUE tokens:
    // there is nothing to count against there but the address.
    const over = await srv.post(bearer("real-token-a"));
    assert.equal(over.status, 429);
    assert.match(((await over.json()) as { error: { message: string } }).error.message, /per address/);
  } finally {
    srv.close();
  }
});

test("a forged X-Forwarded-For cannot buy a fresh bucket, and a trusted one is believed", async () => {
  // Exposed directly (the default): the header is a claim from an untrusted client, so
  // both requests are the same caller. This is what makes per-address limiting worth
  // anything at all — if a header could reset the count nothing here bounds a thing, and
  // the failure would be invisible, since every response is still a 200.
  const direct = await serve(generalRateLimit(cfg({ general_per_minute: 1 })));
  try {
    assert.equal(await direct.get({ headers: { "x-forwarded-for": "10.0.0.1" } }).then((r) => r.status), 200);
    assert.equal(await direct.get({ headers: { "x-forwarded-for": "10.0.0.2" } }).then((r) => r.status), 429);
  } finally {
    direct.close();
  }

  // Behind one trusted proxy the same two headers ARE two callers, which is the other half
  // of the setting: users arriving through a reverse proxy must not share one budget.
  __resetProxyWarning();
  const app = express();
  app.set("trust proxy", normalizeTrustProxy(1));
  app.use("/v1/thing", generalRateLimit(cfg({ general_per_minute: 1 })), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/thing`;
  try {
    const as = (ip: string) => fetch(url, { headers: { "x-forwarded-for": ip } }).then((r) => r.status);
    assert.equal(await as("10.0.0.1"), 200);
    assert.equal(await as("10.0.0.2"), 200);
    assert.equal(await as("10.0.0.1"), 429);
  } finally {
    server.close();
  }
});

// A request whose `Content-Length` does not match the bytes it sends, which is the only
// way to test gates whose whole purpose is to answer before the body arrives. `fetch`
// cannot express it (undici rejects the mismatch client-side), and sending real 128 MB
// bodies to prove a 128 MB limit would be a test that funds the problem.
function rawPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    // `agent: false` — a fresh connection per call. A refusal here leaves an unread body
    // on the socket, so the server closes it rather than pooling it, and a reused
    // keep-alive socket would surface as a hang-up on the NEXT request in this test.
    const req = httpRequest(url, { method: "POST", headers, agent: false }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// An app that holds every upload open until told to let go, so "in flight" is a real
// state rather than a race. `entered(n)` resolves once n requests are inside the handler.
async function uploadServer(gate: express.RequestHandler) {
  const held: Array<() => void> = [];
  let count = 0;
  let announce: () => void = () => {};
  const app = express();
  app.post("/v1/sessions", gate, async (_req, res) => {
    count++;
    announce();
    await new Promise<void>((resolve) => held.push(resolve));
    res.json({ ok: true });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions`,
    entered: (n: number) =>
      new Promise<void>((resolve) => {
        announce = () => {
          if (count >= n) resolve();
        };
        if (count >= n) resolve();
      }),
    releaseAll: () => held.forEach((release) => release()),
    close: () => {
      held.forEach((release) => release());
      server.close();
    },
  };
}

test("upload memory in flight is metered in bytes, so small uploads never wait on each other", async () => {
  // 1 MB of upload budget, against requests that declare what they are about to send.
  const srv = await uploadServer(uploadGate(cfg({ max_upload_memory_mb: 1 })));
  const big = { "content-length": "900000" };
  try {
    const first = rawPost(srv.url, big, "x");
    await srv.entered(1);

    // A second nearly-a-megabyte upload does not fit beside the first.
    const over = await rawPost(srv.url, big, "x");
    assert.equal(over.status, 429);
    assert.equal(over.headers["retry-after"], "10");
    const body = JSON.parse(over.body) as { error: { code: string; message: string; details: Record<string, unknown> } };
    assert.equal(body.error.code, "rate_limited");
    assert.equal(body.error.details.in_flight_bytes, 900000);
    assert.equal(body.error.details.max_upload_memory_bytes, 1024 * 1024);
    assert.match(body.error.message, /1 MB of upload at once/);

    // ...but a small one does, while that same big upload is still arriving. This is the
    // case a cap on the NUMBER of uploads would have refused for no memory reason — and
    // several small uploads at once is what a batch client or a few browser tabs do.
    const small = rawPost(srv.url, { "content-length": "1000" }, "x");
    await srv.entered(2);

    // Finishing them returns what they were charged. This is the assertion the whole gate
    // rests on: a charge that is not returned wedges uploads for the life of the process.
    srv.releaseAll();
    assert.equal((await first).status, 200);
    assert.equal((await small).status, 200);
    const afterwards = rawPost(srv.url, big, "x");
    await srv.entered(3);
    srv.releaseAll();
    assert.equal((await afterwards).status, 200);
  } finally {
    srv.close();
  }
});

test("an upload that will not say how big it is is charged the whole per-request ceiling", async () => {
  const srv = await uploadServer(uploadGate(cfg({ max_upload_memory_mb: 1 })));
  try {
    // No `Content-Length`: the gate cannot know what this costs, so it charges the most a
    // request may carry — otherwise the bound is one any client can opt out of by leaving
    // the header off. The first is admitted anyway, because a budget smaller than one
    // request must still accept uploads one at a time rather than refuse them all.
    const first = rawPost(srv.url, {}, "small");
    await srv.entered(1);
    const second = await rawPost(srv.url, {}, "small");
    assert.equal(second.status, 429);
    assert.equal((JSON.parse(second.body) as { error: { details: Record<string, number> } }).error.details.request_bytes, MAX_UPLOAD_BYTES);
    srv.releaseAll();
    assert.equal((await first).status, 200);
  } finally {
    srv.close();
  }
});

test("an upload charge comes back when the client hangs up mid-request", async () => {
  const held: Array<() => void> = [];
  let announceEntry: () => void = () => {};
  const app = express();
  app.post("/v1/sessions", uploadGate(cfg({ max_upload_memory_mb: 1 })), async (_req, res) => {
    announceEntry();
    await new Promise<void>((resolve) => held.push(resolve));
    res.json({ ok: true });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions`;
  try {
    const entered = new Promise<void>((resolve) => {
      announceEntry = () => resolve();
    });
    const controller = new AbortController();
    // Charged the full ceiling (no declared length), so the 1 MB budget is spent and the
    // request below can only be admitted if this one's charge comes back.
    const abandoned = fetch(url, { method: "POST", signal: controller.signal });
    await entered;
    // An upload that dies in transit is the ordinary case for a large file on a bad
    // connection, and it never reaches the handler's own end of the response. The charge
    // has to come back from the socket closing, not from the handler finishing.
    controller.abort();
    await assert.rejects(abandoned);

    const next = new Promise<void>((resolve) => {
      announceEntry = () => resolve();
    });
    const second = fetch(url, { method: "POST" });
    await next;
    held.forEach((release) => release());
    assert.equal(await second.then((r) => r.status), 200);
  } finally {
    held.forEach((release) => release());
    server.close();
  }
});

test("a request that declares more than one upload may carry is refused unread", async () => {
  const srv = await serve(requestSizeGate());
  try {
    const over = await rawPost(srv.url, {
      "content-length": String(MAX_UPLOAD_BYTES + 1),
      "content-type": "application/octet-stream",
    }, "x");
    assert.equal(over.status, 413);
    const body = JSON.parse(over.body) as { error: { code: string; message: string; details: Record<string, unknown> } };
    // 413, not 429: the caller is not over a rate budget and waiting will not help — the
    // request itself is too big, and retrying it unchanged has to be told so.
    assert.equal(body.error.code, "upload_too_large");
    assert.equal(body.error.details.max_bytes, MAX_UPLOAD_BYTES);
    assert.match(body.error.message, /128 MB/);

    // A request that declares no length at all (Node frames this one as chunked) is a
    // request the gate cannot judge, and it must not invent a reason to refuse it —
    // multer's per-file and per-count limits are what bound that case (MAX_UPLOAD_FILES).
    const undeclared = await rawPost(srv.url, {}, "small");
    assert.equal(undeclared.status, 200);
    assert.equal(await srv.post({ body: "small", headers: { "content-type": "text/plain" } }).then((r) => r.status), 200);
  } finally {
    srv.close();
  }
});

// The real POST /v1/sessions, with auth stubbed out — what is under test is the middleware
// in front of the handler, and standing up GitHub auth to reach it would test something
// else. Only rejection paths are exercised: an upload that PASSES starts a real pipeline.
async function serveUploadRoute() {
  const dir = mkdtempSync(join(tmpdir(), "iris-req-limits-"));
  const config = cfg();
  config.storage = { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") };
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthedRequest).user = { github_user_id: 1, github_login: "tester", max_review_iterations: 1 } as AuthedRequest["user"];
    next();
  });
  app.use("/v1/sessions", sessionsRouter(config, new Store(config.storage.database)));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/sessions`,
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the upload route refuses an over-limit request in front of multer, not after it", async () => {
  const srv = await serveUploadRoute();
  try {
    // Declared over the per-request ceiling: answered without reading the body, which is
    // the only reason the check is worth anything. Mounted after multer this same request
    // would have been buffered first and the assertion below would still pass.
    const declared = await rawPost(srv.url, { "content-length": String(MAX_UPLOAD_BYTES + 1) }, "x");
    assert.equal(declared.status, 413);
    assert.equal((JSON.parse(declared.body) as { error: { code: string } }).error.code, "upload_too_large");

    // And the part count multer itself enforces, in a message that says what the cap is —
    // "Too many files" is multer's own wording and tells a caller nothing actionable.
    const fd = new FormData();
    for (let i = 0; i <= MAX_UPLOAD_FILES; i++) {
      fd.append("images", new Blob([new Uint8Array(8)], { type: "image/png" }), `page-${i}.png`);
    }
    const many = await fetch(srv.url, { method: "POST", body: fd });
    assert.equal(many.status, 400);
    const body = (await many.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invalid_request");
    assert.match(body.error.message, new RegExp(`at most ${MAX_UPLOAD_FILES} file parts`));
  } finally {
    srv.close();
  }
});

test("limiting off means no counter and no headers at all", async () => {
  const srv = await serve(generalRateLimit(cfg({ enabled: false, general_per_minute: 1 })));
  try {
    for (let i = 0; i < 5; i++) {
      const res = await srv.get();
      assert.equal(res.status, 200, "an off switch that still counts is not an off switch");
      assert.equal(res.headers.get("ratelimit"), null);
    }
  } finally {
    srv.close();
  }
});

test("a config that says nothing, or says something unusable, still gets a working budget", () => {
  const fallback = {
    enabled: true,
    general_per_minute: DEFAULT_GENERAL_PER_MINUTE,
    auth_per_minute: DEFAULT_AUTH_PER_MINUTE,
    upload_per_minute: DEFAULT_UPLOAD_PER_MINUTE,
    max_upload_memory_mb: DEFAULT_MAX_UPLOAD_MEMORY_MB,
  };
  assert.deepEqual(resolveRateLimits(undefined), fallback);
  // The YAML trap the other normalizers exist for: `general_per_minute:` with no value
  // parses as null, and a limit of 0 means "refuse every request" — a config typo that
  // would take the deployment down for everyone.
  assert.deepEqual(
    resolveRateLimits({ general_per_minute: null, auth_per_minute: 0, upload_per_minute: -5 } as never),
    fallback,
  );
  assert.deepEqual(resolveRateLimits({ general_per_minute: "abc" } as never), fallback);
  // Numeric strings survive ${ENV_VAR} expansion, which produces strings for everything.
  assert.equal(resolveRateLimits({ general_per_minute: "50" } as never).general_per_minute, 50);
  assert.equal(resolveRateLimits({ general_per_minute: 12.9 }).general_per_minute, 12);
  // Off is off only when a deployment says so, in the field that says so.
  assert.equal(resolveRateLimits({ enabled: false }).enabled, false);
  assert.equal(resolveRateLimits({ enabled: "false" } as never).enabled, false);
  assert.equal(resolveRateLimits({}).enabled, true);
  assert.equal(resolveRateLimits({ enabled: undefined }).enabled, true);
});

test("trust_proxy accepts a hop count and refuses to blindly trust the chain", () => {
  // Unset means trust nothing: a forged X-Forwarded-For must not be able to move a caller
  // into a fresh bucket.
  assert.equal(normalizeTrustProxy(undefined), false);
  assert.equal(normalizeTrustProxy(""), false);
  assert.equal(normalizeTrustProxy("false"), false);
  assert.equal(normalizeTrustProxy(0), false);
  assert.equal(normalizeTrustProxy(1), 1);
  assert.equal(normalizeTrustProxy("2"), 2);
  // Express's own vocabulary passes through for a topology a count cannot describe.
  assert.equal(normalizeTrustProxy("loopback"), "loopback");
  // `true` is the one accepted-and-unsafe value: it trusts the part of the chain the
  // client wrote. Coerced to one hop, and warned about rather than silently corrected.
  assert.equal(normalizeTrustProxy(true), 1);
  assert.equal(normalizeTrustProxy("true"), 1);
  assert.match(trustProxyWarning(true) ?? "", /trust the whole X-Forwarded-For chain/);
  assert.match(trustProxyWarning("true") ?? "", /Using 1 hop instead/);
  assert.equal(trustProxyWarning(1), undefined);
  assert.equal(trustProxyWarning(undefined), undefined);
});

test("GET /v1/limits publishes the request budget, and says so when there is none", async () => {
  const app = express();
  app.use("/on", limitsRouter(cfg({ general_per_minute: 100 })));
  app.use("/off", limitsRouter(cfg({ enabled: false })));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const on = (await fetch(`${base}/on`).then((r) => r.json())) as Record<string, Record<string, unknown>>;
    assert.deepEqual(on.upload, { max_files: MAX_UPLOAD_FILES, max_request_bytes: MAX_UPLOAD_BYTES });
    assert.equal(on.rate_limits.general_per_minute, 100);
    assert.equal(on.rate_limits.window_seconds, 60);
    assert.equal(on.rate_limits.upload_per_minute, DEFAULT_UPLOAD_PER_MINUTE);
    assert.equal(on.rate_limits.max_upload_memory_mb, DEFAULT_MAX_UPLOAD_MEMORY_MB);
    // `enabled` is not published: null already carries that answer, and a body with
    // `enabled: false` beside four numbers invites a client to trust the numbers.
    assert.equal("enabled" in on.rate_limits, false);

    const off = (await fetch(`${base}/off`).then((r) => r.json())) as Record<string, unknown>;
    assert.equal(off.rate_limits, null, "a deployment that does not limit should say so, not go quiet");
    assert.equal(publishedRateLimits(cfg({ enabled: false })), null);
  } finally {
    server.close();
  }
});
