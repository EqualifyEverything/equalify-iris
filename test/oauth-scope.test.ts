import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { authorizeUrl, startDeviceFlow, DEFAULT_OAUTH_SCOPE } from "../src/auth/github.ts";
import { normalizeScope, loadConfig, NO_OAUTH_SCOPE, type IrisConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authRouter } from "../src/routes/auth.ts";

// The OAuth scope decides what a stolen copy of `data/iris.sqlite` is worth: the
// tokens in it are plaintext and replayable, so `repo` would make read access to
// that file push access to every user's private repos. The service needs
// `public_repo` at most (identify the caller: no scope; file an issue on a public
// upstream: public_repo), and nothing at all when a service token files the issues.
//
// Two things are therefore load-bearing and both fail silently: the scope actually
// reaching GitHub in both flows, and an empty configured scope being sent as NO
// `scope` parameter rather than as `scope=` (the omission is the form GitHub
// documents for requesting no scopes).

const scopeOf = (url: string) => new URL(url).searchParams.get("scope");

test("the default scope is public_repo, not repo", () => {
  // Pinned as a value, not just as "whatever the constant says": the whole point
  // is that this is narrower than the `repo` the PRD originally specified, and a
  // future edit widening the constant should have to change this line.
  assert.equal(DEFAULT_OAUTH_SCOPE, "public_repo");
  assert.equal(scopeOf(authorizeUrl("cid", "https://iris.test/cb", "st8", "https://github.test")), "public_repo");
});

test("a configured scope reaches the consent screen", () => {
  const url = authorizeUrl("cid", "https://iris.test/cb", "st8", "https://github.test", "repo");
  assert.equal(scopeOf(url), "repo");
  // The rest of the request must survive being made conditional.
  const p = new URL(url).searchParams;
  assert.equal(p.get("client_id"), "cid");
  assert.equal(p.get("redirect_uri"), "https://iris.test/cb");
  assert.equal(p.get("state"), "st8", "the CSRF state was dropped");
});

// `""` is the NORMALIZED form, not a config spelling: an operator writes
// `oauth_scope: none` and normalizeScope maps it to "" for the helpers. See the
// normalizeScope tests below for why the config side cannot accept empty.
test("an empty scope omits the parameter instead of sending scope=", () => {
  const url = authorizeUrl("cid", "https://iris.test/cb", "st8", "https://github.test", "");
  // `has` rather than `get`: an empty value also reads as "" from get(), so
  // asserting on the value alone would pass for `?scope=` — the exact form this
  // must not produce.
  assert.equal(new URL(url).searchParams.has("scope"), false, "sent scope= for a deployment that asked for no scope");
  assert.equal(scopeOf(url), null);
  assert.match(url, /state=st8/, "the rest of the query survived");
});

