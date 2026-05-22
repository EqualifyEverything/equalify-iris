from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from collections.abc import Iterator
from typing import Any

from .timeutil import utc_now


class Storage:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                PRAGMA journal_mode = wal;

                CREATE TABLE IF NOT EXISTS accounts (
                    github_user_id INTEGER PRIMARY KEY,
                    github_login TEXT NOT NULL,
                    fork_repo TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    github_user_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    iterations_completed INTEGER NOT NULL,
                    iterations_max INTEGER NOT NULL,
                    image_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (github_user_id) REFERENCES accounts(github_user_id)
                );
                """
            )

    def upsert_account(self, github_user_id: int, github_login: str) -> dict[str, Any]:
        now = utc_now()
        with self._connect() as db:
            existing = db.execute(
                "SELECT * FROM accounts WHERE github_user_id = ?",
                (github_user_id,),
            ).fetchone()

            if existing:
                db.execute(
                    """
                    UPDATE accounts
                    SET github_login = ?, updated_at = ?
                    WHERE github_user_id = ?
                    """,
                    (github_login, now, github_user_id),
                )
            else:
                db.execute(
                    """
                    INSERT INTO accounts (github_user_id, github_login, fork_repo, created_at, updated_at)
                    VALUES (?, ?, NULL, ?, ?)
                    """,
                    (github_user_id, github_login, now, now),
                )

            account = db.execute(
                "SELECT * FROM accounts WHERE github_user_id = ?",
                (github_user_id,),
            ).fetchone()
            return dict(account)

    def get_account(self, github_user_id: int) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM accounts WHERE github_user_id = ?",
                (github_user_id,),
            ).fetchone()
            return dict(row) if row else None

    def create_session(self, github_user_id: int, image_count: int, iterations_max: int) -> dict[str, Any]:
        now = utc_now()
        session_id = f"ses_{uuid.uuid4().hex}"
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO sessions (
                    session_id, github_user_id, status, phase, iterations_completed,
                    iterations_max, image_count, created_at, updated_at
                )
                VALUES (?, ?, 'queued', 'triage', 0, ?, ?, ?, ?)
                """,
                (session_id, github_user_id, iterations_max, image_count, now, now),
            )
            row = db.execute(
                """
                SELECT * FROM sessions
                WHERE session_id = ? AND github_user_id = ?
                """,
                (session_id, github_user_id),
            ).fetchone()
            return dict(row)

    def list_sessions(
        self,
        github_user_id: int,
        status: str | None,
        limit: int,
        cursor: str | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        limit = min(max(limit, 1), 100)
        values: list[Any] = [github_user_id]
        where = ["github_user_id = ?"]

        if status:
            where.append("status = ?")
            values.append(status)

        if cursor:
            where.append("created_at < ?")
            values.append(cursor)

        sql = f"""
            SELECT * FROM sessions
            WHERE {' AND '.join(where)}
            ORDER BY created_at DESC, session_id DESC
            LIMIT ?
        """
        values.append(limit + 1)

        with self._connect() as db:
            rows = [dict(row) for row in db.execute(sql, values).fetchall()]

        next_cursor = None
        if len(rows) > limit:
            next_cursor = rows[limit - 1]["created_at"]
            rows = rows[:limit]

        return rows, next_cursor

    def get_session_for_user(self, session_id: str, github_user_id: int) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """
                SELECT * FROM sessions
                WHERE session_id = ? AND github_user_id = ?
                """,
                (session_id, github_user_id),
            ).fetchone()
            return dict(row) if row else None

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            return dict(row) if row else None

    def update_session(self, session_id: str, **fields: Any) -> None:
        if not fields:
            return

        fields["updated_at"] = utc_now()
        assignments = ", ".join(f"{name} = ?" for name in fields)
        values = list(fields.values()) + [session_id]

        with self._connect() as db:
            db.execute(
                f"UPDATE sessions SET {assignments} WHERE session_id = ?",
                values,
            )

    @staticmethod
    def log_event(log_path: Path, event: dict[str, Any]) -> None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(event, sort_keys=True) + "\n")
