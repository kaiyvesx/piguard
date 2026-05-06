from __future__ import annotations

import json
import os
import sqlite3
import threading
from typing import Any, Dict, Optional


class AuditLog:
    """Thread-safe SQLite append-only audit log for commands and responses."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.Lock()
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def _init_schema(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS audit_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        created_at_ms INTEGER NOT NULL,
                        event_type TEXT NOT NULL,
                        device_id TEXT,
                        request_id TEXT,
                        action TEXT,
                        payload_json TEXT NOT NULL
                    );
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_audit_device ON audit_events(device_id);"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);"
                )
                conn.commit()
            finally:
                conn.close()

    def write(
        self,
        *,
        event_type: str,
        payload: Dict[str, Any],
        device_id: Optional[str] = None,
        request_id: Optional[str] = None,
        action: Optional[str] = None,
    ) -> None:
        import time

        created_at_ms = int(time.time() * 1000)
        blob = json.dumps(payload, separators=(",", ":"), default=str)
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO audit_events (created_at_ms, event_type, device_id, request_id, action, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?);
                    """,
                    (created_at_ms, event_type, device_id, request_id, action, blob),
                )
                conn.commit()
            finally:
                conn.close()


def audit_log_from_env() -> AuditLog:
    path = os.getenv("SQLITE_PATH", "./data/command_audit.db")
    return AuditLog(path)
