"""Exit when the host that started us goes away.

The plugin spawns this backend as a child of the desktop app. When the app is
closed the plugin's `stop` hook normally kills us, but a force-quit or a crash
leaves the child running: the next launch then finds port 4000 taken by a
backend nobody owns, which looks exactly like "the plugin is broken".

So the backend watches its parent: `AUTOTEST_PARENT_PID` names the process that
started it, and this thread exits the interpreter once that process is gone.
"""

from __future__ import annotations

import os
import sys
import threading
import time

POLL_SECONDS = 5.0


def _parent_alive_windows(pid: int) -> bool:
    import ctypes

    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        # Access denied means "exists but we may not wait on it"; treat as alive.
        return ctypes.get_last_error() == 5
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def _parent_alive_posix(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def parent_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    try:
        if sys.platform == "win32":
            return _parent_alive_windows(pid)
        return _parent_alive_posix(pid)
    except Exception:  # noqa: BLE001 - unknown platform: never kill the backend
        return True


def _watch(pid: int) -> None:
    while True:
        time.sleep(POLL_SECONDS)
        if not parent_alive(pid):
            # The pipe the host read from is gone too, so nothing is listening:
            # exiting is the only way to free the port for the next launch.
            raise SystemExit(0)


def start_parent_watchdog() -> bool:
    """Start the watchdog when the plugin passed a parent pid. Returns whether it ran."""
    raw = os.environ.get("AUTOTEST_PARENT_PID", "").strip()
    if not raw:
        return False
    try:
        pid = int(raw)
    except ValueError:
        return False
    threading.Thread(target=_watch, args=(pid,), name="parent-watchdog", daemon=True).start()
    return True
