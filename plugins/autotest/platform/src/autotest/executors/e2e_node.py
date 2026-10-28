"""A1 bridge: the e2e Node runner as a UI execution channel.

The Python backend spawns ``node <runner.mjs> --spec <spec.json>``; the runner
prints one RunEvent per line on stdout. This module only translates that
stream into our event envelope — it never interprets UI semantics, so the
runner can be upgraded or replaced without touching the platform.

Provisioning (P4) fills ``<project>/runtime/e2e``. Until then the channel
reports a single failed step with the exact missing path instead of pretending
the case ran.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Iterator

from autotest.executors import events
from autotest.executors.base import CHANNEL_UI, Executor, RunRequest

STEP_ID = "e2e-run"
DEFAULT_TIMEOUT_S = 300.0
MAX_LOG_LINES = 200


def resolve_node() -> str | None:
    explicit = os.environ.get("AUTOTEST_E2E_NODE", "").strip()
    if explicit:
        return explicit if Path(explicit).is_file() else None
    return shutil.which("node")


def resolve_runner(request: RunRequest) -> Path | None:
    explicit = os.environ.get("AUTOTEST_E2E_RUNNER", "").strip()
    if explicit:
        candidate = Path(explicit)
        return candidate if candidate.is_file() else None
    roots = []
    # <plugin>/runner/run.mjs — executors/ -> autotest/ -> src/ -> platform/ -> plugin/
    plugin_root = Path(__file__).resolve().parents[4]
    roots.append(plugin_root / "runner")
    if request.project_dir:
        roots.append(Path(request.project_dir) / "runtime" / "e2e")
    roots.append(request.script_path.parent / "runtime" / "e2e")
    for root in roots:
        candidate = root / "run.mjs"
        if candidate.is_file():
            return candidate
    return None


def resolve_target_url(request: RunRequest) -> str | None:
    """Where the case points the app: meta, then a `// @target` header, then env."""
    meta_target = request.meta.get("target") or {}
    if isinstance(meta_target, dict) and str(meta_target.get("url", "")).strip():
        return str(meta_target["url"]).strip()

    try:
        with request.script_path.open("r", encoding="utf-8", errors="replace") as handle:
            for _ in range(20):
                line = handle.readline()
                if not line:
                    break
                marker = line.strip()
                if marker.startswith("// @target"):
                    value = marker[len("// @target"):].strip()
                    if value:
                        return value
    except OSError:
        pass

    from_env = os.environ.get("AUTOTEST_TARGET_URL", "").strip()
    return from_env or None


def resolve_e2e_home(request: RunRequest) -> Path | None:
    """Directory that holds ``node_modules/e2e`` for the runner."""
    explicit = os.environ.get("AUTOTEST_E2E_HOME", "").strip()
    if explicit and (Path(explicit) / "node_modules" / "e2e").is_dir():
        return Path(explicit)
    plugin_root = Path(__file__).resolve().parents[4]
    for candidate in (
        plugin_root / "platform" / "runtime" / "e2e",
        plugin_root / "runtime" / "e2e",
    ):
        if (candidate / "node_modules" / "e2e").is_dir():
            return candidate
    return None


class E2eNodeExecutor(Executor):
    name = "e2e-node"
    language = "e2e"
    channel = CHANNEL_UI

    def run(self, request: RunRequest) -> Iterator[dict[str, Any]]:
        started = time.monotonic()
        timeout_s = float(request.meta.get("timeout_s") or DEFAULT_TIMEOUT_S)
        yield events.case_start(request.run_id, request.case_id)
        yield events.step_start(
            request.run_id,
            request.case_id,
            STEP_ID,
            0,
            "act",
            f"e2e {request.script_name}",
        )

        node = resolve_node()
        runner = resolve_runner(request)
        e2e_home = resolve_e2e_home(request)
        target_url = resolve_target_url(request)
        missing = []
        if not node:
            missing.append("node (set AUTOTEST_E2E_NODE or put node on PATH)")
        if not runner:
            missing.append(
                "e2e runner (set AUTOTEST_E2E_RUNNER or provision "
                f"{(request.project_dir or request.script_path.parent)!s}/runtime/e2e/run.mjs)"
            )
        if not e2e_home:
            missing.append("e2e runtime (set AUTOTEST_E2E_HOME to a directory holding node_modules/e2e)")
        if not target_url:
            missing.append("target url (add `// @target <url>` to the case or set AUTOTEST_TARGET_URL)")
        if missing:
            message = "e2e runtime not provisioned: " + "; ".join(missing)
            yield events.step_end(
                request.run_id,
                request.case_id,
                STEP_ID,
                "fail",
                (time.monotonic() - started) * 1000,
                detail={"error": message, "returncode": -1, "stdout": "", "stderr": message},
            )
            yield events.case_end(
                request.run_id, request.case_id, "error", (time.monotonic() - started) * 1000, message
            )
            return

        spec = {
            "schemaVersion": events.SCHEMA_VERSION,
            "runId": request.run_id,
            "caseId": request.case_id,
            "projectId": request.project_id,
            "scriptPath": str(request.script_path),
            "caseName": request.script_name,
            "timeoutMs": int(timeout_s * 1000),
            "target": {"url": target_url},
            "artifactsDir": str(request.meta.get("artifacts_dir", request.script_path.parent)),
        }

        step_started = time.monotonic()
        stdout_lines: list[str] = []
        stderr_tail: list[str] = []
        failure: str | None = None
        passed = False
        cancelled = False
        returncode = -1

        with tempfile.TemporaryDirectory(prefix="autotest-e2e-") as scratch:
            spec_path = Path(scratch) / "spec.json"
            spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
            env = {
                **os.environ,
                **(request.env or {}),
                "AUTOTEST_RUN_ID": request.run_id,
                "AUTOTEST_E2E_HOME": str(e2e_home) if e2e_home else "",
            }
            try:
                process = subprocess.Popen(
                    [node, str(runner), "--spec", str(spec_path)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    env=env,
                    cwd=str(request.script_path.parent),
                )
            except OSError as error:
                failure = f"failed to start e2e runner: {error}"
                process = None

            if process is not None:
                assert process.stdout is not None
                deadline = time.monotonic() + timeout_s
                for line in process.stdout:
                    if request.cancel is not None and request.cancel.cancelled:
                        process.kill()
                        cancelled = True
                        failure = f"已取消：{request.cancel.reason}"
                        break
                    line = line.strip()
                    if not line:
                        continue
                    stdout_lines.append(line)
                    if len(stdout_lines) > MAX_LOG_LINES:
                        stdout_lines = stdout_lines[-MAX_LOG_LINES:]
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    normalised = _normalise(event, request)
                    if normalised is None:
                        continue
                    yield normalised
                    if time.monotonic() > deadline:
                        process.kill()
                        failure = f"e2e run exceeded {timeout_s:.0f}s"
                        break

                try:
                    returncode = process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    returncode = -9
                stderr_text = ""
                if process.stderr is not None:
                    stderr_text = process.stderr.read() or ""
                stderr_tail = [line for line in stderr_text.splitlines() if line.strip()][-40:]
                passed = returncode == 0 and not failure
                if not passed and failure is None:
                    failure = (stderr_tail[-1] if stderr_tail else f"e2e runner exit code {returncode}")

        yield events.step_end(
            request.run_id,
            request.case_id,
            STEP_ID,
            "skip" if cancelled else ("pass" if passed else "fail"),
            (time.monotonic() - step_started) * 1000,
            replay_hit=bool(request.meta.get("replay_hit", False)),
            detail={
                "returncode": returncode,
                "stdout": "\n".join(stdout_lines)[-20_000:],
                "stderr": "\n".join(stderr_tail)[-20_000:],
                "timedOut": failure is not None and "exceeded" in failure,
                "cancelled": cancelled,
            },
        )
        yield events.case_end(
            request.run_id,
            request.case_id,
            "skip" if cancelled else ("pass" if passed else "fail"),
            (time.monotonic() - started) * 1000,
            failure=failure,
        )


def _normalise(event: dict[str, Any], request: RunRequest) -> dict[str, Any] | None:
    """Force our run/case identity onto a runner-emitted event."""
    event_type = event.get("type")
    allowed = {
        "step.start",
        "step.end",
        "artifact",
    }
    if event_type not in allowed:
        # run.* stays owned by the dispatcher; unknown types are dropped.
        return None
    normalised = {key: value for key, value in event.items() if key not in ("seq", "ts", "runId")}
    normalised["runId"] = request.run_id
    normalised["caseId"] = request.case_id
    normalised.setdefault("schemaVersion", events.SCHEMA_VERSION)
    return normalised
