import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store/db.ts";
import { makeAuthMiddleware, __clearTokenCache } from "../src/auth/middleware.ts";
import { meRouter } from "../src/routes/me.ts";
import type { IrisConfig } from "../src/config.ts";

// The user's GitHub token is a live credential and it is never persisted.
// It arrives in the `Authorization` header, is held in memory for the run it
// authorizes, and is gone when that run ends.
//
// This is asserted against the DATABASE FILE, not against the schema or the record
// type, because those are the two things a well-meaning change edits without meaning
// to reintroduce the exposure — an added column, a JSON blob of "profile", a debug
// field on a session row. The claim documented in the README is about what a stolen
// copy of `data/iris.sqlite` is worth, so that file is what gets searched. WAL matters
// here: a row written moments ago may live in `iris.sqlite-wal` rather than in the main
// file, so both are read.
//
// The token is deliberately a string that could not appear by coincidence.
const TOKEN = "gho_never_persist_ZZQQ7734";
const GH_USER = { id: 4242, login: "iris-tester" };

// A GitHub whose only job is to identify the caller — the one call a valid token
// makes on an authenticated request.
async function mockGitHub(): Promise<{ base: string; close: () => void; calls: number }> {
  const app = express();
  const state = { calls: 0 };
  app.get("/user", (req, res) => {
    state.calls++;
    if (req.header("authorization") !== `Bearer ${TOKEN}`) {
      res.status(401).json({ message: "Bad credentials" });
      return;
    }
    res.json(GH_USER);
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
    get calls() {
      return state.calls;
    },
  };
}

function cfgFor(apiBase: string): IrisConfig {
  return {
    github: { api_base_url: apiBase, upstream_repo: "https://github.com/example/iris" },
    defaults: { max_review_iterations: 3 },
  } as unknown as IrisConfig;
}

// Drive a real authenticated request through the real middleware and the real store,
// then hand back both the response body and the raw bytes of everything on disk.
async function authenticatedRequest(): Promise<{ body: Record<string, unknown>; dbBytes: string }> {
  __clearTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "iris-token-"));
  const gh = await mockGitHub();
  const dbPath = join(dir, "iris.sqlite");
  const store = new Store(dbPath);
  const cfg = cfgFor(gh.base);

  const app = express();
  app.use(makeAuthMiddleware(store, cfg));
  app.use("/v1/me", meRouter(cfg));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    // Read the body ONCE, before asserting on the status: a failed assertion that
    // needs the text would otherwise consume it and the `.json()` below throws
    // "Body is unusable", masking the real failure with a plumbing error.
    const text = await res.text();
    assert.equal(res.status, 200, `authentication failed: ${text}`);
    const body = JSON.parse(text) as Record<string, unknown>;
    // Read the WAL too: the INSERT is recent, so it may not have been checkpointed
    // into the main file yet, and reading only that file would pass vacuously.
    let dbBytes = readFileSync(dbPath, "latin1");
    for (const suffix of ["-wal", "-shm"]) {
      try {
        dbBytes += readFileSync(dbPath + suffix, "latin1");
      } catch {
        // Absent depending on journal mode and checkpoint timing — not a failure.
      }
    }
    return { body, dbBytes };
  } finally {
    server.close();
    gh.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an authenticated request writes no copy of the token to disk", async () => {
  const { dbBytes } = await authenticatedRequest();
  // Sanity first: the request really did provision the user, so a pass below means
  // "the token is absent from a populated database" and not "the database is empty".
  assert.ok(dbBytes.includes(GH_USER.login), "the user was never written — this test would pass vacuously");
  assert.equal(
    dbBytes.includes(TOKEN),
    false,
    "the user's GitHub token was persisted: a copy of the database is now GitHub access as every user who has logged in",
  );
  // A prefix search as well, in case something stores a truncated or transformed
  // form — enough of the token to be replayable is still too much.
  assert.doesNotMatch(dbBytes, /gho_never_persist/, "a fragment of the token reached the database file");
});

