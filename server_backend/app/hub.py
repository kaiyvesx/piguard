from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List, Set

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from .sqlite_log import AuditLog
from .store import CommandItem, MemoryStore, ResponseItem, now_ms


def new_request_id() -> str:
    return str(uuid.uuid4())


def _envelope_from_command_item(item: CommandItem) -> Dict[str, Any]:
    return {
        "type": "command",
        "action": item.action,
        "request_id": item.command_id,
        "payload": item.payload,
    }


class RealtimeHub:
    """
    WebSocket routing + shared MemoryStore with HTTP polling.
    Commands are always enqueued in the store; WebSocket delivers queued items when connected.
    """

    def __init__(self, audit: AuditLog, store: MemoryStore) -> None:
        self._audit = audit
        self._store = store
        self._lock = asyncio.Lock()
        self._devices: Dict[str, WebSocket] = {}
        self._admins: Set[WebSocket] = set()

    async def add_admin(self, ws: WebSocket) -> None:
        async with self._lock:
            self._admins.add(ws)

    async def remove_admin(self, ws: WebSocket) -> None:
        async with self._lock:
            self._admins.discard(ws)

    async def bind_device(self, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._devices[device_id] = ws
        await self._deliver_store_queue_to_ws(device_id)

    async def unbind_device(self, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            if self._devices.get(device_id) is ws:
                del self._devices[device_id]

    async def _device_ws(self, device_id: str) -> WebSocket | None:
        async with self._lock:
            ws = self._devices.get(device_id)
            if ws is None or ws.client_state != WebSocketState.CONNECTED:
                return None
            return ws

    async def _deliver_store_queue_to_ws(self, device_id: str) -> None:
        while True:
            ws = await self._device_ws(device_id)
            if ws is None:
                return

            item = self._store.fetch_next_command(device_id)
            if item is None:
                return

            envelope = _envelope_from_command_item(item)
            try:
                await ws.send_json(envelope)
            except Exception:
                self._store.revert_dispatched_to_queued(item)
                return

    async def admin_issue_command(
        self,
        *,
        device_id: str,
        action: str,
        request_id: str,
        payload: Dict[str, Any],
        source: str = "admin",
    ) -> CommandItem:
        item = self._store.enqueue_command(
            device_id=device_id,
            action=action,
            payload=payload,
            source=source,
            command_id=request_id,
        )
        envelope = _envelope_from_command_item(item)

        self._audit.write(
            event_type="command_issued",
            device_id=device_id,
            request_id=item.command_id,
            action=action,
            payload=envelope,
        )

        ws = await self._device_ws(device_id)
        if ws is None:
            await self._broadcast_admins(
                {
                    "type": "command_queued",
                    "request_id": item.command_id,
                    "device_id": device_id,
                    "action": action,
                    "message": "Device offline; command will be delivered when the device reconnects.",
                }
            )
            return item

        await self._deliver_store_queue_to_ws(device_id)
        return item

    async def relay_device_response_from_normalized(self, msg: Dict[str, Any]) -> ResponseItem:
        status = msg.get("status")
        if status not in ("success", "error"):
            status = "error"

        executed_at = msg.get("executed_at")
        if not isinstance(executed_at, int):
            executed_at = now_ms()

        err = msg.get("error") if status == "error" else None
        raw_data = msg.get("data") if status == "success" else None
        if isinstance(raw_data, dict):
            result: Dict[str, Any] | None = raw_data
        elif raw_data is None:
            result = {}
        else:
            result = {"value": raw_data}

        saved = self._store.save_response(
            command_id=str(msg["request_id"]),
            device_id=str(msg["device_id"]),
            action=str(msg.get("action") or ""),
            status=status,
            result=result if status == "success" else None,
            error=err if isinstance(err, dict) else None,
            executed_at=executed_at,
        )

        self._audit.write(
            event_type="command_response",
            device_id=str(msg.get("device_id") or ""),
            request_id=str(msg.get("request_id") or ""),
            action=str(msg.get("action") or ""),
            payload=msg,
        )
        out = {**msg, "type": msg.get("type") or "command_response"}
        await self._broadcast_admins(out)
        return saved

    async def notify_admin_error(
        self,
        *,
        request_id: str,
        device_id: str,
        action: str,
        code: str,
        message: str,
    ) -> None:
        body = {
            "type": "command_response",
            "request_id": request_id,
            "device_id": device_id,
            "action": action,
            "status": "error",
            "error": {"code": code, "message": message},
            "executed_at": now_ms(),
        }
        self._audit.write(
            event_type="command_response_synthetic",
            device_id=device_id,
            request_id=request_id,
            action=action,
            payload=body,
        )
        await self._broadcast_admins(body)

    async def _broadcast_admins(self, message: Dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._admins)
        dead: List[WebSocket] = []
        for ws in targets:
            if ws.client_state != WebSocketState.CONNECTED:
                dead.append(ws)
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.remove_admin(ws)

    @staticmethod
    async def _send_json(ws: WebSocket, payload: Dict[str, Any]) -> None:
        await ws.send_json(payload)
