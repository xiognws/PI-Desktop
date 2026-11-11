"""测试报告（Markdown，确定性拼装）。

报告只读已经落库的执行结果：counts 和 execution_cases 必须来自同一批数据，
所以这里不再重算通过率，而是把 stats 与失败明细原样摊开，避免报告与执行详情
对不上。
"""

from __future__ import annotations

from datetime import datetime

from autotest.workflow.execution import failed_results

MAX_SECTIONS = 50
MAX_EVIDENCE_CHARS = 1_200


def _clip(text: str, limit: int = MAX_EVIDENCE_CHARS) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "\n…（已截断）"


def build_report(
    run_id: str,
    module: str,
    payload: dict,
    *,
    cases_total: int = 0,
    requirement: str = "",
    bugs: list[dict] | None = None,
) -> dict:
    """把一次执行 payload 拼成 Markdown 报告。"""
    stats = payload.get("stats") or {}
    total = int(stats.get("total") or 0)
    passed = int(stats.get("pass") or 0)
    failed = int(stats.get("fail") or 0)
    errored = int(stats.get("error") or 0)
    cancelled = int(stats.get("cancelled") or 0)
    pass_rate = f"{(passed / total * 100):.1f}%" if total else "0.0%"

    lines: list[str] = []
    lines.append(f"# 测试报告 {run_id}")
    lines.append("")
    lines.append(f"- 模块：{module or '未标注'}")
    lines.append(f"- 需求来源：{requirement or '未关联'}")
    lines.append(f"- 设计用例数：{cases_total}")
    lines.append(f"- 执行脚本数：{total}")
    lines.append(f"- 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")
    lines.append("## 结果汇总")
    lines.append("")
    lines.append("| 总数 | 通过 | 失败 | 异常 | 取消 | 通过率 | 总耗时 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    lines.append(f"| {total} | {passed} | {failed} | {errored} | {cancelled} | {pass_rate} | {stats.get('duration_ms', 0)} ms |")
    lines.append("")

    if total != cases_total:
        lines.append(f"> 注意：设计用例 {cases_total} 条，实际执行 {total} 个脚本；差额来自未生成脚本的用例或人工筛选。")
        lines.append("")

    bug_list = bugs or []
    if bug_list:
        lines.append("## 缺陷清单")
        lines.append("")
        lines.append("| Bug | 脚本 | 标题 | 级别 | 状态 | 错误类型 | 出现次数 |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for bug in bug_list[:MAX_SECTIONS]:
            lines.append(
                f"| {bug.get('id')} | {bug.get('script_name') or '-'} | {bug.get('title') or ''} "
                f"| {bug.get('severity') or ''} | {bug.get('status') or ''} | {bug.get('error_type') or '-'} "
                f"| {bug.get('occurrences') or 1} |"
            )
        lines.append("")

    failures = failed_results(payload)
    if failures:
        lines.append("## 失败明细")
        lines.append("")
        for item in failures[:MAX_SECTIONS]:
            lines.append(f"### {item.get('script_name') or item.get('script_id')}（{item.get('status')}）")
            lines.append("")
            lines.append(f"- execution_id：{item.get('execution_id')}")
            lines.append(f"- 耗时：{item.get('duration_ms')} ms")
            failure = _clip(str(item.get("failure") or ""))
            if failure:
                lines.append("")
                lines.append("**失败断言**")
                lines.append("")
                lines.append("```text")
                lines.append(failure)
                lines.append("```")
            stderr = _clip(str(item.get("stderr_tail") or ""))
            if stderr:
                lines.append("")
                lines.append("**stderr**")
                lines.append("")
                lines.append("```text")
                lines.append(stderr)
                lines.append("```")
            lines.append("")
    else:
        lines.append("## 失败明细")
        lines.append("")
        lines.append("无失败用例。")
        lines.append("")

    lines.append("## 结论")
    lines.append("")
    if total == 0:
        lines.append("本批次没有执行任何脚本，报告不含有效结论。")
    elif failed == 0 and errored == 0:
        lines.append(f"通过率 {pass_rate}，未发现失败或异常。")
    else:
        lines.append(f"通过率 {pass_rate}，存在 {failed + errored} 个失败/异常用例，见上方失败明细。")

    markdown = "\n".join(lines) + "\n"
    return {
        "markdown": markdown,
        "counts": {
            "total": total,
            "passed": passed,
            "failed": failed,
            "errored": errored,
            "cancelled": cancelled,
            "bugs": len(bug_list),
        },
        "pass_rate": pass_rate,
        "name": f"{run_id}-report.md",
    }