test("the users table has no token column at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-schema-"));
  try {
    const store = new Store(join(dir, "iris.sqlite"));
    store.upsertUser({ github_user_id: GH_USER.id, github_login: GH_USER.login });
    const user = store.getUser(GH_USER.id)!;
    // The record shape is the contract the rest of the service reads, so an added
    // credential field would show up here before it showed up in a leak.
    assert.deepEqual(
      Object.keys(user).sort(),
      ["created_at", "github_login", "github_user_id", "max_review_iterations"],
      "the user record grew or lost a field — if a token-shaped one was added, see the test above",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /v1/me returns no fork_repo", async () => {
  const { body } = await authenticatedRequest();
  // Dropped rather than returned as a permanent `null`: nothing forks and nothing
  // pushes, so the field only ever documented an unbuilt feature.
  assert.equal("fork_repo" in body, false, "reintroduced fork_repo, which can only ever be null");
  assert.deepEqual(Object.keys(body).sort(), [
    "defaults",
    "github_login",
    "github_user_id",
    "upstream_repo",
  ]);
  assert.equal(body.github_login, GH_USER.login);
});

// A database created before the token column was removed is a LEFTOVER, not a
// deployment to upgrade — there is no migration, by decision. But the check has to
// exist, because `CREATE TABLE IF NOT EXISTS` silently keeps the old table, and the
// resulting failure points away from its cause: `upsertUser` throws
// `NOT NULL constraint failed: users.github_token`, the auth middleware catches it,
// and a first-time login gets `401 unauthorized` with a SQLite message in the body
// while anyone who already has a row keeps working.
test("a pre-existing database with a token column is refused at startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-legacy-"));
  const dbPath = join(dir, "iris.sqlite");
  try {
    // Build the old schema by hand — the shape this branch removed. `sessions` and
    // the old two-column index are included because the refusal has to leave them
    // alone: the constructor's DDL drops `idx_sessions_user` and creates the compound
    // replacement, so a check that ran after it would modify a file it then declines.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        github_user_id INTEGER PRIMARY KEY,
        github_login TEXT NOT NULL,
        github_token TEXT NOT NULL,
        fork_repo TEXT,
        max_review_iterations INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        iterations_completed INTEGER NOT NULL DEFAULT 0,
        iterations_max INTEGER NOT NULL DEFAULT 3,
        image_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_user ON sessions(github_user_id, created_at DESC);
    `);
    legacy.prepare(`INSERT INTO users VALUES (?, ?, ?, NULL, 3, ?)`).run(1, "old-user", TOKEN, "2026-01-01T00:00:00.000Z");
    legacy.close();

    // Read the schema through a separate connection so the snapshot cannot be an
    // artifact of the one under test.
    const schemaOf = (p: string): { objects: string[]; mode: string } => {
      const probe = new DatabaseSync(p, { readOnly: true });
      try {
        return {
          objects: (
            probe
              .prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)
              .all() as { name: string }[]
          ).map((r) => r.name),
          mode: String((probe.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode),
        };
      } finally {
        probe.close();
      }
    };
    const before = schemaOf(dbPath);

    assert.throws(
      () => new Store(dbPath),
      (e: Error) =>
        /older version of Iris/.test(e.message) &&
        /github_token/.test(e.message) &&
        // The message must name the fix and say why archiving is not it, since the
        // file still holds live plaintext credentials.
        /[Dd]elete the database/.test(e.message) &&
        /plaintext/.test(e.message),
      "an older database was adopted silently — new logins would 401 with a SQL error",
    );

    // Refusing to adopt a file and modifying it anyway cannot both be true. The
    // throw alone does not pin that: the check used to be the constructor's LAST
    // statement, so this same assertion passed while the DDL had already dropped
    // `idx_sessions_user`, created `idx_sessions_user_page` and converted the file to
    // WAL. That breaks the recovery the error message advises — rolling back to the
    // previous build to export session history before deleting the file, whose
    // `listSessions` pages on the index that is now gone.
    assert.deepEqual(
      schemaOf(dbPath),
      before,
      "the refused database was modified before being refused (index or journal_mode changed)",
    );
    assert.ok(before.objects.includes("idx_sessions_user"), "the fixture lost the index this pins");
    assert.equal(before.mode, "delete", "the fixture was already WAL, so the mode assertion proves nothing");

    // Sanity: the same file, minus the offending columns, opens fine. Otherwise this
    // test would pass for any database at all and prove nothing about the columns.
    rmSync(dbPath, { force: true });
    const fresh = new DatabaseSync(dbPath);
    fresh.exec(`
      CREATE TABLE users (
        github_user_id INTEGER PRIMARY KEY,
        github_login TEXT NOT NULL,
        max_review_iterations INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL
      );
    `);
    fresh.close();
    const store = new Store(dbPath);
    assert.equal(store.getUser(1), undefined, "the current schema failed to open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
