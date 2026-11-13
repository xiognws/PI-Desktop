"""评审与报告的规则可判定。

这两个阶段最容易"看起来没问题"：

* 评审结论是 `needs_fix` 却没有一条明细，或者把无依据的用例判成可测 —— 于是不可测
  的用例一路流到执行阶段，跑出来的绿是无意义的。
* 报告的数字与执行统计对不上、跳过没声明"未计通过"、全部跳过还印个通过率 ——
  对外交付物一旦这样，后面所有结论都不能信。

所以规则以 `workflow.consistency.check_review` / `check_report` 判定，并跟着接口
一起返回。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from autotest.workflow import consistency, report as report_service, review as review_service  # noqa: E402


def _case(**over: object) -> dict:
    case = {
        "title": "AFE过压保护-主流程",
        "function_point": "AFE过压保护",
        "case_type": "功能",
        "priority": "高",
        "precondition": "《CPM》：VBuck_OUT_13V＞5.5V。",
        "steps": ["准备环境", "执行采样", "读取状态位"],
        "expected": ["保护未置位，无故障码上送"],
        "grounding": "strong",
    }
    case.update(over)
    return case


# ---------- 评审 ----------


def test_clean_cases_review_ok_and_pass_the_rules() -> None:
    cases = [_case(), _case(title="语音唤醒-异常输入", case_type="异常")]
    result = review_service.review_cases(cases, "座舱")
    assert result["verdict"] == "ok"
    verdict = consistency.check_review(result, cases)
    assert verdict["ok"] is True, verdict["issues"]


def test_ungrounded_case_is_untestable_and_flips_the_verdict() -> None:
    """无依据的用例测的是模板句式，不是需求 —— 不能判成可测。"""
    cases = [_case(grounding="none")]
    result = review_service.review_cases(cases)

    assert result["verdict"] == "needs_fix"
    reasons = [item["reason"] for item in result["untestable"]]
    assert any("无依据" in reason for reason in reasons)
    assert consistency.check_review(result, cases)["ok"] is True


def test_placeholder_expectation_is_untestable() -> None:
    cases = [_case(expected=["“AFE过压保护”按需求描述完成，结果与预期一致"])]
    result = review_service.review_cases(cases)
    assert result["verdict"] == "needs_fix"
    assert any("预期不可判定" in item["reason"] for item in result["untestable"])


def test_empty_needs_fix_is_rejected_by_the_rules() -> None:
    cases = [_case()]
    broken = {"verdict": "needs_fix", "untestable": [], "duplicates": [], "issues": []}
    verdict = consistency.check_review(broken, cases)
    assert verdict["ok"] is False
    assert verdict["by_field"]["verdict"] == 1


def test_detail_pointing_outside_the_cases_is_rejected() -> None:
    cases = [_case()]
    broken = {
        "verdict": "needs_fix",
        "untestable": [{"index": 7, "reason": "缺少预期结果"}],
        "duplicates": [],
    }
    fields = {issue["field"] for issue in consistency.check_review(broken, cases)["issues"]}
    assert "index" in fields


def test_ungrounded_case_missing_from_untestable_is_rejected() -> None:
    cases = [_case(grounding="none")]
    # 结论自称 ok 且明细为空：规则必须发现"无依据用例没被判为不可测"
    broken = {"verdict": "ok", "untestable": [], "duplicates": []}
    fields = {issue["field"] for issue in consistency.check_review(broken, cases)["issues"]}
    assert "grounding" in fields


# ---------- 报告 ----------


def _payload(total: int, passed: int, skipped: int, failed: int = 0, errored: int = 0) -> dict:
    return {
        "stats": {
            "total": total,
            "pass": passed,
            "skip": skipped,
            "fail": failed,
            "error": errored,
            "cancelled": 0,
            "scripts": total,
            "duration_ms": 1234,
        },
        "results": [],
    }


def test_report_with_skips_passes_its_own_rules() -> None:
    built = report_service.build_report("wf-1", "座舱", _payload(4, 2, 2))
    verdict = consistency.check_report(built["markdown"], built["counts"], built["pass_rate"])
    assert verdict["ok"] is True, verdict["issues"]
    assert "未计通过" in built["markdown"]


def test_all_skipped_report_says_it_cannot_judge() -> None:
    built = report_service.build_report("wf-2", "座舱", _payload(3, 0, 3))
    assert built["pass_rate"] == "—（全部跳过）"
    assert "不能据此判定" in built["markdown"]
    assert consistency.check_report(built["markdown"], built["counts"], built["pass_rate"])["ok"]


def test_report_numbers_must_match_counts() -> None:
    built = report_service.build_report("wf-3", "座舱", _payload(4, 2, 1, failed=1))
    # 篡改表里的一列：总数不变、通过数改大
    tampered = built["markdown"].replace("| 4 | 2 | 1 | 1 | 0 | 0 |", "| 4 | 3 | 1 | 1 | 0 | 0 |")
    assert tampered != built["markdown"], "表格行没被改到，测试本身失效"
    verdict = consistency.check_report(tampered, built["counts"], built["pass_rate"])
    assert verdict["ok"] is False
    assert verdict["by_field"]["table"] >= 1


def test_skip_without_disclaimer_is_rejected() -> None:
    built = report_service.build_report("wf-4", "座舱", _payload(4, 2, 2))
    text = built["markdown"].replace("，未计通过", "")
    verdict = consistency.check_report(text, built["counts"], built["pass_rate"])
    assert verdict["by_field"]["skip"] == 1


def test_pass_rate_must_be_consistent_with_counts() -> None:
    # 4 条用例、2 通过、1 跳过 → 分母 3，通过率 66.7%；给个 100% 必须被发现
    built = report_service.build_report("wf-5", "座舱", _payload(4, 2, 1, failed=1))
    assert built["pass_rate"] == "66.7%"
    verdict = consistency.check_report(built["markdown"], built["counts"], "100.0%")
    assert verdict["by_field"]["pass_rate"] >= 1
