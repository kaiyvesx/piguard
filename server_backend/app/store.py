from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass, field
from time import time
from typing import Any, Dict, List, Optional
from uuid import uuid4


def now_ms() -> int:
    return int(time() * 1000)


@dataclass
class CommandItem:
    command_id: str
    device_id: str
    action: str
    payload: Dict[str, Any]
    status: str
    created_at: int
    source: str = "windows-admin"
    dispatched_at: Optional[int] = None
    completed_at: Optional[int] = None


@dataclass
class ResponseItem:
    command_id: str
    device_id: str
    action: str
    status: str
    result: Optional[Dict[str, Any]]
    error: Optional[Dict[str, Any]]
    executed_at: int
    received_at: int


@dataclass
class LogItem:
    id: str
    device_id: Optional[str]
    type: Optional[str]
    ts: Optional[int]
    payload: Dict[str, Any]
    received_at: int


class BaseStore:
    def enqueue_command(
        self,
        *,
        device_id: str,
        action: str,
        payload: Dict[str, Any],
        source: str,
        command_id: Optional[str] = None,
    ) -> CommandItem:
        raise NotImplementedError

    def fetch_next_command(self, device_id: str) -> Optional[CommandItem]:
        raise NotImplementedError

    def revert_dispatched_to_queued(self, item: CommandItem) -> None:
        raise NotImplementedError

    def save_response(
        self,
        *,
        command_id: str,
        device_id: str,
        action: str,
        status: str,
        result: Optional[Dict[str, Any]],
        error: Optional[Dict[str, Any]],
        executed_at: int,
    ) -> ResponseItem:
        raise NotImplementedError

    def save_log(self, payload: Dict[str, Any]) -> LogItem:
        raise NotImplementedError

    def list_commands(self, *, device_id: Optional[str], action: Optional[str], status: Optional[str]) -> List[CommandItem]:
        raise NotImplementedError

    def list_responses(self, *, device_id: Optional[str], command_id: Optional[str], action: Optional[str]) -> List[ResponseItem]:
        raise NotImplementedError

    def list_devices(self) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def list_logs(self, *, limit: int) -> List[LogItem]:
        raise NotImplementedError


