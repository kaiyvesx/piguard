import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import websockets

TOKEN = "e2WYi3vScfE1r0WK0K0rznZzBQjXbe9u"
PRIMARY_SERVER = "ws://10.10.218.105:8000"
FALLBACK_SERVER = "ws://localhost:8000"
WS_DEVICE_PATH = "/ws/device"

DEVICE_ID = "raspi-device-001"
START_LAT = 14.6100
START_LNG = 121.0000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_unix_ms() -> int:
    return int(time.time() * 1000)


def step_banner(title: str) -> None:
    print(f"\n--- {title} ---")


def format_json(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=True)


def normalize_ws_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"ws", "wss"}:
        raise ValueError("URL must start with ws:// or wss://")

    path = parsed.path or ""
    if path in {"", "/"}:
        return f"{raw_url.rstrip('/')}{WS_DEVICE_PATH}"

    return raw_url


def build_url_candidates(override_url: str | None) -> list[str]:
    if override_url:
        return [normalize_ws_url(override_url)]
    return [
        normalize_ws_url(PRIMARY_SERVER),
        normalize_ws_url(FALLBACK_SERVER),
    ]


async def send_json(ws, payload: dict) -> None:
    encoded = format_json(payload)
    print(f"[SEND] {encoded}")
    await ws.send(encoded)


async def receive_json(ws, timeout_sec: float) -> dict | None:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout_sec)
    print(f"[RECV] {raw}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def wait_for_ready(ws, timeout_sec: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout_sec
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Timed out waiting for backend ready response")

        data = await receive_json(ws, remaining)
        if isinstance(data, dict) and data.get("type") == "ready":
            return data


async def run_simulation(url_override: str | None) -> int:
    print("============================================")
    print(f"PiGuard Raspi Simulator — {DEVICE_ID}")
    print("============================================")

    # Give time for parallel script startup before connecting.
    await asyncio.sleep(1)

    try:
        candidates = build_url_candidates(url_override)
    except Exception as exc:
        print(f"[ERROR] Invalid URL: {exc}")
        print("============================================")
        return 1

    ws = None

    for candidate in candidates:
        try:
            print(f"[CONNECT] Connecting to {candidate}...")
            ws = await websockets.connect(candidate)
            print("[CONNECT] Connected successfully")
            break
        except Exception as exc:
            print(f"[ERROR] Connection attempt failed: {exc}")

    if ws is None:
        print("[ERROR] Backend refused connection on all URLs. Exiting.")
        print("============================================")
        return 1

    try:
        step_banner("STEP 0: Authentication")
        hello_message = {
            "type": "hello",
            "role": "mobile",
            "device_id": DEVICE_ID,
            "token": TOKEN,
        }
        await send_json(ws, hello_message)
        ready = await wait_for_ready(ws)
        registered_device = str(ready.get("device_id") or DEVICE_ID)
        print(f"[AUTH] Device registered as '{registered_device}'")

        step_banner("STEP 1: Announcing online")
        online_message = {
            "type": "device_online",
            "action": "device_online",
            "device_id": DEVICE_ID,
            "payload": {
                "device_id": DEVICE_ID,
                "connected_at": now_iso(),
            },
            "ts": now_unix_ms(),
        }
        await send_json(ws, online_message)
        print("[ONLINE] Device announced as online")
        await asyncio.sleep(2)

        step_banner("STEP 2: Sending GPS updates")
        for idx in range(8):
            lat = START_LAT + (idx * 0.0002)
            lng = START_LNG + (idx * 0.0002)
            location_message = {
                "type": "location_update",
                "action": "location_update",
                "device_id": DEVICE_ID,
                "payload": {
                    "latitude": round(lat, 6),
                    "longitude": round(lng, 6),
                    "timestamp": now_iso(),
                },
                "ts": now_unix_ms(),
            }
            print(f"[GPS] Update {idx + 1}/8: lat={lat:.6f}, lng={lng:.6f}")
            await send_json(ws, location_message)
            if idx < 7:
                print("[WAIT] Next update in 5 seconds...")
                await asyncio.sleep(5)

        step_banner("STEP 3: Going offline")
        offline_message = {
            "type": "device_offline",
            "action": "device_offline",
            "device_id": DEVICE_ID,
            "payload": {
                "device_id": DEVICE_ID,
                "disconnected_at": now_iso(),
            },
            "ts": now_unix_ms(),
        }
        await send_json(ws, offline_message)
        print("[OFFLINE] Device announced as offline")
        await asyncio.sleep(1)

        step_banner("STEP 4: Disconnecting")
        await ws.close(code=1000, reason="Simulation complete")
        print(f"[DONE] Simulation complete for {DEVICE_ID}")
        print("============================================")
        return 0

    except Exception as exc:
        print(f"[ERROR] Simulation failed: {exc}")
        print("============================================")
        return 1

    finally:
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PiGuard raspi device simulator")
    parser.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override backend base URL, e.g. ws://localhost:8000",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return asyncio.run(run_simulation(args.url))


if __name__ == "__main__":
    sys.exit(main())
