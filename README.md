# PiGuard

PiGuard is an Electron desktop dashboard for Raspberry Pi field-device monitoring. It provides a single UI for GPS, SMS, and Camera operations and reads live device data from a Pi-accessible backend.

## Current Features

- GPS panel with Leaflet/OpenStreetMap rendering and live tracker updates
- SMS panel with contact list, thread view, outgoing send flow, and resend for failed messages
- Camera panel with per-slot actions (right-click or 3-dot settings button)
- Camera action modal for Start/Stop recording, power actions, snapshot, and incident tagging (UI preview flow)
- Camera recording status in sidebar, including active count, last command, and per-camera recording list (for example, "Camera 1 recording")
- Connection/state indicators for Pi, GPS, and camera feed availability

## Project Structure

- `src/main/main.js`: Electron main process and BrowserWindow bootstrap
- `src/main/preload.js`: secure renderer bridge (`window.piBridge`)
- `src/main/ipc-handlers.js`: IPC registration scaffold
- `src/renderer/pages/`: panel markup (`panel-gps.html`, `panel-sms.html`, `panel-camera.html`)
- `src/renderer/components/`: sidebar/header partials
- `src/renderer/css/index.css`: dashboard styling
- `src/renderer/js/api.js`: renderer-side data flow and panel behavior
- `src/renderer/js/index.js`: panel switching and map/search helpers
- `src/services/`: service-layer modules (`api.js`, `gps.service.js`, `sms.service.js`, `camera.service.js`, `websocket.js`)
- `backend/backend.py`: Python API/backend service for Pi endpoints
- `backend/app.py`, `backend/app_1.py`, `backend/app_2.py`: Python desktop/control variants

## Tech Stack

- Electron
- HTML/CSS/JavaScript
- Leaflet + OpenStreetMap tiles
- Python (backend tooling/services)

## Run Locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start Electron:
   ```bash
   npm start
   ```
3. Run backend API (recommended for live data):
   ```bash
   python backend/backend.py
   ```

Optional local tools:

- `python backend/app.py`
- `python backend/app_1.py`
- `python backend/app_2.py`

## Notes

- Camera Start/Stop/Power/Snapshot/Incident actions are currently UI-preview actions unless backend command handlers are wired.
- Ensure the Pi backend host is reachable from your machine for real-time GPS/SMS/device updates.
