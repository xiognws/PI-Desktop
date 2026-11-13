"""固定提示词：注册、版本、可追溯，以及"规则真的能拦住不合格用例"。

这层要防的两个坑：

1. 阶段跑完只留下"生成成功"，没人知道用的是哪一版规则 —— 于是每次产出风格都
   可能变，出问题也说不清是谁改的。
2. 提示词只是一段 markdown，没有检查就等于没有约束 —— 空话句式、缺数值断言、
   标题后缀跑偏，都能一路混进用例库。
"""

from __future__ import annotations

import re

import pytest

from autotest.prompts import PROMPT_DIR, STAGES, PromptError, catalog, load, ref
from autotest.workflow import consistency

# ---------- 提示词文件本身 ----------


def test_every_registered_stage_has_a_loadable_prompt() -> None:
    for stage in STAGES:
        prompt = load(stage)
        assert prompt.prompt_id.startswith("autotest."), stage
        assert re.fullmatch(r"\d+\.\d+\.\d+", prompt.version), stage
        assert prompt.stage == stage
        # 正文要够长才可能承载规则，避免空文件被当成"固定提示词"
        assert len(prompt.body) > 400, stage
        assert "## 硬性规则" in prompt.body, stage


def test_prompt_files_are_all_registered_and_no_orphans() -> None:
    on_disk = {path.name for path in PROMPT_DIR.glob("*.md")}
    registered = set(STAGES.values())
    assert on_disk == registered, f"磁盘与注册表不一致：{on_disk ^ registered}"


def test_ref_is_stable_and_versioned() -> None:
    assert ref("case-design") == "autotest.case-design@1.0.0"
    assert load("case-design").ref == ref("case-design")
    # 正文指纹用于发现"改了内容忘了升版本"
    assert len(load("case-design").digest) == 12


def test_catalog_lists_every_stage_with_version() -> None:
    items = catalog()
    assert {item["stage"] for item in items} == set(STAGES)
    assert all(item["ref"].endswith("@" + item["version"]) for item in items)


def test_unknown_stage_is_an_error_not_a_silent_default() -> None:
    with pytest.raises(PromptError):
        load("no-such-stage")


def test_frontmatter_without_stage_is_rejected(tmp_path, monkeypatch) -> None:
    broken = tmp_path / "broken.md"
    broken.write_text("---\nid: autotest.x\nversion: 1.0.0\n---\n正文", encoding="utf-8")
    monkeypatch.setattr("autotest.prompts.STAGES", {"broken": "broken.md"})
    monkeypatch.setattr("autotest.prompts.PROMPT_DIR", tmp_path)
    load.cache_clear()
    try:
        with pytest.raises(PromptError):
            load("broken")
    finally:
        load.cache_clear()


# ---------- 一致性校验 ----------


def _good_case() -> dict:
    return {
        "title": "AFE过压保护-异常输入",
        "function_point": "AFE过压保护",
        "case_type": "异常",
        "priority": "高",
        "precondition": "《CPM》功能开启条件：VBuck_OUT_13V＞5.5V。",
        "steps": [
            "把 VBuck_OUT_13V 供电置为 6.0V 满足开启条件",
            "把单体电压置为 3.80V（高于原文 3.65V 阈值）执行采样",
            "读取保护状态位与故障码",
        ],
        "expected": ["保护置位，上送过压故障码"],
        "grounding": "strong",
        "evidence": {"numbers": ["3.65V", "5.5V"]},
    }


def test_good_case_passes_consistency() -> None:
    verdict = consistency.check_cases([_good_case()])
    assert verdict["ok"] is True
    assert verdict["checked"] == 1


def test_placeholder_wording_is_rejected_when_there_is_evidence() -> None:
    case = _good_case()
    case["steps"] = ["准备环境", "执行正常操作", "观察结果"]
    verdict = consistency.check_cases([case])
    assert verdict["ok"] is False
    assert verdict["by_field"]["wording"] == 1


def test_placeholder_wording_is_allowed_for_ungrounded_skeleton() -> None:
    """占位模式（grounding=none）本来就是空壳，不能拿同一条规则打死。"""
    case = {
        "title": "冷门功能-主流程",
        "function_point": "冷门功能",
        "case_type": "功能",
        "priority": "中",
        "precondition": "资料里没有这一节，先占位",
        "steps": ["准备环境", "执行正常操作", "检查过程中无报错、无脏数据"],
        "expected": ["结果与预期一致"],
        "grounding": "none",
    }
    assert consistency.check_cases([case])["ok"] is True


def test_title_suffix_must_match_case_type() -> None:
    case = _good_case()
    case["title"] = "AFE过压保护-主流程"
    issues = consistency.check_case(case)
    assert any(issue["field"] == "title" for issue in issues)


def test_strong_grounding_requires_the_numbers_to_show_up() -> None:
    case = _good_case()
    case["steps"] = ["准备环境", "把电压拉高执行采样", "读取状态位"]
    issues = consistency.check_case(case)
    assert any(issue["field"] == "steps" for issue in issues)


def test_strong_grounding_without_numbers_is_flagged() -> None:
    case = _good_case()
    case["evidence"] = {"numbers": []}
    issues = consistency.check_case(case)
    assert any(issue["field"] == "evidence" for issue in issues)


def test_too_few_steps_and_empty_expected_are_flagged() -> None:
    case = _good_case()
    case["steps"] = ["只写一条"]
    case["expected"] = []
    fields = {issue["field"] for issue in consistency.check_case(case)}
    assert {"steps", "expected"} <= fields


def test_bad_enums_are_flagged() -> None:
    case = _good_case()
    case["case_type"] = "性能"
    case["priority"] = "紧急"
    case["grounding"] = "maybe"
    fields = {issue["field"] for issue in consistency.check_case(case)}
    assert {"case_type", "priority", "grounding"} <= fields
