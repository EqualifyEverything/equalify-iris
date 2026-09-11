import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.ts";
import { makeAuthMiddleware, __clearTokenCache } from "../src/auth/middleware.ts";
import type { AuthedRequest } from "../src/auth/middleware.ts";
import { meRouter } from "../src/routes/me.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import { uploadRateLimit } from "../src/util/requestLimits.ts";
import { anonymousToken, anonymousTokenWarning, normalizeTrustProxy } from "../src/config.ts";
import type { IrisConfig, RateLimitConfig } from "../src/config.ts";

// `github.anonymous_token` (#456): a deployment can serve callers who send NO credential
// as one shared identity, so a visitor can try the demo without a GitHub account.
//
// Everything worth pinning here is a property that cannot be seen from a response body,
// because the whole point of the feature is that an anonymous request looks like an
// ordinary successful one:
//
//   * WHICH missing-credential shape it answers for. A request with no header is served;
//     a request with a BAD header is still refused. Serving that second one would move a
//     client that was trying to be someone into a shared account's session space, and
//     every response on the way would be a 200.
//   * That the session LIST is closed to anonymous callers. Ownership is `github_user_id`
//     and nothing else, so one shared credential makes "this user's sessions" mean "every
//     anonymous visitor's sessions" — a stranger's document, listed to whoever asks next.
//   * That the shared identity is not one rate-limit bucket. Every anonymous caller
//     resolves to the same user id, so keying uploads on the user would put the whole
//     internet in a single `upload_per_minute`, and it would look like a working
//     deployment that is mysteriously always at its limit.
//   * That the credential from config is VALIDATED like any other, rather than trusted
//     because an operator typed it.
//
// And the default: with the key unset, none of the above is reachable and a token is
// required on every call.
//
// Each of those is pinned by a test that was MEASURED red, not assumed to be: removing the
// `req.anonymous` guard from the session list returns 200 with `ses_anon_one` in the body —
// a session owned by the shared identity, so in a real deployment whatever the previous
// visitor uploaded. Broadening the served shape from `!header` to `!match` serves
// `Basic …`; dropping the flag from `/v1/me` or from `userKey` reddens one test each, and
// never setting it at all reddens two.

const ANON_TOKEN = "gho_anon_demo";
const ANON_USER = { id: 4242, login: "iris-demo-bot" };
const USER_TOKEN = "gho_real_person";
const REAL_USER = { id: 909, login: "a-real-person" };

// A GitHub that knows exactly two tokens, so "the anonymous credential was validated" and
// "the caller's own token was validated" are distinguishable, and anything else 401s.
async function mockGitHub(): Promise<{ base: string; close: () => void; calls: () => number }> {
  const app = express();
  const state = { calls: 0 };
  app.get("/user", (req, res) => {
    state.calls++;
    const auth = req.header("authorization") ?? "";
    if (auth === `Bearer ${ANON_TOKEN}`) return void res.json(ANON_USER);
    if (auth === `Bearer ${USER_TOKEN}`) return void res.json(REAL_USER);
    res.status(401).json({ message: "Bad credentials" });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
    calls: () => state.calls,
  };
}

function cfg(apiBase: string, dir: string, anonToken?: string): IrisConfig {
  return {
    server: { port: 0, base_url: "http://localhost:0" },
    storage: { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite") },
    github: {
      client_id: "Iv1.test",
      client_secret: "s",
      upstream_repo: "https://github.com/o/r",
      api_base_url: apiBase,
      oauth_base_url: "https://github.com",
      anonymous_token: anonToken,
    },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "anthropic/claude-sonnet-4.6" } },
    defaults: { max_review_iterations: 3, extraction_concurrency: 5, max_concurrent_runs: 2, recheck_sample_size: 1 },
  };
}

