# Remote device backend (FastAPI + WebSockets + legacy HTTP)

This service **replaces** the older `backend/` app in this repo: one process exposes **both** real-time WebSockets and the same HTTP API the mobile app already uses for polling (`GET /command`, `POST /response`, `POST /logs`) and admin listing endpoints. Commands now route primarily by authenticated `user_id`, while `device_id` / `device_name` are optional metadata only.

## What it does

- **Device socket** (`/ws/device`): mobile connects with hello + `user_id` + mobile bearer token, optionally includes `device_id` / `device_name`, receives `{ "type": "command", "action": "...", "request_id": "...", "payload": {} }`, and sends results back with the same `user_id`.
- **Admin socket** (`/ws/admin`): Electron connects with admin token; sends command requests; receives `command_response`, `command_queued`, and `accepted` events.
- **Device event broadcast**: tracking workflow logs (`tracking_request`, `location_update`, `tracking_session_end`) sent by mobile to `POST /logs` are forwarded to admin sockets as `type: "device_event"` and persisted to Supabase for location history/current-location queries.
- **Mobile HTTP**: `GET /command?user_id=`, `POST /response`, `POST /logs`.
- **Admin HTTP**: `POST /admin/commands`, `GET /admin/commands`, `GET /admin/responses`, `GET /admin/users`, `GET /admin/logs`, `GET /admin/locations/latest`, `GET /admin/locations/history`.
- **Extra**: `POST /admin/command` (singular) — same as enqueueing a command with Bearer auth (useful for quick scripts).
- **SQLite audit log**: optional persistence under `SQLITE_PATH` (default `./data/command_audit.db`).
- **Offline queue**: if the user session socket is down, commands stay queued in memory and are delivered when that user reconnects.

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

   Set long random values for `ADMIN_BEARER_TOKEN` and `MOBILE_BEARER_TOKEN`. Also set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` so the backend can persist `location_update` events into Supabase. Never commit `.env`.

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
- The app must already have a valid Supabase session. Tracking starts and stops from auth state, not from `device_id`.

## Supabase tracking schema

- Apply [`sql/tracking_schema.sql`](sql/tracking_schema.sql) to your Supabase project.
- This creates:
  - `tracking_locations` for append-only location updates grouped by `user_id`
  - `tracking_latest_locations` for one latest location per `user_id`
- Admin queries should use `GET /admin/locations/latest` and `GET /admin/locations/history?user_id=<uid>`.

## Electron admin

See [docs/ELECTRON_ADMIN.md](docs/ELECTRON_ADMIN.md) for protocol details and example client code.

## Optional HTTP command (for curl or Electron fetch)

`POST /admin/command` with header `Authorization: Bearer <ADMIN_BEARER_TOKEN>` and JSON body:

```json
{
  "user_id": "supabase-auth-uid",
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
