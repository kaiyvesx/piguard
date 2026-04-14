import argparse
import asyncio
import json
import time

import websockets


DEVICE_ID = "mobile-sim-001"
DEVICE_TOKEN = "e2WYi3vScfE1r0WK0K0rznZzBQjXbe9u"
ADMIN_TOKEN = "C9EQlRRiBTWUCltF6yGBKIT0NXuW3OgZ"

TOTAL_COMMANDS = 8
GPS_LAT = 14.5995
GPS_LNG = 120.9842

PRIMARY_URL = "ws://localhost:8000"
SECONDARY_URL = "ws://10.10.218.105:8000"
CONNECT_TIMEOUT_SECONDS = 5


def normalize_base_url(url: str) -> str:
    base = str(url or PRIMARY_URL).strip().rstrip("/")
    for suffix in ("/ws/admin", "/ws/device"):
        if base.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def build_candidate_bases(preferred_url: str) -> list[str]:
    preferred = normalize_base_url(preferred_url)
    candidates = [preferred]
    for base in (SECONDARY_URL, PRIMARY_URL):
        normalized = normalize_base_url(base)
        if normalized not in candidates:
            candidates.append(normalized)
    return candidates


def ws_admin_url(base_url: str) -> str:
    return f"{normalize_base_url(base_url)}/ws/admin"


def ws_device_url(base_url: str) -> str:
    return f"{normalize_base_url(base_url)}/ws/device"


def new_request_id() -> str:
    return f"req-{int(time.time() * 1000)}"


async def can_connect_ws(url: str) -> bool:
    try:
        async with websockets.connect(url, open_timeout=CONNECT_TIMEOUT_SECONDS):
            return True
    except Exception:
        return False


async def resolve_base_url(preferred_url: str) -> str:
    candidates = build_candidate_bases(preferred_url)

    for base in candidates:
        admin_ok = await can_connect_ws(ws_admin_url(base))
        device_ok = await can_connect_ws(ws_device_url(base))

        if admin_ok and device_ok:
            print(f"[INFO] Using backend: {base}")
            return base

        print(f"[WARN] Backend unreachable at {base} (admin_ok={admin_ok}, device_ok={device_ok})")

    raise ConnectionRefusedError(
        "No reachable backend found. Tried: " + ", ".join(candidates)
    )


async def wait_for_ready(ws, role_label: str) -> None:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        msg = json.loads(raw)
        if msg.get("type") == "ready":
            return
        print(f"[{role_label}] Ignoring pre-ready message type={msg.get('type')}")


async def simulate_device(base_url: str, device_ready: asyncio.Event) -> int:
    sent_responses = 0

    async with websockets.connect(ws_device_url(base_url)) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "role": "mobile",
                    "device_id": DEVICE_ID,
                    "token": DEVICE_TOKEN,
                }
            )
        )
        await wait_for_ready(ws, "DEVICE")
        print(f"[DEVICE] Connected as {DEVICE_ID}")

        device_ready.set()

        while sent_responses < TOTAL_COMMANDS:
            raw = await ws.recv()
            msg = json.loads(raw)

            if msg.get("type") != "command" or msg.get("action") != "get_gps":
                print(f"[DEVICE] Ignoring message type={msg.get('type')} action={msg.get('action')}")
                continue

            request_id = str(msg.get("request_id") or "")
            if not request_id:
                request_id = new_request_id()

            print("[DEVICE] Received get_gps command, responding...")
            await asyncio.sleep(1)

            response = {
                "request_id": request_id,
                "action": "get_gps",
                "device_id": DEVICE_ID,
                "status": "success",
                "data": {
                    "lat": GPS_LAT,
                    "lng": GPS_LNG,
                },
            }
            await ws.send(json.dumps(response))
            sent_responses += 1
            print(f"[DEVICE] Sent GPS response for request_id: {request_id}")

        print("[DEVICE] Sent 8 GPS responses, disconnecting")

    return sent_responses


