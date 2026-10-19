import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrisConfig } from "../src/config.ts";
import { sessionsRouter } from "../src/routes/sessions.ts";
import { Store, type SessionStatus } from "../src/store/db.ts";
import { Paths } from "../src/store/paths.ts";
import { pruneSessions, retentionDays, scheduleRetention } from "../src/store/retention.ts";

// The UIC data volume filled on 2026-10-19 because no session was ever deleted. These pin
// what the retention rule deletes, what it keeps, and what a caller sees afterwards.

const DAY = 86_400_000;

function setup(retention?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "iris-retention-"));
  const config: IrisConfig = {
    server: { port: 3000, base_url: "http://localhost:3000" },
    storage: { data_dir: dir, agents_dir: "agents", database: join(dir, "iris.sqlite"), session_retention_days: retention as number },
    providers: { default: "openrouter", openrouter: { api_key: "k", default_model: "m" } },
    defaults: { max_review_iterations: 1, extraction_concurrency: 1, max_concurrent_runs: 1, recheck_sample_size: 0 },
  };
  const store = new Store(config.storage.database);
  const paths = new Paths(config);
  const make = (id: string, status: SessionStatus) => {
    store.createSession({ session_id: id, image_count: 1, iterations_max: 1 });
    store.updateSession(id, { status });
    paths.initSession(id);
    writeFileSync(paths.sessionOutput(id), "<p>x</p>");
    writeFileSync(paths.sessionLog(id), "{}\n");
    mkdirSync(paths.tmpDir(id), { recursive: true });
  };
  return { config, store, paths, make };
}

test("retention is off unless session_retention_days is a positive number", () => {
  for (const v of [undefined, "", 0, -3, "abc"]) assert.equal(retentionDays(setup(v).config), null, String(v));
  assert.equal(retentionDays(setup(30).config), 30);
  // An env-expanded value arrives as a string.
  assert.equal(retentionDays(setup("30").config), 30);
});

test("only finished sessions older than the cutoff lose their files; the rows stay", async () => {
  const { store, paths, make } = setup(30);
  for (const st of ["ready_for_review", "closed", "failed", "queued", "running"] as const) make(st, st);
  const before = store.publicStats();

  // Every session is a few ms old: nothing is 30 days old yet.
  assert.equal(await pruneSessions(store, paths, 30), 0);

  const later = Date.now() + 31 * DAY;
  assert.equal(await pruneSessions(store, paths, 30, later), 3);
  for (const st of ["ready_for_review", "closed", "failed"]) {
    assert.equal(existsSync(paths.sessionDir(st)), false, st);
    assert.ok(store.getSession(st)?.files_deleted_at, st);
    assert.equal(existsSync(paths.tmpDir(st)), false, st);
  }
  for (const st of ["queued", "running"]) {
    assert.equal(existsSync(paths.sessionOutput(st)), true, st);
    assert.equal(store.getSession(st)?.files_deleted_at, null, st);
  }
  assert.deepEqual(store.publicStats(), before);
  // Already expired: not picked twice.
  assert.equal(await pruneSessions(store, paths, 30, later), 0);
});

test("an expired session's file routes answer 410 session_expired, and GET says when", async () => {
  const { config, store, paths, make } = setup(30);
  make("ses_old", "ready_for_review");
  await pruneSessions(store, paths, 30, Date.now() + 31 * DAY);

  const app = express();
  app.use(express.json());
  app.use("/v1/sessions", sessionsRouter(config, store));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions/ses_old`;
  try {
    const meta = (await (await fetch(base)).json()) as { expired_at?: string };
    assert.ok(meta.expired_at);
    const calls: [string, string][] = [
      ["GET", "/output"],
      ["GET", "/logs"],
      ["GET", "/diagnostics"],
      ["GET", "/fields"],
      ["POST", "/pdf"],
      ["POST", "/feedback"],
      ["POST", "/close"],
    ];
    for (const [method, path] of calls) {
      const r = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ feedback: "f" }) : undefined,
      });
      assert.equal(r.status, 410, path);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "session_expired", path);
    }
  } finally {
    server.close();
  }
});

test("a folder whose delete failed is retried on the next sweep", async () => {
  const { store, paths, make } = setup(30);
  make("ses_stuck", "closed");
  const later = Date.now() + 31 * DAY;
  await pruneSessions(store, paths, 30, later);
  // As if the delete had failed: the row is marked and the folder is still there.
  paths.initSession("ses_stuck");
  writeFileSync(paths.sessionOutput("ses_stuck"), "<p>x</p>");
  assert.equal(await pruneSessions(store, paths, 30, later), 0, "a retry is not a new expiry");
  assert.equal(existsSync(paths.sessionDir("ses_stuck")), false);
  // The same when only tmp/<id> is left.
  mkdirSync(paths.tmpDir("ses_stuck"), { recursive: true });
  await pruneSessions(store, paths, 30, later);
  assert.equal(existsSync(paths.tmpDir("ses_stuck")), false);
});

test("a failed sweep is logged, not thrown", async () => {
  const { config, store, paths } = setup(30);
  store.expireSessions = () => {
    throw new Error("disk I/O error");
  };
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (m: string) => void seen.push(m);
  try {
    scheduleRetention(config, store, paths);
    await new Promise((r) => setImmediate(r));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, ["retention: sweep failed: disk I/O error"]);
});

test("the server schedules retention at startup", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /\nscheduleRetention\(cfg, store, new Paths\(cfg\)\);\n/);
});
