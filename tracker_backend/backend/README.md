# Backend (Python FastAPI)

This is a separate Python backend frame for your flow:
- Admin (Windows app) -> Backend -> Mobile agent
- Mobile agent -> Backend -> Admin (result/status)

It is designed to run continuously with uvicorn.

## Run (Windows)

1. Create virtual environment:
   python -m venv .venv
2. Activate:
   .\.venv\Scripts\Activate.ps1
3. Install requirements:
   pip install -r requirements.txt
4. Copy env:
   copy .env.example .env
5. Start server:
   uvicorn app.main:app --host 0.0.0.0 --port 8000

Alternative:
- .\start.ps1

## Fresh Ubuntu Server Setup (CLI, 24/7)

This section is for a brand new Ubuntu server where you want the backend running continuously.

### 1. Install system packages

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git curl ufw
```

### 2. Create app directory and copy project

Option A: clone repo

```bash
sudo mkdir -p /opt/remote-command
sudo chown -R $USER:$USER /opt/remote-command
cd /opt/remote-command
git clone <YOUR_REPO_URL> .
cd backend
```

Option B: upload only backend folder, then enter it

```bash
cd /opt/remote-command/backend
```

### 3. Create Python virtual environment and install dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 4. Create production environment file

```bash
cp .env.example .env
nano .env
```

Set at least these values:

```env
HOST=0.0.0.0
PORT=8000
MOBILE_BEARER_TOKEN=replace-with-long-random-token
ADMIN_BEARER_TOKEN=replace-with-long-random-token
ALLOW_UNAUTHENTICATED=false
```

### 5. Test server manually once

```bash
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

In another shell:

```bash
curl http://127.0.0.1:8000/health
```

You should get a JSON response with ok=true. Stop the manual server with Ctrl+C.

### 6. Create a systemd service (auto-start + restart)

```bash
sudo nano /etc/systemd/system/remote-command-backend.service
```

Paste this and adjust paths/user if needed:

```ini
[Unit]
Description=Remote Command Backend (FastAPI)
After=network.target

[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/remote-command/backend
EnvironmentFile=/opt/remote-command/backend/.env
ExecStart=/opt/remote-command/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable remote-command-backend
sudo systemctl start remote-command-backend
```

Check status/logs:

```bash
sudo systemctl status remote-command-backend
sudo journalctl -u remote-command-backend -f
```

### 7. Open firewall port (if needed)

```bash
sudo ufw allow 8000/tcp
sudo ufw enable
sudo ufw status
```

### 8. Verify from local and remote

Local on server:

```bash
curl http://127.0.0.1:8000/health
```

From another machine:

```bash
curl http://<SERVER_IP>:8000/health
```

### 9. Point mobile app to this server

Set the mobile backend base URL to:

```text
http://<SERVER_IP>:8000
```

If you run behind a domain/reverse proxy, use that URL instead.

### 10. Operational commands

Restart service:

```bash
sudo systemctl restart remote-command-backend
```

Stop service:

```bash
sudo systemctl stop remote-command-backend
```

Pull updates and redeploy:

```bash
cd /opt/remote-command/backend
git pull
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart remote-command-backend
```

### Optional hardening (recommended)

- Put Nginx in front and serve HTTPS with Let's Encrypt.
- Restrict port 8000 to private network and expose only 443 publicly.
- Use long random bearer tokens and rotate them periodically.
- Add persistent storage (SQLite/PostgreSQL/Redis) since current store is in-memory.

## API

### Mobile endpoints
- GET /command?device_id=<id>
- POST /response
- POST /logs

### Admin endpoints
- POST /admin/commands
- GET /admin/commands
- GET /admin/responses
- GET /admin/devices
- GET /admin/logs

### Health
- GET /health

## Auth

Set tokens in .env:
- MOBILE_BEARER_TOKEN
- ADMIN_BEARER_TOKEN

If needed for local testing only:
- ALLOW_UNAUTHENTICATED=true

## Example Flow

1) Admin sends command:
POST /admin/commands

```json
{
  "device_id": "android-device-123",
  "action": "get_gps",
  "payload": {},
  "source": "windows-admin"
}
```

2) Mobile polls:
GET /command?device_id=android-device-123

```json
{
  "command_id": "uuid",
  "device_id": "android-device-123",
  "action": "get_gps",
  "payload": {},
  "issued_at": 1760000000000
}
```

If no command, server returns 204.

3) Mobile returns execution result:
POST /response

```json
{
  "command_id": "uuid",
  "device_id": "android-device-123",
  "action": "get_gps",
  "status": "success",
  "result": {
    "latitude": 14.5995,
    "longitude": 120.9842,
    "accuracy": 5.2
  },
  "executed_at": 1760000005000
}
```

4) Admin checks responses:
GET /admin/responses?device_id=android-device-123

## Current Storage

The backend currently uses in-memory storage. That means data resets on restart. This is intentional for the first frame. You can later replace app/store.py with PostgreSQL/Redis without changing endpoint contracts.
