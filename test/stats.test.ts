import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.ts";

// `GET /v1/stats` is a public celebration of how many document pages Iris has
// made accessible, which puts one unusual requirement on the number: it must not
// go DOWN. Everything below is about that, plus not leaking anything per-user
// through an unauthenticated endpoint.
//
// The failure mode these tests exist for is subtle. "Pages processed" reads like
// `SUM(image_count) WHERE status IN ('ready_for_review','closed')` — but a
// feedback re-run moves a finished session back to `queued`, so that number
// drops every time someone asks Iris to try again, and drops permanently if the
// re-run fails. Hence the write-once `first_completed_at` stamp.

const USER = 4242;
const OTHER = 99;

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-stats-"));
  try {
    fn(new Store(join(dir, "iris.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A session that ran to completion, the way the pipeline finishes one.
function complete(store: Store, id: string, pages: number, user = USER): void {
  store.createSession({ session_id: id, github_user_id: user, image_count: pages, iterations_max: 1 });
  store.updateSession(id, { status: "ready_for_review", phase: "done", iterations_completed: 1 });
}

test("nothing is counted before anything has been converted", () => {
  withStore((store) => {
    assert.deepEqual(store.publicStats(), { pages: 0, documents: 0, since: null });
    // An upload alone is not an accomplishment: the pages exist, the accessible
    // HTML does not.
    store.createSession({ session_id: "ses_a", github_user_id: USER, image_count: 12, iterations_max: 1 });
    assert.deepEqual(store.publicStats(), { pages: 0, documents: 0, since: null });
    // Nor is being mid-run.
    store.updateSession("ses_a", { status: "running", phase: "extraction" });
    assert.equal(store.publicStats().pages, 0);
  });
});

test("pages and documents are summed across users once a run completes", () => {
  withStore((store) => {
    complete(store, "ses_a", 3);
    complete(store, "ses_b", 10, OTHER);
    const s = store.publicStats();
    assert.equal(s.pages, 13, "pages is the sum of image_count over completed sessions");
    assert.equal(s.documents, 2);
    assert.ok(s.since, "since is stamped once something has completed");
  });
});

test("a failed run contributes nothing", () => {
  withStore((store) => {
    complete(store, "ses_ok", 4);
    store.createSession({ session_id: "ses_bad", github_user_id: USER, image_count: 50, iterations_max: 1 });
    store.updateSession("ses_bad", { status: "failed", error: "provider exploded" });
    assert.equal(store.publicStats().pages, 4, "a failed session delivered nothing to count");
    assert.equal(store.publicStats().documents, 1);
  });
});

test("the tally never goes down across a feedback re-run", () => {
  withStore((store) => {
    complete(store, "ses_a", 6);
    const before = store.publicStats();
    assert.equal(before.pages, 6);

    // What POST /v1/sessions/{id}/feedback does: claim the session back out of
    // ready_for_review. On a status-based count the public number would drop to 0
    // here, for as long as the re-run takes.
    assert.ok(store.claimSession("ses_a", "ready_for_review", { status: "queued", phase: "extraction", error: null }));
    assert.deepEqual(store.publicStats(), before, "the tally dipped while a re-run was in flight");

    // And it stays put if that re-run fails outright — the pages were still made
    // accessible once, and the user still has that output.
    store.updateSession("ses_a", { status: "failed", error: "re-run exploded" });
    assert.deepEqual(store.publicStats(), before, "the tally dropped when a re-run failed");
  });
});

test("re-running the same pages does not count them twice", () => {
  withStore((store) => {
    // The number is distinct page images made accessible, not model calls. Three
    // completions of one 6-page document are six pages, not eighteen.
    complete(store, "ses_a", 6);
    const first = store.publicStats().since;
    for (let i = 0; i < 3; i++) {
      store.updateSession("ses_a", { status: "queued", phase: "extraction" });
      store.updateSession("ses_a", { status: "ready_for_review", phase: "done" });
    }
    const s = store.publicStats();
    assert.equal(s.pages, 6);
    assert.equal(s.documents, 1);
    // COALESCE, not overwrite: `since` still reports the FIRST completion, so it
    // cannot creep forward as old sessions are re-run.
    assert.equal(s.since, first, "since moved when a completed session was re-run");
  });
});

test("closing a session keeps it counted", () => {
  withStore((store) => {
    complete(store, "ses_a", 5);
    assert.ok(store.claimSession("ses_a", "ready_for_review", { status: "closed" }));
    assert.equal(store.publicStats().pages, 5);
    assert.equal(store.publicStats().documents, 1);
  });
});

test("since is the earliest completion, not the latest", () => {
  withStore((store) => {
    complete(store, "ses_old", 1);
    const first = store.publicStats().since!;
    complete(store, "ses_new", 1);
    assert.equal(store.publicStats().since, first);
    assert.ok(first <= store.getSession("ses_new")!.first_completed_at!);
  });
});

test("the stamp is written by the store, not by the caller", () => {
  withStore((store) => {
    // The orchestrator only ever says "this session is ready_for_review"; nothing
    // in the codebase sets the stamp, which is what keeps it from being forgotten
    // on a future code path that finishes a run.
    complete(store, "ses_a", 2);
    const row = store.getSession("ses_a")!;
    assert.ok(row.first_completed_at, "reaching ready_for_review did not stamp the session");
    // And it round-trips as the ISO-8601 form everything else in the row uses.
    assert.equal(new Date(row.first_completed_at!).toISOString(), row.first_completed_at);
  });
});

test("an already-deployed database gains the column and backfills it", () => {
  // The half that actually breaks a deployment. `CREATE TABLE IF NOT EXISTS` is a
  // no-op once the table exists, so without the ALTER every write that stamps the
  // column fails with "no such column: first_completed_at" — meaning every run
  // would end `failed` at the moment it was about to succeed.
  const dir = mkdtempSync(join(tmpdir(), "iris-stats-mig-"));
  try {
    const path = join(dir, "old.sqlite");
    const seedStore = new Store(path);
    const raw = (seedStore as unknown as { db: { exec(s: string): void } }).db;
    // Rebuild the pre-change sessions table, rows and all, then reopen it.
    raw.exec(`
      CREATE TABLE sessions_old AS SELECT
        session_id, github_user_id, status, phase, iterations_completed,
        iterations_max, image_count, error, created_at, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_old RENAME TO sessions;
      INSERT INTO sessions (session_id, github_user_id, status, phase, iterations_completed,
        iterations_max, image_count, error, created_at, updated_at) VALUES
        ('ses_ready', ${USER}, 'ready_for_review', 'done', 1, 1, 7, NULL,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'),
        ('ses_closed', ${USER}, 'closed', 'done', 1, 1, 2, NULL,
         '2026-01-02T00:00:00.000Z', '2026-01-02T00:05:00.000Z'),
        ('ses_failed', ${USER}, 'failed', 'extraction', 0, 1, 99, 'boom',
         '2026-01-03T00:00:00.000Z', '2026-01-03T00:05:00.000Z');
    `);
    const cols = () =>
      (new Store(path) as unknown as { db: { prepare(s: string): { all(): { name: string }[] } } }).db
        .prepare(`PRAGMA table_info(sessions)`)
        .all()
        .map((c) => c.name);

    const reopened = new Store(path);
    assert.ok(cols().includes("first_completed_at"), "the column was not added");

    // Sessions that finished before the column existed are counted, using
    // updated_at as the completion time (the best available approximation, and
    // never earlier than the truth). The failed one stays out.
    const s = reopened.publicStats();
    assert.equal(s.pages, 9, "expected the 7-page and 2-page completions, not the failed 99");
    assert.equal(s.documents, 2);
    assert.equal(s.since, "2026-01-01T00:05:00.000Z");

    // And the migrated database still takes new writes, including the stamp.
    complete(reopened, "ses_new", 1);
    assert.equal(reopened.publicStats().pages, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats carry no per-session or per-user detail", () => {
  withStore((store) => {
    // The endpoint is unauthenticated, so the shape of this object is the security
    // boundary. If a field is added here, this assertion is what makes that a
    // deliberate decision rather than an accident.
    complete(store, "ses_a", 3);
    complete(store, "ses_b", 4, OTHER);
    assert.deepEqual(Object.keys(store.publicStats()).sort(), ["documents", "pages", "since"]);
  });
});
