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

export interface UserRecord {
  github_user_id: number;
  github_login: string;
  github_token: string;
  fork_repo: string | null;
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
}

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
      CREATE TABLE IF NOT EXISTS users (
        github_user_id INTEGER PRIMARY KEY,
        github_login TEXT NOT NULL,
        github_token TEXT NOT NULL,
        fork_repo TEXT,
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
        updated_at TEXT NOT NULL
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
  }

  // --- users ---

  // On first auth a user account is provisioned with the deployment's default
  // max_review_iterations (PRD §9.1). Existing users keep their stored default;
  // only login + token are refreshed.
  upsertUser(
    u: { github_user_id: number; github_login: string; github_token: string },
    defaultMaxIter = 3,
  ): UserRecord {
    const existing = this.getUser(u.github_user_id);
    if (existing) {
      this.db
        .prepare(`UPDATE users SET github_login = ?, github_token = ? WHERE github_user_id = ?`)
        .run(u.github_login, u.github_token, u.github_user_id);
      return this.getUser(u.github_user_id)!;
    }
    this.db
      .prepare(
        `INSERT INTO users (github_user_id, github_login, github_token, fork_repo, max_review_iterations, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(u.github_user_id, u.github_login, u.github_token, defaultMaxIter, new Date().toISOString());
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

  updateSession(id: string, patch: Partial<Omit<SessionRecord, "session_id" | "github_user_id" | "created_at">>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    this.db
      .prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE session_id = ?`)
      .run(...(values as never[]), new Date().toISOString(), id);
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
  claimSession(
    id: string,
    expected: SessionStatus,
    patch: Partial<Omit<SessionRecord, "session_id" | "github_user_id" | "created_at">>,
  ): boolean {
    const keys = Object.keys(patch);
    if (keys.length === 0) return false;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    const res = this.db
      .prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE session_id = ? AND status = ?`)
      .run(...(values as never[]), new Date().toISOString(), id, expected);
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
}
