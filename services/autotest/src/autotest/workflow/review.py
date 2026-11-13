"""用例评审（确定性检查）。

只回答"能不能测"和"是不是重复"，不评价用例写得好不好——那是 Agent 的事。
"""

from __future__ import annotations

from autotest.workflow.consistency import PLACEHOLDERS

MIN_STEPS = 2

# 预期里只要每条都挂着这些句子，就没有可判定对象：执行的人也不知道该看什么。
_FILLER = (
    *PLACEHOLDERS,
    "按需求描述完成",
    "按需求执行",
    "结果与预期一致",
)


def _expected_judgeable(expected: list[str]) -> bool:
    """至少要有一条预期不靠空话立住 —— 否则执行时无法判定成败。"""
    return any(
        not any(phrase in str(item) for phrase in _FILLER) for item in expected if str(item).strip()
    )


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

        # 没有依据的用例不能算"可测"：它测的是模板句式，不是需求。
        if str(case.get("grounding") or "") == "none":
            untestable.append(
                {"index": index, "title": title, "reason": "无依据（占位用例，资料缺失）"}
            )
            continue

        steps = [item for item in (case.get("steps") or []) if str(item).strip()]
        expected = [item for item in (case.get("expected") or []) if str(item).strip()]
        if not steps:
            untestable.append({"index": index, "title": title, "reason": "缺少步骤"})
        elif len(steps) < MIN_STEPS:
            issues.append({"index": index, "title": title, "reason": f"步骤少于 {MIN_STEPS} 条"})
        if not expected:
            untestable.append({"index": index, "title": title, "reason": "缺少预期结果"})
        elif not _expected_judgeable(expected):
            untestable.append(
                {"index": index, "title": title, "reason": "预期不可判定（只有空话）"}
            )
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
