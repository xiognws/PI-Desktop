"""In-process Python scripts: the legacy ``subprocess.run`` path, now streamed.

Behaviour is preserved from the pre-executor route: same interpreter (the
running venv), same cwd (the script's folder), same 30 s default timeout, same
Chinese timeout message. The only addition is the event stream.
"""

from __future__ import annotations

import subprocess
import sys
import time
from typing import Any, Iterator

from autotest.executors import events
from autotest.executors.base import CHANNEL_API, Executor, RunRequest

STEP_ID = "run-script"
POLL_S = 0.1


class PythonNativeExecutor(Executor):
    name = "python-native"
    language = "python"
    channel = CHANNEL_API

    def run(self, request: RunRequest) -> Iterator[dict[str, Any]]:
        started = time.monotonic()
        yield events.case_start(request.run_id, request.case_id)
        yield events.step_start(
            request.run_id,
            request.case_id,
            STEP_ID,
            0,
            "driver",
            f"python {request.script_name}",
        )

        stdout = ""
        stderr = ""
        returncode = -1
        timed_out = False
        cancelled = False
        step_started = time.monotonic()

        try:
            process = subprocess.Popen(
                [sys.executable, str(request.script_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(request.script_path.parent),
                env=request.env or None,
            )
            deadline = step_started + float(request.timeout_s)
            while process.poll() is None:
                if request.cancel is not None and request.cancel.cancelled:
                    process.kill()
                    cancelled = True
                    break
                if time.monotonic() > deadline:
                    process.kill()
                    timed_out = True
                    break
                time.sleep(POLL_S)
            out, err = process.communicate()
            stdout = out or ""
            stderr = err or ""
            returncode = process.returncode if process.returncode is not None else -1
            if timed_out:
                stderr = f"脚本执行超时（{int(request.timeout_s)}秒）"
                returncode = -1
            elif cancelled:
                reason = request.cancel.reason if request.cancel else "cancelled"
                stderr = f"已取消：{reason}"
                returncode = -1
        except OSError as error:
            stderr = str(error)
            returncode = -1

        duration_ms = (time.monotonic() - step_started) * 1000
        passed = returncode == 0 and not timed_out and not cancelled
        yield events.step_end(
            request.run_id,
            request.case_id,
            STEP_ID,
            "pass" if passed else ("skip" if cancelled else "fail"),
            duration_ms,
            detail={
                "returncode": returncode,
                "stdout": stdout[-20_000:],
                "stderr": stderr[-20_000:],
                "timedOut": timed_out,
                "cancelled": cancelled,
            },
        )
        yield events.case_end(
            request.run_id,
            request.case_id,
            "pass" if passed else ("skip" if cancelled else "fail"),
            (time.monotonic() - started) * 1000,
            failure=None if passed else (stderr.strip() or f"exit code {returncode}"),
        )


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)
