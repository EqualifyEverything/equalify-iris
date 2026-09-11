import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.ts";
import { makeAuthMiddleware, __identityResolved, __resetIdentity } from "../src/auth/middleware.ts";
import { meRouter } from "../src/routes/me.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import { apiToken, githubToken, identityWarning, loadConfig } from "../src/config.ts";
import type { IrisConfig } from "../src/config.ts";

// Iris authenticates as ONE account. `github.token` is a PAT the operator sets, the server
// holds it and nothing else ever presents a GitHub credential — no device flow, no per-user
// token, no browser that has seen one. This file pins what that leaves.
//
// Three things it replaces are gone with the design: a token cache keyed by user, a shared
// "anonymous" credential, and OAuth scope validation. What survived them is the pair of
// questions the middleware still has to keep apart, and they are separate questions on
// purpose:
//
//   * may this caller use the API at all? — `server.api_token`, optional, and NOT a GitHub
//     credential. Absent, the deployment is open, which is what makes the demo page work.
//   * who is this deployment? — `github.token`, resolved once against `GET /user`.
//
// Conflating them is the failure this design is one refactor away from: a caller who
// presents the gate token is not thereby anybody, and a deployment GitHub cannot identify
// must not read as a caller problem. Both are asserted below by counting the outbound
// lookups, because both mistakes still answer with a plausible status code.

const TOKEN = "ghp_deployment_QQ7734";
const GATE = "s3cret";
const GH_USER = { id: 4242, login: "iris-deployment" };

type GhReply = "user" | 401 | 500;

