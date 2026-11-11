"""Run dispatcher: one place that owns the envelope, the row and the counters.

``execute_script`` keeps the response keys the pre-executor route returned
(``stdout`` / ``stderr`` / ``returncode`` / ``success``) and adds the run
identity plus the event stream, so existing callers and the panel keep
working while new consumers read events.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Mapping

from autotest.executors import events
from autotest.executors.base import Executor, RunRequest
from autotest.executors.cancel import CancelToken
from autotest.executors.e2e_node import E2eNodeExecutor
from autotest.executors.python_native import PythonNativeExecutor

EXECUTORS: tuple[Executor, ...] = (PythonNativeExecutor(), E2eNodeExecutor())

RUNNING: dict[str, CancelToken] = {}


def _run_key(project_id: str, execution_id: int) -> str:
    """Execution ids are per project database, so the key needs both halves."""
    return f"{project_id}:{int(execution_id)}"


def cancel_execution(project_id: str, execution_id: int, reason: str = "cancelled by user") -> bool:
    """Ask the running executor to stop; False when that run already finished."""
    token = RUNNING.get(_run_key(project_id, execution_id))
    if token is None:
        return False
    token.cancel(reason)
    return True


def pick_executor(language: str | None) -> Executor:
    """Resolve ``scripts.language`` to an executor; unknown languages run python."""
    wanted = (language or "python").strip().lower()
    for executor in EXECUTORS:
        if executor.language == wanted:
            return executor
    return EXECUTORS[0]


def _conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _field(row: Mapping[str, Any], key: str, default: Any = None) -> Any:
    """Read from sqlite3.Row or dict without raising on a missing column."""
    try:
        value = row[key]
    except (KeyError, IndexError):
        return default
    return default if value is None else value


def execute_script(
    db_path: Path,
    project_id: str,
    script: Mapping[str, Any],
    *,
    project_dir: Path | None = None,
    timeout_s: float = 30.0,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run one script row and return the legacy response shape plus events."""
    db_path = Path(db_path)
    script_id = str(script["id"])
    script_name = str(script["name"])
    script_path = Path(str(script["filepath"])).resolve()
    executor = pick_executor(_field(script, "language", "python"))
    token = CancelToken()

    with _conn(db_path) as conn:
        events.ensure_execution_tables(conn)
        cursor = conn.execute(
            "INSERT INTO executions (name, status, total, executor, channel) VALUES (?, ?, ?, ?, ?)",
            (script_name, "执行中", 1, executor.name, executor.channel),
        )
        execution_id = int(cursor.lastrowid)
        conn.commit()

    RUNNING[_run_key(project_id, execution_id)] = token

    run_id = events.new_run_id()
    log = events.RunEventLog(db_path, execution_id)
    case_id = str(_field(script, "case_id", script_id))
    started = time.monotonic()

    request = RunRequest(
        run_id=run_id,
        execution_id=execution_id,
        project_id=project_id,
        case_id=case_id,
        script_id=script_id,
        script_name=script_name,
        script_path=script_path,
        project_dir=project_dir,
        timeout_s=timeout_s,
        meta=meta or {},
        cancel=token,
    )

    log.append(events.run_start(run_id, project_id, [case_id], executor.channel))
    first_event = log.next_seq

    status = "pass"
    counts = {"pass": 0, "fail": 0, "skip": 0}
    failure: str | None = None
    try:
        for event in executor.run(request):
            stored = log.append(event)
            if stored["type"] == "case.end":
                case_status = str(stored.get("status", "pass"))
                counts[case_status if case_status in counts else "fail"] += 1
                if case_status != "pass":
                    status = "fail" if case_status != "error" else "error"
                    failure = stored.get("failure")
    except Exception as error:  # noqa: BLE001 - a run must never take the server down
        status = "error"
        failure = f"{type(error).__name__}: {error}"
        log.append(
            events.case_end(run_id, case_id, "error", (time.monotonic() - started) * 1000, failure)
        )
        counts["fail"] += 1
    finally:
        RUNNING.pop(_run_key(project_id, execution_id), None)

    if token.cancelled:
        # A cancelled case is not a regression: keep it out of the failure count
        # so the report does not read as "1 failed" for a user-stopped run.
        status = "cancelled"
        failure = failure or f"已取消：{token.reason}"
        if counts["fail"] and not counts["pass"]:
            counts["fail"] -= 1
            counts["skip"] += 1

    duration_ms = (time.monotonic() - started) * 1000
    replay_hits = sum(
        1 for event in log.replay() if event["type"] == "step.end" and event.get("replayHit")
    )
    log.append(
        events.run_end(run_id, status, counts, duration_ms, replay_hits=replay_hits, model_calls=0)
    )

    stored_events = log.replay()
    stdout, stderr, returncode, success = _legacy_fields(stored_events, first_event)
    if status == "cancelled":
        success = False

    finished_status = {
        "pass": "已完成",
        "fail": "失败",
        "error": "异常",
        "cancelled": "已取消",
    }.get(status, "已完成")

    # 用例级结果落库：execution_cases 明细 + test_cases.status 回写。
    # 以前 execution_cases 只有建表没有写入，用例页永远显示"未执行"。
    case_result_text = {
        "pass": "通过",
        "fail": "失败",
        "error": "异常",
        "cancelled": "已取消",
    }.get(status, "未执行")
    if case_id and case_id != script_id:
        with _conn(db_path) as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS execution_cases ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id INTEGER NOT NULL, "
                "case_id TEXT NOT NULL, result TEXT DEFAULT '未执行', duration_ms INTEGER, "
                "error_message TEXT)"
            )
            conn.execute(
                "INSERT INTO execution_cases (execution_id, case_id, result, duration_ms, error_message) "
                "VALUES (?, ?, ?, ?, ?)",
                (execution_id, case_id, case_result_text, round(duration_ms, 1), failure),
            )
            if conn.execute("SELECT 1 FROM test_cases WHERE id = ?", (case_id,)).fetchone():
                conn.execute(
                    "UPDATE test_cases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (case_result_text, case_id),
                )
            conn.commit()
    with _conn(db_path) as conn:
        conn.execute(
            "UPDATE executions SET status = ?, finished_at = CURRENT_TIMESTAMP, "
            "passed = ?, failed = ?, running = 0, replay_hits = ?, model_calls = ? WHERE id = ?",
            (
                finished_status,
                counts["pass"],
                counts["fail"],
                replay_hits,
                0,
                execution_id,
            ),
        )
        conn.commit()

    return {
        "stdout": stdout,
        "stderr": stderr,
        "returncode": returncode,
        "success": success,
        "executor": executor.name,
        "channel": executor.channel,
        "execution_id": execution_id,
        "run_id": run_id,
        "status": status,
        "failure": failure,
        "duration_ms": round(duration_ms, 1),
        "events": stored_events,
    }


def read_events(db_path: Path, execution_id: int) -> list[dict[str, Any]]:
    """Replay one execution's events in order (used by the SSE endpoint)."""
    payloads: list[dict[str, Any]] = []
    with _conn(Path(db_path)) as conn:
        rows = conn.execute(
            "SELECT payload FROM execution_events WHERE execution_id = ? ORDER BY seq",
            (int(execution_id),),
        ).fetchall()
    for row in rows:
        try:
            payloads.append(json.loads(row["payload"]))
        except json.JSONDecodeError:
            continue
    return payloads


def _legacy_fields(
    stored_events: list[dict[str, Any]], first_seq: int
) -> tuple[str, str, int, bool]:
    stdout = ""
    stderr = ""
    returncode = -1
    success = False
    for event in stored_events[first_seq:]:
        if event["type"] == "step.end":
            detail = event.get("detail") or {}
            stdout = str(detail.get("stdout", ""))
            stderr = str(detail.get("stderr", ""))
            returncode = int(detail.get("returncode", -1))
        elif event["type"] == "case.end":
            success = event.get("status") == "pass"
    return stdout, stderr, returncode, success
