"""报告里的异常覆盖表：类别 × 功能点 + 缺口清单。"""

from __future__ import annotations

from autotest.workflow import consistency, report


PAYLOAD = {
    "stats": {"total": 10, "pass": 8, "skip": 1, "fail": 1, "error": 0, "cancelled": 0, "scripts": 10},
    "results": [],
}

COVERAGE = {
    "AFE过压保护": ["越界值", "边界值", "电气故障"],
    "3608驱动": ["越界值", "边界值"],
}
GAPS = {
    "AFE过压保护": ["通信超时", "持久化"],
}


def _build(**over: object) -> dict:
    kwargs = {
        "cases_total": 10,
        "requirement": "CPM低软开发需求0409.docx",
        "exception_coverage": COVERAGE,
        "exception_gaps": GAPS,
    }
    kwargs.update(over)
    return report.build_report("wf-test", "CPM", PAYLOAD, **kwargs)


def test_report_contains_coverage_matrix() -> None:
    """覆盖表要同时出现功能点行与失效模式列，命中格用 ● 标出。"""
    markdown = _build()["markdown"]
    assert "## 异常覆盖" in markdown
    assert "| 功能点 | 越界值 | 边界值 | 电气故障 |" in markdown
    assert "| AFE过压保护 | ● | ● | ● |" in markdown
    assert "| 3608驱动 | ● | ● | — |" in markdown


def test_report_lists_missing_failure_modes() -> None:
    """资料没写到的失效模式要单列，读的人据此去补资料。"""
    markdown = _build()["markdown"]
    assert "### 待补资料的失效模式" in markdown
    assert "| AFE过压保护 | 通信超时, 持久化 |" in markdown


def test_report_without_exception_data_has_no_section() -> None:
    """没有异常数据时不要凭空加一节空表。"""
    markdown = _build(exception_coverage={}, exception_gaps={})["markdown"]
    assert "## 异常覆盖" not in markdown


def test_check_report_requires_the_section_when_exceptions_exist() -> None:
    counts = {"total": 10, "passed": 8, "skipped": 1, "failed": 1, "errored": 0, "cancelled": 0}
    ok_markdown = _build()["markdown"]
    assert consistency.check_report(ok_markdown, counts, "88.9%", exception_expected=True)["ok"]

    stripped = ok_markdown.replace("## 异常覆盖", "## 概览")
    judgement = consistency.check_report(stripped, counts, "88.9%", exception_expected=True)
    assert not judgement["ok"]
    assert any(issue["field"] == "exception" for issue in judgement["issues"])