test("the device flow sends the same scope, and omits it when empty", async () => {
  // The device flow is the DEFAULT path (bundled OAuth App, no client secret), so
  // a scope wired into only the web flow would leave nearly every real
  // authorization still granting the old wide scope.
  const bodies: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      json: async () => ({
        device_code: "dc",
        user_code: "UC-1234",
        verification_uri: "https://github.test/login/device",
        expires_in: 900,
        interval: 5,
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    await startDeviceFlow("cid", "https://github.test");
    await startDeviceFlow("cid", "https://github.test", "repo");
    await startDeviceFlow("cid", "https://github.test", "");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies[0].scope, "public_repo");
  assert.equal(bodies[1].scope, "repo");
  // Absent, not "" — GitHub is being asked for no scopes, and `"scope": ""` is not
  // a documented way to say that.
  assert.equal("scope" in bodies[2], false, "sent an empty scope key");
  assert.equal(bodies[2].client_id, "cid");
});

// --- normalizeScope: the config side ----------------------------------------
//
// "Request nothing" has to be a word, because empty cannot be trusted to mean it:
// `expandEnv` rewrites an unset `${VAR}` to `""` before normalizeScope runs, so a
// deliberate `oauth_scope: ""` and a mistyped or unset environment variable are
// the same value by then. Reading empty as "request nothing" would send no scope
// on a deployment that never asked for that, and the resulting 403 from issue
// filing is swallowed as a single log line.

test("every flavor of empty falls back to the default, including an unset ${VAR}", () => {
  assert.equal(normalizeScope(undefined), DEFAULT_OAUTH_SCOPE, "key absent");
  assert.equal(normalizeScope(null), DEFAULT_OAUTH_SCOPE, "`oauth_scope:` with no value parses as null");
  // The one that matters: expandEnv has already turned `${IRIS_SCOPE}` into "" by
  // the time this runs, and it is the form config.example.yaml's house style leads
  // an operator to write. Indistinguishable here from a quoted "", which is
  // exactly why neither can mean "request nothing".
  assert.equal(normalizeScope(""), DEFAULT_OAUTH_SCOPE, "an unset ${VAR} silently requested no scope");
  assert.equal(normalizeScope("   "), DEFAULT_OAUTH_SCOPE, "whitespace is the same mistake");
  // A non-string (`oauth_scope: 5`, or a nested block) is a config error; falling
  // back beats sending "5" or "[object Object]" as a scope.
  assert.equal(normalizeScope(42), DEFAULT_OAUTH_SCOPE);
  assert.equal(normalizeScope(["repo"]), DEFAULT_OAUTH_SCOPE);
});

test("`none` is the spelling that requests no scope", () => {
  // Maps to "" because that is what the helpers read as "omit the parameter" —
  // the word exists so the intent cannot be produced by an accident.
  assert.equal(normalizeScope("none"), "");
  assert.equal(normalizeScope(NO_OAUTH_SCOPE), "");
  assert.equal(normalizeScope("  none  "), "");
  // YAML parses `None`/`NONE` as strings, not as null, so they would otherwise be
  // sent to GitHub as literal scope values.
  assert.equal(normalizeScope("None"), "");
  assert.equal(normalizeScope("NONE"), "");
});

test("a configured scope is passed through, trimmed", () => {
  assert.equal(normalizeScope("repo"), "repo");
  assert.equal(normalizeScope("public_repo"), "public_repo");
  // YAML keeps surrounding spaces in a quoted value, and an untrimmed scope goes
  // into the query string verbatim — GitHub would see ` repo ` and reject it.
  assert.equal(normalizeScope("  repo  "), "repo");
  // Multi-scope values are a legitimate shape; nothing here should split them.
  assert.equal(normalizeScope("public_repo read:org"), "public_repo read:org");
});

// The bug the `none` spelling exists to prevent lived one layer above
// normalizeScope, in the order loadConfig does things: expandEnv rewrites
// `${VAR}` before any normalizer runs. Unit-testing normalizeScope with literals
// cannot see that, so this drives the real loadConfig over a real file.
test("loadConfig: an unset ${VAR} yields the default, and `none` survives expansion", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-scope-"));
  // A distinct filename per case, because loadConfig caches by resolved path:
  // reusing one name would hand back the previous case's parsed config and the
  // assertion would be checking nothing.
  let n = 0;
  const write = (scope: string) => {
    const p = join(dir, `cfg-${n++}.yaml`);
    writeFileSync(
      p,
      `server: { port: 3000, base_url: "http://localhost:3000" }\n` +
        `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}/agents\n  database: ${dir}/iris.sqlite\n` +
        `github:\n  client_id: cid\n  oauth_scope: ${scope}\n` +
        `providers:\n  default: openrouter\n  openrouter: { api_key: k, default_model: m }\n`,
    );
    return p;
  };
  const scopeIn = (path: string) => loadConfig(path).github.oauth_scope;
  try {
    delete process.env.IRIS_TEST_SCOPE;
    // The failure this replaced: `""` after expansion read as "request nothing".
    assert.equal(scopeIn(write("${IRIS_TEST_SCOPE}")), DEFAULT_OAUTH_SCOPE, "an unset ${VAR} requested no scope");
    assert.equal(scopeIn(write('""')), DEFAULT_OAUTH_SCOPE, "a quoted empty string is not distinguishable from the above");
    // `none` is a plain string, so expansion leaves it alone and the deliberate
    // intent still gets through.
    assert.equal(scopeIn(write("none")), "", "`none` did not reach normalizeScope intact");
    // And a set variable expands normally — the knob still works via env.
    process.env.IRIS_TEST_SCOPE = "repo";
    assert.equal(scopeIn(write("${IRIS_TEST_SCOPE} ")), "repo");
    process.env.IRIS_TEST_SCOPE = "none";
    assert.equal(scopeIn(write("${IRIS_TEST_SCOPE}  ")), "", "`none` via the environment");
  } finally {
    delete process.env.IRIS_TEST_SCOPE;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the routes actually pass the configured scope ---------------------------
//
// The two halves above can both be right while the config never reaches them: the
// route calls the helper, and the helper defaults to `public_repo`, so a route that
// forgets to pass `cfg.github.oauth_scope` looks correct in every default
// deployment AND in test/e2e.sh (whose config sets no scope). The only shape that
// catches it is a deployment configuring something OTHER than the default — the
// `repo` case an operator with a private upstream depends on, and the no-scope case
// that is the recommended production shape. These take the value POST-normalization
// (`""`, what `oauth_scope: none` becomes), since that is what a route reads off
// the config object.

// A config with only the fields the auth router reads.
function cfgWith(scope: string, oauthBase: string): IrisConfig {
  return {
    server: { port: 0, base_url: "https://iris.test" },
    github: {
      client_id: "cid",
      client_secret: "secret",
      upstream_repo: "https://github.com/example/iris",
      api_base_url: oauthBase,
      oauth_base_url: oauthBase,
      oauth_scope: scope,
    },
  } as unknown as IrisConfig;
}

// A stand-in GitHub that records the device-flow body, mounted with the real auth
// router so the assertion covers the route -> helper -> wire path.
async function deviceScopeFor(scope: string): Promise<Record<string, unknown>> {
  const gh = express();
  let body: Record<string, unknown> = {};
  gh.post("/login/device/code", express.json(), (req, res) => {
    body = req.body as Record<string, unknown>;
    res.json({ device_code: "dc", user_code: "UC-1", verification_uri: "https://gh.test/d", expires_in: 900, interval: 5 });
  });
  const ghServer = gh.listen(0);
  await new Promise((r) => ghServer.once("listening", r));
  const ghBase = `http://127.0.0.1:${(ghServer.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json());
  app.use("/v1/auth", authRouter(cfgWith(scope, ghBase)));
  const appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  const appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${appBase}/v1/auth/github/device`, { method: "POST" });
    assert.equal(res.status, 200, `device start failed: ${await res.text()}`);
    return body;
  } finally {
    ghServer.close();
    appServer.close();
  }
}

test("POST /auth/github/device sends the configured scope, not the default", async () => {
  // `repo` is deliberately not the default, so this fails if the route drops the
  // argument — which the e2e cannot detect, since its config omits the key.
  assert.equal((await deviceScopeFor("repo")).scope, "repo");
  assert.equal((await deviceScopeFor("public_repo")).scope, "public_repo");
  const empty = await deviceScopeFor("");
  assert.equal("scope" in empty, false, "an operator who configured no scope still had one requested");
});

test("GET /auth/github/start redirects with the configured scope", async () => {
  const app = express();
  app.use("/v1/auth", authRouter(cfgWith("repo", "https://gh.test")));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/auth/github/start`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/gh\.test\/login\/oauth\/authorize\?/);
    assert.equal(new URL(location).searchParams.get("scope"), "repo");
  } finally {
    server.close();
  }
});
