"""Tests for the stage-output rules and the model-call ledger.

The stage machine that used to drive these rules is gone — the agent plans the
order now. What still has to hold: an output that is missing a name, a step,
an expected result, a target header, a failure note or a verdict is rejected
before it can reach the database, and every model call leaves one ledger row.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from autotest.pipelines import ledger, validation
from autotest.pipelines.validation import PipelineRuleError


def _db(tmp_path: Path) -> Path:
    db_path = tmp_path / "data.db"
    conn = sqlite3.connect(db_path)
    ledger.ensure_agent_call_table(conn)
    conn.commit()
    conn.close()
    return db_path


# ------------------------------------------------------------------ analyze ----


def test_analyze_requires_a_non_empty_function_point_list():
    with pytest.raises(PipelineRuleError, match="function_points"):
        validation.validate_analyze({"function_points": []})


def test_analyze_normalizes_priority_and_optional_fields():
    result = validation.validate_analyze(
        {"function_points": [{"name": " 首页展示项目列表 ", "module": "工作台"}]}
    )
    point = result["function_points"][0]
    assert point["name"] == "首页展示项目列表"
    assert point["priority"] == "中"
    assert point["description"] == ""


# ------------------------------------------------------------------ design ----


def test_design_rejects_duplicate_titles():
    duplicated = {
        "cases": [
            {"title": "同一条", "steps": ["a"], "expected": "b"},
            {"title": "同一条", "steps": ["c"], "expected": "d"},
        ]
    }
    with pytest.raises(PipelineRuleError, match="duplicate"):
        validation.validate_design(duplicated)


def test_design_joins_step_lists_into_text():
    result = validation.validate_design(
        {"cases": [{"title": "首页", "steps": ["打开首页", "点列表"], "expected": "看到卡片"}]}
    )
    case = result["cases"][0]
    assert case["steps"] == "打开首页\n点列表"
    assert case["case_type"] == "正向"


# ------------------------------------------------------------------ author ----


def test_author_rejects_e2e_script_without_target_header():
    bad = {"scripts": [{"name": "x.e2e.ts", "language": "e2e", "content": "import {test} from 'x';\n"}]}
    with pytest.raises(PipelineRuleError, match="target"):
        validation.validate_author(bad)


def test_author_rejects_unknown_language():
    with pytest.raises(PipelineRuleError, match="language"):
        validation.validate_author({"scripts": [{"name": "x.ts", "language": "js", "content": "x"}]})


def test_author_accepts_python_without_target_header():
    result = validation.validate_author(
        {"scripts": [{"name": "case.py", "language": "python", "content": "assert True\n"}]}
    )
    assert result["scripts"][0]["language"] == "python"


# -------------------------------------------------------------------- gate ----


def test_gate_failures_override_a_claimed_ok():
    result = validation.validate_gate({"ok": True, "failures": ["home.e2e.ts：语法错误"]})
    assert result["ok"] is False
    assert result["failures"] == ["home.e2e.ts：语法错误"]


# ----------------------------------------------------------------- execute ----


def test_execute_requires_ids_and_a_known_verdict():
    with pytest.raises(PipelineRuleError, match="status"):
        validation.validate_execute({"executions": [{"scriptId": "s", "executionId": 1, "status": "weird"}]})


def test_execute_normalizes_counts_and_artifacts():
    result = validation.validate_execute(
        {
            "executions": [
                {
                    "scriptId": "s1",
                    "executionId": 7,
                    "status": "fail",
                    "counts": {"fail": 1},
                    "artifacts": [{"kind": "log", "path": "a.log"}, {"kind": "log"}],
                }
            ]
        }
    )
    run = result["executions"][0]
    assert run["counts"] == {"pass": 0, "fail": 1, "skip": 0}
    assert run["artifacts"] == [{"kind": "log", "path": "a.log"}]


# ------------------------------------------------------------------ judge ----


def test_judge_sums_verdict_counts():
    result = validation.validate_judge(
        {"results": [{"verdict": "pass"}, {"verdict": "fail"}, {"verdict": "fail"}]}
    )
    assert result["counts"] == {"pass": 1, "fail": 2, "error": 0, "cancelled": 0}


def test_judge_rejects_unknown_verdict():
    with pytest.raises(PipelineRuleError, match="verdict"):
        validation.validate_judge({"results": [{"verdict": "maybe"}]})


# ----------------------------------------------------------------- repair ----


def test_repair_requires_a_note_naming_the_failure():
    with pytest.raises(PipelineRuleError, match="note"):
        validation.validate_repair({"patched": [{"scriptId": "s1", "content": "assert 1\n"}]})


def test_repair_rejects_an_empty_patch_set():
    with pytest.raises(PipelineRuleError, match="no patched script"):
        validation.validate_repair({"patched": []})


# ----------------------------------------------------------------- report ----


def test_report_rejects_too_short_markdown():
    with pytest.raises(PipelineRuleError, match="too short"):
        validation.validate_report({"markdown": "ok", "counts": {}})


def test_report_keeps_counts_and_name():
    markdown = "# 报告\n\n" + "通过 1 条，失败 0 条。\n" * 6
    result = validation.validate_report({"markdown": markdown})
    assert result["name"] == "测试报告"
    assert result["counts"] == {"pass": 0, "fail": 0, "error": 0, "cancelled": 0}


def test_validators_cover_every_stage_name():
    assert set(validation.VALIDATORS) == {
        "analyze",
        "design",
        "author",
        "gate",
        "execute",
        "judge",
        "repair",
        "report",
    }


# ----------------------------------------------------------------- ledger ----


def test_agent_call_is_recorded_with_hashes(tmp_path: Path):
    db_path = _db(tmp_path)
    ledger.record_agent_call(
        db_path, "wf-abcdef1234", "analyze", "chenxi/v4", "prompt", "answer", 12, 34, True
    )
    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT pipeline_id, stage, model_key, accepted, tokens_in, prompt_hash FROM agent_calls"
    ).fetchone()
    conn.close()
    assert row[0] == "wf-abcdef1234"
    assert row[1] == "analyze"
    assert row[2] == "chenxi/v4"
    assert row[3] == 1
    assert row[4] == 12
    assert len(row[5]) == 32
