"""异常覆盖面：反面用例要按失效模式分,而不是每个功能点一条"异常输入"。"""

from __future__ import annotations

from autotest.workflow import cases as case_mod
from autotest.workflow import exception_matrix


def _evidence(quote: str, numbers: list[tuple[float, str]] | None = None, doc: str = "需求.docx") -> dict:
    return {
        "doc": doc,
        "quote": quote,
        "numbers": [{"value": value, "unit": unit} for value, unit in (numbers or [])],
    }


def test_threshold_clause_gets_out_of_range_and_boundary():
    """有阈值的条款要同时长出越界与边界两类用例, 且步骤里带真实数值。"""
    evidence = {"AFE过压保护": [_evidence("AFE 过压阈值为 5.5V, 超过即进入保护", [(5.5, "V")])]}
    result = case_mod.design_cases(
        {"function_points": [{"name": "AFE过压保护"}]},
        types=["功能", "异常"],
        evidence=evidence,
    )
    exception_cases = [c for c in result["cases"] if c["case_type"] == "异常"]
    classes = {c["exception_class"] for c in exception_cases}
    assert {"out_of_range", "boundary"} <= classes
    out_of_range = next(c for c in exception_cases if c["exception_class"] == "out_of_range")
    text = "".join(out_of_range["steps"])
    assert "5.5V" in text, "越界用例必须引用原文阈值"
    assert any("6.05V" in line or "6.1V" in line or "6.05" in line for line in out_of_range["steps"]) or "V" in text


def test_comm_clause_gets_timeout_case():
    """提到报文/超时的条款要长出通信超时用例。"""
    evidence = {"报文监控": [_evidence("控制器需监控 VCU 报文, 超过 500ms 未收到判定通信超时", [(500, "ms")])]}
    result = case_mod.design_cases(
        {"function_points": [{"name": "报文监控"}]},
        types=["异常"],
        evidence=evidence,
    )
    classes = {c["exception_class"] for c in result["cases"]}
    assert "comm_timeout" in classes


def test_safety_point_is_raised_to_high():
    """涉及保护/短路的失效后果要抬到高优先级, 不能一律"中"。"""
    evidence = {"AFE过流保护": [_evidence("采样电流超过 20A 触发过流保护", [(20, "A")])]}
    result = case_mod.design_cases(
        {"function_points": [{"name": "AFE过流保护"}]},
        types=["异常"],
        evidence=evidence,
    )
    assert result["cases"], "应当生成异常用例"
    assert all(case["priority"] == "高" for case in result["cases"])


def test_unsupported_classes_are_reported_as_gaps():
    """依据支撑不了的失效模式不能编造, 要记进缺口清单。"""
    evidence = {"音量调节": [_evidence("音量可在 0-30 之间调节")]}
    result = case_mod.design_cases(
        {"function_points": [{"name": "音量调节"}]},
        types=["异常"],
        evidence=evidence,
    )
    gaps = result["stats"]["exception_gaps"]["音量调节"]
    assert "通信超时" in gaps or "持久化" in gaps
    generated = {c["exception_class"] for c in result["cases"] if c.get("exception_class")}
    assert not (set(gaps) & set(generated)), "缺口里的类别不能被生成"
    # 一条失效模式都写不出来时，仍保留一条按条款写的异常用例（不能因此少一条反面用例）
    assert any(c["case_type"] == "异常" for c in result["cases"])


def test_budget_caps_cases_per_point():
    """每个功能点的异常条数受预算约束, 不因关键词多就无限膨胀。"""
    quote = "上电自检: 采样电压阈值 12V, 监控 CAN 报文超时, 写入 NVM 记录, 重复触发需串行"
    evidence = {"上电自检": [_evidence(quote, [(12, "V")])]}
    result = case_mod.design_cases(
        {"function_points": [{"name": "上电自检"}]},
        types=["异常"],
        evidence=evidence,
        exception_budget=2,
    )
    assert len(result["cases"]) == 2
    assert result["stats"]["exception_budget"] == 2


def test_ungrounded_falls_back_to_single_generic_case():
    """没有依据时保持旧行为: 生成一条通用异常输入, 不凭空造失效模式。"""
    result = case_mod.design_cases(
        {"function_points": [{"name": "冷门功能"}]},
        types=["异常"],
        evidence={},
        skip_ungrounded=False,
    )
    assert len(result["cases"]) == 1
    assert result["cases"][0]["title"].endswith("异常输入")
    assert "exception_class" not in result["cases"][0]


def test_no_unfilled_placeholders_in_generated_text():
    """生成的步骤/预期里不能残留 {name} 这类占位符 —— 那是给模板留的, 不是给用例的。"""
    evidence = {
        "上电自检": [
            _evidence(
                "上电自检需监控 CAN 报文, 超时 200ms 判故障, 采样电压阈值 12V, 写入 NVM 记录",
                [(200, "ms"), (12, "V")],
            )
        ]
    }
    result = case_mod.design_cases(
        {"function_points": [{"name": "上电自检"}]},
        types=["异常"],
        evidence=evidence,
    )
    assert result["cases"], "应当生成异常用例"
    for case in result["cases"]:
        text = " ".join(case["steps"]) + " ".join(case["expected"])
        assert "{name}" not in text, f"{case['title']} 残留占位符"


def test_matrix_reports_classes_per_function_point():
    """stats 要能直接回答"每个功能点覆盖了哪几类异常"。"""
    evidence = {
        "上电自检": [_evidence("上电自检需监控 CAN 报文, 超时 200ms 判故障", [(200, "ms")])],
    }
    result = case_mod.design_cases(
        {"function_points": [{"name": "上电自检"}]},
        types=["异常"],
        evidence=evidence,
    )
    covered = result["stats"]["exception_matrix"]["上电自检"]
    assert covered, "矩阵里要记录覆盖到的类别"
    assert set(covered) <= set(exception_matrix.gap_labels([c.id for c in exception_matrix.CLASSES]))
