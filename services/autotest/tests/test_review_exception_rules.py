"""评审阶段拦下"泛化异常用例"和"不可判定的预期"。"""

from __future__ import annotations

from autotest.workflow import consistency


def _case(**over: object) -> dict:
    case = {
        "title": "AFE过压保护-异常-越界值",
        "function_point": "AFE过压保护",
        "case_type": "异常",
        "exception_class": "out_of_range",
        "priority": "高",
        "precondition": "《CPM》：VBuck_OUT_13V＞5.5V。",
        "steps": ["准备环境", "注入 6.05V", "读取保护状态"],
        "expected": ["6.05V 被拒绝并进入保护，DTC 置位"],
        "grounding": "strong",
    }
    case.update(over)
    return case


REVIEW_OK = {"verdict": "ok", "untestable": [], "duplicates": []}


def test_exception_case_without_failure_mode_is_rejected() -> None:
    """泛化的「-异常输入」不能再通过评审 —— 它没有失效模式。"""
    cases = [_case(title="AFE过压保护-异常输入", exception_class=None)]
    judgement = consistency.check_review(REVIEW_OK, cases)
    assert not judgement["ok"]
    assert any(issue["field"] == "exception_class" for issue in judgement["issues"])


def test_exception_case_with_vague_expectation_is_rejected() -> None:
    """预期要能判定：只有"系统可继续操作"这种句子不算。"""
    cases = [_case(expected=["系统可继续操作"])]
    judgement = consistency.check_review(REVIEW_OK, cases)
    assert not judgement["ok"]
    assert any(issue["field"] == "expected" for issue in judgement["issues"])


def test_exception_case_with_concrete_expectation_passes() -> None:
    cases = [_case()]
    judgement = consistency.check_review(REVIEW_OK, cases)
    assert judgement["ok"], judgement["issues"]


def test_review_reports_exception_coverage() -> None:
    """评审结论要带上覆盖到哪几类失效模式，评审人据此判断够不够。"""
    cases = [
        _case(),
        _case(
            title="AFE过压保护-异常-边界值",
            exception_class="boundary",
            expected=["阈值 5.5V 两侧行为符合条款"],
        ),
        _case(
            title="AFE过压保护-异常-电气故障",
            exception_class="electrical",
            expected=["开路被检出并触发保护"],
        ),
    ]
    judgement = consistency.check_review(REVIEW_OK, cases)
    coverage = judgement["exception_coverage"]
    assert coverage == {"out_of_range": 1, "boundary": 1, "electrical": 1}


def test_functional_cases_are_not_checked_for_failure_mode() -> None:
    """功能用例不参与失效模式校验，避免把正面用例误判成问题。"""
    cases = [
        _case(
            title="AFE过压保护-主流程",
            case_type="功能",
            exception_class=None,
            expected=["保护未置位，无故障码上送"],
        )
    ]
    judgement = consistency.check_review(REVIEW_OK, cases)
    assert judgement["ok"], judgement["issues"]
