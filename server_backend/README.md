# Remote device backend (FastAPI + WebSockets + legacy HTTP)

This service **replaces** the older `backend/` app in this repo: one process exposes **both** real-time WebSockets and the **same HTTP API** the mobile app already uses for polling (`GET /command`, `POST /response`, `POST /logs`) and admin listing endpoints. Commands live in a **single in-memory queue**; WebSocket and HTTP transports share it (pick one transport per device in practice to avoid races).

## What it does

- **Device socket** (`/ws/device`): mobile connects with hello + `device_id` + mobile bearer token; receives `{ "type": "command", "action": "...", "request_id": "...", "payload": {} }` where `request_id` equals `command_id` in the HTTP API; sends results as JSON with `request_id` + `data` or `error`.
- **Admin socket** (`/ws/admin`): Electron connects with admin token; sends command requests; receives `command_response`, `command_queued`, and `accepted` events.
- **Mobile HTTP** (legacy): `GET /command?device_id=`, `POST /response`, `POST /logs` — same contract as the old `backend/`.
- **Admin HTTP** (legacy): `POST /admin/commands`, `GET /admin/commands`, `GET /admin/responses`, `GET /admin/devices`, `GET /admin/logs`.
- **Extra**: `POST /admin/command` (singular) — same as enqueueing a command with Bearer auth (useful for quick scripts).
- **SQLite audit log**: optional persistence under `SQLITE_PATH` (default `./data/command_audit.db`).
- **Offline queue**: if the device WebSocket is down, commands stay **queued** in the store; they are delivered over WS when the device reconnects, or consumed via **HTTP** `GET /command` if you use polling instead.

## Deploy on Ubuntu (`~/backend_tracking`)

These steps match a layout where Python 3 and a venv already exist in `~/backend_tracking`.

1. **Copy this folder** to the server (for example into `~/backend_tracking` so that `app/main.py` lives at `~/backend_tracking/app/main.py`).

2. **Activate the virtual environment** (adjust the venv folder name if yours differs):

   ```bash
   cd ~/backend_tracking
   source .venv/bin/activate
   ```

3. **Install dependencies**:

   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment**:

   ```bash
   cp .env.example .env
   nano .env
   ```

   Set long random values for `ADMIN_BEARER_TOKEN` and `MOBILE_BEARER_TOKEN`. The mobile app and Electron admin must use the matching tokens. Never commit `.env`.

5. **Run the server**:

   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```

   For production, run behind **nginx** with TLS and proxy WebSockets, or use a process manager (`systemd`, `supervisor`) with the same `uvicorn` command.

6. **Open firewall ports** as needed (8000, or 443 behind nginx).

7. **Health check**: `GET http://<host>:8000/health`

## Mobile app configuration (React Native / Expo)

- Set **`remoteCommandWsUrl`** in `app.json` → `expo.extra` to `ws://<server-ip>:8000/ws/device` (or `wss://` behind TLS).
- Set **`remoteCommandAuthToken`** to the same value as `MOBILE_BEARER_TOKEN` on the server.
- When `remoteCommandWsUrl` is non-empty, the app uses **WebSocket transport** instead of HTTP polling.

## Electron admin

See [docs/ELECTRON_ADMIN.md](docs/ELECTRON_ADMIN.md) for protocol details and example client code.

## Optional HTTP command (for curl or Electron fetch)

`POST /admin/command` with header `Authorization: Bearer <ADMIN_BEARER_TOKEN>` and JSON body:

```json
{
  "device_id": "your-device-id",
  "action": "get_gps",
  "request_id": "optional-custom-id",
  "payload": {}
}
```

Subscribe to results over `/ws/admin` as well, since responses are broadcast to connected admin sockets.

## Security notes

- Use **TLS** (`wss://`, `https://`) in production.
- Treat bearer tokens like passwords; rotate them if leaked.
- `ALLOW_UNAUTHENTICATED=true` is only for local development.
