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
    // the old cursor did. Asserting the SKIP, not just that it returns something —
    // ses_b and ses_c are lost on this one request, which is the accepted cost of
    // honoring a pre-deploy cursor instead of 400ing it. It is self-clearing (the
    // next cursor is compound) and it is in docs/API.md §8, so a gap reported
    // during an upgrade window is diagnosable. If someone "fixes" this by making a
    // bare cursor inclusive, this assertion is what tells them they have instead
    // made the endpoint repeat rows.
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

test("a timestamp that PARSES but is not this column's format is rejected", () => {
  // The interesting class, and the one a plain Date.parse check waves through.
  // The value is bound into a STRING comparison, so the only question is whether
  // it is comparable to the stored `toISOString()` values — and every string
  // below sorts ABOVE "2026-…", which means "match every row, return page one":
  // exactly the bug the compound cursor exists to fix, just reached by a
  // different route.
  //
  // The last two are the ones that matter in practice. They are not adversarial —
  // they are legitimate ISO-8601 for the same instant, and they are what a client
  // that reformats a timestamp (drops the milliseconds, or renders in local time)
  // actually sends.
  for (const raw of [
    "9999",
    "Dec 2026",
    "Jan 1 2026",
    "2026-05-22T18:00:00Z", // valid ISO-8601, no milliseconds
    "2026-05-22T19:00:00.000+01:00", // same instant, offset instead of Z
  ]) {
    assert.ok(!Number.isNaN(Date.parse(raw)), `precondition: ${raw} parses as a date`);
    assert.ok(raw > "2026-05-22T18:00:00.000Z", `precondition: ${raw} string-sorts above stored values`);
    assert.equal(parseCursor(raw), null, `${raw} should be rejected`);
    assert.equal(parseCursor(`${raw}|ses_a`), null, `${raw} should be rejected with an id too`);
  }
  // And what the endpoint actually issues still passes, in both forms.
  assert.deepEqual(parseCursor("2026-05-22T18:00:00.000Z"), {
    created_at: "2026-05-22T18:00:00.000Z",
    session_id: "",
  });
  assert.deepEqual(parseCursor("2026-05-22T18:00:00.000Z|ses_a"), {
    created_at: "2026-05-22T18:00:00.000Z",
    session_id: "ses_a",
  });
});

test("every timestamp the store writes round-trips through parseCursor", () => {
  // The validator has to accept exactly what createSession produces — checking a
  // format by hand is how you reject your own cursors. Sample real rows rather
  // than asserting against a hand-written pattern.
  withStore((store) => {
    for (let i = 0; i < 5; i++) {
      store.createSession({ session_id: `ses_${i}`, github_user_id: USER, image_count: 1, iterations_max: 3 });
    }
    const rows = store.listSessions(USER, { limit: 10 });
    assert.equal(rows.length, 5);
    for (const r of rows) {
      const c = { created_at: r.created_at, session_id: r.session_id };
      assert.deepEqual(parseCursor(encodeCursor(c)), c, `store wrote a cursor it would reject: ${r.created_at}`);
    }
  });
});

test("a nonsense limit cannot produce a short page with a cursor", () => {
  // `parseInt("-5") || 20` is -5 (negative numbers are truthy), and a negative
  // limit is destructive twice: SQLite reads `LIMIT -4` as NO limit, and
  // `slice(0, -5)` trims rows off the END of the page while still leaving an
  // extra row held back — a short page that claims there is more, about rows the
  // client was never shown.
  withStore((store) => {
    seed(store, Array.from({ length: 8 }, (_, i) => ({ id: `ses_${i}`, ts: T(i) })));
    const rows = store.listSessions(USER, { limit: 100 });
    for (const bad of [-5, 0, NaN, 0.4]) {
      const { page, next } = pageSessions(rows, bad);
      assert.equal(page.length, 1, `limit ${bad} should floor to a 1-row page, got ${page.length}`);
      assert.notEqual(next, null, `limit ${bad}: 7 rows remain, so there must be a cursor`);
    }
    // A sane limit is untouched.
    assert.equal(pageSessions(rows, 3).page.length, 3);
  });
});

