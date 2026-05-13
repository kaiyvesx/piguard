# Remote Device Backend

This project is a FastAPI backend that coordinates mobile devices, admin clients, command delivery, device logs, optional location tracking, and recording uploads. The entire application lives in the `app/` package, and the README below explains how each module fits together.

The design is intentionally simple:

- Commands are stored in an in-memory queue in `app/store.py`.
- WebSockets in `app/main.py` provide real-time delivery and admin updates.
- HTTP endpoints in `app/main.py` preserve the legacy polling contract.
- Optional persistence is handled by `app/sqlite_log.py` and `app/supabase_tracking.py`.
- Recording uploads and the Socket.IO recording workflow live in `app/socket_recording.py`.

## `app/` package map

| File | Responsibility |
| --- | --- |
| `app/main.py` | FastAPI application, HTTP routes, WebSocket routes, static file mounts, and startup wiring. |
| `app/hub.py` | Realtime command routing between admin sockets, device sockets, and the shared store. |
| `app/store.py` | In-memory queues, command history, response history, logs, and active device state. |
| `app/models.py` | Pydantic request models used by the HTTP API. |
| `app/http_auth.py` | Dependency helpers for bearer-token auth on HTTP routes. |
| `app/auth_tokens.py` | Token validation helpers used by the WebSocket handshake and HTTP routes. |
| `app/sqlite_log.py` | Optional SQLite audit log for command and response events. |
| `app/supabase_tracking.py` | Optional Supabase-backed location history store with a buffered write path. |
| `app/socket_recording.py` | Socket.IO recording workflow, device registry, upload endpoints, and file listing. |
| `app/__init__.py` | Package marker. |

## How the backend works

### Command flow

1. An admin creates a command over HTTP or WebSocket.
2. `app/hub.py` stores it in the shared `MemoryStore` and records an audit event.
3. If the user is online, the command is delivered to the device WebSocket immediately.
4. If the device is offline, the command stays queued until the device reconnects or the mobile client polls `GET /command`.
5. The device sends a response back through `/ws/device` or `POST /response`.
6. The backend normalizes the response, saves it, and broadcasts it to connected admin sockets.

### Storage model

The core command state is in-memory only. That means:

- queued commands, responses, logs, and active device state are lost if the process restarts;
- SQLite audit logging is optional and only captures the events written through `app/sqlite_log.py`;
- Supabase tracking is optional and only stores location history when the related environment variables are set.

## Module details

### `app/main.py`

This is the application entrypoint. It:

- creates the FastAPI app;
- loads environment variables with `python-dotenv`;
- configures CORS;
- mounts static folders for `captured_video`, `captured_img`, and `captured_location`;
- exposes HTTP endpoints for health, commands, responses, logs, admin views, and location history;
- exposes `/ws/admin` and `/ws/device` for realtime communication;
- mounts the recording router and Socket.IO ASGI app from `app/socket_recording.py`.

Important routes exposed here:

- `GET /health`
- `GET /command`
- `POST /response`
- `POST /logs`
- `POST /admin/commands`
- `GET /admin/commands`
- `GET /admin/responses`
- `GET /admin/users`
- `GET /admin/logs`
- `GET /admin/locations/latest`
- `GET /admin/locations/history`
- `POST /admin/command`
- `GET /ws/admin`
- `GET /ws/device`

### `app/hub.py`

`RealtimeHub` coordinates the shared store and connected WebSockets.

- Keeps track of connected admin sockets.
- Tracks one active device socket per user.
- Delivers queued commands to devices when they connect.
- Normalizes device responses before storing and broadcasting them.
- Emits admin-side events such as `command_queued`, `command_response`, and synthetic error notifications.

### `app/store.py`

This is the in-memory database for the service.

- `CommandItem` tracks queued, dispatched, completed, and errored commands.
- `ResponseItem` stores normalized command results.
- `LogItem` stores device log payloads.
- `MemoryStore` manages command queues, active devices, logs, and response history.

The store also provides admin listing helpers used by the HTTP endpoints.