@dataclass
class MemoryStore(BaseStore):
    queues: Dict[str, List[CommandItem]] = field(default_factory=lambda: defaultdict(list))
    commands: Dict[str, CommandItem] = field(default_factory=dict)
    responses: List[ResponseItem] = field(default_factory=list)
    logs: List[LogItem] = field(default_factory=list)
    devices: set[str] = field(default_factory=set)

    def _allocate_command_id(self, preferred: Optional[str]) -> str:
        if preferred and preferred not in self.commands:
            return preferred
        return str(uuid4())

    def enqueue_command(
        self,
        *,
        device_id: str,
        action: str,
        payload: Dict[str, Any],
        source: str,
        command_id: Optional[str] = None,
    ) -> CommandItem:
        cid = self._allocate_command_id(command_id)
        item = CommandItem(
            command_id=cid,
            device_id=device_id,
            action=action,
            payload=payload,
            status="queued",
            created_at=now_ms(),
            source=source,
        )
        self.devices.add(device_id)
        self.queues[device_id].append(item)
        self.commands[item.command_id] = item
        return item

    def fetch_next_command(self, device_id: str) -> Optional[CommandItem]:
        self.devices.add(device_id)
        for item in self.queues[device_id]:
            if item.status == "queued":
                item.status = "dispatched"
                item.dispatched_at = now_ms()
                self.commands[item.command_id] = item
                return item
        return None

    def revert_dispatched_to_queued(self, item: CommandItem) -> None:
        if item.status != "dispatched":
            return
        item.status = "queued"
        item.dispatched_at = None
        self.commands[item.command_id] = item

    def save_response(
        self,
        *,
        command_id: str,
        device_id: str,
        action: str,
        status: str,
        result: Optional[Dict[str, Any]],
        error: Optional[Dict[str, Any]],
        executed_at: int,
    ) -> ResponseItem:
        item = ResponseItem(
            command_id=command_id,
            device_id=device_id,
            action=action,
            status=status,
            result=result,
            error=error,
            executed_at=executed_at,
            received_at=now_ms(),
        )
        self.responses.append(item)
        self.devices.add(device_id)

        cmd = self.commands.get(command_id)
        if cmd is not None:
            cmd.status = "completed" if status == "success" else "error"
            cmd.completed_at = item.received_at
            self.commands[command_id] = cmd

        return item

    def save_log(self, payload: Dict[str, Any]) -> LogItem:
        device_id = payload.get("device_id") if isinstance(payload.get("device_id"), str) else None
        log_item = LogItem(
            id=str(uuid4()),
            device_id=device_id,
            type=payload.get("type") if isinstance(payload.get("type"), str) else None,
            ts=payload.get("ts") if isinstance(payload.get("ts"), int) else None,
            payload=payload,
            received_at=now_ms(),
        )
        if log_item.device_id:
            self.devices.add(log_item.device_id)
        self.logs.append(log_item)
        return log_item

    def list_commands(self, *, device_id: Optional[str], action: Optional[str], status: Optional[str]) -> List[CommandItem]:
        items = list(self.commands.values())
        if device_id:
            items = [x for x in items if x.device_id == device_id]
        if action:
            items = [x for x in items if x.action == action]
        if status:
            items = [x for x in items if x.status == status]
        return sorted(items, key=lambda x: x.created_at, reverse=True)

    def list_responses(self, *, device_id: Optional[str], command_id: Optional[str], action: Optional[str]) -> List[ResponseItem]:
        items = self.responses
        if device_id:
            items = [x for x in items if x.device_id == device_id]
        if command_id:
            items = [x for x in items if x.command_id == command_id]
        if action:
            items = [x for x in items if x.action == action]
        return sorted(items, key=lambda x: x.received_at, reverse=True)

    def list_devices(self) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for device_id in sorted(self.devices):
            queued = len([x for x in self.queues[device_id] if x.status == "queued"])
            latest_response = max((x.received_at for x in self.responses if x.device_id == device_id), default=0)
            latest_log = max((x.received_at for x in self.logs if x.device_id == device_id), default=0)
            last_seen = max(latest_response, latest_log) or None
            result.append(
                {
                    "device_id": device_id,
                    "queued": queued,
                    "last_seen_at": last_seen,
                }
            )
        return result

    def list_logs(self, *, limit: int) -> List[LogItem]:
        return sorted(self.logs, key=lambda x: x.received_at, reverse=True)[:limit]


