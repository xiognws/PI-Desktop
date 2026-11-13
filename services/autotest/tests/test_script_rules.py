"""脚本规则可判定：`prompts/script-author.md` 的硬规则要能拦住"假通过"。

脚本是流水线里唯一会被执行器直接跑的产物。骨架写成 `assert True`、或者干脆不
skip 也不断言，pytest 跑出来都是绿的 —— 报告上写着通过，实际一行都没验证。
所以这些规则必须由代码判定，而不是靠写提示词的人自觉。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from autotest.workflow import consistency, scripts as script_service  # noqa: E402

CASE = {
    "title": "AFE过压保护-主流程",
    "function_point": "AFE过压保护",
    "case_type": "功能",
    "priority": "高",
    "precondition": "《CPM》：VBuck_OUT_13V＞5.5V。",
    "steps": ["准备环境", "执行采样", "读取状态位"],
    "expected": ["保护未置位"],
    "grounding": "strong",
    "evidence": {"numbers": ["3.65V"]},
}


def test_generated_skeleton_passes_the_script_rules() -> None:
    """模板生成的骨架必须自己就合格，否则规则本身就是错的。"""
    script = script_service.author_script(CASE, "pytest")
    verdict = consistency.check_scripts([script])
    assert verdict["ok"] is True, verdict["issues"]


def test_tautological_assertion_is_rejected() -> None:
    script = script_service.author_script(CASE, "pytest")
    script["content"] = script["content"].replace(
        'pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")', "assert True"
    )
    verdict = consistency.check_scripts([script])
    assert verdict["ok"] is False
    assert verdict["by_field"]["tautology"] == 1


def test_skeleton_without_skip_and_without_assertions_is_rejected() -> None:
    script = script_service.author_script(CASE, "pytest")
    script["content"] = script["content"].replace(
        'pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")', "pass"
    )
    fields = {issue["field"] for issue in consistency.check_scripts([script])["issues"]}
    assert "skeleton" in fields


def test_completed_script_with_real_assertions_passes() -> None:
    """补全后（有真实断言、去掉 skip）不算违规。"""
    script = script_service.author_script(CASE, "pytest")
    script["content"] = script["content"].replace(
        'pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")',
        "assert 3.60 < 3.65  # 原文阈值",
    )
    assert consistency.check_scripts([script])["ok"] is True


def test_filename_and_function_name_must_match_the_rule() -> None:
    script = script_service.author_script(CASE, "pytest")
    broken = dict(script)
    broken["name"] = "AFE过压保护-主流程.py"
    fields = {issue["field"] for issue in consistency.check_scripts([broken])["issues"]}
    assert {"name", "function"} <= fields


def test_missing_constants_and_main_entry_are_rejected() -> None:
    script = script_service.author_script(CASE, "pytest")
    content = script["content"].replace("STEPS = ", "STEPS_DISABLED = ")
    content = content.replace('if __name__ == "__main__":', "")
    verdict = consistency.check_scripts([{**script, "content": content}])
    fields = {issue["field"] for issue in verdict["issues"]}
    assert {"constants", "standalone"} <= fields
