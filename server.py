#!/usr/bin/env python3
"""Serve Daylight and persist each browser profile's planner data in SQLite."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import date, datetime, time, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DAYLIGHT_DATA_DIR", ROOT / "data")).expanduser().resolve()
DATABASE_PATH = DATA_DIR / "daylight.sqlite3"
MAX_REQUEST_BYTES = 2_000_000
MAX_TASKS = 2_000
THEMES = {"fern", "ocean", "lavender", "sunset"}
CATEGORIES = {"Work", "Personal", "Wellbeing", "Other"}
PRIORITIES = {"high", "medium", "low"}
PUBLIC_FILES = {"/", "/index.html", "/app.js", "/styles.css"}


def connect_database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect_database() as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS planner_data (
                user_id TEXT PRIMARY KEY,
                tasks_json TEXT NOT NULL,
                reminder_state_json TEXT NOT NULL,
                theme TEXT NOT NULL DEFAULT 'fern',
                updated_at TEXT NOT NULL
            )
            """
        )


def validate_document(document: object) -> tuple[list[dict], dict[str, str], str]:
    if not isinstance(document, dict):
        raise ValueError("The request must be a JSON object.")

    tasks = document.get("tasks")
    if not isinstance(tasks, list) or len(tasks) > MAX_TASKS:
        raise ValueError(f"Tasks must be a list with no more than {MAX_TASKS} items.")

    seen_ids: set[str] = set()
    for task in tasks:
        if not isinstance(task, dict):
            raise ValueError("Each task must be an object.")
        task_id = task.get("id")
        title = task.get("title")
        task_date = task.get("date")
        if not isinstance(task_id, str) or not task_id or len(task_id) > 100 or task_id in seen_ids:
            raise ValueError("Each task must have a unique, valid id.")
        seen_ids.add(task_id)
        if not isinstance(title, str) or not title.strip() or len(title) > 160:
            raise ValueError("Each task must have a title of 1 to 160 characters.")
        if not isinstance(task_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", task_date):
            raise ValueError("Each task must have a date in YYYY-MM-DD format.")
        try:
            date.fromisoformat(task_date)
        except ValueError as error:
            raise ValueError("A task has an invalid calendar date.") from error

        task_time = task.get("time", "")
        if not isinstance(task_time, str):
            raise ValueError("Task time must be a string.")
        if task_time:
            try:
                time.fromisoformat(task_time)
            except ValueError as error:
                raise ValueError("A task has an invalid time.") from error

        category = task.get("category", "Other")
        if not isinstance(category, str) or category not in CATEGORIES:
            raise ValueError("A task has an invalid category.")
        priority = task.get("priority", "medium")
        if not isinstance(priority, str) or priority not in PRIORITIES:
            raise ValueError("A task has an invalid priority.")
        if not isinstance(task.get("completed", False), bool):
            raise ValueError("Task completion must be true or false.")
        duration = task.get("duration", 30)
        if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= 600:
            raise ValueError("Task duration must be between 1 and 600 minutes.")
        reminder = task.get("reminder")
        if reminder is not None and (isinstance(reminder, bool) or not isinstance(reminder, int) or reminder not in {0, 5, 10, 30}):
            raise ValueError("Task reminder must be 0, 5, 10, 30, or null.")

    reminder_state = document.get("reminderState", {})
    if not isinstance(reminder_state, dict) or len(reminder_state) > MAX_TASKS * 2:
        raise ValueError("Reminder state must be a valid object.")
    if any(not isinstance(key, str) or len(key) > 100 or not isinstance(value, str) or len(value) > 128
           for key, value in reminder_state.items()):
        raise ValueError("Reminder state contains an invalid entry.")

    theme = document.get("theme", "fern")
    if not isinstance(theme, str) or theme not in THEMES:
        raise ValueError("Theme must be fern, ocean, lavender, or sunset.")

    return tasks, reminder_state, theme


class DaylightHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        route = urlsplit(path).path
        if route not in PUBLIC_FILES:
            return str(ROOT / "__not_found__")
        return str(ROOT / ("index.html" if route == "/" else route.lstrip("/")))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _user_id(self) -> str | None:
        value = self.headers.get("X-User-ID", "")
        try:
            parsed = uuid.UUID(value)
        except (ValueError, AttributeError):
            return None
        return str(parsed)

    def _read_document(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length header."})
            return None
        if length < 1 or length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "Request must contain a JSON body smaller than 2 MB."})
            return None
        try:
            document = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "Request body must be valid JSON."})
            return None
        try:
            validate_document(document)
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return None
        return document

    def do_GET(self) -> None:
        route = urlsplit(self.path).path
        if route == "/api/health":
            self._send_json(200, {"status": "ok", "database": "sqlite"})
            return
        if route != "/api/tasks":
            if route not in PUBLIC_FILES:
                self._send_json(404, {"error": "Not found."})
                return
            super().do_GET()
            return

        user_id = self._user_id()
        if user_id is None:
            self._send_json(401, {"error": "A valid planner identity is required."})
            return
        with connect_database() as connection:
            row = connection.execute(
                "SELECT tasks_json, reminder_state_json, theme, updated_at "
                "FROM planner_data WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        if row is None:
            self._send_json(200, {"exists": False, "tasks": [], "reminderState": {}, "theme": "fern"})
            return
        self._send_json(
            200,
            {
                "exists": True,
                "tasks": json.loads(row["tasks_json"]),
                "reminderState": json.loads(row["reminder_state_json"]),
                "theme": row["theme"],
                "updatedAt": row["updated_at"],
            },
        )

    def do_PUT(self) -> None:
        if urlsplit(self.path).path != "/api/tasks":
            self._send_json(404, {"error": "Not found."})
            return
        user_id = self._user_id()
        if user_id is None:
            self._send_json(401, {"error": "A valid planner identity is required."})
            return
        document = self._read_document()
        if document is None:
            return
        tasks, reminder_state, theme = validate_document(document)
        updated_at = datetime.now(timezone.utc).isoformat()
        with connect_database() as connection:
            connection.execute(
                """
                INSERT INTO planner_data (user_id, tasks_json, reminder_state_json, theme, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    tasks_json = excluded.tasks_json,
                    reminder_state_json = excluded.reminder_state_json,
                    theme = excluded.theme,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    json.dumps(tasks, separators=(",", ":"), ensure_ascii=False),
                    json.dumps(reminder_state, separators=(",", ":"), ensure_ascii=False),
                    theme,
                    updated_at,
                ),
            )
        self._send_json(200, {"saved": True, "updatedAt": updated_at})

    def log_message(self, format: str, *args) -> None:
        super().log_message(format, *args)


def main() -> None:
    initialize_database()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer((host, port), DaylightHandler)
    print(f"Daylight is listening on http://{host}:{port}")
    print(f"SQLite data directory: {DATA_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Daylight.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
