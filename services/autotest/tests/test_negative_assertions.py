"""反面断言：异常用例喂的是越界值，断言的是"被测件拒绝"，不是合法值。"""

from __future__ import annotations

import pytest

from autotest.workflow import assertion_gen
from autotest.workflow.dut_contract import Entry

CASE = {
    "title": "AFE过压保护-异常-越界值",
    "case_type": "异常",
    "evidence": {"numbers": ["5.5V"]},
}


def _entry(kind: str = "raises", value: object = "DutError", arrange=None) -> Entry:
    return Entry(
        function_point="AFE过压保护",
        factory="AfeSim()",
        arrange=list(arrange or ["dut.set_voltage({{number}})"]),
        observe="dut.voltage",
        expect={"kind": kind, "value": value},
    )


def test_negative_case_feeds_the_out_of_range_value():
    """异常用例的输入必须按阈值算出越界值 6.05，而不是原文的 5.5。"""
    generated = assertion_gen.generate(CASE, _entry(), polarity="negative")
    body = "\n".join(generated.body)
    assert "6.05" in body, body
    assert "5.5" not in body, "不能把合法值喂给异常用例"
    assert "pytest.raises(DutError)" in body


def test_negative_case_requires_a_raises_contract():
    """契约没声明"会被拒绝"时不生成断言 —— 宁缺，不写假断言。"""
    with pytest.raises(assertion_gen.GenerationError) as problem:
        assertion_gen.generate(CASE, _entry(kind="bool", value=True), polarity="negative")
    assert "没有声明该点会被拒绝" in str(problem.value)


def test_positive_case_still_uses_the_documented_value():
    """功能用例保持原样：喂原文阈值，断言观测值。"""
    functional = dict(CASE, case_type="功能")
    generated = assertion_gen.generate(functional, _entry(kind="number", value=5.5))
    body = "\n".join(generated.body)
    assert "5.5" in body
    assert "pytest.raises" not in body


def test_boundary_placeholders_differ_on_each_side():
    """边界用例两侧要算出不同的值（阈内/阈外各一档）。"""
    entry = _entry(arrange=["dut.set_voltage({{near:-}})", "dut.set_voltage({{near:+}})"])
    generated = assertion_gen.generate(CASE, entry, polarity="negative")
    body = "\n".join(generated.body)
    assert "5.45" in body and "5.55" in body, body
    assert body.count("set_voltage") == 2
