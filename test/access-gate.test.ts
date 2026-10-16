import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { makeAuthMiddleware } from "../src/auth/middleware.ts";
import { meRouter } from "../src/routes/me.ts";
import { accessWarning, loadConfig } from "../src/config.ts";
import type { IrisConfig } from "../src/config.ts";

// Every session belongs to the deployment (#540). Iris asks no one who a caller is. The
// one question left is whether a caller may use the API: `server.api_token`, optional.
// Absent, the deployment is open, which is what makes the demo page work.

const GATE = "s3cret";

interface Deployment {
  get: (path: string, init?: RequestInit) => Promise<Response>;
  // Calls this process made to anywhere but itself. Iris has no identity to look up, so
  // the count is always 0; a lookup that crept back would show here first.
  outbound: () => number;
  close: () => void;
}

// A real Express app with the real middleware in front of `/v1/me`, the capability probe.
async function deploy(opts: { gate?: string; maxIter?: number } = {}): Promise<Deployment> {
  const cfg = {
    server: opts.gate === undefined ? {} : { api_token: opts.gate },
    defaults: { max_review_iterations: opts.maxIter ?? 3 },
  } as unknown as IrisConfig;
  const app = express();
  app.use(makeAuthMiddleware(cfg));
  app.use("/v1/me", meRouter(cfg));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input instanceof Request ? input.url : input).startsWith(base)) outbound++;
    return realFetch(input, init);
  }) as typeof fetch;
  return {
    get: (path, init) => fetch(base + path, init),
    outbound: () => outbound,
    close: () => {
      globalThis.fetch = realFetch;
      server.close();
    },
  };
}

const bearer = (t: string): RequestInit => ({ headers: { authorization: `Bearer ${t}` } });

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

test("an open deployment serves a caller who presents nothing at all, and asks no one", async () => {
  const d = await deploy();
  try {
    // `public/demo.html` holds no credential. If this ever becomes a 401 the shipped page
    // stops working with no other symptom.
    assert.equal((await d.get("/v1/me")).status, 200);
    // A bearer from an older client is not refused: the header is not consulted here.
    assert.equal((await d.get("/v1/me", bearer("left-over-from-an-old-build"))).status, 200);
    assert.equal(d.outbound(), 0, "a request made an outbound call");
  } finally {
    d.close();
  }
});

test("the body of /v1/me is the deployment's defaults, and names no account", async () => {
  const d = await deploy({ maxIter: 5 });
  try {
    const body = await (await d.get("/v1/me")).json();
    assert.deepEqual(body, { defaults: { max_review_iterations: 5 } });
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
    // tells a caller which half of their guess was right.
    assert.equal(messages.size, 1, `the refusals differ, which distinguishes them: ${[...messages].join(" | ")}`);
    assert.match([...messages][0], /requires a shared API token/i);

    const ok = await d.get("/v1/me", bearer(GATE));
    assert.equal(ok.status, 200, `the right token was refused: ${await ok.text()}`);
    assert.equal(d.outbound(), 0);
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
    assert.equal((await d.get("/v1/me")).status, 200, "a blank api_token locked the deployment");
  } finally {
    d.close();
  }
});

test("a config that still has a github block loads, with its variable unset", () => {
  // Every deployment from before #540 has one. Refusing it would take a working
  // deployment down on upgrade for a key that no longer does anything.
  const dir = mkdtempSync(join(tmpdir(), "iris-cfg-"));
  try {
    delete process.env.IRIS_GITHUB_TOKEN;
    const path = join(dir, "old.yaml");
    writeFileSync(
      path,
      `storage:\n  data_dir: ${dir}\n  agents_dir: ${dir}\n  database: ${join(dir, "iris.sqlite")}\n` +
        `providers:\n  default: openrouter\n  openrouter:\n    api_key: k\n    default_model: m\n` +
        `github:\n  token: \${IRIS_GITHUB_TOKEN}\n  api_base_url: https://api.github.com\n`,
    );
    assert.equal(loadConfig(path).providers.default, "openrouter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the boot line says who can use the deployment", () => {
  const open = accessWarning(false);
  const gated = accessWarning(true);
  for (const line of [open, gated]) {
    assert.match(line, /every session belongs to this deployment/i);
    assert.match(line, /\/v1\/sessions/);
    assert.doesNotMatch(line, /github/i);
  }
  // An open deployment is told it is reachable by anyone AND told the remedy. A gated one
  // is told the demo page cannot be used against it, which is otherwise discovered as a
  // page that fails at upload.
  assert.match(open, /anyone who can reach this deployment/i);
  assert.match(open, /Set server\.api_token/);
  assert.match(gated, /demo page cannot be used/i);
  assert.doesNotMatch(gated, /anyone who can reach/i, "told a gated deployment it was open to the internet");
});
