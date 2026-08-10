import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { authorizeUrl, startDeviceFlow } from "../src/auth/github.ts";
import { loadConfig, type IrisConfig } from "../src/config.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authRouter } from "../src/routes/auth.ts";

// Iris requests NO OAuth scope, and this file pins that from both flows and from
// config.
//
// It is the reason the service authenticates as a GitHub App rather than an OAuth
// App. The token does two things — identify the caller (`GET /user`) and file issues
// on `upstream_repo` — and an OAuth App can only express the second as
// `public_repo`: an account-wide grant of read AND WRITE to every public repository
// the user can reach. Nothing here pushes or opens pull requests, so that consent
// screen asked for far more than the service uses, and no narrower OAuth scope
// exists. Under a GitHub App the permission comes from INSTALLING the app on
// `upstream_repo` (`issues: write`), so a user's authorization needs no repository
// access at all.
//
// A regression here is silent in the direction that matters: a `scope` parameter
// added back would be ignored by GitHub (an App takes permissions from the
// installation), so nothing would break at runtime — it would just quietly
// misrepresent what the service asks for, and would be the first step back toward an
// OAuth App. Both flows are driven end to end because the device flow is the default
// path and a parameter wired into only one of them would be easy to miss.

const scopeOf = (url: string) => new URL(url).searchParams.get("scope");

test("the web flow requests no scope, and keeps the rest of the request intact", () => {
  const url = authorizeUrl("cid", "https://iris.test/cb", "st8", "https://github.test");
  // `has` rather than `get`: an empty value also reads as "" from get(), so
  // asserting on the value alone would pass for `?scope=`.
  assert.equal(new URL(url).searchParams.has("scope"), false, "requested an OAuth scope");
  assert.equal(scopeOf(url), null);
  const p = new URL(url).searchParams;
  assert.equal(p.get("client_id"), "cid");
  assert.equal(p.get("redirect_uri"), "https://iris.test/cb");
  assert.equal(p.get("state"), "st8", "the CSRF state was dropped");
});

test("the device flow requests no scope either", async () => {
  // The device flow is the DEFAULT path (bundled app, no client secret), so a scope
  // reintroduced here would affect nearly every real authorization.
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
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal("scope" in bodies[0], false, "sent a scope in the device-flow body");
  assert.equal(bodies[0].client_id, "cid");
});

// --- the config side ---------------------------------------------------------
//
// `github.oauth_scope` is gone, along with the startup rejection of a scopeless
// deployment. Both existed to keep an OAuth App's grant at a floor that could file
// issues; a GitHub App has no such knob to get wrong. What remains worth pinning is
// that removing the key did not leave a landmine: a config carrying the OLD key must
// still start (an operator upgrading should not be broken by a setting that stopped
// mattering), and the bundled client_id must be the App's.

test("loadConfig: a config with a leftover oauth_scope still starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-scope-"));
  // A distinct filename per case, because loadConfig caches by resolved path.
  let n = 0;
  const write = (github: string) => {
    const p = join(dir, `cfg-${n++}.yaml`);
    writeFileSync(
      p,
      `server: { port: 3000, base_url: "http://localhost:3000" }\n` +
        `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}/agents\n  database: ${dir}/iris.sqlite\n` +
        `github:\n  client_id: cid\n${github}` +
        `providers:\n  default: openrouter\n  openrouter: { api_key: k, default_model: m }\n`,
    );
    return p;
  };
  try {
    // `none` used to be a startup ERROR, and `public_repo`/`repo` used to be
    // meaningful. All three are now simply ignored — an unknown key, not a fatal one.
    for (const leftover of ["  oauth_scope: none\n", "  oauth_scope: public_repo\n", "  oauth_scope: repo\n"]) {
      const cfg = loadConfig(write(leftover));
      assert.equal(
        (cfg.github as Record<string, unknown>).oauth_scope !== undefined,
        true,
        "the raw key is still parsed (harmlessly) — this only asserts loadConfig did not throw",
      );
    }
    // And the default config still starts, with no github block beyond client_id.
    assert.equal(loadConfig(write("")).github.client_id, "cid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bundled client_id is a GitHub App, not an OAuth App", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-cid-"));
  const p = join(dir, "cfg.yaml");
  writeFileSync(
    p,
    `server: { port: 3000, base_url: "http://localhost:3000" }\n` +
      `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}/agents\n  database: ${dir}/iris.sqlite\n` +
      `github:\n  client_id: ""\n` +
      `providers:\n  default: openrouter\n  openrouter: { api_key: k, default_model: m }\n`,
  );
  try {
    // GitHub App client ids start `Iv`, OAuth App ids `Ov`. Pinned as a prefix rather
    // than a whole value so rotating the app does not break this, while swapping back
    // to an OAuth App does — which is the change that would silently restore the
    // account-wide consent screen this whole design exists to avoid.
    assert.match(loadConfig(p).github.client_id, /^Iv/, "the bundled app is not a GitHub App");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the routes send no scope either -----------------------------------------
//
// The helpers above can be right while a route reintroduces a scope of its own, so
// both routes are driven through the real auth router against a stand-in GitHub.

// A config with only the fields the auth router reads.
function cfgFor(oauthBase: string): IrisConfig {
  return {
    server: { port: 0, base_url: "https://iris.test" },
    github: {
      client_id: "cid",
      client_secret: "secret",
      upstream_repo: "https://github.com/example/iris",
      api_base_url: oauthBase,
      oauth_base_url: oauthBase,
    },
  } as unknown as IrisConfig;
}

test("POST /auth/github/device sends no scope", async () => {
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
  app.use("/v1/auth", authRouter(cfgFor(ghBase)));
  const appServer = app.listen(0);
  await new Promise((r) => appServer.once("listening", r));
  const appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${appBase}/v1/auth/github/device`, { method: "POST" });
    assert.equal(res.status, 200, `device start failed: ${await res.text()}`);
    assert.equal("scope" in body, false, "the device route added a scope");
    assert.equal(body.client_id, "cid");
  } finally {
    ghServer.close();
    appServer.close();
  }
});

test("GET /auth/github/start redirects without a scope", async () => {
  const app = express();
  app.use("/v1/auth", authRouter(cfgFor("https://gh.test")));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/auth/github/start`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    assert.match(location, /^https:\/\/gh\.test\/login\/oauth\/authorize\?/);
    assert.equal(new URL(location).searchParams.has("scope"), false, "the web route added a scope");
    assert.match(location, /state=/, "the CSRF state was dropped");
  } finally {
    server.close();
  }
});
