"""
Temporary test script - simulates a mobile device connecting to the backend.
Run this while your Electron app is open to test the full flow.

Delete this file when testing is complete.
"""
import asyncio
import json
import os
import websockets

BACKEND_URL = "ws://localhost:8000/ws/device"
MOBILE_TOKEN = os.getenv("MOBILE_BEARER_TOKEN", "change-me-mobile-token")
DEVICE_ID = "mobile-01"

# Fake GPS data to return
FAKE_GPS = {
    "fix": "1",
    "lat": 14.5995,
    "lon": 120.9842,
    "speed": 45.5,
    "alt": 15.2,
    "sat": 8
}

FAKE_DEVICE_INFO = {
    "model": "Test Phone",
    "android_version": "13",
    "battery": 85,
    "charging": False
}

async def handle_command(ws, msg):
    """Handle incoming command and send response."""
    action = msg.get("action", "")
    request_id = msg.get("request_id", "")

    print(f"[Mobile] Received command: {action} (request_id: {request_id})")

    # Simulate processing delay
    await asyncio.sleep(0.5)

    # Build response based on action
    if action == "get_gps":
        data = FAKE_GPS
    elif action == "get_device_info":
        data = FAKE_DEVICE_INFO
    elif action == "take_photo":
        data = {"photo_url": "data:image/jpeg;base64,/9j/4AAQSkZJRg==", "camera": "back"}
    elif action == "get_messages":
        data = {"sms": [], "sms_inbox": [{"from_number": "09171234567", "message": "Test message", "ts": "2024-01-01T12:00:00Z"}]}
    elif action == "get_contacts":
        data = {"contacts": [{"name": "Test Contact", "number": "09171234567"}]}
    else:
        data = {"echo": action, "message": f"Received {action} command"}

    response = {
        "type": "command_response",
        "request_id": request_id,
        "action": action,
        "status": "success",
        "data": data
    }

    await ws.send(json.dumps(response))
    print(f"[Mobile] Sent response for {action}")

async def main():
    print("=" * 50)
    print("Mobile Device Simulator")
    print("=" * 50)
    print(f"Connecting to: {BACKEND_URL}")
    print(f"Device ID: {DEVICE_ID}")
    print("=" * 50)

    try:
        async with websockets.connect(BACKEND_URL) as ws:
            # Send hello message
            hello = {
                "type": "hello",
                "role": "device",
                "device_id": DEVICE_ID,
                "token": MOBILE_TOKEN
            }
            await ws.send(json.dumps(hello))
            print("[Mobile] Sent hello message")

            # Wait for ready response
            response = await ws.recv()
            data = json.loads(response)

            if data.get("type") == "ready":
                print(f"[Mobile] Connected and ready as '{data.get('device_id')}'")
                print("\n[Mobile] Waiting for commands from admin...")
                print("[Mobile] (Press Ctrl+C to disconnect)\n")
            else:
                print(f"[Mobile] Unexpected response: {data}")
                return

            # Listen for commands
            while True:
                try:
                    msg_raw = await ws.recv()
                    msg = json.loads(msg_raw)

                    if msg.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                        continue

                    if msg.get("type") == "command" or msg.get("action"):
                        await handle_command(ws, msg)
                    else:
                        print(f"[Mobile] Unknown message: {msg}")

                except websockets.ConnectionClosed:
                    print("[Mobile] Connection closed by server")
                    break

    except ConnectionRefusedError:
        print("[Mobile] ERROR: Cannot connect to backend server")
        print("[Mobile] Make sure the backend is running: python -m uvicorn app.main:app")
    except Exception as e:
        print(f"[Mobile] ERROR: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Mobile] Disconnected by user")