// The real auth middleware in front of the real `/v1/me` and `/v1/sessions` routers, so
// each request below runs the branch under test rather than a re-implementation of it.
async function harness(anonToken?: string) {
  __clearTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "iris-anon-"));
  const gh = await mockGitHub();
  const config = cfg(gh.base, dir, anonToken);
  const store = new Store(join(dir, "iris.sqlite"));
  const app = express();
  const auth = makeAuthMiddleware(store, config);
  app.use("/v1/me", auth, meRouter(config));
  app.use("/v1/sessions", auth, sessionsRouter(config, store));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    ghCalls: gh.calls,
    // No `headers` key at all when nothing is passed: an empty object would still be a
    // request with no Authorization header, but being explicit is what this suite is about.
    fetch: (path: string, headers?: Record<string, string>) =>
      fetch(`${base}${path}`, headers ? { headers } : undefined),
    close: () => {
      server.close();
      gh.close();
      // The database goes with the temp directory, as in test/token-cache.test.ts: the
      // handle is process-local and the file is about to not exist.
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  __clearTokenCache();
});

test("with no anonymous_token, a request without a credential is still refused", async () => {
  const h = await harness(undefined);
  try {
    const res = await h.fetch("/v1/me");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "unauthorized");
    assert.match(body.error.message, /Missing or malformed Authorization header/);
    // And nothing was asked of GitHub: there was no credential to validate, so the
    // refusal costs no outbound call.
    assert.equal(h.ghCalls(), 0);
  } finally {
    h.close();
  }
});

test("a whitespace-only anonymous_token is not a credential, end to end", async () => {
  // The shape an unset `${IRIS_ANONYMOUS_TOKEN}` and a blank YAML value both arrive as. Its own
  // test rather than an assertion inside the unit test above, because what is at stake is which
  // deployment an operator actually gets: the config helper agreeing with itself proves nothing
  // if the middleware asks a different question.
  const h = await harness("   ");
  try {
    assert.equal(await h.fetch("/v1/me").then((r) => r.status), 401);
    assert.equal(h.ghCalls(), 0, "a blank credential must not be sent to GitHub for validation");
  } finally {
    h.close();
  }
});

test("with anonymous_token set, a request with no credential is served and says so", async () => {
  const h = await harness(ANON_TOKEN);
  try {
    const res = await h.fetch("/v1/me");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { github_login: string; github_user_id: number; anonymous?: boolean };
    // The identity is the configured credential's, and `anonymous: true` is the only
    // thing in the body that says the caller is not that person: without it a demo page
    // would greet a visitor who never signed in as `iris-demo-bot`.
    assert.equal(body.github_login, ANON_USER.login);
    assert.equal(body.github_user_id, ANON_USER.id);
    assert.equal(body.anonymous, true);
    // Validated through GitHub like any other token, not trusted because it came from
    // config — one `GET /user`, and the second request is served from the same cache a
    // user's token uses.
    assert.equal(h.ghCalls(), 1);
    assert.equal(await h.fetch("/v1/me").then((r) => r.status), 200);
    assert.equal(h.ghCalls(), 1);
  } finally {
    h.close();
  }
});

test("a signed-in caller is unchanged, and carries no anonymous flag", async () => {
  const h = await harness(ANON_TOKEN);
  try {
    const res = await h.fetch("/v1/me", { authorization: `Bearer ${USER_TOKEN}` });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { github_login: string; anonymous?: boolean };
    assert.equal(body.github_login, REAL_USER.login);
    // Absent, not `false`. The key means "this response is not about a person", so it
    // appears only in the mode it describes.
    assert.equal("anonymous" in body, false);
  } finally {
    h.close();
  }
});

// The two shapes below are two tests and not one, because they fail through different
// mechanisms and a single test stops at its first failed assertion. `Bearer <expired>`
// MATCHES the header pattern and dies in validation; `Basic …` never matches and dies at
// the guard. Widening either one leaves the other's assertion unrun and unreported, which
// is the state where a reader edits the first test to match the new behaviour and only
// discovers the second on a later run.

test("a credential GitHub rejects is refused, not downgraded to the shared identity", async () => {
  const h = await harness(ANON_TOKEN);
  try {
    // The tempting behaviour — fall back to the anonymous credential — would serve this
    // caller 200 under a bot account, so its uploads would land somewhere it cannot list
    // and its feedback would be filed as someone else. The failure it needs to see is its
    // own expired token.
    const rejected = await h.fetch("/v1/me", { authorization: "Bearer gho_expired" });
    assert.equal(rejected.status, 401);
    assert.match(((await rejected.json()) as { error: { message: string } }).error.message, /Token validation failed/);
    // And the deployment is still serving anonymous callers, so the 401 above is about
    // this request rather than the mode being off.
    assert.equal(await h.fetch("/v1/me").then((r) => r.status), 200);
  } finally {
    h.close();
  }
});