### `app/models.py`

This file defines the request bodies accepted by the HTTP API.

- `AdminCommandCreate` for `POST /admin/commands`
- `CommandResponseIn` for `POST /response`
- `DeviceLogIn` for `POST /logs`

### `app/http_auth.py` and `app/auth_tokens.py`

These modules implement bearer-token checks.

- HTTP routes use FastAPI dependencies from `app/http_auth.py`.
- WebSocket handshakes use `validate_admin_token` and `validate_mobile_token` from `app/auth_tokens.py`.
- `ALLOW_UNAUTHENTICATED=true` disables auth for local development only.

### `app/sqlite_log.py`

This module writes append-only audit events to SQLite.

- The database path comes from `SQLITE_PATH`.
- The schema stores event time, event type, device id, request id, action, and the JSON payload.
- `audit_log_from_env()` returns a ready-to-use logger or creates the database file if needed.

### `app/supabase_tracking.py`

This module is optional and only activates when both `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present.

- `SupabaseTrackingStore` talks to Supabase REST endpoints directly.
- `BufferedTrackingStore` batches location updates in memory before flushing them.
- Buffered writes reduce Supabase traffic and preserve recent points if a flush fails.
- The backend uses it for location update ingestion and for admin location history endpoints.

### `app/socket_recording.py`

This module handles Socket.IO-based device registration and recording uploads.

- `GET /api/devices` lists connected devices.
- `POST /api/record` sends a `command:record` event to a target socket.
- `POST /api/recordings/upload` accepts uploaded media and exposes it via the public recording route.
- `GET /api/admin/files` lists files from the captured media folders for admins.
- Socket events such as `device:register` and `device:upload_complete` keep device metadata and upload state in sync.

The module also mounts the Socket.IO ASGI app used by the server.

## Public file locations

The server serves a few local directories as static assets:

- `captured_video/` at `/captured_video` and `/recordings`
- `captured_img/` at `/captured_img`
- `captured_location/` at `/captured_location`

## Running locally

1. Create and activate a virtual environment.

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. Install dependencies.

   ```bash
   pip install -r requirements.txt
   ```

3. Copy the example environment file and set real secrets.

   ```bash
   cp .env.example .env
   ```

4. Start the server.

   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```

You can also use `./start.sh`, which loads `.env` if present and then launches Uvicorn.

## Environment variables

The minimal set is defined in `.env.example`:

- `HOST` - bind address for the server process
- `PORT` - bind port for the server process
- `ADMIN_BEARER_TOKEN` - admin auth token
- `MOBILE_BEARER_TOKEN` - mobile auth token
- `ALLOW_UNAUTHENTICATED` - local-dev auth bypass only
- `SQLITE_PATH` - path for the SQLite audit log

Additional optional settings used by `app/main.py` and `app/socket_recording.py`:

- `RECORDING_UPLOAD_DIR`
- `RECORDING_PUBLIC_ROUTE`
- `RECORDING_UPLOAD_MAX_MB`
- `CAPTURED_IMG_DIR`
- `CAPTURED_LOCATION_DIR`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_TRACKING_TABLE`
- `SUPABASE_TRACKING_LATEST_VIEW`

## Client integration

### Mobile app

When the mobile client uses WebSockets, it should connect to `/ws/device`, send a `hello` frame with `role: device` or `role: mobile`, and provide `user_id` plus the mobile bearer token.

If the mobile client uses the legacy HTTP path instead, it should keep polling `GET /command?user_id=...`, then post results to `POST /response` and logs to `POST /logs`.

### Electron admin

See [docs/ELECTRON_ADMIN.md](docs/ELECTRON_ADMIN.md) for the admin WebSocket protocol and example client code.

## Notes

- Commands and responses are ephemeral unless you add your own persistence layer.
- Use TLS in production so the WebSocket endpoints use `wss://` and the HTTP endpoints use `https://`.
- Treat bearer tokens like passwords.
- `ALLOW_UNAUTHENTICATED=true` should never be enabled in production.