import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.ts";

// An early build stored a GitHub token per user. Iris stores none now, and a database from
// that build still holds them in plaintext, so the store refuses it rather than adopting it.

const TOKEN = "gho_never_persist_ZZQQ7734";

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
      "an older database holding plaintext tokens was adopted silently",
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
    new Store(dbPath);
    assert.ok(!schemaOf(dbPath).objects.includes("users"), "a users table without tokens is dropped, not refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
