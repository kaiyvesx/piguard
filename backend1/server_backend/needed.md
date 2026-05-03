Here’s what was added and how the pieces fit together.

Backend: server_backend/ (FastAPI + WebSockets + SQLite audit)

This is a separate tree from the existing HTTP backend/ folder, meant to be copied to ~/backend_tracking on Ubuntu.

Piece Role
GET /health Liveness
WS /ws/device Mobile agent: hello + device_id + token → receives commands
WS /ws/admin Electron: hello + admin token → send commands, receive responses
POST /admin/command Optional HTTP enqueue (same hub as WebSocket)
SQLITE_PATH Append-only audit log (default ./data/command_audit.db)

Flow: Admin sends a command → server delivers to the device socket (or queues if offline) → device runs the action → server normalizes the reply → broadcasts to all connected admin sockets.

Setup on the server (details are in server_backend/README.md):

cd ~/backend_tracking

source .venv/bin/activate   # or venv/bin/activate

pip install -r requirements.txt

cp .env.example .env          # set ADMIN_BEARER_TOKEN + MOBILE_BEARER_TOKEN

uvicorn app.main:app --host 0.0.0.0 --port 8000

Or run ./start.sh from server_backend after copying it to the server and chmod +x start.sh.

Electron developer guide: server_backend/docs/ELECTRON_ADMIN.md — handshake, command_request, incoming command_response / command_queued, optional POST /admin/command, and a small Electron ws example.

Mobile (React Native / Expo):

WebSocket agent services/realtimeWsCommandService.ts — connects to /ws/device, sends hello with getAgentDeviceId() (Android ID) and the mobile token, handles { type: "command", action, request_id, payload }, runs the same executor as polling, replies with request_id + data / error.

services/remoteCommandTransport.ts — if a WS URL is configured → WebSocket only; otherwise → existing HTTP polling (startRemoteCommandAgent).

app/_layout.tsx — starts startRemoteCommandTransport() instead of HTTP-only.

services/apiService.ts — getRemoteCommandWsUrl(), getRemoteCommandTransportMode(), exported getRemoteCommandAuthToken().

services/commandService.ts — getAgentDeviceId(), executeQueuedCommand (renamed from internal executeCommand), executeRealtimeCommand() for WS.

Configure when server_backend is live: In app.json → expo.extra, set remoteCommandWsUrl to e.g. ws://YOUR_SERVER_IP:8000/ws/device (use wss:// behind TLS). Set remoteCommandAuthToken to the same value as MOBILE_BEARER_TOKEN on the server. remoteCommandWsUrl is currently "" so the app keeps using HTTP until you set a real URL.

Background: The existing Expo Background Fetch path still only does HTTP polling. With WS-only mode, commands are real-time while the app process is alive and after reconnect on resume (AppState → active). True “always-on” background on Android usually needs a native foreground service + a native WS or push bridge; that’s outside what we wired here.

Protocol (aligned with your JSON shape)

To device:
{ "type": "command", "action": "get_gps", "request_id": "abc123", "payload": {} }

From device (success):
{ "request_id": "abc123", "action": "get_gps", "device_id": "…", "status": "success", "data": { "lat": 14.5995, "lng": 120.9842 } }

Auth & device identity

Admin: ADMIN_BEARER_TOKEN — first WS message
{ "type": "hello", "role": "admin", "token": "…" }

Mobile: MOBILE_BEARER_TOKEN — hello includes "token"; device id is the string you send as "device_id".

Files to share with the Electron dev: everything under server_backend/docs/ELECTRON_ADMIN.md.

SMS / call log actions are not implemented in runAction yet (only get_gps, take_photo, make_call).

TL;DR

server_backend/ is a separate backend replacing the old HTTP backend folder.
Provides FastAPI + WebSockets + SQLite audit.

Pinalitan ko yung backend folder para iisa nalang naging server_backend nalang idedeploy.

Single backend: server_backend/ now replaces backend/.

Shared MemoryStore (server_backend/app/store.py)
Same idea as the old backend: per-device queues, command_id, responses, logs, device list.

enqueue_command(..., command_id=...)
revert_dispatched_to_queued()

RealtimeHub refactored (server_backend/app/hub.py)

No separate _pending list; everything goes through the store.

Legacy HTTP API restored (server_backend/app/main.py)

Mobile: GET /command, POST /response, POST /logs.

Admin: POST /admin/commands, GET /admin/commands, GET /admin/responses, GET /admin/devices, GET /admin/logs.

HTTP auth (server_backend/app/http_auth.py)

Same env vars as the old app.

Docs

server_backend/README.md — main reference.
backend/README.md — deprecated.

Deploy

Point remoteCommandApiBaseUrl and remoteCommandWsUrl at this one server.

TL;DR

Central server connecting Electron and React Native.
Queues commands, delivers via WebSocket or HTTP polling.
Stores results, logs, and audit trail.
