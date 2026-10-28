"""Scheduled pipeline runs.

A schedule is a small, inspectable rule: which project, which requirement, which
target, and when to fire. The plugin polls `due` and calls `fire`; the backend
creates the pipeline (always `auto`, no checkpoint) so a nightly run can never
sit waiting for someone to click approve.

Kept out of `service.py` because it has its own lifecycle (time math, enable /
disable, next-run advance) and that file is already the pipeline state machine.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from autotest.pipelines.service import (
    CHECKPOINT_POLICIES,
    PipelineRuleError,
    create_pipeline,
    get_pipeline,
)

SCHEDULE_SCHEMA = """
CREATE TABLE IF NOT EXISTS pipeline_schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    requirement_filename TEXT,
    target_url TEXT,
    kind TEXT NOT NULL DEFAULT 'daily',
    at_time TEXT,
    interval_minutes INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TIMESTAMP,
    next_run_at TIMESTAMP,
    last_pipeline_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""

KINDS = ("daily", "interval")
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def ensure_schedule_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEDULE_SCHEMA)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(pipelines)").fetchall()}
    if columns and "schedule_id" not in columns:
        conn.execute("ALTER TABLE pipelines ADD COLUMN schedule_id TEXT")


def _conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(Path(db_path))
    conn.row_factory = sqlite3.Row
    ensure_schedule_tables(conn)
    return conn


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), TIME_FORMAT)
    except ValueError:
        return None


