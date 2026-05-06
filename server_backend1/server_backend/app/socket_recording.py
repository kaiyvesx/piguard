from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, Literal

import socketio
from fastapi import APIRouter, FastAPI, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

RecordingCamera = Literal["front", "back"]

recording_router = APIRouter(prefix="/api", tags=["recording"])
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

connectedDevices: Dict[str, Dict[str, Any]] = {}
pendingRecordingsBySocket: Dict[str, Dict[str, Any]] = {}

UPLOAD_DIR = os.getenv("RECORDING_UPLOAD_DIR", "uploads")
MAX_UPLOAD_MB = int(os.getenv("RECORDING_UPLOAD_MAX_MB", "100"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
os.makedirs(UPLOAD_DIR, exist_ok=True)


class RecordRequest(BaseModel):
    socket_id: str = Field(min_length=1)
    camera: RecordingCamera
    duration: int = Field(ge=1, le=600)


class DeviceRegisterPayload(BaseModel):
    deviceId: str = Field(min_length=1)
    deviceName: str = Field(min_length=1)
    userId: str | None = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class UploadCompletePayload(BaseModel):
    fileUrl: str = Field(min_length=1)
    deviceId: str = Field(min_length=1)
    deviceName: str | None = None
    camera: RecordingCamera | None = None
    duration: int | None = None
    path: str | None = None
    bucket: str | None = None
    request_id: str | None = None


async def _save_upload(file: UploadFile, filename: str) -> str:
    target = os.path.join(UPLOAD_DIR, filename)
    bytes_written = 0
    with open(target, "wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            bytes_written += len(chunk)
            if bytes_written > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail="Recording exceeds size limit")
            output.write(chunk)
    return target


def now_ms() -> int:
    return int(time.time() * 1000)


def _device_snapshot(socket_id: str, info: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "socket_id": socket_id,
        "device_id": info.get("device_id"),
        "device_name": info.get("device_name"),
        "user_id": info.get("user_id"),
        "metadata": info.get("metadata") or {},
        "connected_at": info.get("connected_at"),
        "last_seen_at": info.get("last_seen_at"),
        "last_record_request": info.get("last_record_request"),
        "last_upload": info.get("last_upload"),
        "is_online": True,
    }


def _device_list() -> list[Dict[str, Any]]:
    return sorted(
        [_device_snapshot(socket_id, info) for socket_id, info in connectedDevices.items()],
        key=lambda item: item.get("last_seen_at") or item.get("connected_at") or 0,
        reverse=True,
    )


async def _broadcast_devices_updated() -> None:
    await sio.emit(
        "devices:updated",
        {"devices": _device_list(), "count": len(connectedDevices)},
    )


@recording_router.get("/devices")
async def get_devices() -> Dict[str, Any]:
    devices = _device_list()
    return {"ok": True, "count": len(devices), "devices": devices}


@recording_router.post("/record")
async def post_record_command(body: RecordRequest) -> Dict[str, Any]:
    device = connectedDevices.get(body.socket_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Target socket is not connected")

    request_id = str(uuid.uuid4())
    issued_at = now_ms()
    payload = {
        "request_id": request_id,
        "socket_id": body.socket_id,
        "camera": body.camera,
        "duration": body.duration,
        "issued_at": issued_at,
    }

    pendingRecordingsBySocket[body.socket_id] = payload
    device["last_record_request"] = payload
    device["last_seen_at"] = issued_at

    await sio.emit("command:record", payload, room=body.socket_id)
    await _broadcast_devices_updated()

    return {
        "ok": True,
        "request_id": request_id,
        "socket_id": body.socket_id,
        "device": _device_snapshot(body.socket_id, device),
        "command": payload,
    }


@recording_router.post("/recordings/upload")
async def upload_recording(
    request: Request,
    file: UploadFile = File(...),
    socket_id: str = Form(default=""),
    device_id: str = Form(default=""),
    device_name: str = Form(default=""),
    camera: RecordingCamera | None = Form(default=None),
    duration: int | None = Form(default=None),
    request_id: str | None = Form(default=None),
) -> Dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing upload filename")

    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit():
        if int(content_length) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Recording exceeds size limit")

    ext = os.path.splitext(file.filename)[1] or ".mp4"
    storage_name = f"recording-{uuid.uuid4().hex}{ext}"
    await _save_upload(file, storage_name)

    base_url = str(request.base_url).rstrip("/")
    file_url = f"{base_url}/recordings/{storage_name}"

    pending = pendingRecordingsBySocket.pop(socket_id, None) if socket_id else None
    now = now_ms()
    info = connectedDevices.get(socket_id, {}) if socket_id else {}
    resolved_device_id = device_id or info.get("device_id") or "unknown"
    resolved_device_name = device_name or info.get("device_name") or resolved_device_id

    if socket_id:
        info = {
            **info,
            "socket_id": socket_id,
            "device_id": resolved_device_id,
            "device_name": resolved_device_name,
            "last_seen_at": now,
            "last_upload": {
                "socket_id": socket_id,
                "device_id": resolved_device_id,
                "device_name": resolved_device_name,
                "file_url": file_url,
                "camera": camera or (pending.get("camera") if pending else None),
                "duration": duration or (pending.get("duration") if pending else None),
                "path": storage_name,
                "bucket": "backend",
                "uploaded_at": now,
                "request_id": request_id or (pending.get("request_id") if pending else None),
            },
        }
        connectedDevices[socket_id] = info

    admin_payload = {
        "type": "admin:upload_ready",
        "socket_id": socket_id,
        "device_id": resolved_device_id,
        "device_name": resolved_device_name,
        "file_url": file_url,
        "camera": camera or (pending.get("camera") if pending else None),
        "duration": duration or (pending.get("duration") if pending else None),
        "path": storage_name,
        "bucket": "backend",
        "request_id": request_id or (pending.get("request_id") if pending else None),
        "uploaded_at": now,
    }
    await sio.emit("admin:upload_ready", admin_payload)
    await _broadcast_devices_updated()
    return {"ok": True, "upload": admin_payload}


@sio.event
async def connect(sid: str, environ: Dict[str, Any], auth: Dict[str, Any] | None) -> None:
    return None


@sio.on("device:register")
async def device_register(sid: str, payload: Dict[str, Any] | None) -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    parsed = DeviceRegisterPayload.model_validate(data)
    current = connectedDevices.get(sid, {})
    connected_at = current.get("connected_at") or now_ms()
    info = {
        "socket_id": sid,
        "device_id": parsed.deviceId,
        "device_name": parsed.deviceName,
        "user_id": parsed.userId,
        "metadata": parsed.metadata,
        "connected_at": connected_at,
        "last_seen_at": now_ms(),
    }
    connectedDevices[sid] = info
    await _broadcast_devices_updated()
    return {"ok": True, "device": _device_snapshot(sid, info)}


@sio.on("device:upload_complete")
async def device_upload_complete(sid: str, payload: Dict[str, Any] | None) -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    parsed = UploadCompletePayload.model_validate(data)
    current = connectedDevices.get(sid, {})
    pending = pendingRecordingsBySocket.pop(sid, None)
    info = {
        **current,
        "socket_id": sid,
        "device_id": parsed.deviceId,
        "device_name": parsed.deviceName or current.get("device_name") or parsed.deviceId,
        "last_seen_at": now_ms(),
        "last_upload": {
            "socket_id": sid,
            "device_id": parsed.deviceId,
            "device_name": parsed.deviceName or current.get("device_name") or parsed.deviceId,
            "file_url": parsed.fileUrl,
            "camera": parsed.camera or (pending.get("camera") if pending else parsed.camera),
            "duration": parsed.duration or (pending.get("duration") if pending else parsed.duration),
            "path": parsed.path,
            "bucket": parsed.bucket or "recordings",
            "uploaded_at": now_ms(),
            "request_id": pending.get("request_id") if pending else None,
        },
    }
    connectedDevices[sid] = info

    admin_payload = {
        "type": "admin:upload_ready",
        "socket_id": sid,
        "device_id": info["device_id"],
        "device_name": info["device_name"],
        "file_url": parsed.fileUrl,
        "camera": parsed.camera or (pending.get("camera") if pending else None),
        "duration": parsed.duration or (pending.get("duration") if pending else None),
        "path": parsed.path,
        "bucket": parsed.bucket or "recordings",
        "request_id": parsed.request_id or (pending.get("request_id") if pending else None),
        "uploaded_at": info["last_upload"]["uploaded_at"],
    }
    await sio.emit("admin:upload_ready", admin_payload)
    await _broadcast_devices_updated()
    return {"ok": True, "upload": admin_payload}


@sio.event
async def disconnect(sid: str) -> None:
    connectedDevices.pop(sid, None)
    pendingRecordingsBySocket.pop(sid, None)
    await _broadcast_devices_updated()


def mount_recording_socket_app(app: FastAPI, *, socketio_path: str = "socket.io") -> socketio.ASGIApp:
    return socketio.ASGIApp(sio, other_asgi_app=app, socketio_path=socketio_path)
