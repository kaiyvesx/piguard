# PiGuard Storage and Persistence Analysis

Date: 2026-04-14

This document summarizes current behavior for Electron mobile tracking state and Ubuntu backend persistence.

## Scope

- Electron desktop app runtime state
- Renderer tracking state
- Ubuntu backend endpoints and data persistence
- Day-to-day restart behavior

## 1) Does Electron store mobile tracking state only in runtime memory?

Answer: YES

Evidence:
- Main-process tracking state is an in-memory Map: [src/services/tracking-handler.js](src/services/tracking-handler.js#L5)
- Device fields like last_seen and last_location are updated in memory: [src/services/tracking-handler.js](src/services/tracking-handler.js#L92), [src/services/tracking-handler.js](src/services/tracking-handler.js#L121), [src/services/tracking-handler.js](src/services/tracking-handler.js#L184)
- Renderer tracking state also uses in-memory structures (Map/arrays): [src/renderer/js/api.js](src/renderer/js/api.js#L336), [src/renderer/js/api.js](src/renderer/js/api.js#L339)
- Local storage is used for UI preference (pane collapsed), not tracking history persistence: [src/renderer/js/api.js](src/renderer/js/api.js#L348), [src/renderer/js/api.js](src/renderer/js/api.js#L416), [src/renderer/js/api.js](src/renderer/js/api.js#L982)

## 2) After closing/reopening Electron, does it remember yesterday last location/offline status?

Answer: NO

Evidence:
- Renderer bootstrap calls get-device-list via IPC: [src/main/preload.js](src/main/preload.js#L322)
- Main IPC get-device-list returns trackingHandler.getDeviceList from runtime memory: [src/main/tracking-ipc.js](src/main/tracking-ipc.js#L29), [src/main/tracking-ipc.js](src/main/tracking-ipc.js#L33)
- There is no startup load from disk/database for Electron tracking map

## 3) Does Ubuntu backend already have response/device endpoints and store command responses?

Answer: YES (with persistence mode caveat)

Evidence:
- Admin response/device list endpoints exist: [server_backend/app/main.py](server_backend/app/main.py#L112), [server_backend/app/main.py](server_backend/app/main.py#L122)
- Device responses are processed and saved through hub/store flow: [server_backend/app/hub.py](server_backend/app/hub.py#L124), [server_backend/app/hub.py](server_backend/app/hub.py#L142)
- Store mode depends on DATABASE_URL:
  - In-memory when DATABASE_URL is empty: [server_backend/app/store.py](server_backend/app/store.py#L99), [server_backend/app/store.py](server_backend/app/store.py#L572), [server_backend/app/store.py](server_backend/app/store.py#L573)
  - Postgres persistence when DATABASE_URL is set: [server_backend/app/store.py](server_backend/app/store.py#L239), [server_backend/.env.example](server_backend/.env.example#L16)
- SQLite audit logging exists separately (event trail): [server_backend/app/sqlite_log.py](server_backend/app/sqlite_log.py#L32), [server_backend/app/sqlite_log.py](server_backend/app/sqlite_log.py#L53), [server_backend/.env.example](server_backend/.env.example#L13)

## 4) If backend received GPS yesterday, will Electron auto-show it tomorrow without new events?

Answer: NO

Evidence:
- Electron tracking flow is live command/event driven via WebSocket client: [src/services/api.js](src/services/api.js#L76), [src/services/api.js](src/services/api.js#L77), [src/services/websocket.js](src/services/websocket.js#L191), [src/services/websocket.js](src/services/websocket.js#L204)
- Current UI path does not hydrate history from backend /admin/responses or /admin/devices on startup

## Important Variant Caveat

If Ubuntu is running the older backend1 variant, only singular admin command endpoint is present in that main file and the response/device listing endpoints above are not defined there.

Evidence:
- backend1 singular command endpoint: [backend1/server_backend/app/main.py](backend1/server_backend/app/main.py#L54)
- current server_backend response/device listing endpoints: [server_backend/app/main.py](server_backend/app/main.py#L112), [server_backend/app/main.py](server_backend/app/main.py#L122)

## Practical Interpretation

- Electron remembers tracking state only while the app process is running.
- Backend can retain data across restarts only when configured with Postgres (DATABASE_URL).
- SQLite audit file records events but does not replace full state hydration in Electron.
