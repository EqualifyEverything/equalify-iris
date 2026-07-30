import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionCursor } from "../src/store/db.ts";
import { Store, encodeCursor, pageSessions, parseCursor } from "../src/store/db.ts";

// `GET /v1/sessions` pages by keyset. The property that matters is boring to
// state and easy to break: walking every page must visit each session exactly
// once. It used to page on `created_at` alone, which is a millisecond timestamp —
// so a burst of uploads produces ties, and at a page boundary inside a tie the
// old query both SKIPPED rows (`created_at < ?` excludes the rest of the tied
// group) and could REPEAT them (nothing pinned the order among tied rows). Both
// failures are invisible at small volume and silently corrupt a client that walks
// pages to build a list, which is the only reason to paginate at all.
//
// These tests write ties deliberately, because they are what the real workload
// produces and what no incidental test would generate.

const USER = 4242;
const OTHER = 99;

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "iris-page-"));
  try {
    fn(new Store(join(dir, "iris.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// createSession stamps created_at with Date.now(), so ties are a matter of luck.
// Set the timestamps explicitly instead: `ts` is the millisecond bucket, and
// several ids can share one.
function seed(store: Store, rows: { id: string; ts: string; user?: number; status?: string }[]): void {
  for (const row of rows) {
    store.createSession({
      session_id: row.id,
      github_user_id: row.user ?? USER,
      image_count: 1,
      iterations_max: 3,
    });
    // Reaching past `private db` on purpose: createSession stamps `new Date()`,
    // and there is no reason to widen the store's API just so a test can forge a
    // timestamp collision.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE sessions SET created_at = ?, status = ? WHERE session_id = ?`)
      .run(row.ts, row.status ?? "ready_for_review", row.id);
  }
}

// Walk every page the way a client does: follow next_cursor until it is null.
//
// This drives the SAME functions the route does — listSessions for the query and
// pageSessions for the slice-and-cursor decision — deliberately, rather than
// reimplementing the over-fetch/slice logic here. A helper that reimplements it
// passes no matter what the route does, which is exactly the bug class these
// tests exist to catch.
function walk(store: Store, limit: number, status?: string): { ids: string[]; pages: number } {
  const ids: string[] = [];
  let cursor: SessionCursor | undefined;
  let pages = 0;
  for (;;) {
    const rows = store.listSessions(USER, { limit: limit + 1, status, cursor });
    const { page, next } = pageSessions(rows, limit);
    pages++;
    ids.push(...page.map((r) => r.session_id));
    if (!next) return { ids, pages };
    cursor = next;
    assert.ok(pages < 50, "pagination did not terminate");
  }
}

const T = (ms: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms)).toISOString();

test("every session is visited exactly once when pages split a timestamp tie", () => {
  withStore((store) => {
    // Six sessions, all in the SAME millisecond — a burst of uploads. With
    // limit=2 both page boundaries fall inside the tie, which is precisely where
    // the old cursor lost rows.
    const ids = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e", "ses_f"];
    seed(store, ids.map((id) => ({ id, ts: T(0) })));

    const { ids: seen } = walk(store, 2);
    assert.equal(seen.length, 6, `expected 6 rows across pages, got ${seen.length}: ${seen.join(",")}`);
    assert.equal(new Set(seen).size, 6, `duplicate rows across pages: ${seen.join(",")}`);
    assert.deepEqual([...seen].sort(), [...ids].sort());
  });
});

test("order is total and descending, ties broken by session_id", () => {
  withStore((store) => {
    seed(store, [
      { id: "ses_a", ts: T(0) },
      { id: "ses_b", ts: T(0) },
      { id: "ses_c", ts: T(5) },
    ]);
    // Newest first; within the T(0) tie, session_id DESC.
    assert.deepEqual(
      walk(store, 10).ids,
      ["ses_c", "ses_b", "ses_a"],
    );
    // And the same order regardless of page size — the ORDER BY and the cursor
    // predicate have to agree, or the sequence changes when it is split.
    assert.deepEqual(walk(store, 1).ids, ["ses_c", "ses_b", "ses_a"]);
    assert.deepEqual(walk(store, 2).ids, ["ses_c", "ses_b", "ses_a"]);
  });
});

test("mixed ties and distinct timestamps page correctly at every page size", () => {
  withStore((store) => {
    // Two tie groups of 3 plus two singletons: 8 rows, so limit 1..9 covers every
    // boundary position including "page size == row count" and "one page only".
    seed(store, [
      { id: "ses_a1", ts: T(0) },
      { id: "ses_a2", ts: T(0) },
      { id: "ses_a3", ts: T(0) },
      { id: "ses_b1", ts: T(1) },
      { id: "ses_c1", ts: T(2) },
      { id: "ses_c2", ts: T(2) },
      { id: "ses_c3", ts: T(2) },
      { id: "ses_d1", ts: T(3) },
    ]);
    const full = walk(store, 100).ids;
    assert.equal(full.length, 8);
    for (let limit = 1; limit <= 9; limit++) {
      const { ids } = walk(store, limit);
      assert.deepEqual(ids, full, `limit=${limit} produced a different sequence`);
    }
  });
});

test("a status filter pages independently of the unfiltered list", () => {
  withStore((store) => {
    // Alternating statuses inside one tie group: the filter must not change what
    // the cursor means, and the filtered walk must still see each match once.
    seed(store, [
      { id: "ses_a", ts: T(0), status: "ready_for_review" },
      { id: "ses_b", ts: T(0), status: "failed" },
      { id: "ses_c", ts: T(0), status: "ready_for_review" },
      { id: "ses_d", ts: T(0), status: "failed" },
      { id: "ses_e", ts: T(0), status: "ready_for_review" },
    ]);
    const ready = walk(store, 2, "ready_for_review").ids;
    assert.deepEqual(ready, ["ses_e", "ses_c", "ses_a"]);
    assert.deepEqual(walk(store, 1, "failed").ids, ["ses_d", "ses_b"]);
  });
});

test("another user's sessions are never reachable by paging", () => {
  withStore((store) => {
    // Ownership is enforced in the WHERE clause, and the cursor adds a second
    // predicate to it. A cursor is not a capability: sharing a millisecond with
    // someone else's session must not expose it.
    seed(store, [
      { id: "ses_mine1", ts: T(0) },
      { id: "ses_theirs", ts: T(0), user: OTHER },
      { id: "ses_mine2", ts: T(0) },
    ]);
    const { ids } = walk(store, 1);
    assert.deepEqual(ids, ["ses_mine2", "ses_mine1"]);
  });
});

test("a full final page still ends pagination", () => {
  withStore((store) => {
    // 4 rows at limit 2: the second page is full, and the only thing that says
    // "stop" is that no extra row came back. Getting this wrong costs every
    // client one guaranteed-empty request per list.
    seed(store, [
      { id: "ses_a", ts: T(0) },
      { id: "ses_b", ts: T(1) },
      { id: "ses_c", ts: T(2) },
      { id: "ses_d", ts: T(3) },
    ]);
    const { ids, pages } = walk(store, 2);
    assert.equal(ids.length, 4);
    assert.equal(pages, 2, "a full final page should not trigger a third request");
    // Directly: the second page is full, so the only signal is that no extra row
    // came back. Asserting the cursor and not just the page count, because a
    // caller that re-derives this decision instead of using pageSessions is the
    // failure mode — and it is invisible from the row sequence alone.
    const second = store.listSessions(USER, {
      limit: 3,
      cursor: { created_at: T(2), session_id: "ses_c" },
    });
    assert.equal(second.length, 2, "exactly 2 rows remain below the cursor");
    assert.equal(pageSessions(second, 2).next, null, "no row was held back -> no cursor");
    // And one row below that boundary DOES yield a cursor, so the assertion above
    // is not passing for want of rows.
    assert.notEqual(pageSessions(second, 1).next, null);
  });
});

test("a session created mid-pagination does not shift the pages below it", () => {
  withStore((store) => {
    // Keyset's whole advantage over OFFSET. A new row is newer than the cursor,
    // so it lands on a page already read — never inserted into an unread one,
    // which is how OFFSET makes a client skip a row.
    seed(store, [
      { id: "ses_a", ts: T(0) },
      { id: "ses_b", ts: T(1) },
      { id: "ses_c", ts: T(2) },
    ]);
    const first = store.listSessions(USER, { limit: 2, status: undefined, cursor: undefined });
    assert.deepEqual(first.map((r) => r.session_id), ["ses_c", "ses_b"]);
    seed(store, [{ id: "ses_new", ts: T(9) }]);
    const rest = store.listSessions(USER, {
      limit: 2,
      cursor: { created_at: first[1].created_at, session_id: first[1].session_id },
    });
    assert.deepEqual(rest.map((r) => r.session_id), ["ses_a"], "the unread page changed");
  });
});

// --- cursor encoding ---

test("a cursor round-trips", () => {
  const c = { created_at: T(7), session_id: "ses_01HXYZ" };
  assert.deepEqual(parseCursor(encodeCursor(c)), c);
});

test("a legacy bare-timestamp cursor still pages, and does not skip rows", () => {
  // Clients mid-pagination across a deploy hold a bare created_at. It parses to
  // an empty id, which sorts below every real one, so the tie-breaking half of
  // the predicate is unsatisfiable and it degrades to the old `created_at < ?`.
  const parsed = parseCursor(T(3));
  assert.deepEqual(parsed, { created_at: T(3), session_id: "" });
  withStore((store) => {
    seed(store, [
      { id: "ses_a", ts: T(1) },
      { id: "ses_b", ts: T(3) },
      { id: "ses_c", ts: T(3) },
      { id: "ses_d", ts: T(5) },
    ]);
    const rows = store.listSessions(USER, { limit: 10, cursor: parsed! });
    // Strictly older than T(3): the tied rows themselves are excluded, exactly as
    // the old cursor did. The point is that it still WORKS, not that it is exact.
    assert.deepEqual(rows.map((r) => r.session_id), ["ses_a"]);
  });
});

test("a cursor whose timestamp is not a date is rejected, not compared as a string", () => {
  // The old code pushed the raw string into `created_at < ?`, so `cursor=hello`
  // matched every row ('2026-…' < 'hello') and returned page one — a client
  // following next_cursor would page forever. Null here becomes a 400.
  assert.equal(parseCursor("hello"), null);
  assert.equal(parseCursor(""), null);
  assert.equal(parseCursor("|ses_a"), null, "empty timestamp half");
  assert.equal(parseCursor("not-a-date|ses_a"), null);
});

test("a session_id containing the separator does not truncate the cursor", () => {
  // Ids are ULIDs today, but splitting on the FIRST separator rather than the
  // last keeps a weird id from silently becoming a different, valid cursor.
  const c = { created_at: T(0), session_id: "ses_a|b" };
  assert.deepEqual(parseCursor(encodeCursor(c)), c);
});
