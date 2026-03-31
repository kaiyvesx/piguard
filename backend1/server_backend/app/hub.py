from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from typing import Any, DefaultDict, Dict, List, Set

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from .sqlite_log import AuditLog


class RealtimeHub:
    """
    Routes admin → device commands and device → admin responses.
    Queues outbound commands when the device socket is offline.
    """

    def __init__(self, audit: AuditLog) -> None:
        self._audit = audit
        self._lock = asyncio.Lock()
        self._devices: Dict[str, WebSocket] = {}
        self._admins: Set[WebSocket] = set()
        self._pending: DefaultDict[str, List[Dict[str, Any]]] = defaultdict(list)

    async def add_admin(self, ws: WebSocket) -> None:
        async with self._lock:
            self._admins.add(ws)

    async def remove_admin(self, ws: WebSocket) -> None:
        async with self._lock:
            self._admins.discard(ws)

    async def bind_device(self, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._devices[device_id] = ws
        await self._flush_pending(device_id)

    async def unbind_device(self, device_id: str, ws: WebSocket) -> None:
        async with self._lock:
            if self._devices.get(device_id) is ws:
                del self._devices[device_id]

    async def _flush_pending(self, device_id: str) -> None:
        async with self._lock:
            to_send = list(self._pending[device_id])
            self._pending[device_id].clear()
            ws = self._devices.get(device_id)
            ws_connected = ws is not None and ws.client_state == WebSocketState.CONNECTED

        if not to_send:
            return

        if not ws_connected:
            async with self._lock:
                self._pending[device_id] = to_send + self._pending[device_id]
            return

        assert ws is not None
        for idx, item in enumerate(to_send):
            try:
                await self._send_json(ws, item)
            except Exception:
                # Socket state may have changed after we released the lock.
                # Requeue this and remaining unsent items in original order.
                unsent = to_send[idx:]
                async with self._lock:
                    self._pending[device_id] = unsent + self._pending[device_id]
                return

    async def admin_issue_command(
        self,
        *,
        device_id: str,
        action: str,
        request_id: str,
        payload: Dict[str, Any],
    ) -> None:
        envelope = {
            "type": "command",
            "action": action,
            "request_id": request_id,
            "payload": payload,
        }
        self._audit.write(
            event_type="command_issued",
            device_id=device_id,
            request_id=request_id,
            action=action,
            payload=envelope,
        )

        live_ws: WebSocket | None = None
        queued = False
        async with self._lock:
            target = self._devices.get(device_id)
            if target is None or target.client_state != WebSocketState.CONNECTED:
                self._pending[device_id].append(envelope)
                queued = True
            else:
                live_ws = target

        if queued:
            await self._broadcast_admins(
                {
                    "type": "command_queued",
                    "request_id": request_id,
                    "device_id": device_id,
                    "action": action,
                    "message": "Device offline; command will be delivered when the device reconnects.",
                }
            )
            return

        assert live_ws is not None
        await self._send_json(live_ws, envelope)

    async def device_responded(self, message: Dict[str, Any]) -> None:
        self._audit.write(
            event_type="command_response",
            device_id=str(message.get("device_id") or ""),
            request_id=str(message.get("request_id") or ""),
            action=str(message.get("action") or ""),
            payload=message,
        )
        await self._broadcast_admins(message)

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


def new_request_id() -> str:
    return str(uuid.uuid4())
