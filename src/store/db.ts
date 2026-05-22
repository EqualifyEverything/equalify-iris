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

  setFork(id: number, forkRepo: string): void {
    this.db.prepare(`UPDATE users SET fork_repo = ? WHERE github_user_id = ?`).run(forkRepo, id);
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

  listSessions(userId: number, opts: { status?: string; limit: number; cursor?: string }): SessionRecord[] {
    const params: unknown[] = [userId];
    let where = `github_user_id = ?`;
    if (opts.status) {
      where += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.cursor) {
      // Cursor is the created_at of the last item from the previous page.
      where += ` AND created_at < ?`;
      params.push(opts.cursor);
    }
    params.push(opts.limit);
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...(params as never[])) as unknown as SessionRecord[];
  }
}
