# PiGuard

PiGuard is a desktop monitoring dashboard for Raspberry Pi-based field devices.  
It runs as an Electron app and provides a unified interface for GPS tracking, SMS monitoring, and camera panel views, with live data fetched from a Pi backend.

## What It Does

- Tracks device location on a live Leaflet/OpenStreetMap map
- Shows GPS status, coordinates, speed, and route/track details
- Displays SMS contacts, message threads, and send-message actions
- Includes a camera dashboard panel for live feed placeholders
- Surfaces device connectivity state and modem/network status from the Pi

## Project Structure

- `main.js`: Electron main process and desktop window setup
- `preload.js`: secure bridge between renderer and backend APIs
- `frontend/`: dashboard UI (GPS, SMS, Camera panels)
- `backend/app.py`: Python desktop control panel entry point
- `backend/app_2.py`: active desktop control panel implementation
- `backend/backend.py`: Python API/backend service for Pi endpoints

## Tech Stack

- Electron (desktop shell)
- HTML/CSS/JavaScript (frontend dashboard)
- Leaflet + OpenStreetMap tiles (map rendering)
- Python (backend tooling/control panel)

## Run Locally

1. Install dependencies:
	```bash
	npm install
	```
2. Start the Electron dashboard:
	```bash
	npm start
	```
3. Start the Python backend API:
	```bash
	python backend/backend.py
	```
4. Start the updated Python desktop control panel:
	```bash
	python backend/app.py
	```

Make sure your Raspberry Pi backend service is reachable from your machine for live GPS/SMS/device data.
