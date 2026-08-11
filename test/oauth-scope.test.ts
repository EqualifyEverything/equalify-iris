import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  authorizeUrl,
  exchangeCode,
  expiringTokenWarning,
  pollDeviceFlow,
  startDeviceFlow,
} from "../src/auth/github.ts";
import { clientIdWarning, loadConfig, type IrisConfig } from "../src/config.ts";
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

// --- the one registration setting this flow can diagnose ----------------------
//
// "Enable Device Flow" is OFF for a newly registered GitHub App, and the device flow
// is the default deployment's ONLY login path — so this is the first thing wrong with
// a fresh app, and the string `device_flow_disabled` is the only place it is named.
// It arrives in the response BODY, which the route turns into the operator's error
// message. Dropping it leaves "device flow start failed: 400", which is unguessable.

test("a disabled device flow reaches the operator by name", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "device_flow_disabled",
        error_description: "Device flow is not enabled for this app.",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )) as unknown as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => startDeviceFlow("cid", "https://github.test"),
      (e: Error) => {
        assert.match(e.message, /device flow is not enabled/i, "GitHub's explanation was discarded");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an error delivered with a 200 is still an error", async () => {
  // GitHub's OAuth endpoints answer some errors at HTTP 200 with the failure in the
  // body. A status-only check read that as success and returned a DeviceCodeResponse
  // of undefineds, so the route replied 200 with `device_code: null` — a client then
  // polls forever against a flow that never started, which is worse than a 502.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "device_flow_disabled" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => startDeviceFlow("cid", "https://github.test"),
      (e: Error) => {
        assert.match(e.message, /device_flow_disabled/, "a 200 with an error body was reported as success");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an unparseable body does not mask the failure", async () => {
  // An HTML error page from a proxy, or an empty body. The status is all there is;
  // the point is that reading the body cannot itself throw and lose it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => startDeviceFlow("cid", "https://github.test"),
      (e: Error) => {
        assert.match(e.message, /502/, "the status was lost while parsing the body");
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- the other registration setting, on BOTH flows ----------------------------
//
// "Expire user authorization tokens" must be OFF. Nothing here persists or refreshes
// a credential, so with it on every user is logged out mid-use and their requests 401
// eight hours after a login that worked — the least guessable symptom this service
// has, and hours from its cause. The token itself is valid, so there is no failure to
// hang the diagnosis on: the only moment it can be caught is when GitHub hands over
// an `expires_in`, in whichever flow did the handing.
//
// Which is why both flows are pinned. The device flow had this warning and the web
// flow did not, which is worse than neither having it: the gap is invisible until a
// web-flow deployment hits the exact case the other flow diagnoses.

test("both login flows carry an expiry out of GitHub's response", async () => {
  const realFetch = globalThis.fetch;
  const withExpiry = (async () =>
    new Response(JSON.stringify({ access_token: "ghu_t", token_type: "bearer", expires_in: 28800 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  try {
    globalThis.fetch = withExpiry;
    const exchanged = await exchangeCode("cid", "secret", "code", "https://iris.test/cb", "https://github.test");
    assert.equal(exchanged.expires_in, 28800, "the web flow dropped the expiry");
    const polled = await pollDeviceFlow("cid", "dc", "https://github.test");
    assert.equal(polled.status === "approved" && polled.expires_in, 28800, "the device flow dropped the expiry");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a token with no expiry warns about nothing", async () => {
  // The correct registration, which is also the bundled app's: GitHub omits
  // `expires_in` entirely. A warning here would fire on every login of every healthy
  // deployment, which is how a warning stops being read.
  assert.equal(expiringTokenWarning(undefined), undefined);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: "ghu_t", token_type: "bearer" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
  try {
    const exchanged = await exchangeCode("cid", "secret", "code", "https://iris.test/cb", "https://github.test");
    assert.equal(exchanged.expires_in, undefined);
    assert.equal(expiringTokenWarning(exchanged.expires_in), undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the expiry warning names the setting to change", () => {
  // An operator reading this has a working login and a 401 hours later, and the fix
  // is a checkbox they have probably never seen. Naming it by its exact label is most
  // of the value; a bare "token expired" would send them looking at Iris.
  const w = String(expiringTokenWarning(28800));
  assert.match(w, /28800/, "did not say how long the token lasts");
  assert.match(w, /Expire user authorization tokens/, "did not name the setting by its label");
  assert.match(w, /401/, "did not connect it to the symptom the operator will see");
  // Zero is a real value and must not read as "no expiry" — `if (expiresIn)` would
  // drop it, which is the falsy-zero trap this codebase's normalizers keep hitting.
  assert.match(String(expiringTokenWarning(0)), /Expire user authorization tokens/);
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

// --- an operator's OWN client_id ----------------------------------------------
//
// The bundled id above is the one value that cannot be wrong. A CONFIGURED one can,
// and in exactly the way the deleted `oauth_scope` floor existed to prevent: point
// `client_id` at an OAuth App and this code requests no scope (it has none left to
// send), so tokens identify users, `GET /user` works, every request answers 200, and
// issue filing 403s once per run forever. Nothing at runtime recovers from it, and the
// deployment looks healthy. So the shape of the credential is checked at boot.

function cfgWithClientId(dir: string, clientId: string): string {
  const p = join(dir, `cfg-${clientId || "empty"}.yaml`);
  writeFileSync(
    p,
    `server: { port: 3000, base_url: "http://localhost:3000" }\n` +
      `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}/agents\n  database: ${dir}/iris.sqlite\n` +
      `github:\n  client_id: "${clientId}"\n` +
      `providers:\n  default: openrouter\n  openrouter: { api_key: k, default_model: m }\n`,
  );
  return p;
}

test("loadConfig rejects an OAuth App client_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-ov-"));
  try {
    // `Ov` is an OAuth App on github.com and nothing else, so this case is
    // unambiguous enough to refuse rather than warn about.
    assert.throws(
      () => loadConfig(cfgWithClientId(dir, "Ov23liGG4MfEn0DM4vTA")),
      (e: Error) => {
        assert.match(e.message, /OAuth App/, "the error did not say what was wrong with the id");
        assert.match(e.message, /GitHub App/, "the error did not say what is needed instead");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig accepts an unrecognized client_id, and warns", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-ghes-"));
  try {
    // GitHub Enterprise Server mints its own id formats and pre-2022 OAuth Apps used
    // bare hex, so an unrecognized prefix must NOT be fatal — refusing here would
    // break a deployment that works. The warning is the whole diagnosis in that case.
    const cfg = loadConfig(cfgWithClientId(dir, "abc123def456"));
    assert.equal(cfg.github.client_id, "abc123def456");
    assert.match(String(clientIdWarning("abc123def456")), /GitHub App/);
    assert.match(String(clientIdWarning("abc123def456")), /filing/i, "the warning did not name the consequence");
    // A GitHub App id is the expected case and must stay quiet, or the warning
    // becomes noise every operator learns to ignore.
    assert.equal(clientIdWarning("Iv23liv73tlbX0VfoEkr"), undefined);
    // Empty means "fall back to the bundled app", which loadConfig does before this
    // runs — warning there would fire on the default deployment.
    assert.equal(clientIdWarning(""), undefined);
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
