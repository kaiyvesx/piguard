# Web Monitor

Simple browser monitor with two separate pages:

- Raspberry monitor (`index.html`)
- Phone admin monitor (`phone-admin.html`)
- Camera admin monitor (`camera-admin.html`)

## Raspberry monitor page

- Raspberry Pi server `GET /health`
- Raspberry Pi status `GET /status`
- Raspberry Pi GPS latest `GET /gps_latest`
- Backend server `GET /health`
- Backend location output through `GET /admin/logs` (looks for `type: "location_update"`)

## Phone admin monitor page

- Backend health `GET /health`
- Phone/device detection `GET /admin/devices`
- Phone output/event stream `GET /admin/logs`
- Shows detected device IDs and latest event type per device (for example `location_update`, `tracking_request`, `tracking_session_end`)

## Camera admin monitor page

- Backend health `GET /health`
- Backend user detection `GET /admin/users`
- Latest location snapshot `GET /admin/locations/latest`
- Camera command history `GET /admin/commands` and `GET /admin/responses`
- Queues `camera_stream_start` and `camera_stream_stop` commands for the selected backend user
- Shows a live mock camera panel so you can wire the real mobile stream later

## How to run

1. Open terminal in this folder.
2. Start a static web server:

```powershell
python -m http.server 5500
```

3. Open Raspberry monitor:

`http://localhost:5500`

4. Open phone admin monitor:

`http://localhost:5500/phone-admin.html`

5. Open camera admin monitor:

`http://localhost:5500/camera-admin.html`

If you want to test from your phone, open:

`http://<your-pc-local-ip>:5500`

## Notes

- For `GET /admin/devices` and `GET /admin/logs`, enter your backend admin bearer token in the UI.
- If browser shows CORS errors, allow your monitor origin on the backend or run this monitor from a host already allowed by backend CORS settings.
