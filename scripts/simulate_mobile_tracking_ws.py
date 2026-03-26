import asyncio
import json
from datetime import datetime, timezone

import websockets


# Defaults based on your provided environment/config
WS_BASE_URL = "ws://10.10.218.105:8000"
WS_PATH_CANDIDATES = ("/ws/device", "/ws/mobile")
MOBILE_BEARER_TOKEN = "e2WYi3vScfE1r0WK0K0rznZzBQjXbe9u"
DEVICE_ID = "13e1b5b146eba495"

# Manila baseline
BASE_LAT = 14.5995
BASE_LON = 120.9842


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_unix_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


async def connect_with_fallback(base_url: str):
    """Try /ws/device first, then /ws/mobile."""
    last_error = None
    for path in WS_PATH_CANDIDATES:
        url = f"{base_url.rstrip('/')}{path}"
        print(f"[CONNECT] Trying {url}")
        try:
            ws = await websockets.connect(url)
            return ws, path
        except Exception as exc:
            last_error = exc
            print(f"[CONNECT] Failed on {path}: {exc}")
    raise RuntimeError(f"Unable to connect to any path {WS_PATH_CANDIDATES}: {last_error}")


async def recv_once(ws, timeout_sec=5):
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout_sec)
        try:
            parsed = json.loads(raw)
            print(f"[RECV] {json.dumps(parsed, ensure_ascii=True)}")
        except Exception:
            print(f"[RECV] {raw}")
        return raw
    except asyncio.TimeoutError:
        print("[RECV] (no message)")
        return None


async def send_json(ws, payload):
    body = json.dumps(payload, ensure_ascii=True)
    await ws.send(body)
    print(f"[SEND] {body}")


async def main():
    ws, selected_path = await connect_with_fallback(WS_BASE_URL)
    print(f"[CONNECT] Connected using {selected_path}")

    async with ws:
        # Handshake/auth expected by backend /ws/device
        hello = {
            "type": "hello",
            "role": "mobile",
            "device_id": DEVICE_ID,
            "token": MOBILE_BEARER_TOKEN,
        }

        print("[STEP 0] Sending hello/auth...")
        await send_json(ws, hello)
        await recv_once(ws, timeout_sec=5)

        # 1) tracking_request
        start_iso = now_iso()
        tracking_request = {
            "type": "tracking_request",
            "action": "tracking_request",
            "device_id": DEVICE_ID,
            "payload": {
                "source": "tracker_tab",
                "requested_at": start_iso,
            },
            "ts": now_unix_ms(),
        }

        print("[STEP 1] Sending tracking_request...")
        await send_json(ws, tracking_request)

        print("[WAIT] Sleeping 3 seconds...")
        await asyncio.sleep(3)

        # 2) location_update x5, every 5 seconds
        route = []
        lat_step = 0.00015
        lon_step = 0.00018

        for i in range(5):
            lat = round(BASE_LAT + (i * lat_step), 6)
            lon = round(BASE_LON + (i * lon_step), 6)
            point_ts = now_iso()

            location_update = {
                "type": "location_update",
                "action": "location_update",
                "device_id": DEVICE_ID,
                "latitude": lat,
                "longitude": lon,
                "timestamp": point_ts,
                "ts": now_unix_ms(),
            }

            route.append(
                {
                    "latitude": lat,
                    "longitude": lon,
                    "timestamp": point_ts,
                }
            )

            print(f"[STEP 2] Sending location update {i + 1}/5...")
            await send_json(ws, location_update)

            if i < 4:
                print("[WAIT] Sleeping 5 seconds...")
                await asyncio.sleep(5)

        # 3) tracking_session_end
        end_iso = now_iso()
        tracking_session_end = {
            "type": "tracking_session_end",
            "action": "tracking_session_end",
            "device_id": DEVICE_ID,
            "session": {
                "start_time": start_iso,
                "end_time": end_iso,
                "duration_seconds": 25,
                "route": route,
            },
            "ts": now_unix_ms(),
        }

        print("[STEP 3] Sending tracking_session_end...")
        await send_json(ws, tracking_session_end)

        print("[DONE] Simulation finished.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[STOP] Interrupted by user.")
