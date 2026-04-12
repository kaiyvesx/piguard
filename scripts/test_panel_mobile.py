import asyncio
import websockets
import json
import datetime
import argparse
import time

PRIMARY_URL = "ws://localhost:8000"
SECONDARY_URL = "ws://10.10.218.105:8000"
WS_PATH = "/ws/device"
MOBILE_TOKEN = "e2WYi3vScfE1r0WK0K0rznZzBQjXbe9u"

GPS_UPDATES = 8
GPS_INTERVAL_SECONDS = 5
LOCATION_STEP = 0.0002

DEVICES = [
    {
        "name": "Device 1",
        "device_id": "mobile-user-001",
        "latitude": 14.5995,
        "longitude": 120.9842,
        "start_delay": 0,
        "expected_color": "Blue",
    },
    {
        "name": "Device 2",
        "device_id": "mobile-user-002",
        "latitude": 14.6100,
        "longitude": 121.0000,
        "start_delay": 3,
        "expected_color": "Green",
    },
    {
        "name": "Device 3",
        "device_id": "raspi-device-001",
        "latitude": 14.5800,
        "longitude": 120.9700,
        "start_delay": 6,
        "expected_color": "Orange",
    },
]


def iso_now():
    return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def unix_ms():
    return int(time.time() * 1000)


def normalize_base_url(url):
    base = str(url or PRIMARY_URL).strip().rstrip("/")
    if base.endswith(WS_PATH):
        base = base[: -len(WS_PATH)].rstrip("/")
    return base


def ws_device_url(base_url):
    return normalize_base_url(base_url) + WS_PATH


async def connect_with_fallback(base_url):
    requested = normalize_base_url(base_url)
    candidates = [requested]

    if requested != PRIMARY_URL:
        candidates.append(PRIMARY_URL)
    elif SECONDARY_URL != PRIMARY_URL:
        candidates.append(SECONDARY_URL)

    tried = []
    last_error = None

    for idx, candidate in enumerate(candidates):
        if candidate in tried:
            continue
        tried.append(candidate)

        try:
            ws = await websockets.connect(ws_device_url(candidate))
            return ws, candidate
        except OSError as err:
            last_error = err
            print(f"[ERROR] Cannot connect to {candidate}")
        except Exception as err:
            last_error = err
            print(f"[ERROR] Cannot connect to {candidate}")

        if idx < len(candidates) - 1:
            next_target = candidates[idx + 1]
            if next_target == PRIMARY_URL:
                print(f"[INFO] Trying fallback {PRIMARY_URL}")
            else:
                print(f"[INFO] Trying fallback {next_target}")

    if last_error:
        raise last_error
    raise RuntimeError("Unable to establish WebSocket connection")


async def wait_for_ready(ws, device_id):
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        msg = json.loads(raw)
        if msg.get("type") == "ready":
            print(f"[{device_id}] AUTH OK")
            return


async def simulate_device(device, base_url):
    device_id = device["device_id"]
    lat = float(device["latitude"])
    lng = float(device["longitude"])
    start_delay = int(device["start_delay"])

    result = {
        "device_id": device_id,
        "gps_updates_sent": 0,
        "offline_announced": False,
    }

    ws = None

    try:
        if start_delay > 0:
            await asyncio.sleep(start_delay)

        ws, _connected_base = await connect_with_fallback(base_url)

        hello = {
            "type": "hello",
            "role": "mobile",
            "device_id": device_id,
            "token": MOBILE_TOKEN,
        }
        await ws.send(json.dumps(hello))
        await wait_for_ready(ws, device_id)

        online_msg = {
            "type": "device_online",
            "action": "device_online",
            "device_id": device_id,
            "payload": {
                "device_id": device_id,
                "connected_at": iso_now(),
            },
            "ts": unix_ms(),
        }
        await ws.send(json.dumps(online_msg))
        print(f"[{device_id}] ONLINE announced")
        await asyncio.sleep(2)

        for i in range(1, GPS_UPDATES + 1):
            lat += LOCATION_STEP
            lng += LOCATION_STEP

            gps_msg = {
                "type": "location_update",
                "action": "location_update",
                "device_id": device_id,
                "payload": {
                    "latitude": round(lat, 6),
                    "longitude": round(lng, 6),
                    "timestamp": iso_now(),
                },
                "ts": unix_ms(),
            }

            await ws.send(json.dumps(gps_msg))
            result["gps_updates_sent"] = i
            print(f"[{device_id}] GPS {i}/8 lat={lat:.6f} lng={lng:.6f}")

            if i < GPS_UPDATES:
                await asyncio.sleep(GPS_INTERVAL_SECONDS)

        offline_msg = {
            "type": "device_offline",
            "action": "device_offline",
            "device_id": device_id,
            "payload": {
                "device_id": device_id,
                "disconnected_at": iso_now(),
            },
            "ts": unix_ms(),
        }
        await ws.send(json.dumps(offline_msg))
        result["offline_announced"] = True
        print(f"[{device_id}] OFFLINE announced")
        await asyncio.sleep(1)

        print(f"[{device_id}] DONE")

    except Exception as err:
        print(f"[{device_id}] ERROR: {err}")
    finally:
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    return result


def print_header():
    print("============================================")
    print("PiGuard Panel-Mobile Test - 3 Devices")
    print("============================================")
    print("Starting Device 1 (mobile-user-001) immediately...")
    print("Starting Device 2 (mobile-user-002) in 3 seconds...")
    print("Starting Device 3 (raspi-device-001) in 6 seconds...")
    print("Open panel-mobile.html in Electron to see devices appear!")
    print("============================================")


def print_summary(results_by_id):
    print("============================================")
    print("TEST COMPLETE")

    for device in DEVICES:
        device_id = device["device_id"]
        result = results_by_id.get(device_id, {"gps_updates_sent": 0, "offline_announced": False})
        sent = int(result.get("gps_updates_sent", 0))
        mark = "✓" if sent == GPS_UPDATES else "x"
        print(f"{device_id}: {sent} GPS updates sent {mark}")

    all_offline = all(results_by_id.get(d["device_id"], {}).get("offline_announced", False) for d in DEVICES)
    offline_mark = "✓" if all_offline else "x"
    print(f"All devices offline {offline_mark}")
    print("============================================")


async def run_test(base_url):
    print_header()

    tasks = [
        asyncio.create_task(simulate_device(device, base_url))
        for device in DEVICES
    ]

    gathered = await asyncio.gather(*tasks, return_exceptions=True)

    results_by_id = {}
    for idx, item in enumerate(gathered):
        device_id = DEVICES[idx]["device_id"]

        if isinstance(item, Exception):
            print(f"[{device_id}] ERROR: {item}")
            results_by_id[device_id] = {
                "gps_updates_sent": 0,
                "offline_announced": False,
            }
            continue

        results_by_id[device_id] = item

    print_summary(results_by_id)


def parse_args():
    parser = argparse.ArgumentParser(description="PiGuard panel-mobile multi-device simulator")
    parser.add_argument(
        "--url",
        default=PRIMARY_URL,
        help="Backend base URL, e.g. ws://localhost:8000",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    target_url = normalize_base_url(args.url)

    try:
        asyncio.run(run_test(target_url))
    except KeyboardInterrupt:
        print("\n[INFO] Interrupted by user")


if __name__ == "__main__":
    main()