class PostgresStore(BaseStore):
    def __init__(self, dsn: str) -> None:
        import psycopg

        self._psycopg = psycopg
        self._dsn = dsn
        self._ensure_schema()

    def _connect(self):
        return self._psycopg.connect(self._dsn)

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS devices (
                        device_id TEXT PRIMARY KEY,
                        created_at_ms BIGINT NOT NULL,
                        last_seen_at_ms BIGINT,
                        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
                    );
                    CREATE TABLE IF NOT EXISTS commands (
                        command_id TEXT PRIMARY KEY,
                        device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                        action TEXT NOT NULL,
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        source TEXT NOT NULL DEFAULT 'windows-admin',
                        status TEXT NOT NULL CHECK (status IN ('queued','dispatched','completed','error')),
                        created_at_ms BIGINT NOT NULL,
                        dispatched_at_ms BIGINT,
                        completed_at_ms BIGINT
                    );
                    CREATE TABLE IF NOT EXISTS command_responses (
                        command_id TEXT PRIMARY KEY REFERENCES commands(command_id) ON DELETE CASCADE,
                        device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
                        action TEXT NOT NULL,
                        status TEXT NOT NULL CHECK (status IN ('success','error')),
                        result JSONB,
                        error JSONB,
                        executed_at_ms BIGINT NOT NULL,
                        received_at_ms BIGINT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS device_logs (
                        id TEXT PRIMARY KEY,
                        device_id TEXT REFERENCES devices(device_id) ON DELETE SET NULL,
                        type TEXT,
                        ts_ms BIGINT,
                        payload JSONB NOT NULL,
                        received_at_ms BIGINT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_commands_device_status_created
                        ON commands (device_id, status, created_at_ms DESC);
                    CREATE INDEX IF NOT EXISTS idx_responses_device_received
                        ON command_responses (device_id, received_at_ms DESC);
                    CREATE INDEX IF NOT EXISTS idx_logs_device_received
                        ON device_logs (device_id, received_at_ms DESC);
                    """
                )
            conn.commit()

    def _ensure_device(self, cur, device_id: str, seen_at_ms: Optional[int] = None) -> None:
        cur.execute(
            """
            INSERT INTO devices (device_id, created_at_ms, last_seen_at_ms)
            VALUES (%s, %s, %s)
            ON CONFLICT (device_id)
            DO UPDATE SET last_seen_at_ms = GREATEST(devices.last_seen_at_ms, EXCLUDED.last_seen_at_ms);
            """,
            (device_id, now_ms(), seen_at_ms),
        )

    def _row_to_command(self, row) -> CommandItem:
        return CommandItem(
            command_id=row[0],
            device_id=row[1],
            action=row[2],
            payload=row[3] or {},
            status=row[4],
            created_at=row[5],
            source=row[6],
            dispatched_at=row[7],
            completed_at=row[8],
        )

    def enqueue_command(
        self,
        *,
        device_id: str,
        action: str,
        payload: Dict[str, Any],
        source: str,
        command_id: Optional[str] = None,
    ) -> CommandItem:
        cid = command_id or str(uuid4())
        created = now_ms()
        with self._connect() as conn:
            with conn.cursor() as cur:
                self._ensure_device(cur, device_id)
                cur.execute(
                    """
                    INSERT INTO commands (command_id, device_id, action, payload, source, status, created_at_ms)
                    VALUES (%s, %s, %s, %s::jsonb, %s, 'queued', %s)
                    RETURNING command_id, device_id, action, payload, status, created_at_ms, source, dispatched_at_ms, completed_at_ms;
                    """,
                    (cid, device_id, action, json.dumps(payload or {}), source, created),
                )
                row = cur.fetchone()
            conn.commit()
        return self._row_to_command(row)

    def fetch_next_command(self, device_id: str) -> Optional[CommandItem]:
        dispatched = now_ms()
        with self._connect() as conn:
            with conn.cursor() as cur:
                self._ensure_device(cur, device_id, dispatched)
                cur.execute(
                    """
                    WITH next_row AS (
                        SELECT command_id
                        FROM commands
                        WHERE device_id = %s AND status = 'queued'
                        ORDER BY created_at_ms ASC
                        LIMIT 1
                        FOR UPDATE SKIP LOCKED
                    )
                    UPDATE commands c
                    SET status = 'dispatched', dispatched_at_ms = %s
                    FROM next_row
                    WHERE c.command_id = next_row.command_id
                    RETURNING c.command_id, c.device_id, c.action, c.payload, c.status, c.created_at_ms, c.source, c.dispatched_at_ms, c.completed_at_ms;
                    """,
                    (device_id, dispatched),
                )
                row = cur.fetchone()
            conn.commit()
        if not row:
            return None
        return self._row_to_command(row)

    def revert_dispatched_to_queued(self, item: CommandItem) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE commands
                    SET status = 'queued', dispatched_at_ms = NULL
                    WHERE command_id = %s AND status = 'dispatched';
                    """,
                    (item.command_id,),
                )
            conn.commit()

    def save_response(
        self,
        *,
        command_id: str,
        device_id: str,
        action: str,
        status: str,
        result: Optional[Dict[str, Any]],
        error: Optional[Dict[str, Any]],
        executed_at: int,
    ) -> ResponseItem:
        received = now_ms()
        command_status = "completed" if status == "success" else "error"
        with self._connect() as conn:
            with conn.cursor() as cur:
                self._ensure_device(cur, device_id, received)
                cur.execute(
                    """
                    INSERT INTO command_responses (
                        command_id, device_id, action, status, result, error, executed_at_ms, received_at_ms
                    )
                    VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
                    ON CONFLICT (command_id) DO UPDATE
                    SET status = EXCLUDED.status,
                        result = EXCLUDED.result,
                        error = EXCLUDED.error,
                        executed_at_ms = EXCLUDED.executed_at_ms,
                        received_at_ms = EXCLUDED.received_at_ms
                    RETURNING command_id, device_id, action, status, result, error, executed_at_ms, received_at_ms;
                    """,
                    (
                        command_id,
                        device_id,
                        action,
                        status,
                        json.dumps(result) if result is not None else None,
                        json.dumps(error) if error is not None else None,
                        executed_at,
                        received,
                    ),
                )
                row = cur.fetchone()
                cur.execute(
                    """
                    UPDATE commands
                    SET status = %s, completed_at_ms = %s
                    WHERE command_id = %s;
                    """,
                    (command_status, received, command_id),
                )
            conn.commit()
        return ResponseItem(
            command_id=row[0],
            device_id=row[1],
            action=row[2],
            status=row[3],
            result=row[4],
            error=row[5],
            executed_at=row[6],
            received_at=row[7],
        )

    def save_log(self, payload: Dict[str, Any]) -> LogItem:
        lid = str(uuid4())
        device_id = payload.get("device_id") if isinstance(payload.get("device_id"), str) else None
        log_type = payload.get("type") if isinstance(payload.get("type"), str) else None
        ts = payload.get("ts") if isinstance(payload.get("ts"), int) else None
        received = now_ms()
        with self._connect() as conn:
            with conn.cursor() as cur:
                if device_id:
                    self._ensure_device(cur, device_id, received)
                cur.execute(
                    """
                    INSERT INTO device_logs (id, device_id, type, ts_ms, payload, received_at_ms)
                    VALUES (%s, %s, %s, %s, %s::jsonb, %s);
                    """,
                    (lid, device_id, log_type, ts, json.dumps(payload), received),
                )
            conn.commit()
        return LogItem(
            id=lid,
            device_id=device_id,
            type=log_type,
            ts=ts,
            payload=payload,
            received_at=received,
        )

    def list_commands(self, *, device_id: Optional[str], action: Optional[str], status: Optional[str]) -> List[CommandItem]:
        query = """
            SELECT command_id, device_id, action, payload, status, created_at_ms, source, dispatched_at_ms, completed_at_ms
            FROM commands
            WHERE (%s IS NULL OR device_id = %s)
              AND (%s IS NULL OR action = %s)
              AND (%s IS NULL OR status = %s)
            ORDER BY created_at_ms DESC;
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (device_id, device_id, action, action, status, status))
                rows = cur.fetchall()
        return [self._row_to_command(r) for r in rows]

    def list_responses(self, *, device_id: Optional[str], command_id: Optional[str], action: Optional[str]) -> List[ResponseItem]:
        query = """
            SELECT command_id, device_id, action, status, result, error, executed_at_ms, received_at_ms
            FROM command_responses
            WHERE (%s IS NULL OR device_id = %s)
              AND (%s IS NULL OR command_id = %s)
              AND (%s IS NULL OR action = %s)
            ORDER BY received_at_ms DESC;
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (device_id, device_id, command_id, command_id, action, action))
                rows = cur.fetchall()
        return [
            ResponseItem(
                command_id=r[0],
                device_id=r[1],
                action=r[2],
                status=r[3],
                result=r[4],
                error=r[5],
                executed_at=r[6],
                received_at=r[7],
            )
            for r in rows
        ]

    def list_devices(self) -> List[Dict[str, Any]]:
        query = """
            SELECT
                d.device_id,
                (
                    SELECT count(*)
                    FROM commands c
                    WHERE c.device_id = d.device_id AND c.status = 'queued'
                ) AS queued,
                GREATEST(
                    COALESCE(d.last_seen_at_ms, 0),
                    COALESCE((SELECT max(r.received_at_ms) FROM command_responses r WHERE r.device_id = d.device_id), 0),
                    COALESCE((SELECT max(l.received_at_ms) FROM device_logs l WHERE l.device_id = d.device_id), 0)
                ) AS last_seen_at
            FROM devices d
            ORDER BY d.device_id ASC;
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(query)
                rows = cur.fetchall()
        return [{"device_id": r[0], "queued": int(r[1]), "last_seen_at": int(r[2]) if r[2] else None} for r in rows]

    def list_logs(self, *, limit: int) -> List[LogItem]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, device_id, type, ts_ms, payload, received_at_ms
                    FROM device_logs
                    ORDER BY received_at_ms DESC
                    LIMIT %s;
                    """,
                    (limit,),
                )
                rows = cur.fetchall()
        return [
            LogItem(
                id=r[0],
                device_id=r[1],
                type=r[2],
                ts=r[3],
                payload=r[4] if isinstance(r[4], dict) else {},
                received_at=r[5],
            )
            for r in rows
        ]


def build_store_from_env() -> BaseStore:
    dsn = os.getenv("DATABASE_URL", "").strip()
    if not dsn:
        return MemoryStore()
    return PostgresStore(dsn)


store: BaseStore = build_store_from_env()
