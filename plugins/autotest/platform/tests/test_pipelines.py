"""Tests for the pipeline rule layer.

These cover what must hold even when the model behaves: stage order, output
contracts, checkpoint policies, the gate, and the audit ledger. Prompts and real
model answers are out of scope (they need a host model).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from autotest.pipelines import service
from autotest.pipelines.service import PipelineRuleError


def _db(tmp_path: Path) -> Path:
    db_path = tmp_path / "data.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS scripts (id TEXT PRIMARY KEY, name TEXT, language TEXT);
        """
    )
    conn.commit()
    conn.close()
    return db_path


def _analyze_output() -> dict:
    return {"function_points": [{"name": "首页展示项目列表", "module": "工作台", "priority": "高"}]}


def _design_output() -> dict:
    return {
        "cases": [
            {
                "title": "首页展示项目列表",
                "function_point": "首页展示项目列表",
                "steps": ["打开首页"],
                "expected": "看到项目卡片",
            }
        ]
    }


def _author_output(target: str = "http://127.0.0.1:4000") -> dict:
    return {
        "scripts": [
            {
                "case_title": "首页展示项目列表",
                "name": "home.e2e.ts",
                "language": "e2e",
                "content": f"// @target {target}\nimport {{ test }} from '@e2e-dev/web';\n",
            }
        ]
    }


def test_pipeline_advances_stage_by_stage(tmp_path: Path):
    db_path = _db(tmp_path)
    state = service.create_pipeline(db_path, "proj", "req.md", "auto")
    pipeline_id = state["pipeline"]["id"]
    assert state["pipeline"]["current_stage"] == "analyze"

    state = service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output(), tokens_in=10)
    assert state["pipeline"]["current_stage"] == "design"

    state = service.report_stage(db_path, pipeline_id, "design", "done", _design_output())
    assert state["pipeline"]["current_stage"] == "author"

    state = service.report_stage(db_path, pipeline_id, "author", "done", _author_output())
    assert state["pipeline"]["current_stage"] == "gate"

    state = service.report_stage(db_path, pipeline_id, "gate", "done", {"ok": True, "failures": []})
    assert state["pipeline"]["current_stage"] == "execute"

    state = service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output())
    assert state["pipeline"]["current_stage"] == "judge"

    state = service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output())
    assert state["pipeline"]["current_stage"] == "report"

    state = service.report_stage(db_path, pipeline_id, "report", "done", _report_output())
    assert state["pipeline"]["status"] == "done"
    assert [row["stage"] for row in state["stages"]] == [
        "analyze",
        "design",
        "author",
        "gate",
        "execute",
        "judge",
        "report",
    ]