test("a header that is not a usable Bearer is refused, not read as a missing one", async () => {
  const h = await harness(ANON_TOKEN);
  try {
    // Present but not a Bearer at all: still a client trying to authenticate, so still a
    // 401 rather than a silent downgrade.
    const wrongScheme = await h.fetch("/v1/me", { authorization: "Basic dXNlcjpwYXNz" });
    assert.equal(wrongScheme.status, 401);
    assert.match(
      ((await wrongScheme.json()) as { error: { message: string } }).error.message,
      /Missing or malformed Authorization header/,
    );

    // An empty Bearer, the shape closest to "no header", must land on the same side of the
    // line: the guard is `!header`, not "no token in the header", so a caller who sends the
    // scheme and nothing else is refused rather than served.
    assert.equal(await h.fetch("/v1/me", { authorization: "Bearer " }).then((r) => r.status), 401);

    assert.equal(await h.fetch("/v1/me").then((r) => r.status), 200);
  } finally {
    h.close();
  }
});

test("the session list refuses an anonymous caller and still serves a signed-in one", async () => {
  const h = await harness(ANON_TOKEN);
  try {
    // Two sessions that exist: one owned by the shared anonymous identity, one by a real
    // user. Written through the store rather than by upload, because what is under test is
    // who may READ the list.
    h.store.upsertUser({ github_user_id: ANON_USER.id, github_login: ANON_USER.login }, 1);
    h.store.upsertUser({ github_user_id: REAL_USER.id, github_login: REAL_USER.login }, 1);
    h.store.createSession({ session_id: "ses_anon_one", github_user_id: ANON_USER.id, image_count: 1, iterations_max: 1 });
    h.store.createSession({ session_id: "ses_real_one", github_user_id: REAL_USER.id, image_count: 1, iterations_max: 1 });

    const refused = await h.fetch("/v1/sessions");
    assert.equal(refused.status, 403);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "anonymous_session_list");
    // The message has to name the remedy, because a client that just uploaded has the one
    // thing that still works and no way to guess it from a bare 403.
    assert.match(body.error.message, /session id returned by POST \/v1\/sessions/);
    assert.match(body.error.message, /sign in with GitHub/);

    // The refusal is about the caller, not the route: the same deployment lists a
    // signed-in user's own sessions, and lists only theirs.
    const listed = await h.fetch("/v1/sessions", { authorization: `Bearer ${USER_TOKEN}` });
    assert.equal(listed.status, 200);
    const page = (await listed.json()) as { sessions: { session_id: string }[] };
    assert.deepEqual(
      page.sessions.map((s) => s.session_id),
      ["ses_real_one"],
    );

    // And what an anonymous caller keeps: the session it holds the id of. This is the
    // narrowing the mode trades for — reachability by id, which is `ses_` + a ULID rather
    // than an owner check.
    assert.equal(await h.fetch("/v1/sessions/ses_anon_one").then((r) => r.status), 200);
  } finally {
    h.close();
  }
});

// The rate-limit key, driven through `uploadRateLimit` with the auth result stubbed: what
// is under test is which bucket a request lands in, and reaching the real upload route
// would mean standing up multer and a pipeline to assert something decided before either.
//
// Two addresses from one process, which needs `trust proxy` — the same device
// test/request-limits.test.ts uses for the forged-header case, and the only way to have
// two callers in one test file.
//
// Stubbing the auth result means these two cannot see whether a real request arrives at the
// limiter with the flag already on. That it does is an ordering fact, checked by reading
// rather than asserted here: `uploadBudget` is mounted inside the sessions router
// (src/routes/sessions.ts:274), and src/index.ts:144 mounts that router behind `auth`. The
// `/v1` general limiter is the one that runs first, which is why it has no anonymous
// branch at all.
async function serveUploadLimit(
  limits: Partial<RateLimitConfig>,
  stub: (req: AuthedRequest) => void,
): Promise<{ as: (ip: string) => Promise<number>; close: () => void }> {
  const app = express();
  app.set("trust proxy", normalizeTrustProxy(1));
  const config = {
    server: { port: 0, base_url: "http://localhost:0", rate_limits: limits },
  } as unknown as IrisConfig;
  app.use(
    "/upload",
    (req, _res, next) => {
      stub(req as AuthedRequest);
      next();
    },
    uploadRateLimit(config),
    (_req, res) => void res.json({ ok: true }),
  );
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  return {
    as: (ip: string) => fetch(url, { method: "POST", headers: { "x-forwarded-for": ip } }).then((r) => r.status),
    close: () => server.close(),
  };
}

