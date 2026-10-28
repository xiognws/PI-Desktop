"""Scheduled runs: next-run math, due filtering, and firing.

The point of these tests is that a scheduled run can never be "waiting for a
click": firing always creates a pipeline with the `auto` checkpoint policy.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from autotest.pipelines import schedules
from autotest.pipelines.service import PipelineRuleError, get_pipeline


def _db(tmp_path: Path) -> Path:
    db_path = tmp_path / "data.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS scripts (id TEXT PRIMARY KEY, name TEXT, language TEXT);
        CREATE TABLE IF NOT EXISTS test_cases (id TEXT PRIMARY KEY, title TEXT);
        """
    )
    conn.commit()
    conn.close()
    schedules.ensure_schedule_tables(conn := sqlite3.connect(db_path))
    conn.commit()
    conn.close()
    return db_path


def test_daily_schedule_computes_tomorrow_after_the_time_passed():
    now = datetime(2026, 10, 27, 23, 30, 0)
    nxt = schedules.compute_next({"kind": "daily", "at_time": "02:00"}, now)
    assert nxt == datetime(2026, 10, 28, 2, 0, 0)


def test_daily_schedule_keeps_today_when_still_ahead():
    now = datetime(2026, 10, 27, 1, 0, 0)
    nxt = schedules.compute_next({"kind": "daily", "at_time": "02:00"}, now)
    assert nxt == datetime(2026, 10, 27, 2, 0, 0)


def test_interval_schedule_adds_minutes():
    now = datetime(2026, 10, 27, 10, 0, 0)
    nxt = schedules.compute_next({"kind": "interval", "interval_minutes": 45}, now)
    assert nxt == datetime(2026, 10, 27, 10, 45, 0)


def test_bad_schedule_input_is_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    with pytest.raises(PipelineRuleError, match="atTime"):
        schedules.create_schedule(
            db_path, "proj", {"requirementFilename": "req.md", "kind": "daily", "atTime": "25:00"}
        )
    with pytest.raises(PipelineRuleError, match="at least 5"):
        schedules.create_schedule(
            db_path, "proj", {"requirementFilename": "req.md", "kind": "interval", "intervalMinutes": 2}
        )
    with pytest.raises(PipelineRuleError, match="requirementFilename"):
        schedules.create_schedule(db_path, "proj", {"kind": "daily", "atTime": "02:00"})


def test_due_only_returns_enabled_and_past_schedules(tmp_path: Path):
    db_path = _db(tmp_path)
    soon = schedules.create_schedule(
        db_path, "proj", {"requirementFilename": "req.md", "kind": "interval", "intervalMinutes": 60}
    )
    later = schedules.create_schedule(
        db_path, "proj", {"requirementFilename": "req.md", "kind": "daily", "atTime": "00:05"}
    )
    now = datetime.now()
    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE pipeline_schedules SET next_run_at = ? WHERE id = ?",
        ((now - timedelta(minutes=1)).strftime(schedules.TIME_FORMAT), soon["id"]),
    )
    conn.execute(
        "UPDATE pipeline_schedules SET next_run_at = ? WHERE id = ?",
        ((now + timedelta(hours=3)).strftime(schedules.TIME_FORMAT), later["id"]),
    )
    conn.commit()
    conn.close()

    due = schedules.due_schedules(db_path, now)
    assert [row["id"] for row in due] == [soon["id"]]

    schedules.update_schedule(db_path, soon["id"], {"enabled": False})
    assert schedules.due_schedules(db_path, now) == []


def test_fire_creates_auto_pipeline_and_advances_next_run(tmp_path: Path):
    db_path = _db(tmp_path)
    schedule = schedules.create_schedule(
        db_path, "proj", {"requirementFilename": "req.md", "kind": "interval", "intervalMinutes": 30}
    )
    fired = schedules.fire_schedule(db_path, "proj", schedule["id"])
    pipeline = fired["pipeline"]

    # 计划触发的运行必须是全自动：没有人会在半夜点"确认继续"
    assert pipeline["checkpoint_policy"] == "auto"
    assert pipeline["status"] == "running"
    assert fired["schedule"]["last_pipeline_id"] == pipeline["id"]
    assert fired["schedule"]["last_run_at"] is not None
    assert fired["schedule"]["next_run_at"] > fired["schedule"]["last_run_at"]

    state = get_pipeline(db_path, pipeline["id"])
    assert state["pipeline"]["schedule_id"] == schedule["id"]


def test_fire_rejects_disabled_schedule(tmp_path: Path):
    db_path = _db(tmp_path)
    schedule = schedules.create_schedule(
        db_path, "proj", {"requirementFilename": "req.md", "kind": "daily", "atTime": "03:00"}
    )
    schedules.update_schedule(db_path, schedule["id"], {"enabled": False})
    with pytest.raises(PipelineRuleError, match="disabled"):
        schedules.fire_schedule(db_path, "proj", schedule["id"])
