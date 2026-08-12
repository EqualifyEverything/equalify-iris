import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SessionStatus = "queued" | "running" | "ready_for_review" | "closed" | "failed";
// The phases the pipeline actually enters, in order. "triage" and
// "reconciliation" were removed: neither is implemented (nothing writes triage
// notes, and reconciliation cannot run while extraction hardcodes `edges: []`),
// so a client that switched on them was branching on states it would never see.
// A new session starts at "extraction" rather than "triage" for the same reason
// — it used to report a phase for the length of one INSERT, until runPipeline
// immediately overwrote it. See #30 Tier 4 for the decision to build or drop
// each phase; this only stops the enum from claiming they exist today.
export type Phase = "extraction" | "assembly" | "review" | "done";

// No `github_token` field, deliberately. The user's GitHub token is a live
// credential — it files issues on their behalf during a run (§7.13) — but it never
// needs to OUTLIVE the request that carried it: it arrives in the `Authorization`
// header, is passed in memory to the queued run, and is gone when the run ends.
// Storing it made a copy of `data/iris.sqlite` equivalent to GitHub API access as
// every user who had ever logged in, in exchange for nothing the service used.
export interface UserRecord {
  github_user_id: number;
  github_login: string;
  max_review_iterations: number;
  created_at: string;
}

export interface SessionRecord {
  session_id: string;
  github_user_id: number;
  status: SessionStatus;
  phase: Phase;
  iterations_completed: number;
  iterations_max: number;
  image_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  // When this session FIRST reached ready_for_review, or null if it never has.
  // Written once, by the store, and never cleared (see writeSet) — which is the
  // whole point: it is what `publicStats` counts, and a public "pages processed"
  // tally that can go DOWN is worse than no tally. `status` cannot answer the
  // question, because a feedback re-run moves a finished session back to
  // `queued` and then possibly to `failed`; counting on status alone would make
  // the public number dip every time someone asked Iris to try again.
  first_completed_at: string | null;
}

// What a caller may change about a session. `first_completed_at` is omitted
// alongside the immutable identity/creation fields: it is derived from the
// status transition itself, so no handler needs to (or gets to) set it by hand.
export type SessionPatch = Partial<
  Omit<SessionRecord, "session_id" | "github_user_id" | "created_at" | "first_completed_at">
>;

// The sort key `GET /v1/sessions` pages on. Both halves are required: session
// rows are ordered by `created_at DESC`, and `created_at` is a millisecond
// ISO-8601 string, so two sessions created in the same millisecond are
// indistinguishable by it. Ties are broken by `session_id DESC` — arbitrary but
// TOTAL, which is what keyset pagination needs.
export interface SessionCursor {
  created_at: string;
  session_id: string;
}

// Cursors are line-noise to a client but deliberately readable in a log:
// "2026-05-22T18:00:00.000Z|ses_01HXYZ…". No base64 wrapper, because an opaque
// blob makes a paging bug unreadable from a request log without buying any real
// encapsulation — the shape is documented either way.
const CURSOR_SEP = "|";

export function encodeCursor(s: SessionCursor): string {
  return `${s.created_at}${CURSOR_SEP}${s.session_id}`;
}

/**
 * Parse a client-supplied cursor, or return null if it is not one.
 *
 * Two behaviors worth stating:
 *
 *   * A cursor with no separator is treated as a bare `created_at` with an empty
 *     id. That is exactly the shape this endpoint issued before the compound
 *     cursor existed, and it degrades to the old `created_at < ?` predicate
 *     (nothing sorts below the empty string, so the tie-breaking clause is
 *     unsatisfiable). A client mid-pagination across a deploy keeps working —
 *     but note what "keeps working" means: that one request still skips the rows
 *     tied on its timestamp, which is the very bug the compound cursor exists to
 *     fix. It is accepted anyway because the alternative is a 400 that breaks the
 *     client outright, and it is self-clearing: the cursor handed back is
 *     compound. Documented in docs/API.md §8 so a gap reported during an upgrade
 *     window is diagnosable rather than mysterious.
 *   * The timestamp half must be in EXACTLY the format the column stores —
 *     `Date#toISOString()`, UTC with milliseconds — not merely something
 *     `Date.parse` accepts. It is bound into a **string** comparison, so the only
 *     question that matters is whether it is comparable to the stored values, and
 *     "parses as a date" is a much weaker predicate than that. `"9999"`,
 *     `"Dec 2026"`, and even the legitimate ISO forms `"2026-05-22T18:00:00Z"`
 *     (no milliseconds) and `"2026-05-22T19:00:00.000+01:00"` (an offset instead
 *     of Z) all parse, and all sort ABOVE every stored `"2026-…"` value — which
 *     reproduces the exact bug the compound cursor exists to fix: the query
 *     matches every row and hands back page one, so a client looping on
 *     `next_cursor` pages forever. The last two are not adversarial input; they
 *     are what a client that reformats a timestamp produces. Rejecting them is a
 *     400 that says what is wrong, rather than a 200 that quietly lies.
 *
 *     Round-tripping through `toISOString()` is the check, because that is
 *     literally the function that produced the stored value (see createSession).
 *     Cursors this endpoint issued before the compound form existed were bare
 *     `created_at` values from the same call, so they still pass.
 */