test("anonymous uploads are counted per address, not against the shared identity", async () => {
  // Every anonymous caller is `iris-demo-bot` as far as the store is concerned. Keyed on
  // that user id, one upload per minute would be one upload per minute for the whole
  // internet — and the symptom is a deployment that looks healthy and is permanently at
  // its limit for everyone but the first visitor.
  const anon = await serveUploadLimit({ upload_per_minute: 1 }, (req) => {
    req.user = { github_user_id: ANON_USER.id, github_login: ANON_USER.login, max_review_iterations: 1 } as AuthedRequest["user"];
    req.anonymous = true;
  });
  try {
    assert.equal(await anon.as("10.0.0.1"), 200);
    assert.equal(await anon.as("10.0.0.2"), 200, "a second visitor must not be paying for the first");
    assert.equal(await anon.as("10.0.0.1"), 429, "and each address still has a budget of its own");
  } finally {
    anon.close();
  }
});

test("a signed-in user's uploads are still counted per user, across addresses", async () => {
  // The other axis, and the reason the branch is on `anonymous` rather than on "is there a
  // user": per-user keying is what makes Iris usable from a campus NAT, so switching
  // uploads to per-address wholesale would be a regression that this file's other test
  // could not see. One user, two addresses, one budget.
  const signedIn = await serveUploadLimit({ upload_per_minute: 1 }, (req) => {
    req.user = { github_user_id: REAL_USER.id, github_login: REAL_USER.login, max_review_iterations: 1 } as AuthedRequest["user"];
  });
  try {
    assert.equal(await signedIn.as("10.0.0.1"), 200);
    assert.equal(await signedIn.as("10.0.0.2"), 429, "the same user from a second address shares one bucket");
  } finally {
    signedIn.close();
  }
});

test("one rule decides whether the key is set, so the warning cannot contradict the behaviour", () => {
  // `${IRIS_ANONYMOUS_TOKEN}` unset expands to `""`, not to a missing key (`expandEnv`), and a
  // YAML value can be whitespace. Both mean OFF, and both have to mean off in the same way in
  // two places: the middleware decides whether to serve an anonymous request, and the boot log
  // tells the operator which deployment they have. Split rules here would print "anonymous
  // access is on" over a service that 401s every anonymous call — a bug hunt in the wrong half.
  const off = (v: string | undefined) => ({ github: { anonymous_token: v } }) as unknown as IrisConfig;
  assert.equal(anonymousToken(off(undefined)), undefined);
  assert.equal(anonymousToken(off("")), undefined);
  assert.equal(anonymousToken(off("   ")), undefined);
  // And a real value survives, trimmed — a token pasted with a trailing newline still works.
  assert.equal(anonymousToken(off(` ${ANON_TOKEN}\n`)), ANON_TOKEN);
});

test("the boot warning fires only when the key is set, and never prints the credential", () => {
  assert.equal(anonymousTokenWarning(undefined), undefined);
  assert.equal(anonymousTokenWarning(""), undefined);
  const warning = anonymousTokenWarning(ANON_TOKEN) ?? "";
  // The three consequences an operator cannot see from outside, each named. Asserted
  // because this string is the only place the deployment states its own policy, and a
  // warning that says "anonymous access is on" without saying what that costs is the
  // version of this that would have shipped.
  assert.match(warning, /GET \/v1\/sessions refuses them/);
  assert.match(warning, /rate limited by address/);
  assert.match(warning, /filed under this credential's account/);
  // A boot log gets pasted into issues. This is the one config value that is a live
  // GitHub token for a real account, so no part of it appears here.
  assert.equal(warning.includes(ANON_TOKEN), false);
  assert.equal(warning.includes(ANON_TOKEN.slice(0, 8)), false);
});
