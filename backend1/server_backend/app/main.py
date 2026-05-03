from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .auth_tokens import validate_admin_token, validate_mobile_token
from .hub import RealtimeHub, new_request_id
from .sqlite_log import audit_log_from_env

load_dotenv()

audit = audit_log_from_env()
hub = RealtimeHub(audit)

app = FastAPI(title="Remote Device Realtime Backend", version="1.0.0")

raw_origins = os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:3000,http://localhost:5173")
cors_allow_origins: List[str] = [o.strip() for o in raw_origins.split(",") if o.strip()]
if not cors_allow_origins:
    cors_allow_origins = ["http://localhost:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[7:].strip()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "remote-device-ws-backend"}


class AdminHttpCommand(BaseModel):
    device_id: str = Field(min_length=1)
    action: str = Field(min_length=1)
    request_id: Optional[str] = None
    payload: Dict[str, Any] = Field(default_factory=dict)


@app.post("/admin/command")
async def admin_command_http(
    body: AdminHttpCommand,
    authorization: str | None = Header(default=None),
) -> Dict[str, Any]:
    if not validate_admin_token(_bearer(authorization)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    request_id = body.request_id or new_request_id()
    await hub.admin_issue_command(
        device_id=body.device_id,
        action=body.action,
        request_id=request_id,
        payload=body.payload,
    )
    return {"ok": True, "request_id": request_id, "device_id": body.device_id, "action": body.action}

async def _close_unauthorized(ws: WebSocket, code: int = 4401) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


@app.websocket("/ws/admin")
async def ws_admin(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        raw = await websocket.receive_json()
    except Exception:
        await _close_unauthorized(websocket)
        return

    if raw.get("type") != "hello" or raw.get("role") != "admin":
        await _close_unauthorized(websocket, code=4400)
        return

    token = raw.get("token") if isinstance(raw.get("token"), str) else None
    if not token and isinstance(raw.get("bearer"), str):
        token = raw.get("bearer")

    if not validate_admin_token(token):
        await _close_unauthorized(websocket)
        return

    await hub.add_admin(websocket)
    await websocket.send_json({"type": "ready"})

    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            device_id = msg.get("device_id")
            action = msg.get("action")
            if msg.get("type") == "command_request" or (device_id and action):
                if not device_id or not action:
                    await websocket.send_json({"type": "error", "message": "device_id and action are required"})
                    continue

                request_id = msg.get("request_id") if isinstance(msg.get("request_id"), str) else None
                request_id = request_id or new_request_id()
                payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}

                await hub.admin_issue_command(
                    device_id=str(device_id),
                    action=str(action),
                    request_id=request_id,
                    payload=payload,
                )
                await websocket.send_json(
                    {
                        "type": "accepted",
                        "request_id": request_id,
                        "device_id": str(device_id),
                        "action": str(action),
                    }
                )
            else:
                await websocket.send_json({"type": "error", "message": "unrecognized_message"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove_admin(websocket)


def _normalize_device_response(device_id: str, msg: Dict[str, Any]) -> Dict[str, Any] | None:
    request_id = msg.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip():
        return None

    action = msg.get("action") if isinstance(msg.get("action"), str) else ""

    looks_like_response = (
        msg.get("type") == "command_response"
        or "data" in msg
        or "result" in msg
        or "error" in msg
        or msg.get("status") in ("success", "error")
    )
    if not looks_like_response:
        return None

    err = msg.get("error")
    explicit_status = msg.get("status")
    data = msg.get("data")
    if data is None and msg.get("result") is not None:
        data = msg.get("result")

    if explicit_status == "error" or (explicit_status != "success" and bool(err)):
        status_val = "error"
    elif explicit_status == "success":
        status_val = "success"
    else:
        status_val = "success"

    normalized: Dict[str, Any] = {
        "type": "command_response",
        "request_id": request_id.strip(),
        "device_id": device_id,
        "action": action,
        "status": status_val,
    }

    if status_val == "error":
        if isinstance(err, dict):
            normalized["error"] = err
        else:
            normalized["error"] = {"code": "error", "message": str(err) if err else "Unknown error"}
    else:
        normalized["data"] = data if isinstance(data, dict) else ({} if data is None else {"value": data})

    return normalized


@app.websocket("/ws/device")
async def ws_device(websocket: WebSocket) -> None:
    await websocket.accept()
    device_id: str | None = None

    try:
        raw = await websocket.receive_json()
    except Exception:
        await _close_unauthorized(websocket)
        return

    if raw.get("type") != "hello" or raw.get("role") not in ("device", "mobile"):
        await _close_unauthorized(websocket, code=4400)
        return

    did = raw.get("device_id")
    if not isinstance(did, str) or not did.strip():
        await _close_unauthorized(websocket, code=4400)
        return

    token = raw.get("token") if isinstance(raw.get("token"), str) else None
    if not token and isinstance(raw.get("bearer"), str):
        token = raw.get("bearer")

    if not validate_mobile_token(token):
        await _close_unauthorized(websocket)
        return

    device_id = did.strip()
    await hub.bind_device(device_id, websocket)
    await websocket.send_json({"type": "ready", "device_id": device_id})

    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            normalized = _normalize_device_response(device_id, msg)
            if normalized is None:
                continue

            await hub.device_responded(normalized)
    except WebSocketDisconnect:
        pass
    finally:
        if device_id is not None:
            await hub.unbind_device(device_id, websocket)


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