def compute_next(schedule: dict[str, Any], now: datetime | None = None) -> datetime | None:
    """Next fire time for a schedule; ``None`` means "not scheduled"."""
    now = now or datetime.now().replace(microsecond=0)
    kind = str(schedule.get("kind") or "daily")
    if kind == "interval":
        minutes = int(schedule.get("interval_minutes") or 0)
        if minutes <= 0:
            return None
        return now + timedelta(minutes=minutes)
    at_time = str(schedule.get("at_time") or "").strip()
    try:
        hour, minute = (int(part) for part in at_time.split(":", 1))
    except (ValueError, TypeError):
        return None
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None
    candidate = now.replace(hour=hour, minute=minute, second=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def validate_schedule(payload: dict[str, Any]) -> dict[str, Any]:
    kind = str(payload.get("kind") or "daily").strip()
    if kind not in KINDS:
        raise PipelineRuleError(f"kind must be one of {KINDS}")
    name = str(payload.get("name") or "").strip() or "计划任务"
    requirement = str(payload.get("requirementFilename") or "").strip()
    if not requirement:
        raise PipelineRuleError("requirementFilename is required")

    at_time = None
    interval_minutes = None
    if kind == "daily":
        raw = str(payload.get("atTime") or "").strip()
        try:
            hour, minute = (int(part) for part in raw.split(":", 1))
        except (ValueError, TypeError) as error:
            raise PipelineRuleError("atTime must look like HH:MM") from error
        if not (0 <= hour < 24 and 0 <= minute < 60):
            raise PipelineRuleError("atTime must be within 00:00–23:59")
        at_time = f"{hour:02d}:{minute:02d}"
    else:
        try:
            interval_minutes = int(payload.get("intervalMinutes") or 0)
        except (TypeError, ValueError) as error:
            raise PipelineRuleError("intervalMinutes must be an integer") from error
        if interval_minutes < 5:
            raise PipelineRuleError("intervalMinutes must be at least 5")

    return {
        "name": name,
        "requirement_filename": requirement,
        "target_url": str(payload.get("targetUrl") or "").strip(),
        "kind": kind,
        "at_time": at_time,
        "interval_minutes": interval_minutes,
        "enabled": 1 if payload.get("enabled", True) else 0,
    }


def create_schedule(db_path: Path, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    values = validate_schedule(payload)
    schedule_id = f"sch_{uuid.uuid4().hex[:8]}"
    next_run = compute_next(values)
    conn = _conn(db_path)
    try:
        conn.execute(
            "INSERT INTO pipeline_schedules (id, project_id, name, requirement_filename, "
            "target_url, kind, at_time, interval_minutes, enabled, next_run_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                schedule_id,
                project_id,
                values["name"],
                values["requirement_filename"],
                values["target_url"],
                values["kind"],
                values["at_time"],
                values["interval_minutes"],
                values["enabled"],
                next_run.strftime(TIME_FORMAT) if next_run else None,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_schedule(db_path, schedule_id)


def list_schedules(db_path: Path, project_id: str) -> list[dict[str, Any]]:
    conn = _conn(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM pipeline_schedules WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def get_schedule(db_path: Path, schedule_id: str) -> dict[str, Any]:
    conn = _conn(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM pipeline_schedules WHERE id = ?", (schedule_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise PipelineRuleError(f"schedule not found: {schedule_id}")
    return dict(row)


def update_schedule(db_path: Path, schedule_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    current = get_schedule(db_path, schedule_id)
    merged = {
        "name": payload.get("name", current["name"]),
        "requirementFilename": payload.get(
            "requirementFilename", current["requirement_filename"]
        ),
        "targetUrl": payload.get("targetUrl", current["target_url"]),
        "kind": payload.get("kind", current["kind"]),
        "atTime": payload.get("atTime", current["at_time"]),
        "intervalMinutes": payload.get("intervalMinutes", current["interval_minutes"]),
        "enabled": payload.get("enabled", bool(current["enabled"])),
    }
    values = validate_schedule(merged)
    next_run = compute_next(values) if values["enabled"] else None
    conn = _conn(db_path)
    try:
        conn.execute(
            "UPDATE pipeline_schedules SET name = ?, requirement_filename = ?, target_url = ?, "
            "kind = ?, at_time = ?, interval_minutes = ?, enabled = ?, next_run_at = ? WHERE id = ?",
            (
                values["name"],
                values["requirement_filename"],
                values["target_url"],
                values["kind"],
                values["at_time"],
                values["interval_minutes"],
                values["enabled"],
                next_run.strftime(TIME_FORMAT) if next_run else None,
                schedule_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return get_schedule(db_path, schedule_id)


def delete_schedule(db_path: Path, schedule_id: str) -> None:
    conn = _conn(db_path)
    try:
        conn.execute("DELETE FROM pipeline_schedules WHERE id = ?", (schedule_id,))
        conn.commit()
    finally:
        conn.close()


def due_schedules(db_path: Path, now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now()
    conn = _conn(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM pipeline_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    due: list[dict[str, Any]] = []
    for row in rows:
        next_run = _parse(row["next_run_at"])
        if next_run is not None and next_run <= now:
            due.append(dict(row))
    return due


def fire_schedule(db_path: Path, project_id: str, schedule_id: str) -> dict[str, Any]:
    """Create the pipeline this schedule describes, then advance its next run."""
    schedule = get_schedule(db_path, schedule_id)
    if not schedule["enabled"]:
        raise PipelineRuleError("schedule is disabled")
    state = create_pipeline(
        db_path,
        project_id,
        str(schedule["requirement_filename"] or ""),
        "auto",
        "scheduled",
        str(schedule["target_url"] or ""),
    )
    pipeline_id = state["pipeline"]["id"]

    now = datetime.now().replace(microsecond=0)
    following = compute_next(schedule, now)
    conn = _conn(db_path)
    try:
        conn.execute(
            "UPDATE pipeline_schedules SET last_run_at = ?, next_run_at = ?, last_pipeline_id = ? "
            "WHERE id = ?",
            (
                now.strftime(TIME_FORMAT),
                following.strftime(TIME_FORMAT) if following else None,
                pipeline_id,
                schedule_id,
            ),
        )
        conn.execute(
            "UPDATE pipelines SET schedule_id = ? WHERE id = ?", (schedule_id, pipeline_id)
        )
        conn.commit()
    finally:
        conn.close()
    return {"schedule": get_schedule(db_path, schedule_id), **get_pipeline(db_path, pipeline_id)}


def all_due(db_paths: list[tuple[str, Path]]) -> list[dict[str, Any]]:
    """`[(project_id, db_path)]` → every due schedule with its project id."""
    due: list[dict[str, Any]] = []
    for project_id, db_path in db_paths:
        try:
            for row in due_schedules(db_path):
                due.append({**row, "project_id": project_id})
        except sqlite3.Error:
            continue
    return due


__all__ = [
    "CHECKPOINT_POLICIES",
    "all_due",
    "compute_next",
    "create_schedule",
    "delete_schedule",
    "due_schedules",
    "ensure_schedule_tables",
    "fire_schedule",
    "get_schedule",
    "list_schedules",
    "update_schedule",
    "validate_schedule",
]
