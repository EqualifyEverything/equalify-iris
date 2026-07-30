import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SessionStatus = "queued" | "running" | "ready_for_review" | "closed" | "failed";
export type Phase = "triage" | "extraction" | "reconciliation" | "assembly" | "review" | "done";

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
 *     unsatisfiable). A client mid-pagination across a deploy keeps working.
 *   * Anything whose timestamp half is not a valid date is REJECTED rather than
 *     passed through. The old code compared it as a string, so `cursor=hello`
 *     matched every row (`'2026-…' < 'hello'`) and handed back page one — a
 *     client looping on next_cursor would page forever. A 400 says what is wrong.
 */
export function parseCursor(raw: string): SessionCursor | null {
  const i = raw.indexOf(CURSOR_SEP);
  const created_at = i === -1 ? raw : raw.slice(0, i);
  const session_id = i === -1 ? "" : raw.slice(i + 1);
  if (!created_at || Number.isNaN(Date.parse(created_at))) return null;
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
 */
export function pageSessions(
  rows: SessionRecord[],
  limit: number,
): { page: SessionRecord[]; next: SessionCursor | null } {
  const page = rows.slice(0, limit);
  const held = rows.length > limit ? page[page.length - 1] : null;
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
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(github_user_id, created_at DESC);
      -- Matches the compound keyset order listSessions pages on. A separate name
      -- from idx_sessions_user rather than a redefinition: CREATE INDEX IF NOT
      -- EXISTS is a no-op when the name already exists, so changing the columns
      -- of the old index in place would silently leave every already-deployed
      -- database on the two-column version.
      CREATE INDEX IF NOT EXISTS idx_sessions_user_page
        ON sessions(github_user_id, created_at DESC, session_id DESC);
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
         VALUES (?, ?, 'queued', 'triage', 0, ?, ?, NULL, ?, ?)`,
      )
      .run(s.session_id, s.github_user_id, s.iterations_max, s.image_count, now, now);
    return this.getSession(s.session_id)!;
  }

  // Sessions run in-process; after a restart any still-"running"/"queued" rows
  // are orphaned (the process that drove them is gone). Mark them failed so
  // clients stop polling a run that will never finish. Single-instance only.
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
  // expansion; SQLite's planner uses the covering index for the former
  // (`SEARCH ... (u=? AND (created_at,session_id)<(?,?))`) and degrades to
  // scanning the whole user's rows for the latter (`SEARCH ... (u=?)`).
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
    params.push(opts.limit);
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${where} ORDER BY created_at DESC, session_id DESC LIMIT ?`,
      )
      .all(...(params as never[])) as unknown as SessionRecord[];
  }
}