def test_empty_function_points_is_rejected_and_fails_the_run(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    with pytest.raises(PipelineRuleError):
        service.report_stage(db_path, pipeline_id, "analyze", "done", {"function_points": []})
    state = service.get_pipeline(db_path, pipeline_id)
    assert state["pipeline"]["status"] == "failed"
    assert "function_points" in state["stages"][0]["error"]


def test_e2e_script_without_target_header_is_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    service.report_stage(db_path, pipeline_id, "design", "done", _design_output())
    bad = {"scripts": [{"name": "x.e2e.ts", "language": "e2e", "content": "import {test} from 'x';\n"}]}
    with pytest.raises(PipelineRuleError):
        service.report_stage(db_path, pipeline_id, "author", "done", bad)


def test_duplicate_case_titles_are_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    duplicated = {
        "cases": [
            {"title": "同一条", "steps": ["a"], "expected": "b"},
            {"title": "同一条", "steps": ["c"], "expected": "d"},
        ]
    }
    with pytest.raises(PipelineRuleError, match="duplicate"):
        service.report_stage(db_path, pipeline_id, "design", "done", duplicated)


def test_out_of_order_stage_is_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    with pytest.raises(PipelineRuleError, match="not current"):
        service.report_stage(db_path, pipeline_id, "author", "done", _author_output())


def test_checkpoint_policy_pauses_and_approve_continues(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "analyze")["pipeline"]["id"]
    state = service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    assert state["pipeline"]["status"] == "waiting"
    assert state["pipeline"]["current_stage"] == "analyze"

    state = service.resume(db_path, pipeline_id, "approve")
    assert state["pipeline"]["status"] == "running"
    assert state["pipeline"]["current_stage"] == "design"


def test_analyze_author_policy_pauses_twice(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "analyze_author")["pipeline"]["id"]
    state = service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    assert state["pipeline"]["status"] == "waiting"
    service.resume(db_path, pipeline_id, "approve")
    service.report_stage(db_path, pipeline_id, "design", "done", _design_output())
    state = service.report_stage(db_path, pipeline_id, "author", "done", _author_output())
    assert state["pipeline"]["status"] == "waiting"
    assert state["pipeline"]["current_stage"] == "author"


def test_failed_gate_stops_the_pipeline(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    service.report_stage(db_path, pipeline_id, "design", "done", _design_output())
    service.report_stage(db_path, pipeline_id, "author", "done", _author_output())
    state = service.report_stage(
        db_path, pipeline_id, "gate", "done", {"ok": False, "failures": ["home.e2e.ts：语法错误"]}
    )
    assert state["pipeline"]["status"] == "failed"
    gate_row = [row for row in state["stages"] if row["stage"] == "gate"][0]
    assert "静态闸门未通过" in (gate_row["error"] or "")


def test_retry_supersedes_the_attempt(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "analyze")["pipeline"]["id"]
    service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    state = service.resume(db_path, pipeline_id, "retry")
    assert state["pipeline"]["status"] == "running"
    attempts = [row["attempt"] for row in state["stages"] if row["stage"] == "analyze"]
    assert attempts == [1, 2]


def test_agent_calls_are_recorded(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    service.record_agent_call(
        db_path, pipeline_id, "analyze", "chenxi/v4", "prompt", "answer", 12, 34, True
    )
    state = service.get_pipeline(db_path, pipeline_id)
    assert state["agent_calls"][0]["accepted"] == 1
    assert state["agent_calls"][0]["tokens_in"] == 12


def test_cancel_marks_running_stage(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    state = service.cancel(db_path, pipeline_id)
    assert state["pipeline"]["status"] == "cancelled"
    assert state["stages"][0]["status"] == "cancelled"


# ------------------------------------------------------------------ execution ----


def _execute_output(status: str = "pass") -> dict:
    return {
        "executions": [
            {
                "scriptId": "script_1",
                "scriptName": "home.py",
                "caseId": "case_1",
                "executionId": 7,
                "status": status,
                "durationMs": 12.5,
                "failure": "" if status == "pass" else "AssertionError: expected 1",
                "counts": {"pass": 1 if status == "pass" else 0, "fail": 0 if status == "pass" else 1, "skip": 0},
            }
        ]
    }


def _judge_output(verdict: str = "pass") -> dict:
    return {
        "results": [
            {
                "scriptId": "script_1",
                "scriptName": "home.py",
                "caseId": "case_1",
                "caseTitle": "首页展示项目列表",
                "verdict": verdict,
                "reason": "" if verdict == "pass" else "AssertionError: expected 1",
                "durationMs": 12.5,
            }
        ]
    }


def _repair_output() -> dict:
    return {
        "patched": [
            {
                "scriptId": "script_1",
                "scriptName": "home.py",
                "content": "assert 1 == 1\n",
                "note": "AssertionError: expected 1 → 修正被测值",
            }
        ]
    }


def _report_output(counts: dict | None = None) -> dict:
    return {
        "name": "测试报告",
        "markdown": "# 报告\n\n" + "通过 1 条，失败 0 条。\n" * 6,
        "counts": counts or {"pass": 1, "fail": 0, "error": 0, "cancelled": 0},
    }


def _drive_to_before_execute(db_path: Path, pipeline_id: str) -> None:
    service.report_stage(db_path, pipeline_id, "analyze", "done", _analyze_output())
    service.report_stage(db_path, pipeline_id, "design", "done", _design_output())
    service.report_stage(db_path, pipeline_id, "author", "done", _author_output())
    service.report_stage(db_path, pipeline_id, "gate", "done", {"ok": True, "failures": []})


def test_passing_run_goes_execute_judge_report(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    assert service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output())["pipeline"][
        "current_stage"
    ] == "judge"
    # pass → straight to report, no repair round
    state = service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("pass"))
    assert state["pipeline"]["current_stage"] == "report"
    state = service.report_stage(db_path, pipeline_id, "report", "done", _report_output())
    assert state["pipeline"]["status"] == "done"


def test_failure_enters_repair_then_reruns_execute(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("fail"))
    state = service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("fail"))
    assert state["pipeline"]["current_stage"] == "repair"
    state = service.report_stage(db_path, pipeline_id, "repair", "done", _repair_output())
    assert state["pipeline"]["current_stage"] == "execute"
    # 第二轮 execute 必须有独立的 attempt，第一轮证据不能被覆盖
    attempts = [row["attempt"] for row in state["stages"] if row["stage"] == "execute"]
    assert attempts == [1, 2]


def test_repair_rounds_are_capped(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    for _ in range(service.MAX_REPAIR_ROUNDS):
        service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("fail"))
        state = service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("fail"))
        assert state["pipeline"]["current_stage"] == "repair"
        service.report_stage(db_path, pipeline_id, "repair", "done", _repair_output())
    service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("fail"))
    state = service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("fail"))
    # 超过上限：带着失败进报告，不再无限修
    assert state["pipeline"]["current_stage"] == "report"


def test_repair_without_content_is_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("fail"))
    service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("fail"))
    with pytest.raises(PipelineRuleError, match="content is required"):
        service.report_stage(
            db_path, pipeline_id, "repair", "done", {"patched": [{"scriptId": "script_1"}]}
        )


def test_report_is_written_to_disk_and_reports_table(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("pass"))
    service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("pass"))
    service.report_stage(db_path, pipeline_id, "report", "done", _report_output())

    markdown = service.read_report(db_path, pipeline_id)
    assert markdown and "通过 1 条" in markdown
    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT total, passed, failed, pass_rate FROM reports WHERE id = ?", (pipeline_id,)).fetchone()
    conn.close()
    assert row == (1, 1, 0, "100.0%")


def test_short_report_is_rejected(tmp_path: Path):
    db_path = _db(tmp_path)
    pipeline_id = service.create_pipeline(db_path, "proj", "req.md", "auto")["pipeline"]["id"]
    _drive_to_before_execute(db_path, pipeline_id)
    service.report_stage(db_path, pipeline_id, "execute", "done", _execute_output("pass"))
    service.report_stage(db_path, pipeline_id, "judge", "done", _judge_output("pass"))
    with pytest.raises(PipelineRuleError, match="too short"):
        service.report_stage(db_path, pipeline_id, "report", "done", {"markdown": "ok", "counts": {}})
