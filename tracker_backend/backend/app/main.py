import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from .auth import require_admin_auth, require_mobile_auth
from .models import AdminCommandCreate, CommandResponseIn
from .store import store

load_dotenv()

app = FastAPI(title="Remote Command Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "remote-command-backend", "now": __import__('time').time_ns() // 1_000_000}


@app.get("/command", dependencies=[Depends(require_mobile_auth)])
def get_command(device_id: str = Query(..., min_length=1)):
    item = store.fetch_next_command(device_id=device_id)
    if item is None:
        return Response(status_code=204)

    return {
        "command_id": item.command_id,
        "device_id": item.device_id,
        "action": item.action,
        "payload": item.payload,
        "issued_at": item.created_at,
    }


@app.post("/response", dependencies=[Depends(require_mobile_auth)], status_code=201)
def post_response(body: CommandResponseIn):
    saved = store.save_response(
        command_id=body.command_id,
        device_id=body.device_id,
        action=body.action,
        status=body.status,
        result=body.result,
        error=body.error,
        executed_at=body.executed_at,
    )
    return {"ok": True, "response": saved.__dict__}


@app.post("/logs", dependencies=[Depends(require_mobile_auth)], status_code=201)
def post_logs(payload: Dict[str, Any]):
    item = store.save_log(payload)
    return {"ok": True, "log_id": item.id}


@app.post("/admin/commands", dependencies=[Depends(require_admin_auth)], status_code=201)
def admin_create_command(body: AdminCommandCreate):
    item = store.enqueue_command(
        device_id=body.device_id,
        action=body.action,
        payload=body.payload,
        source=body.source,
    )
    return {"ok": True, "command": item.__dict__}


@app.get("/admin/commands", dependencies=[Depends(require_admin_auth)])
def admin_list_commands(
    device_id: Optional[str] = None,
    action: Optional[str] = None,
    status: Optional[str] = None,
):
    items = [x.__dict__ for x in store.list_commands(device_id=device_id, action=action, status=status)]
    return {"ok": True, "count": len(items), "commands": items}


@app.get("/admin/responses", dependencies=[Depends(require_admin_auth)])
def admin_list_responses(
    device_id: Optional[str] = None,
    command_id: Optional[str] = None,
    action: Optional[str] = None,
):
    items = [x.__dict__ for x in store.list_responses(device_id=device_id, command_id=command_id, action=action)]
    return {"ok": True, "count": len(items), "responses": items}


@app.get("/admin/devices", dependencies=[Depends(require_admin_auth)])
def admin_list_devices():
    items = store.list_devices()
    return {"ok": True, "count": len(items), "devices": items}


@app.get("/admin/logs", dependencies=[Depends(require_admin_auth)])
def admin_list_logs(limit: int = Query(default=200, ge=1, le=1000)):
    logs = sorted(store.logs, key=lambda x: x.received_at, reverse=True)[:limit]
    return {"ok": True, "count": len(logs), "logs": [x.__dict__ for x in logs]}


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