async def admin_response_listener(ws, state: dict) -> None:
    while True:
        try:
            raw = await ws.recv()
        except websockets.ConnectionClosed:
            return

        msg = json.loads(raw)

        if msg.get("type") != "command_response":
            continue
        if msg.get("action") != "get_gps":
            continue

        request_id = str(msg.get("request_id") or "")
        lat = msg.get("data", {}).get("lat")
        lng = msg.get("data", {}).get("lng")
        status = str(msg.get("status") or "")

        if request_id and request_id in state["seen_request_ids"]:
            continue

        if request_id:
            state["seen_request_ids"].add(request_id)

        state["responses_received"] += 1

        print(f"[ADMIN]  Got GPS response: lat={lat} lng={lng} status={status}")
        print(f"[ADMIN]  Got GPS: lat={lat} lng={lng} {'✓' if status == 'success' else 'x'}")

        if state["responses_received"] >= TOTAL_COMMANDS:
            state["responses_done"].set()
            return


async def simulate_admin(base_url: str, device_ready: asyncio.Event) -> int:
    state = {
        "responses_received": 0,
        "seen_request_ids": set(),
        "responses_done": asyncio.Event(),
    }

    async with websockets.connect(ws_admin_url(base_url)) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "role": "admin",
                    "token": ADMIN_TOKEN,
                }
            )
        )
        await wait_for_ready(ws, "ADMIN")
        print("[ADMIN]  Connected as admin")

        try:
            await asyncio.wait_for(device_ready.wait(), timeout=10)
        except asyncio.TimeoutError:
            print("[ADMIN]  Device readiness timeout, continuing anyway")

        listener_task = asyncio.create_task(admin_response_listener(ws, state))

        await asyncio.sleep(3)

        for idx in range(1, TOTAL_COMMANDS + 1):
            request_id = new_request_id()
            command = {
                "type": "command_request",
                "device_id": DEVICE_ID,
                "action": "get_gps",
                "request_id": request_id,
                "payload": {},
            }
            print(f"[ADMIN]  Sending get_gps command {idx}/{TOTAL_COMMANDS}...")
            await ws.send(json.dumps(command))
            print(f"[ADMIN] Sent get_gps command, request_id: {request_id}")

            if idx < TOTAL_COMMANDS:
                await asyncio.sleep(5)

        try:
            await asyncio.wait_for(state["responses_done"].wait(), timeout=90)
        except asyncio.TimeoutError:
            print("[ADMIN]  Timed out waiting for GPS responses")

        listener_task.cancel()
        try:
            await listener_task
        except asyncio.CancelledError:
            pass

    return state["responses_received"]


def print_header() -> None:
    print("============================================")
    print("PiGuard GPS Command Test")
    print("============================================")


def print_footer(total_received: int) -> None:
    print("============================================")
    mark = "✓" if total_received >= TOTAL_COMMANDS else "x"
    print(f"TEST COMPLETE - {total_received}/{TOTAL_COMMANDS} GPS responses received {mark}")
    print("============================================")


async def run_test(base_url: str) -> None:
    resolved_base = await resolve_base_url(base_url)
    device_ready = asyncio.Event()

    device_task = asyncio.create_task(simulate_device(resolved_base, device_ready))
    admin_task = asyncio.create_task(simulate_admin(resolved_base, device_ready))

    _device_sent, admin_received = await asyncio.gather(device_task, admin_task)
    print_footer(admin_received)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PiGuard GPS command/response end-to-end test")
    parser.add_argument(
        "--url",
        default=PRIMARY_URL,
        help="Backend base URL, for example: ws://10.10.218.105:8000",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    print_header()

    try:
        asyncio.run(run_test(args.url))
    except ConnectionRefusedError as err:
        print(f"\n[ERROR] {err}")
        print("[ERROR] Start the backend or pass a reachable URL, for example:")
        print("        python scripts/test_gps_command.py --url ws://10.10.218.105:8000")
    except KeyboardInterrupt:
        print("\n[INFO] Interrupted by user")
    except Exception as err:
        print(f"\n[ERROR] Test failed: {err}")


if __name__ == "__main__":
    main()
