from __future__ import annotations

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
    user_id: str
    action: str
    payload: Dict[str, Any]
    status: str
    created_at: int
    device_id: Optional[str] = None
    device_name: Optional[str] = None
    source: str = "windows-admin"
    dispatched_at: Optional[int] = None
    completed_at: Optional[int] = None


@dataclass
class ResponseItem:
    command_id: str
    user_id: str
    action: str
    status: str
    device_id: Optional[str]
    device_name: Optional[str]
    result: Optional[Dict[str, Any]]
    error: Optional[Dict[str, Any]]
    executed_at: int
    received_at: int


@dataclass
class LogItem:
    id: str
    user_id: Optional[str]
    device_id: Optional[str]
    device_name: Optional[str]
    type: Optional[str]
    ts: Optional[int]
    payload: Dict[str, Any]
    received_at: int


@dataclass
class MemoryStore:
    queues: Dict[str, List[CommandItem]] = field(default_factory=lambda: defaultdict(list))
    commands: Dict[str, CommandItem] = field(default_factory=dict)
    responses: List[ResponseItem] = field(default_factory=list)
    logs: List[LogItem] = field(default_factory=list)
    users: set[str] = field(default_factory=set)
    active_devices_by_user: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    def _allocate_command_id(self, preferred: Optional[str]) -> str:
        if preferred and preferred not in self.commands:
            return preferred
        return str(uuid4())

    def enqueue_command(
        self,
        *,
        user_id: str,
        action: str,
        payload: Dict[str, Any],
        source: str,
        device_id: Optional[str] = None,
        device_name: Optional[str] = None,
        command_id: Optional[str] = None,
    ) -> CommandItem:
        cid = self._allocate_command_id(command_id)
        item = CommandItem(
            command_id=cid,
            user_id=user_id,
            action=action,
            payload=payload,
            status="queued",
            created_at=now_ms(),
            device_id=device_id,
            device_name=device_name,
            source=source,
        )
        self.users.add(user_id)
        self.queues[user_id].append(item)
        self.commands[item.command_id] = item
        return item

    def fetch_next_command(self, user_id: str) -> Optional[CommandItem]:
        self.users.add(user_id)
        for item in self.queues[user_id]:
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
        user_id: str,
        action: str,
        status: str,
        device_id: Optional[str],
        device_name: Optional[str],
        result: Optional[Dict[str, Any]],
        error: Optional[Dict[str, Any]],
        executed_at: int,
    ) -> ResponseItem:
        item = ResponseItem(
            command_id=command_id,
            user_id=user_id,
            action=action,
            status=status,
            device_id=device_id,
            device_name=device_name,
            result=result,
            error=error,
            executed_at=executed_at,
            received_at=now_ms(),
        )
        self.responses.append(item)
        self.users.add(user_id)

        cmd = self.commands.get(command_id)
        if cmd is not None:
            cmd.status = "completed" if status == "success" else "error"
            cmd.completed_at = item.received_at
            cmd.device_id = device_id or cmd.device_id
            cmd.device_name = device_name or cmd.device_name
            self.commands[command_id] = cmd

        return item

    def save_log(self, payload: Dict[str, Any]) -> LogItem:
        user_id = payload.get("user_id") if isinstance(payload.get("user_id"), str) else None
        device_id = payload.get("device_id") if isinstance(payload.get("device_id"), str) else None
        device_name = payload.get("device_name") if isinstance(payload.get("device_name"), str) else None
        log_item = LogItem(
            id=str(uuid4()),
            user_id=user_id,
            device_id=device_id,
            device_name=device_name,
            type=payload.get("type") if isinstance(payload.get("type"), str) else None,
            ts=payload.get("ts") if isinstance(payload.get("ts"), int) else None,
            payload=payload,
            received_at=now_ms(),
        )
        if log_item.user_id:
            self.users.add(log_item.user_id)
        self.logs.append(log_item)
        return log_item

    def remember_active_device(
        self,
        *,
        user_id: str,
        device_id: Optional[str],
        device_name: Optional[str],
    ) -> None:
        self.users.add(user_id)
        self.active_devices_by_user[user_id] = {
            "user_id": user_id,
            "device_id": device_id,
            "device_name": device_name,
            "last_seen_at": now_ms(),
        }

    def forget_active_device(self, user_id: str, device_id: Optional[str]) -> None:
        current = self.active_devices_by_user.get(user_id)
        if current is None:
            return
        if current.get("device_id") == device_id:
            del self.active_devices_by_user[user_id]

    def get_active_device(self, user_id: str) -> Optional[Dict[str, Any]]:
        return self.active_devices_by_user.get(user_id)

    def list_commands(self, *, user_id: Optional[str], action: Optional[str], status: Optional[str]) -> List[CommandItem]:
        items = list(self.commands.values())
        if user_id:
            items = [x for x in items if x.user_id == user_id]
        if action:
            items = [x for x in items if x.action == action]
        if status:
            items = [x for x in items if x.status == status]
        return sorted(items, key=lambda x: x.created_at, reverse=True)

    def list_responses(self, *, user_id: Optional[str], command_id: Optional[str], action: Optional[str]) -> List[ResponseItem]:
        items = self.responses
        if user_id:
            items = [x for x in items if x.user_id == user_id]
        if command_id:
            items = [x for x in items if x.command_id == command_id]
        if action:
            items = [x for x in items if x.action == action]
        return sorted(items, key=lambda x: x.received_at, reverse=True)

    def list_users(self) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for user_id in sorted(self.users):
            queued = len([x for x in self.queues[user_id] if x.status == "queued"])
            latest_response = max((x.received_at for x in self.responses if x.user_id == user_id), default=0)
            latest_log = max((x.received_at for x in self.logs if x.user_id == user_id), default=0)
            last_seen = max(latest_response, latest_log) or None
            active_device = self.active_devices_by_user.get(user_id) or {}
            result.append(
                {
                    "user_id": user_id,
                    "queued": queued,
                    "last_seen_at": last_seen,
                    "device_id": active_device.get("device_id"),
                    "device_name": active_device.get("device_name"),
                }
            )
        return result


store = MemoryStore()
