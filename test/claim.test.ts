import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.ts";

// `claimSession` is the lock behind the endpoints that start work on a session:
// `POST /:id/feedback` (which enqueues a pipeline) and `POST /:id/close` (which
// files regression fixtures into the shared agent library and deletes the tmp
// tree). Both used to read the status, check it, then write — safe today only
// because both handlers are fully synchronous.
//
// The property under test is that the check and the write cannot come apart:
// whatever happens between two callers, at most one of them is told it won. That
// is what lets a handler treat "claim returned true" as permission to do
// non-idempotent work.

const USER = 4242;

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-claim-"));
  try {
    fn(new Store(join(dir, "iris.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A session parked in `ready_for_review` — the state both endpoints claim from.
function ready(store: Store, id = "ses_1"): string {
  store.createSession({ session_id: id, github_user_id: USER, image_count: 1, iterations_max: 3 });
  store.updateSession(id, { status: "ready_for_review" });
  return id;
}

test("a claim from the expected status wins and applies the patch", () => {
  withStore((store) => {
    const id = ready(store);
    assert.equal(store.claimSession(id, "ready_for_review", { status: "queued", phase: "triage" }), true);
    const s = store.getSession(id)!;
    assert.equal(s.status, "queued");
    assert.equal(s.phase, "triage");
  });
});

test("only the first of two claims wins", () => {
  withStore((store) => {
    const id = ready(store);
    // The second call is what a concurrent caller does after the first one has
    // landed — the interleaving that matters, without needing real concurrency:
    // the guard is the WHERE clause, so a serialized second attempt exercises it
    // exactly as a raced one does.
    const first = store.claimSession(id, "ready_for_review", { status: "queued", phase: "triage" });
    const second = store.claimSession(id, "ready_for_review", { status: "queued", phase: "triage" });
    assert.equal(first, true);
    assert.equal(second, false, "two callers both got permission to start a run");
  });
});

test("a losing claim leaves the winner's state untouched", () => {
  withStore((store) => {
    const id = ready(store);
    assert.equal(store.claimSession(id, "ready_for_review", { status: "closed" }), true);
    // A close and a feedback re-run racing: the re-run must not resurrect a
    // closed session into `queued`, which would enqueue a pipeline writing over
    // an accepted output.
    assert.equal(store.claimSession(id, "ready_for_review", { status: "queued", phase: "triage" }), false);
    assert.equal(store.getSession(id)!.status, "closed");
  });
});

test("a claim from the wrong status changes nothing", () => {
  withStore((store) => {
    const id = "ses_running";
    store.createSession({ session_id: id, github_user_id: USER, image_count: 1, iterations_max: 3 });
    store.updateSession(id, { status: "running", phase: "extraction" });
    assert.equal(store.claimSession(id, "ready_for_review", { status: "queued", phase: "triage" }), false);
    const s = store.getSession(id)!;
    assert.equal(s.status, "running");
    assert.equal(s.phase, "extraction", "the patch was applied despite the claim failing");
  });
});

test("a claim on a session that does not exist fails rather than throwing", () => {
  withStore((store) => {
    assert.equal(store.claimSession("ses_nope", "ready_for_review", { status: "queued" }), false);
  });
});

test("an empty patch does not report a win", () => {
  withStore((store) => {
    // There is no UPDATE to build from zero keys, so there is nothing to serialize
    // on. Returning true would hand out a claim no statement enforced — every
    // caller would "win". False is the honest answer; `updateSession` likewise
    // treats an empty patch as a no-op.
    const id = ready(store);
    assert.equal(store.claimSession(id, "ready_for_review", {}), false);
    assert.equal(store.getSession(id)!.status, "ready_for_review");
  });
});

test("the claim stamps updated_at", () => {
  withStore((store) => {
    const id = ready(store);
    // Backdate it first, and compare with a STRICT `>`. Written as
    // `updated_at >= before` this asserted nothing: createSession already wrote a
    // current timestamp, so dropping the stamp from the claim's UPDATE left that
    // valid value in place and the test still passed. Forging an old value is what
    // makes the comparison a measurement — and it has to be forged, because two
    // writes in the same millisecond are equal, not increasing.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE session_id = ?`)
      .run("2020-01-01T00:00:00.000Z", id);
    const before = store.getSession(id)!.updated_at;
    // Same contract as updateSession: a client polling GET /:id uses updated_at to
    // tell a progressing run from a stuck one, so the lock must not be a silent
    // write.
    assert.equal(store.claimSession(id, "ready_for_review", { status: "queued" }), true);
    const after = store.getSession(id)!.updated_at;
    assert.ok(after > before, `updated_at was not stamped (${before} -> ${after})`);
    assert.ok(/^\d{4}-\d\d-\d\dT[\d:.]{9,}Z$/.test(after), `not an ISO timestamp: ${after}`);
  });
});