export function parseCursor(raw: string): SessionCursor | null {
  const i = raw.indexOf(CURSOR_SEP);
  const created_at = i === -1 ? raw : raw.slice(0, i);
  const session_id = i === -1 ? "" : raw.slice(i + 1);
  if (!created_at) return null;
  const t = new Date(created_at);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== created_at) return null;
  return { created_at, session_id };
}

/**
 * Turn an over-fetched result set into one page plus the cursor that follows it.
 *
 * Callers ask `listSessions` for `limit + 1` rows and pass the result here. The
 * extra row is the entire mechanism: it is what distinguishes "the page is full
 * and there is more" from "the page is full and that was everything". Emitting a
 * cursor in the second case costs every client one guaranteed-empty request per
 * list, and a client that treats a non-null cursor as "more exists" reports a
 * page that isn't there.
 *
 * This lives beside the query rather than in the route because the two halves are
 * one contract — the over-fetch, the slice, and the cursor have to agree, and a
 * route that re-derives them can drift from the query silently.
 *
 * `limit` is clamped here as well as at the route, because a negative one is
 * quietly destructive at both ends: SQLite treats `LIMIT -4` as NO limit (it
 * reads the user's entire session table), and `rows.slice(0, -5)` drops rows off
 * the END of the page while still leaving `rows.length > limit` true — so the
 * response is a short page with a non-null cursor, the one combination that tells
 * a client "there is more" about rows it was never shown.
 */