// A GitHub that answers the one call this design makes, and counts it. The count is the
// instrument for every caching claim here: "resolved once" and "asked again after the
// window" are both statements about how many times this handler ran.
async function mockGitHub(): Promise<{
  base: string;
  calls: () => number;
  reply: (r: GhReply) => void;
  delay: (ms: number) => void;
  account: (u: { id: number; login: string }) => void;
  close: () => void;
}> {
  const state = { calls: 0, reply: "user" as GhReply, delay: 0, account: GH_USER };
  const app = express();
  app.get("/user", async (_req, res) => {
    state.calls++;
    // Held open on request, so a burst of callers is still waiting on the first lookup when
    // the second arrives. Without it the handler answers inside one tick and a concurrency
    // claim would be timing luck rather than a pin.
    if (state.delay > 0) await new Promise((r) => setTimeout(r, state.delay));
    if (state.reply === 401) {
      res.status(401).json({ message: "Bad credentials" });
      return;
    }
    if (state.reply === 500) {
      res.status(500).json({ message: "Server Error" });
      return;
    }
    res.json(state.account);
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => state.calls,
    reply: (r) => {
      state.reply = r;
    },
    delay: (ms) => {
      state.delay = ms;
    },
    // Which account the PAT belongs to. Changing it is how an operator repointing
    // `github.token` at a different GitHub account looks from in here — the only way this
    // deployment's identity can ever change.
    account: (u) => {
      state.account = u;
    },
    close: () => server.close(),
  };
}

interface Deployment {
  get: (path: string, init?: RequestInit) => Promise<Response>;
  calls: () => number;
  reply: (r: GhReply) => void;
  delay: (ms: number) => void;
  account: (u: { id: number; login: string }) => void;
  store: Store;
  close: () => void;
}

// A real Express app with the real middleware and a real store in front of `/v1/me` —
// the capability probe, and the cheapest route that requires the whole identity to have
// resolved. `token: null` builds the config a `validateConfig` refuses, to check what a
// deployment does when it was started some other way.
async function deploy(
  opts: { gate?: string; token?: string | null; breakStore?: string; sessions?: boolean } = {},
): Promise<Deployment> {
  __resetIdentity();
  const dir = mkdtempSync(join(tmpdir(), "iris-identity-"));
  const gh = await mockGitHub();
  const store = new Store(join(dir, "iris.sqlite"));
  // A store that cannot record the row. Replaced on the instance rather than by faking the
  // database, because what is under test is where the failure is REPORTED, and any throw
  // from this call reaches the same place.
  if (opts.breakStore !== undefined) {
    store.upsertUser = () => {
      throw new Error(opts.breakStore);
    };
  }
  const cfg = {
    github: {
      api_base_url: gh.base,
      upstream_repo: "https://github.com/example/iris",
      ...(opts.token === null ? {} : { token: opts.token ?? TOKEN }),
    },
    server: opts.gate === undefined ? {} : { api_token: opts.gate },
    defaults: { max_review_iterations: 3 },
    // Only read when `sessions` mounts the real router: `new Paths(cfg)` dereferences
    // storage, and `resolveImageLimits(cfg)` reads providers.
    storage: { data_dir: dir, agents_dir: dir, database: join(dir, "iris.sqlite") },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "m" } },
  } as unknown as IrisConfig;

  const app = express();
  app.use(makeAuthMiddleware(store, cfg));
  app.use("/v1/me", meRouter(cfg));
  // Off by default. Most tests here need the cheapest route that forces the identity to
  // resolve; only the repoint test needs a route that filters BY that identity.
  if (opts.sessions) app.use("/v1/sessions", sessionsRouter(cfg, store));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (path, init) => fetch(base + path, init),
    calls: gh.calls,
    reply: gh.reply,
    delay: gh.delay,
    account: gh.account,
    store,
    close: () => {
      server.close();
      gh.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bearer = (t: string): RequestInit => ({ headers: { authorization: `Bearer ${t}` } });

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

// Time as the middleware reads it. The failure backoff is 30 seconds, and a test that
// waited it out would be a test nobody runs — so `Date.now` moves instead of the clock.
// Only `Date.now` is replaced: the store timestamps rows through `new Date()`, which is
// left alone.
function withClock<T>(fn: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let now = realNow.call(Date);
  Date.now = () => now;
  return fn((ms) => {
    now += ms;
  }).finally(() => {
    Date.now = realNow;
  });
}

test("the deployment's identity is resolved once, however many requests arrive", async () => {
  const d = await deploy();
  try {
    for (let i = 0; i < 3; i++) {
      const res = await d.get("/v1/me");
      assert.equal(res.status, 200, `request ${i + 1} failed: ${await res.text()}`);
    }
    // One account, one lookup. Per-request lookups would work — every response is a 200 —
    // and would spend an outbound GitHub call on every read this service serves, which on
    // the polling path (a page polls a running session every 2.5s) is the whole rate limit.
    assert.equal(d.calls(), 1, "asked GitHub who the deployment is more than once");
    assert.ok(__identityResolved(), "the identity did not survive the request that resolved it");
  } finally {
    d.close();
  }
});

// The test above cannot see this one's failure, and that is the point of writing it
// separately: it awaits each request, so the second always finds the first finished. A cold
// start does not arrive in that order. `identity` is assigned after the await, so every
// request that lands while the first lookup is still in flight took the same branch and made
// its own call — eight requests, eight lookups, once per process, against a rate limit
// shared by everything else this deployment does with GitHub.
test("a burst at a cold start is one lookup, not one per request", async () => {
  const d = await deploy();
  try {
    // Long enough that all eight are demonstrably inside the window: the mock does not
    // answer the first until the last has been issued.
    d.delay(120);
    const results = await Promise.all(Array.from({ length: 8 }, () => d.get("/v1/me")));
    for (const [i, res] of results.entries()) {
      assert.equal(res.status, 200, `request ${i + 1} of the burst failed: ${await res.text()}`);
    }
    assert.equal(d.calls(), 1, `a burst of 8 at a cold start spent ${d.calls()} GitHub lookups`);
  } finally {
    d.close();
  }
});

// A write failure is not an authentication failure, and the difference is the whole value of
// the message. `upsertUser` used to sit inside the same `try` as `fetchUser`, so a store
// fault answered `401 could not authenticate to GitHub: <sqlite message>` — which is exactly
// the symptom `rejectLegacyUsersTable` names (src/store/db.ts) as the one that sends an
// operator to look at their token instead of their database. It also armed the 30-second
// GitHub backoff, which a store fault has no reason to wait out.
test("a store that cannot record the identity is not reported as GitHub refusing us", async () => {
  const detail = "SQLITE_READONLY: attempt to write a readonly database (/private/tmp/iris.sqlite)";
  const d = await deploy({ breakStore: detail });
  const logged: string[] = [];
  const realError = console.error;
  console.error = (m?: unknown) => void logged.push(String(m));
  try {
    const res = await d.get("/v1/me");
    assert.equal(res.status, 500, "a failed write answered as something other than a server fault");
    const err = await errorOf(res);
    assert.equal(err.code, "server_error");
    // The driver's text stays server-side. On an open deployment this response is public, and
    // a SQLite message carries the database's path.
    assert.doesNotMatch(err.message, /SQLITE|readonly|\/private\/tmp/i, `the 500 echoed the driver: ${err.message}`);
    assert.match(err.message, /record its own identity/i, "the 500 does not say what failed");
    assert.ok(
      logged.some((l) => l.includes(detail)),
      `the detail reached neither the caller nor the log: ${JSON.stringify(logged)}`,
    );

    // And a second request does not re-ask GitHub for an identity it already has, nor sit
    // out a backoff window it never earned.
    const again = await d.get("/v1/me");
    assert.equal(again.status, 500, "the second attempt changed answer");
    assert.equal((await errorOf(again)).code, "server_error", "the second attempt blamed the credential");
    assert.equal(d.calls(), 1, "a store failure sent us back to GitHub");
  } finally {
    console.error = realError;
    d.close();
  }
});

test("the body of /v1/me describes the deployment, not the caller", async () => {
  const d = await deploy();
  try {
    const body = (await (await d.get("/v1/me")).json()) as Record<string, unknown>;
    assert.equal(body.github_login, GH_USER.login);
    // The probe the page uses: a 200 here means this deployment can convert a document, so
    // it must run the same middleware an upload does rather than answer from config. That
    // it reports the deployment's own login is the part a reader of the page could
    // misunderstand as "who am I signed in as".
    assert.equal(body.upstream_repo, "https://github.com/example/iris");
  } finally {
    d.close();
  }
});

test("a credential GitHub refuses is asked about once, not once per request", async () => {
  const d = await deploy();
  try {
    d.reply(401);
    const first = await d.get("/v1/me");
    assert.equal(first.status, 401);
    const { code, message } = await errorOf(first);
    assert.equal(code, "unauthorized");
    // The caller is told the deployment failed, not that THEY did, and nothing about the
    // credential: it is the operator's token, and a stranger learning that this deployment
    // holds a broken PAT learns about its configuration.
    assert.match(message, /deployment could not authenticate/i);
    assert.doesNotMatch(message, /ghp_|github\.token/, "the 401 named the operator's credential to a stranger");

    for (let i = 0; i < 3; i++) assert.equal((await d.get("/v1/me")).status, 401);
    // A rejection that is not remembered costs one outbound call per request, which is the
    // shape that turns a bad PAT into a rate-limit ban on the account it belongs to.
    assert.equal(d.calls(), 1, "re-asked GitHub about a credential it had just refused");
    assert.equal(__identityResolved(), false, "a refused credential left an identity behind");
  } finally {
    d.close();
  }
});

test("a rejection expires, and serving a cached one does not push its expiry out", async () => {
  await withClock(async (advance) => {
    const d = await deploy();
    try {
      d.reply(500);
      assert.equal((await d.get("/v1/me")).status, 401);
      assert.equal(d.calls(), 1);

      // Inside the window: answered from the backoff, no second call.
      advance(10_000);
      assert.equal((await d.get("/v1/me")).status, 401);
      assert.equal(d.calls(), 1, "asked GitHub again inside the backoff window");

      // Past the ORIGINAL 30s, which the request above must not have extended. A cache that
      // renews its own window on a hit stays shut for as long as traffic keeps arriving —
      // and traffic is exactly what a poll produces — so a deployment whose credential was
      // fine all along never recovers while anybody is watching.
      advance(21_000);
      d.reply("user");
      const back = await d.get("/v1/me");
      assert.equal(back.status, 200, `never retried after the window: ${await back.text()}`);
      assert.equal(d.calls(), 2, "the retry did not happen when the window passed");

      // And having resolved, it stays resolved: the backoff is not a state the success has
      // to keep stepping over.
      assert.equal((await d.get("/v1/me")).status, 200);
      assert.equal(d.calls(), 2);
    } finally {
      d.close();
    }
  });
});

test("an open deployment serves a caller who presents nothing at all", async () => {
  const d = await deploy();
  try {
    // The premise of the whole collapse: with no `server.api_token` there is nothing for a
    // visitor to obtain, and `public/demo.html` holds no credential. If this ever becomes a
    // 401 the shipped page stops working with no other symptom.
    assert.equal((await d.get("/v1/me")).status, 200);
    // A caller who volunteers a bearer is not refused for it either — the header is simply
    // not consulted on an open deployment, so a client that kept one from an older build
    // keeps working.
    assert.equal((await d.get("/v1/me", bearer("left-over-from-an-old-build"))).status, 200);
  } finally {
    d.close();
  }
});

test("a gated deployment answers absent, malformed and wrong the same way", async () => {
  const d = await deploy({ gate: GATE });
  try {
    const refusals = [
      { name: "absent", init: undefined },
      { name: "malformed", init: { headers: { authorization: GATE } } },
      { name: "wrong scheme", init: { headers: { authorization: `Token ${GATE}` } } },
      { name: "wrong secret", init: bearer("not-the-secret") },
      { name: "empty bearer", init: { headers: { authorization: "Bearer " } } },
    ];
    const messages = new Set<string>();
    for (const { name, init } of refusals) {
      const res = await d.get("/v1/me", init as RequestInit);
      assert.equal(res.status, 401, `${name} was not refused`);
      const { code, message } = await errorOf(res);
      assert.equal(code, "unauthorized");
      messages.add(message);
    }
    // One message for all of them. A different answer for "malformed" than for "wrong"
    // tells a caller which half of their guess was right, and the only thing they are
    // entitled to learn is that this deployment is gated at all.
    assert.equal(messages.size, 1, `the refusals differ, which distinguishes them: ${[...messages].join(" | ")}`);
    assert.match([...messages][0], /requires a shared API token/i);

    // The gate is answered BEFORE GitHub is consulted. Otherwise every unauthorized
    // request costs the deployment an outbound `GET /user`, so a stranger who cannot use
    // the API at all can still spend its GitHub rate limit.
    assert.equal(d.calls(), 0, "consulted GitHub on behalf of a caller the gate had already refused");

    const ok = await d.get("/v1/me", bearer(GATE));
    assert.equal(ok.status, 200, `the right token was refused: ${await ok.text()}`);
    assert.equal(d.calls(), 1);
  } finally {
    d.close();
  }
});

test("the gate compares trimmed, at both ends", async () => {
  // `apiToken` trims what it reads from config, so a YAML value with trailing whitespace
  // must be the gate the operator thinks they set — not one only an untrimmed copy opens.
  const d = await deploy({ gate: `  ${GATE}  ` });
  try {
    assert.equal((await d.get("/v1/me", bearer(GATE))).status, 200, "the trimmed secret did not open its own gate");
    assert.equal((await d.get("/v1/me", bearer(`  ${GATE}  `))).status, 200, "a padded header was not trimmed");
  } finally {
    d.close();
  }
});

test("a whitespace-only gate is no gate, not an unopenable one", async () => {
  const d = await deploy({ gate: "   " });
  try {
    // The alternative is a deployment nobody can use and nothing to say why: the operator
    // set the key, so every refusal looks correct. `apiToken` returns undefined instead,
    // and the boot line says the deployment is open.
    assert.equal((await d.get("/v1/me")).status, 200, "a blank api_token locked the deployment");
  } finally {
    d.close();
  }
});

test("an unset github.token is the deployment's failure, not the caller's", async () => {
  const d = await deploy({ token: null });
  try {
    const res = await d.get("/v1/me");
    // 500 rather than 401: nothing the caller could send would help, and a 401 would send
    // whoever is holding the page looking for a credential that does not exist in this
    // design. `validateConfig` refuses this at boot, so reaching here means the config was
    // built in code — a test, or an embedder.
    assert.equal(res.status, 500);
    const { code, message } = await errorOf(res);
    assert.equal(code, "server_error");
    assert.match(message, /github\.token/, "the 500 did not name the key that is missing");
    assert.equal(d.calls(), 0, "tried to authenticate to GitHub with no credential");
  } finally {
    d.close();
  }
});

test("a config with no github.token is refused at startup, by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-cfg-"));
  try {
    // An unset `${IRIS_GITHUB_TOKEN}` expands to the empty string rather than dropping the
    // key (see `expandEnv`), so "present in the YAML" is not the test — a key that is there
    // and empty is exactly what an operator who forgot the variable produces.
    const base =
      `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}\n  database: ${join(dir, "iris.sqlite")}\n` +
      `providers:\n  default: openrouter\n  openrouter:\n    api_key: k\n    default_model: m\n` +
      `github:\n  upstream_repo: https://github.com/example/iris\n`;
    const empty = join(dir, "empty.yaml");
    writeFileSync(empty, `${base}  token: ""\n`);
    assert.throws(
      () => loadConfig(empty),
      (e: Error) =>
        /github\.token is not set/.test(e.message) &&
        // Fatal is only worth it if the message is the fix: which kind of token, what it
        // needs to be able to do, and where the example reads it from.
        /issues:write/.test(e.message) &&
        /IRIS_GITHUB_TOKEN/.test(e.message),
      "a deployment with no identity started anyway, and every request would 401",
    );

    // Sanity: the same config with the key set loads. Otherwise this passes for any config
    // at all and pins nothing about the token. A separate path — `loadConfig` memoizes per
    // resolved path.
    const set = join(dir, "set.yaml");
    writeFileSync(set, `${base}  token: ${TOKEN}\n`);
    assert.equal(githubToken(loadConfig(set)), TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("githubToken and apiToken agree on what 'set' means", () => {
  const cfgWith = (github: unknown, server: unknown): IrisConfig =>
    ({ github, server }) as unknown as IrisConfig;
  // One rule, in one place, because the middleware and the boot warning both read it: a
  // config the warning calls open and the middleware gates (or the reverse) is a deployment
  // whose log contradicts its behaviour.
  for (const [value, expected] of [
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    ["  padded  ", "padded"],
    ["plain", "plain"],
  ] as [string | undefined, string | undefined][]) {
    assert.equal(githubToken(cfgWith({ token: value }, {})), expected, `github.token ${JSON.stringify(value)}`);
    assert.equal(apiToken(cfgWith({}, { api_token: value })), expected, `server.api_token ${JSON.stringify(value)}`);
  }
});

test("the boot line says what one identity costs, and never prints the credential", () => {
  const open = identityWarning(TOKEN, false);
  const gated = identityWarning(TOKEN, true);
  assert.ok(open, "an open deployment got no boot line");
  assert.ok(gated, "a gated deployment got no boot line");
  for (const [name, line] of [["open", open], ["gated", gated]] as [string, string][]) {
    // A boot log gets pasted into issues.
    assert.doesNotMatch(line, /ghp_|QQ7734/, `${name}: the boot line printed the deployment's GitHub token`);
    // The three consequences an operator cannot see from outside: whose account owns the
    // work, whose name is on the issues, and what `GET /v1/sessions` therefore returns.
    assert.match(line, /every session is owned by that one account/i, `${name}: did not say who owns a session`);
    assert.match(line, /no attribution/i, `${name}: did not say contributors are not credited`);
    assert.match(line, /\/v1\/sessions/, `${name}: did not say what the session list now lists`);
  }
  // The halves differ where it matters: an open deployment is told it is reachable by
  // anyone AND told the remedy, and a gated one is told the demo page cannot be used
  // against it — which is otherwise discovered as a page that fails at upload.
  assert.match(open, /anyone who can reach this deployment/i);
  assert.match(open, /Set server\.api_token/);
  assert.match(gated, /demo page cannot be used/i);
  assert.doesNotMatch(gated, /anyone who can reach/i, "told a gated deployment it was open to the internet");

  // Nothing to say when there is no identity: `validateConfig` has already refused that
  // config, and a warning here would be the second voice on it. Whitespace is not this
  // function's problem — its caller passes `githubToken(cfg)`, which is where the one
  // definition of "set" lives (see the test above).
  assert.equal(identityWarning(undefined, false), undefined);
  assert.equal(identityWarning(githubToken({ github: { token: "   " } } as unknown as IrisConfig), false), undefined);
});

test("after a repoint the old account's session id no longer reaches its session", async () => {
  // The store-level test below shows the row survives. This one is about what an OPERATOR
  // meets, which is a route, and the difference matters: `docs/github-auth.md` tells them a
  // repoint costs them the LISTING, and the honest version is that the id stops working —
  // `ownedSession` gates every per-session route, so a session id they still hold answers
  // 404 rather than fetching the document it converted.
  //
  // One route is enough because all six go through that one function; six pins would be the
  // right answer only if there were six guards.
  const d = await deploy({ sessions: true });
  try {
    // Resolve the identity first, so the session is created as the account the deployment
    // is actually running as rather than as a number chosen here.
    const me = (await (await d.get("/v1/me")).json()) as { github_user_id: number };
    d.store.createSession({ session_id: "s-1", github_user_id: me.github_user_id, image_count: 1, iterations_max: 1 });
    assert.equal((await d.get("/v1/sessions/s-1")).status, 200, "the owning account could not read its own session");

    // The repoint. `__resetIdentity` is the restart: config does not hot-reload, so an
    // operator changing `github.token` always gets a fresh process.
    d.account({ id: 5150, login: "second-account" });
    __resetIdentity();
    const after = await d.get("/v1/sessions/s-1");
    assert.equal(after.status, 404, "a session from the old account was still reachable by id");
    assert.equal((await errorOf(after)).code, "session_not_found");

    // Back again, which is the remedy the docs give. Without this the 404 above could just
    // as well be a session the repoint destroyed.
    d.account(GH_USER);
    __resetIdentity();
    assert.equal((await d.get("/v1/sessions/s-1")).status, 200, "pointing the token back did not restore the session");
  } finally {
    d.close();
  }
});

test("pointing the deployment at a different GitHub account hides the old sessions without deleting them", () => {
  // `docs/github-auth.md` tells operators this, so it needs a check rather than an argument
  // from how `upsertUser` looks. Two accounts is not a per-user model coming back: it is one
  // deployment whose token was repointed, which is the ONLY way a second row appears —
  // `upsertUser` keys on `github_user_id` and nothing deletes a row.
  //
  // The reason to pin it is that the symptom reads as data loss. An operator who switches
  // accounts sees an empty `GET /v1/sessions` against a database that still has every row,
  // and the honest advice — point it back — is only true if the rows really are still there.
  const dir = mkdtempSync(join(tmpdir(), "iris-switch-"));
  try {
    const store = new Store(join(dir, "iris.sqlite"));
    const OLD = 4242;
    const NEW = 9999;
    store.upsertUser({ github_user_id: OLD, github_login: "first-account" });
    store.createSession({ session_id: "s-old", github_user_id: OLD, image_count: 1, iterations_max: 1 });

    // The switch. A rotation for the SAME account is the `upsertUser` above running twice and
    // is not this case, which is why the ids differ rather than the logins.
    store.upsertUser({ github_user_id: NEW, github_login: "second-account" });
    store.createSession({ session_id: "s-new", github_user_id: NEW, image_count: 1, iterations_max: 1 });

    assert.deepEqual(
      store.listSessions(NEW, { limit: 10 }).map((s) => s.session_id),
      ["s-new"],
      "the new account's session list showed a session it does not own",
    );
    // The claim that matters: hidden, not gone. Read through `getSession`, which does not
    // filter by account, so it can see a row `listSessions` will not return.
    assert.ok(store.getSession("s-old"), "switching accounts deleted the old account's session");
    assert.equal(store.getUser(OLD)?.github_login, "first-account", "the old account's row was removed");
    // And the advice in the docs works: pointing the config back lists them again.
    assert.deepEqual(
      store.listSessions(OLD, { limit: 10 }).map((s) => s.session_id),
      ["s-old"],
      "pointing the deployment back at the first account did not restore its session list",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
