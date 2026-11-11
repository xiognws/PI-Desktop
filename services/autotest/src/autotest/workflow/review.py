"""用例评审（确定性检查）。

只回答"能不能测"和"是不是重复"，不评价用例写得好不好——那是 Agent 的事。
"""

from __future__ import annotations

MIN_STEPS = 2


def review_cases(cases: list[dict], module: str = "") -> dict:
    issues: list[dict] = []
    duplicates: list[dict] = []
    untestable: list[dict] = []

    seen: dict[str, int] = {}
    for index, case in enumerate(cases):
        title = str(case.get("title") or "").strip()
        if not title:
            untestable.append({"index": index, "reason": "缺少标题"})
            continue
        key = title.lower()
        if key in seen:
            duplicates.append({"index": index, "title": title, "duplicate_of": seen[key]})
        else:
            seen[key] = index

        steps = [item for item in (case.get("steps") or []) if str(item).strip()]
        expected = [item for item in (case.get("expected") or []) if str(item).strip()]
        if not steps:
            untestable.append({"index": index, "title": title, "reason": "缺少步骤"})
        elif len(steps) < MIN_STEPS:
            issues.append({"index": index, "title": title, "reason": f"步骤少于 {MIN_STEPS} 条"})
        if not expected:
            untestable.append({"index": index, "title": title, "reason": "缺少预期结果"})
        if not str(case.get("priority") or "").strip():
            issues.append({"index": index, "title": title, "reason": "缺少优先级"})

    verdict = "ok" if not untestable and not duplicates else "needs_fix"
    return {
        "verdict": verdict,
        "issues": issues,
        "duplicates": duplicates,
        "untestable": untestable,
        "stats": {"total": len(cases), "module": module},
    }
