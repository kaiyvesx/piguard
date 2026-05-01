from __future__ import annotations

import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .auth_tokens import validate_admin_token, validate_mobile_token
from .http_auth import require_admin_auth, require_mobile_auth
from .hub import RealtimeHub, new_request_id
from .models import AdminCommandCreate, CommandResponseIn, DeviceLogIn
from .sqlite_log import audit_log_from_env
from .store import now_ms, store
from .supabase_tracking import tracking_store_from_env

load_dotenv()

audit = audit_log_from_env()
hub = RealtimeHub(audit, store)
tracking_store = tracking_store_from_env()

app = FastAPI(title="Remote Device Backend", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    return {
        "ok": True,
        "service": "remote-device-backend",
        "now": __import__("time").time_ns() // 1_000_000,
    }


@app.get("/command", dependencies=[Depends(require_mobile_auth)])
def get_command(user_id: str = Query(..., min_length=1)):
    item = store.fetch_next_command(user_id=user_id)
    if item is None:
        return Response(status_code=204)

    return {
        "command_id": item.command_id,
        "user_id": item.user_id,
        "device_id": item.device_id,
        "device_name": item.device_name,
        "action": item.action,
        "payload": item.payload,
        "issued_at": item.created_at,
    }


@app.post("/response", dependencies=[Depends(require_mobile_auth)], status_code=201)
async def post_response(body: CommandResponseIn):
    msg: Dict[str, Any] = {
        "type": "command_response",
        "request_id": body.command_id,
        "user_id": body.user_id,
        "device_id": body.device_id,
        "device_name": body.device_name,
        "action": body.action,
        "status": body.status,
        "executed_at": body.executed_at,
    }
    if body.status == "success":
        msg["data"] = body.result if body.result is not None else {}
    else:
        msg["error"] = body.error if isinstance(body.error, dict) else {"code": "error", "message": "Unknown error"}

    saved = await hub.relay_device_response_from_normalized(msg)
    return {"ok": True, "response": saved.__dict__}


@app.post("/logs", dependencies=[Depends(require_mobile_auth)], status_code=201)
async def post_logs(payload: DeviceLogIn):
    body = payload.model_dump(exclude_none=True)
    item = store.save_log(body)
    event_action = body.get("action") if isinstance(body.get("action"), str) else None
    event_type = body.get("type") if isinstance(body.get("type"), str) else None
    tracking_events = {
        "tracking_request",
        "location_update",
        "tracking_session_end",
    }
    # For location updates, buffer on the server (to reduce Supabase writes).
    if event_type == "location_update" and tracking_store is not None and body.get("user_id"):
        try:
            if hasattr(tracking_store, "buffer_location_update"):
                tracking_store.buffer_location_update(body)
            else:
                tracking_store.insert_location_update(body)
        except Exception:
            # Keep log ingestion available even if Supabase is temporarily unavailable.
            pass

    # On explicit tracking session end, flush buffered history for the user.
    if event_type == "tracking_session_end" and tracking_store is not None and body.get("user_id"):
        try:
            if hasattr(tracking_store, "flush_user_history"):
                tracking_store.flush_user_history(body.get("user_id"))
        except Exception:
            pass
    if (event_action in tracking_events) or (event_type in tracking_events):
        await hub.relay_device_event(
            {
                "user_id": body.get("user_id"),
                "device_id": body.get("device_id"),
                "device_name": body.get("device_name"),
                "action": event_action,
                "event": event_type,
                "payload": body,
                "received_at": item.received_at,
            }
        )
    return {"ok": True, "log_id": item.id}


@app.post("/admin/commands", dependencies=[Depends(require_admin_auth)], status_code=201)
async def admin_create_command(body: AdminCommandCreate):
    rid = body.request_id or new_request_id()
    item = await hub.admin_issue_command(
        user_id=body.user_id,
        action=body.action,
        request_id=rid,
        payload=body.payload,
        source=body.source,
    )
    return {"ok": True, "command": item.__dict__}


@app.get("/admin/commands", dependencies=[Depends(require_admin_auth)])
def admin_list_commands(
    user_id: Optional[str] = None,
    action: Optional[str] = None,
    status: Optional[str] = None,
):
    items = [x.__dict__ for x in store.list_commands(user_id=user_id, action=action, status=status)]
    return {"ok": True, "count": len(items), "commands": items}


@app.get("/admin/responses", dependencies=[Depends(require_admin_auth)])
def admin_list_responses(
    user_id: Optional[str] = None,
    command_id: Optional[str] = None,
    action: Optional[str] = None,
):
    items = [x.__dict__ for x in store.list_responses(user_id=user_id, command_id=command_id, action=action)]
    return {"ok": True, "count": len(items), "responses": items}


@app.get("/admin/users", dependencies=[Depends(require_admin_auth)])
def admin_list_users():
    items = store.list_users()
    return {"ok": True, "count": len(items), "users": items}


@app.get("/admin/logs", dependencies=[Depends(require_admin_auth)])
def admin_list_logs(
    limit: int = Query(default=200, ge=1, le=1000),
    user_id: Optional[str] = None,
):
    logs = sorted(store.logs, key=lambda x: x.received_at, reverse=True)
    if user_id:
        logs = [x for x in logs if x.user_id == user_id]
    logs = logs[:limit]
    return {"ok": True, "count": len(logs), "logs": [x.__dict__ for x in logs]}


@app.get("/admin/locations/latest", dependencies=[Depends(require_admin_auth)])
def admin_latest_locations():
    if tracking_store is None:
        return {"ok": False, "reason": "Supabase tracking store not configured", "locations": []}
    items = tracking_store.list_latest_locations()
    return {"ok": True, "count": len(items), "locations": items}


@app.get("/admin/locations/history", dependencies=[Depends(require_admin_auth)])
def admin_location_history(
    user_id: Optional[str] = None,
    limit: int = Query(default=200, ge=1, le=1000),
):
    if tracking_store is None:
        return {"ok": False, "reason": "Supabase tracking store not configured", "locations": []}
    items = tracking_store.list_location_history(user_id=user_id, limit=limit)
    return {"ok": True, "count": len(items), "locations": items}


class AdminHttpCommand(BaseModel):
    user_id: str = Field(min_length=1)
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

    rid = body.request_id or new_request_id()
    item = await hub.admin_issue_command(
        user_id=body.user_id,
        action=body.action,
        request_id=rid,
        payload=body.payload,
        source="http-admin",
    )
    return {
        "ok": True,
        "request_id": item.command_id,
        "user_id": body.user_id,
        "action": body.action,
        "command": item.__dict__,
    }


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

            user_id = msg.get("user_id")
            action = msg.get("action")
            if msg.get("type") == "command_request" or (user_id and action):
                if not user_id or not action:
                    await websocket.send_json({"type": "error", "message": "user_id and action are required"})
                    continue

                request_id = msg.get("request_id") if isinstance(msg.get("request_id"), str) else None
                request_id = request_id or new_request_id()
                payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}

                item = await hub.admin_issue_command(
                    user_id=str(user_id),
                    action=str(action),
                    request_id=request_id,
                    payload=payload,
                    source="ws-admin",
                )
                await websocket.send_json(
                    {
                        "type": "accepted",
                        "request_id": item.command_id,
                        "user_id": str(user_id),
                        "device_id": item.device_id,
                        "device_name": item.device_name,
                        "action": str(action),
                    }
                )
            else:
                await websocket.send_json({"type": "error", "message": "unrecognized_message"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove_admin(websocket)


def _normalize_device_response(
    user_id: str,
    device_id: str | None,
    device_name: str | None,
    msg: Dict[str, Any],
) -> Dict[str, Any] | None:
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

    if explicit_status == "error" or (isinstance(err, dict) and err):
        status_val = "error"
    elif explicit_status == "success":
        status_val = "success"
    elif isinstance(err, dict) and err:
        status_val = "error"
    else:
        status_val = "success"

    normalized: Dict[str, Any] = {
        "type": "command_response",
        "request_id": request_id.strip(),
        "user_id": user_id,
        "device_id": device_id,
        "device_name": device_name,
        "action": action,
        "status": status_val,
    }

    ex = msg.get("executed_at")
    if isinstance(ex, int):
        normalized["executed_at"] = ex
    else:
        normalized["executed_at"] = now_ms()

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
    user_id: str | None = None
    device_id: str | None = None
    device_name: str | None = None

    try:
        raw = await websocket.receive_json()
    except Exception:
        await _close_unauthorized(websocket)
        return

    if raw.get("type") != "hello" or raw.get("role") not in ("device", "mobile"):
        await _close_unauthorized(websocket, code=4400)
        return

    uid = raw.get("user_id")
    if not isinstance(uid, str) or not uid.strip():
        await _close_unauthorized(websocket, code=4400)
        return

    token = raw.get("token") if isinstance(raw.get("token"), str) else None
    if not token and isinstance(raw.get("bearer"), str):
        token = raw.get("bearer")

    if not validate_mobile_token(token):
        await _close_unauthorized(websocket)
        return

    user_id = uid.strip()
    did = raw.get("device_id")
    if isinstance(did, str) and did.strip():
        device_id = did.strip()
    dname = raw.get("device_name")
    if isinstance(dname, str) and dname.strip():
        device_name = dname.strip()

    await hub.bind_device(user_id, device_id, device_name, websocket)
    await websocket.send_json(
        {
            "type": "ready",
            "user_id": user_id,
            "device_id": device_id,
            "device_name": device_name,
        }
    )

    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            normalized = _normalize_device_response(user_id, device_id, device_name, msg)
            if normalized is None:
                continue

            await hub.relay_device_response_from_normalized(normalized)
    except WebSocketDisconnect:
        pass
    finally:
        if user_id is not None:
            await hub.unbind_device(user_id, device_id, websocket)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc: HTTPException):
    return Response(
        content=f'{{"error":"http_error","message":"{str(exc.detail)}"}}',
        media_type="application/json",
        status_code=exc.status_code,
    )


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
