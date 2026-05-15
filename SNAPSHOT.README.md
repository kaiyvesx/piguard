# Snapshot Flow — Web Monitor

This document explains how the snapshot feature in the Web Monitor UI works, how a snapshot request flows from the browser to a device, and where snapshot files are stored and accessed.

## Overview

- The UI (Recording Controls) sends a snapshot request to the configured backend.
- The backend forwards the command to the device (via its socket connection) and the device captures an image.
- The device uploads the captured image to backend storage and the backend emits an `admin:upload_ready` Socket.IO event with a `file_url`.
- The UI displays upload entries and the Storage Browser can list files from the backend.

## Key UI pieces

- Recording Mode: radio inputs named `recording-mode` (values: `record`, `snapshot`).
- Snapshot button: `recordingSnapshotBtn` triggers a snapshot request.
- Device selection: choose a connected device from the device list before sending a command.
- Storage Browser: select folder (`captured_video`, `captured_img`, `captured_location`) and click `Refresh Storage` to list stored files.

## How the snapshot request is sent (technical)

1. When you click the `Take Snapshot` button (or call the send routine with `mode: "snapshot"`), the frontend runs `submitRecordCommand("snapshot")`.
2. `submitRecordCommand` gathers:
   - `socket_id` of the selected device,
   - selected `camera` side (`front` or `back`),
   - `duration` (ignored for snapshot but still included),
   - `mode` = `snapshot`.
3. The frontend POSTs JSON to the backend endpoint:

```
POST {backendBase}/api/record
Content-Type: application/json
Authorization: Bearer <admin token>   (if provided)

{
  "socket_id": "<device-socket-id>",
  "camera": "front|back",
  "mode": "snapshot",
  "duration": 15
}
```

4. The backend should validate the request, forward the snapshot command to the device identified by `socket_id`, and return an OK response when the request is queued.

5. When the device finishes capturing and uploads the image, the backend emits a Socket.IO event `admin:upload_ready` containing an object with `file_url` (public or proxied URL), `mode` (should be `snapshot`), `camera`, and metadata.

6. The frontend listens for `admin:upload_ready`, adds the upload to the `Upload Feed`, and shows a `Download / view file` link.

## Where snapshots are stored

- The frontend doesn't store snapshot files itself; snapshots are stored by the backend in the backend's configured storage (local disk, cloud object storage, or other).
- The UI provides a Storage Browser that calls:

```
GET {backendBase}/api/admin/files?folder=<captured_img|captured_video|captured_location>
Authorization: Bearer <storage token>
```

- Typical folder for single-frame snapshots: `captured_img`. Use that folder in the Storage Browser to list images.
- Each file item returned by the backend should include a `url` or `file_url` property that the UI will render as an `Open` link.

## Configuration (what to set in the UI)

- Backend Base URL: `backendBase` — the base URL for API calls and Socket.IO (no trailing slash recommended).
- Admin Token: `adminToken` — Bearer token used for `/api/record` and socket auth. The token saved by UI is normalized (prefix `Bearer ` is optional).
- Storage Token: `recordingStorageAdminToken` — required for listing files via `/api/admin/files`.
- Local storage key used by the frontend: `camera-recording-admin-config-v1` (saves backendBase, adminToken, durationSeconds, recordingMode, storageAdminToken, etc.).

## Typical user steps

1. Open the Recording Controls page and ensure the backend URL is set (or the global `Backend Base URL`).
2. Verify the Socket State shows `Connected` and devices appear in the device list.
3. Select a device from the list and choose camera side (`Front` or `Back`).
4. Click `Take Snapshot` (or set Command Type to `Snapshot` and use the send button).
5. Watch the `Upload Feed` for a new entry. Click `Download / view file` to open the snapshot.
6. Optionally use the Storage Browser, choose folder `Captured Images`, set the Storage Token, then `Refresh Storage` to list stored images.

## Troubleshooting

- No devices listed: check backend `/api/devices` and ensure devices are connected to the backend Socket.IO server.
- Socket shows Disconnected: verify `backendBase` and `adminToken`, then click `Refresh Devices` or wait for reconnection.
- Snapshot request returned error: check backend logs and the response status shown in the UI `selectionSummary` text.
- Upload never appears: ensure the backend emits `admin:upload_ready` with `file_url`; check server storage settings and device upload success.

## Notes for backend implementers

- Implement or verify these endpoints and behaviors:
  - `GET /api/devices` — returns connected device list for the admin UI.
  - `POST /api/record` — accept `{ socket_id, camera, mode, duration }`, forward command to device, respond OK when queued.
  - `GET /api/admin/files?folder=...` — return JSON `{ ok: true, data: { files: [ { name, url, size, modified_at } ] } }` for the Storage Browser.
  - Socket.IO: accept admin auth (token) and emit `devices:updated` and `admin:upload_ready` events.

## Example admin:upload_ready payload (frontend expects fields similar to):

```
{
  "socket_id": "abcd-1234",
  "device_name": "dashcam-1",
  "file_url": "https://.../captured_img/2026-05-15-1234.jpg",
  "camera": "front",
  "mode": "snapshot",
  "uploaded_at": 1670000000000
}
```

---

If you want, I can now convert this README into a short prompt template for reuse — send me the `.md` or tell me how you'd like the prompt to read. 