test("a negative limit cannot make the query unbounded", () => {
  // SQLite reads a negative LIMIT as NO limit, so this is the difference between
  // returning one row and reading the user's whole session table. Clamping only in
  // the route would leave the query itself unbounded by arithmetic upstream of it,
  // and the symptom — a full scan per list request — is invisible in the response.
  withStore((store) => {
    seed(store, Array.from({ length: 8 }, (_, i) => ({ id: `ses_${i}`, ts: T(i) })));
    for (const bad of [-4, -1, 0, NaN]) {
      const rows = store.listSessions(USER, { limit: bad });
      assert.equal(rows.length, 1, `limit ${bad} returned ${rows.length} rows (expected a floor of 1)`);
    }
    assert.equal(store.listSessions(USER, { limit: 3 }).length, 3, "a sane limit is untouched");
  });
});

// --- schema ---

// Indexes on the SESSIONS table specifically. Scoped by `tbl_name` rather than
// listing every `idx_%` in the schema, because the two assertions below are exact
// (`deepEqual`) and are about which sessions index survives the migration — an index
// added for an unrelated table, e.g. run_signals' recorded_at, is not a change to
// that and should not fail them.
function indexes(store: Store): string[] {
  return (store as unknown as { db: { prepare(s: string): { all(): { name: string }[] } } }).db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'sessions' AND name LIKE 'idx_%'
        ORDER BY name`,
    )
    .all()
    .map((r) => r.name);
}

test("the keyset index is created and the prefix index it supersedes is dropped", () => {
  withStore((store) => {
    // The old (github_user_id, created_at DESC) index is a strict PREFIX of the
    // keyset one, and nothing orders on that pair alone any more, so keeping it
    // only costs a b-tree write per session insert.
    assert.deepEqual(indexes(store), ["idx_sessions_user_page"]);
  });
});

test("an existing database is migrated off the two-column index", () => {
  // The half that matters. `CREATE INDEX IF NOT EXISTS` is a no-op when the name
  // already exists, so an already-deployed database does not pick up a schema
  // change by having the CREATE edited — it needs the explicit DROP. Build a
  // database with the OLD schema, then open it with the current Store.
  const dir = mkdtempSync(join(tmpdir(), "iris-mig-"));
  try {
    const path = join(dir, "old.sqlite");
    const seedStore = new Store(path);
    (seedStore as unknown as { db: { exec(s: string): void } }).db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(github_user_id, created_at DESC);`,
    );
    assert.deepEqual(indexes(seedStore), ["idx_sessions_user", "idx_sessions_user_page"], "precondition");
    // Reopening runs the migration.
    const reopened = new Store(path);
    assert.deepEqual(indexes(reopened), ["idx_sessions_user_page"]);
    // And the paging query still uses an index rather than scanning — dropping the
    // wrong one would be silent, since correctness is unaffected.
    const plan = (
      reopened as unknown as { db: { prepare(s: string): { all(...a: unknown[]): { detail: string }[] } } }
    ).db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE github_user_id = ?
         AND (created_at, session_id) < (?, ?) ORDER BY created_at DESC, session_id DESC LIMIT ?`,
      )
      .all(1, "x", "y", 2)
      .map((r) => r.detail)
      .join(" ");
    assert.match(plan, /SEARCH sessions USING INDEX idx_sessions_user_page/, `expected an index seek, got: ${plan}`);
    assert.doesNotMatch(plan, /SCAN sessions/, `expected no table scan, got: ${plan}`);
    // And it is NOT a covering-index seek, because the real query is `SELECT *`:
    // the row is fetched from the table either way, and the index earns its keep
    // by bounding which rows are visited. Asserted because the comment in
    // listSessions says so, and the plan for a projection over indexed columns
    // alone DOES say COVERING — which is how that comment came to be wrong.
    assert.doesNotMatch(plan, /COVERING/, `SELECT * cannot be covered by this index: ${plan}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session_id containing the separator does not truncate the cursor", () => {
  // Ids are ULIDs today, but splitting on the FIRST separator rather than the
  // last keeps a weird id from silently becoming a different, valid cursor.
  const c = { created_at: T(0), session_id: "ses_a|b" };
  assert.deepEqual(parseCursor(encodeCursor(c)), c);
});
