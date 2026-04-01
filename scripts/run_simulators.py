import argparse
import asyncio
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
MOBILE_SCRIPT = SCRIPTS_DIR / "simulate_mobile.py"
RASPI_SCRIPT = SCRIPTS_DIR / "simulate_raspi.py"


def build_command(script_path: Path, url_override: str | None) -> list[str]:
    command = [sys.executable, str(script_path)]
    if url_override:
        command.extend(["--url", url_override])
    return command


async def stream_output(prefix: str, stream: asyncio.StreamReader) -> None:
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").rstrip("\n")
        print(f"[{prefix}] {text}")


async def launch_process(name: str, command: list[str]) -> tuple[asyncio.subprocess.Process, asyncio.Task]:
    print(f"[LAUNCH] Starting {name}: {' '.join(command)}")
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(SCRIPTS_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stream_task = asyncio.create_task(stream_output(name, process.stdout))
    return process, stream_task


async def run_launcher(url: str | None, mobile_url: str | None, raspi_url: str | None) -> int:
    if not MOBILE_SCRIPT.exists() or not RASPI_SCRIPT.exists():
        print("[ERROR] Required simulator scripts not found in scripts folder.")
        return 1

    mobile_target_url = mobile_url or url
    raspi_target_url = raspi_url or url

    mobile_cmd = build_command(MOBILE_SCRIPT, mobile_target_url)
    raspi_cmd = build_command(RASPI_SCRIPT, raspi_target_url)

    mobile_proc = None
    raspi_proc = None
    mobile_stream_task = None
    raspi_stream_task = None

    print("============================================")
    print("PiGuard Dual Simulator Launcher")
    print("============================================")

    try:
        mobile_proc, mobile_stream_task = await launch_process("MOBILE", mobile_cmd)
        raspi_proc, raspi_stream_task = await launch_process("RASPI", raspi_cmd)

        mobile_wait_task = asyncio.create_task(mobile_proc.wait())
        raspi_wait_task = asyncio.create_task(raspi_proc.wait())

        mobile_code, raspi_code = await asyncio.gather(mobile_wait_task, raspi_wait_task)

        if mobile_stream_task:
            await mobile_stream_task
        if raspi_stream_task:
            await raspi_stream_task

        print("--------------------------------------------")
        print(f"[RESULT] MOBILE exit code: {mobile_code}")
        print(f"[RESULT] RASPI  exit code: {raspi_code}")

        if mobile_code == 0 and raspi_code == 0:
            print("[DONE] Both simulators completed successfully.")
            print("============================================")
            return 0

        print("[DONE] One or more simulators exited with errors.")
        print("============================================")
        return 1

    except KeyboardInterrupt:
        print("\n[STOP] Interrupted by user. Stopping simulators...")
        return 130

    finally:
        for proc in (mobile_proc, raspi_proc):
            if proc and proc.returncode is None:
                proc.terminate()

        for proc in (mobile_proc, raspi_proc):
            if proc and proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    proc.kill()

        stream_tasks = [task for task in (mobile_stream_task, raspi_stream_task) if task]
        if stream_tasks:
            await asyncio.gather(*stream_tasks, return_exceptions=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run both PiGuard simulators concurrently")
    parser.add_argument(
        "--url",
        type=str,
        default=None,
        help="Shared backend URL for both scripts (example: ws://localhost:8000)",
    )
    parser.add_argument(
        "--mobile-url",
        type=str,
        default=None,
        help="Backend URL override for mobile simulator only",
    )
    parser.add_argument(
        "--raspi-url",
        type=str,
        default=None,
        help="Backend URL override for raspi simulator only",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return asyncio.run(run_launcher(args.url, args.mobile_url, args.raspi_url))


if __name__ == "__main__":
    sys.exit(main())
