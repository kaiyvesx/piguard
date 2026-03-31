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


@dataclass
class MemoryStore:
    queues: Dict[str, List[CommandItem]] = field(default_factory=lambda: defaultdict(list))
    commands: Dict[str, CommandItem] = field(default_factory=dict)
    responses: List[ResponseItem] = field(default_factory=list)
    logs: List[LogItem] = field(default_factory=list)
    devices: set[str] = field(default_factory=set)

    def enqueue_command(self, *, device_id: str, action: str, payload: Dict[str, Any], source: str) -> CommandItem:
        item = CommandItem(
            command_id=str(uuid4()),
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
        item = LogItem(
            id=str(uuid4()),
            device_id=device_id,
            type=payload.get("type") if isinstance(payload.get("type"), str) else None,
            ts=payload.get("ts") if isinstance(payload.get("ts"), int) else None,
            payload=payload,
            received_at=now_ms(),
        )
        if item.device_id:
            self.devices.add(item.device_id)
        self.logs.append(item)
        return item

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
            result.append({
                "device_id": device_id,
                "queued": queued,
                "last_seen_at": last_seen,
            })
        return result


store = MemoryStore()