export function pageSessions(
  rows: SessionRecord[],
  limit: number,
): { page: SessionRecord[]; next: SessionCursor | null } {
  const size = Math.max(1, Math.floor(limit) || 1);
  const page = rows.slice(0, size);
  const held = rows.length > size ? page[page.length - 1] : null;
  return {
    page,
    next: held ? { created_at: held.created_at, session_id: held.session_id } : null,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // BEFORE any DDL or PRAGMA below. Refusing to adopt a file and then writing to
    // it anyway is a contradiction, and the writes are not harmless: the `exec`
    // block drops `idx_sessions_user`, creates its compound replacement, and
    // switches the file to WAL. All three land on a database this then declines,
    // which breaks the one recovery path the error message implies — rolling back to
    // the previous build to export session history before deleting the file, whose
    // `listSessions` pages on the index that is now gone.
    this.rejectLegacyUsersTable(path);
    // busy_timeout is 0 on a fresh node:sqlite connection — "fail immediately",
    // not "wait for the lock". WAL still allows only one writer, so without a
    // timeout a second process's UPDATE against a held write lock throws
    // ERR_SQLITE_ERROR instead of completing. That would break claimSession in
    // the very scenario that justifies it: a loser is supposed to report 0
    // changed rows so the caller can answer 409, and a synchronous throw in a
    // handler is an uncaught exception (there is no error middleware) — a 500.
    // Every write here is a single-statement autocommit, so contention lasts
    // microseconds; 5s is a ceiling for the multi-process case, not a budget.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      -- No github_token column, and no fork_repo column. The token is never
      -- persisted (see UserRecord above); fork_repo belonged to the fork-and-PR
      -- flow of PRD §7.13, which was never built and is not going to be —
      -- contributions are filed as issues under the user's own identity (§12).
      CREATE TABLE IF NOT EXISTS users (
        github_user_id INTEGER PRIMARY KEY,
        github_login TEXT NOT NULL,
        max_review_iterations INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        iterations_completed INTEGER NOT NULL DEFAULT 0,
        iterations_max INTEGER NOT NULL DEFAULT 3,
        image_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- Nullable and write-once; see SessionRecord and addCompletionColumn.
        first_completed_at TEXT
      );
      -- Matches the compound keyset order listSessions pages on, exactly. A new
      -- NAME rather than a redefinition of idx_sessions_user: CREATE INDEX IF NOT
      -- EXISTS is a no-op when the name already exists, so editing the old
      -- statement's columns in place would silently leave every already-deployed
      -- database on the two-column version.
      CREATE INDEX IF NOT EXISTS idx_sessions_user_page
        ON sessions(github_user_id, created_at DESC, session_id DESC);
      -- ...and then drop the two-column index it supersedes. It was a strict
      -- PREFIX of the above, and no query orders on (github_user_id, created_at)
      -- alone any more, so keeping it bought nothing and cost an extra b-tree
      -- write on every session insert. Unconditional and idempotent: this is the
      -- migration step for databases created before the compound cursor.
      DROP INDEX IF EXISTS idx_sessions_user;
    `);
    // ...and the column the CREATE TABLE above cannot add to a database that
    // already has a sessions table.
    this.addCompletionColumn();
  }

  /**
   * Add `sessions.first_completed_at` to an already-deployed database, and
   * backfill it.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so editing the
   * statement above adds the column to fresh databases only — an existing one
   * needs the ALTER, or every write that stamps the column fails with "no such
   * column" and every run ends `failed` at the moment it would have succeeded.
   *
   * The backfill is an approximation, deliberately and only here: sessions that
   * finished before this column existed have no record of WHEN they finished, so
   * `updated_at` stands in. That is exact for a session nothing has touched since
   * (the completion was its last write) and late for one that was closed or
   * re-run afterwards. It cannot be earlier than the real completion, which is
   * the property that matters — `publicStats` reports `since` from the minimum,
   * and the count itself is unaffected either way.
   *
   * `failed` is not backfilled even though a failed session may well have
   * completed once before a feedback re-run broke: nothing distinguishes it from
   * one that failed on its first run, and undercounting is the honest direction
   * for a public tally. Going forward the stamp survives the re-run, so this only
   * ever affects sessions that predate the column.
   *
   * One more session is missed, for the same reason and only at the upgrade
   * moment: one that had completed and was **mid-feedback-re-run** (`queued` or
   * `running`) when the new build booted. It is not in the backfill set, and
   * `failStaleSessions` then marks it `failed` on that same boot — so it is
   * excluded permanently rather than until its re-run finishes. Widening the
   * filter to include in-flight sessions would be worse: it would count first
   * runs that had never produced anything. Documented in docs/API.md §0b so the
   * one-off gap is explicable rather than mysterious.
   *
   * Unlike everything else in the constructor, `ALTER TABLE` is not idempotent,
   * so the check and the write are wrapped rather than trusted. Two processes
   * booting against one database in the same window both see no column, both
   * ALTER, and the loser would otherwise throw `duplicate column name` straight
   * out of `new Store()` — an uncaught boot crash, and not one `busy_timeout`
   * covers, since it is not a lock error. Re-checking on failure is what tells
   * "someone else already did this" (fine — the winner also runs the backfill)
   * from a real DDL error, which is rethrown. Multi-process is not a supported
   * topology, so this is defense in depth; it just costs three lines to put this
   * statement on the same footing as the IF NOT EXISTS block above it.
   */
  private addCompletionColumn(): void {
    const hasColumn = (): boolean =>
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).some(
        (c) => c.name === "first_completed_at",
      );
    if (hasColumn()) return;
    try {
      this.db.exec(`
        ALTER TABLE sessions ADD COLUMN first_completed_at TEXT;
        UPDATE sessions SET first_completed_at = updated_at
         WHERE status IN ('ready_for_review', 'closed');
      `);
    } catch (e) {
      if (!hasColumn()) throw e;
    }
  }

  /**
   * Build the `SET` clause shared by every session write, including the two
   * columns no caller passes: `updated_at`, and the write-once completion stamp.
   *
   * The stamp lives here rather than in the orchestrator so that "a session that
   * has reached ready_for_review is stamped" is a property of the store instead
   * of something each call site remembers. `COALESCE` is what makes it write
   * ONCE: the second and third times a session goes ready_for_review — every
   * feedback re-run does — the existing value wins, so the public tally counts
   * each set of page images once no matter how many times Iris re-read them.
   */
  private writeSet(patch: SessionPatch, now: string): { sets: string; values: unknown[] } {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = ?`);
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    if (patch.status === "ready_for_review") {
      sets.push(`first_completed_at = COALESCE(first_completed_at, ?)`);
      values.push(now);
    }
    sets.push(`updated_at = ?`);
    values.push(now);
    return { sets: sets.join(", "), values };
  }

  /**
   * Refuse to open a database whose `users` table predates the removal of
   * `github_token` / `fork_repo`.
   *
   * There is deliberately **no migration**: every user starts from scratch, so a
   * pre-existing database is not a deployment to be upgraded — it is a leftover, and
   * the honest response is to say so rather than to quietly adopt it.
   *
   * A check is still needed, because `CREATE TABLE IF NOT EXISTS` in the constructor
   * is a no-op when the table already exists. Without this, a stray `data/` directory (a
   * development leftover, a restored backup, a volume mounted from an older image)
   * keeps the old table — `github_token TEXT NOT NULL` — while `upsertUser` no longer
   * supplies that column, and the two symptoms both point away from the cause:
   *
   *   * Every FIRST-TIME login throws `NOT NULL constraint failed:
   *     users.github_token` inside the auth middleware's try, which answers
   *     `401 unauthorized` with the SQLite message in the body. Anyone who already
   *     has a row keeps working, so it reads as "GitHub is flaky for new signups"
   *     rather than as a schema mismatch.
   *   * The plaintext tokens in that file stay there, now never refreshed and never
   *     cleared, while `getUser`'s `SELECT *` still returns them — so
   *     `req.user.github_token` exists at runtime although `UserRecord` says it
   *     cannot. The claim that a stolen copy of `data/iris.sqlite` is not GitHub
   *     access would be false for exactly that file.
   *
   * Failing at startup is what makes "starting from scratch" a checked precondition
   * instead of an assumption. It also keeps the fix in the operator's hands: deleting
   * the file is a decision about live credentials, and a silent rebuild-and-VACUUM
   * would be this service erasing data nobody asked it to touch.
   *
   * Which is why this runs FIRST, before the schema block and before `journal_mode`.
   * "We will not adopt this file" and "we already modified this file" cannot both be
   * true, and the modifications are the kind an operator would need undone: the DDL
   * drops the index the older build's `listSessions` pages on, so a rollback to that
   * build in order to export session history before deleting the file would meet a
   * schema its queries no longer match. `PRAGMA table_info` on a table that does not
   * exist returns no rows, so a fresh or current database falls straight through.
   */
  private rejectLegacyUsersTable(path: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const legacy = cols.map((c) => c.name).filter((n) => n === "github_token" || n === "fork_repo");
    if (legacy.length === 0) return;
    this.db.close();
    throw new Error(
      `${path} was created by an older version of Iris: its users table still has ` +
        `${legacy.join(" and ")}. There is no migration — GitHub tokens are no longer stored at ` +
        `all, and every user re-authorizes from scratch. Delete the database (and its -wal/-shm ` +
        `files) and restart; users log in again with GitHub and lose nothing but their session ` +
        `history. Note that the old file still contains plaintext GitHub tokens for every user ` +
        `who logged in, so delete it rather than archiving it.`,
    );
  }

  // --- users ---

  // On first auth a user account is provisioned with the deployment's default
  // max_review_iterations (PRD §9.1). Existing users keep their stored default; the
  // login is the only field an existing row refreshes, since it is the only one that
  // can change upstream and the token is not stored at all (see UserRecord).
  upsertUser(
    u: { github_user_id: number; github_login: string },
    defaultMaxIter = 3,
  ): UserRecord {
    const existing = this.getUser(u.github_user_id);
    if (existing) {
      // Only the login can change (GitHub renames); the numeric id is stable and
      // is what everything else keys on.
      this.db
        .prepare(`UPDATE users SET github_login = ? WHERE github_user_id = ?`)
        .run(u.github_login, u.github_user_id);
      return this.getUser(u.github_user_id)!;
    }
    this.db
      .prepare(
        `INSERT INTO users (github_user_id, github_login, max_review_iterations, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(u.github_user_id, u.github_login, defaultMaxIter, new Date().toISOString());
    return this.getUser(u.github_user_id)!;
  }

  getUser(id: number): UserRecord | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE github_user_id = ?`).get(id) as UserRecord | undefined;
  }

  // --- sessions ---

  createSession(s: {
    session_id: string;
    github_user_id: number;
    image_count: number;
    iterations_max: number;
  }): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions
         (session_id, github_user_id, status, phase, iterations_completed, iterations_max, image_count, error, created_at, updated_at)
         VALUES (?, ?, 'queued', 'extraction', 0, ?, ?, NULL, ?, ?)`,
      )
      .run(s.session_id, s.github_user_id, s.iterations_max, s.image_count, now, now);
    return this.getSession(s.session_id)!;
  }

  // Sessions run in-process; after a restart any still-"running"/"queued" rows
  // are orphaned (the process that drove them is gone). Mark them failed so
  // clients stop polling a run that will never finish.
  //
  // SINGLE-INSTANCE ONLY, and this is the sharpest edge of that constraint: no
  // row records which process owns a run, so this cannot distinguish "orphaned"
  // from "a peer instance is running it right now". A second instance booting
  // against the same data_dir marks the first instance's live runs `failed` —
  // the pipeline keeps going and still writes output.html, but the client is
  // told the conversion failed. Declared in README's implementation notes;
  // making it safe needs an owning-instance id, not a change here.
  failStaleSessions(): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE sessions SET status = 'failed', error = 'interrupted (server restarted)', updated_at = ?
         WHERE status IN ('running','queued')`,
      )
      .run(now);
    return Number(res.changes);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(id) as SessionRecord | undefined;
  }

  updateSession(id: string, patch: SessionPatch): void {
    if (Object.keys(patch).length === 0) return;
    const { sets, values } = this.writeSet(patch, new Date().toISOString());
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE session_id = ?`).run(...(values as never[]), id);
  }

  // Apply `patch` only if the session is still in `expected`, and report whether
  // this call is the one that did it. The status test and the write are one
  // statement, so exactly one of two concurrent callers can win: SQLite reports 0
  // changed rows to the loser.
  //
  // This replaces read-status-then-write in the endpoints that start work on a
  // session (`POST /:id/feedback`, `POST /:id/close`). Those handlers are fully
  // synchronous, so within one process there is no await between the check and the
  // write and the plain pattern is already safe — the gap only opens across
  // processes, where two instances share this WAL database. Verified: two processes
  // racing the read-then-write pattern at a shared wall-clock instant both reported
  // "won"; through this method exactly one does.
  //
  // A second instance is not the supported topology (the queue is in-process and
  // `failStaleSessions` assumes it), so this is defense in depth rather than a fix
  // for a reachable bug today. It earns its place by being the *cheaper* invariant
  // to hold: correctness stops depending on every future handler staying
  // synchronous. Adding one `await` between the guard and the write in a handler —
  // the ordinary thing to do when a check needs I/O — would silently reintroduce
  // the race in-process, and a duplicated feedback run is invisible in the response
  // (both callers get a 202) while two pipelines write the same output.html and
  // fragments/final.json.
  claimSession(id: string, expected: SessionStatus, patch: SessionPatch): boolean {
    if (Object.keys(patch).length === 0) return false;
    const { sets, values } = this.writeSet(patch, new Date().toISOString());
    const res = this.db
      .prepare(`UPDATE sessions SET ${sets} WHERE session_id = ? AND status = ?`)
      .run(...(values as never[]), id, expected);
    return Number(res.changes) > 0;
  }

  // Keyset pagination over (created_at DESC, session_id DESC).
  //
  // This used to page on `created_at < ?` alone. `created_at` is a millisecond
  // ISO-8601 timestamp and sessions are created by an HTTP handler, so two rows
  // sharing one is not a corner case — it is what a burst of uploads looks like.
  // With a non-unique sort key the old query lost and duplicated rows at every
  // page boundary that fell inside a tie: `<` skipped every other row sharing the
  // last row's timestamp (they never appear on any page), while SQLite is free to
  // order the tied rows differently between the two queries, so a row already
  // returned could come back on the next page. Neither shows up in testing at
  // small volume, and both silently corrupt any client that walks pages to build
  // a list.
  //
  // The predicate is the row-value form `(created_at, session_id) < (?, ?)`
  // rather than the equivalent `created_at < ? OR (created_at = ? AND ...)`
  // expansion. Only the row-value form is visible to SQLite's planner as an
  // index bound: it seeks
  // (`SEARCH ... USING INDEX ... (u=? AND (created_at,session_id)<(?,?))`)
  // where the OR-expansion degrades to scanning every one of the user's rows
  // (`SEARCH ... (u=?)`). Not a COVERING index seek — this is `SELECT *`, so the
  // row has to be fetched from the table either way; the index earns its keep by
  // bounding which rows are visited, not by answering the query alone.
  listSessions(
    userId: number,
    opts: { status?: string; limit: number; cursor?: SessionCursor },
  ): SessionRecord[] {
    const params: unknown[] = [userId];
    let where = `github_user_id = ?`;
    if (opts.status) {
      where += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.cursor) {
      // Strictly after the last row of the previous page, in the same total order
      // the ORDER BY below imposes — the two must match exactly or rows are
      // skipped.
      where += ` AND (created_at, session_id) < (?, ?)`;
      params.push(opts.cursor.created_at, opts.cursor.session_id);
    }
    // Clamped, not trusted. SQLite reads a NEGATIVE limit as *no* limit, so
    // `LIMIT -4` returns the user's entire session table — a caller that computed
    // its limit with `parseInt(x) || 20` (where a negative x is truthy and
    // survives) turns one list request into a full scan, and nothing about the
    // response says so. Refusing it here rather than only at the route means the
    // query cannot be made unbounded by arithmetic upstream of it.
    params.push(Math.max(1, Math.floor(opts.limit) || 1));
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${where} ORDER BY created_at DESC, session_id DESC LIMIT ?`,
      )
      .all(...(params as never[])) as unknown as SessionRecord[];
  }

  // --- public stats ---

  /**
   * The deployment-wide totals behind `GET /v1/stats`: how many page images Iris
   * has converted, across how many documents, and since when.
   *
   * Aggregate only, and that is a requirement rather than a simplification —
   * this feeds an UNAUTHENTICATED endpoint. Every value here is a count over the
   * whole table: no user id, no login, no session id, no filename, and no content.
   *
   * What that does NOT promise, since the endpoint is public and pollable: the
   * DELTA between two reads is a per-upload figure. `documents_processed` +1
   * alongside `pages_processed` +40 says a 40-page document finished in that
   * window, and on a quiet deployment the aggregate IS the individual. The route's
   * 60s cache coarsens when that shows up, not the page count. Nothing identifying
   * is inferable from it — no who, no what — so the query is right as it stands;
   * an operator who considers document sizes sensitive should not expose this
   * endpoint publicly, and this paragraph is here so that stays a decision rather
   * than a surprise.
   *
   * "Processed" means a session that reached ready_for_review at least once, so:
   *
   *   * A queued or in-flight run is not counted yet — the pages have been
   *     uploaded, not converted.
   *   * A run that has NEVER completed is not counted, since nothing was
   *     delivered. Note the asymmetry with a `failed` status: a session that
   *     completed once and then failed a feedback re-run stays counted, because
   *     its pages really were made accessible and the user still has that output.
   *   * A feedback re-run does not count its pages a second time. The tally is
   *     of distinct page images Iris has made accessible, not of model calls, so
   *     re-reading page 3 four times is still one page (see writeSet).
   *
   * There is no index for the `IS NOT NULL` filter: this is a full scan of a
   * table with one row per upload, behind a 60s response cache at the route, so
   * an extra b-tree to maintain on every session write would cost more than it
   * saves. If sessions ever grow to the point where this matters, a partial index
   * on (first_completed_at, image_count) covers this query exactly.
   */
  publicStats(): { pages: number; documents: number; since: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS documents,
                COALESCE(SUM(image_count), 0) AS pages,
                MIN(first_completed_at) AS since
           FROM sessions
          WHERE first_completed_at IS NOT NULL`,
      )
      .get() as { documents: number; pages: number; since: string | null };
    return { pages: Number(row.pages), documents: Number(row.documents), since: row.since ?? null };
  }
}
