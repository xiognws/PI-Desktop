"""用例一致性校验：把 `prompts/case-design.md` 的硬性规则变成可执行的检查。

生成用例的代码是确定性的，但用例也会来自 Agent / 以后接入的模型 —— 光有提示词
文本约束不了任何东西。这里把"不合格"具体化成可判定的问题，产出里带上结论，
评审阶段和界面据此拦下来。
"""

from __future__ import annotations

CASE_TYPES = ("功能", "异常", "边界", "接口", "兼容")
TYPE_SUFFIX = {
    "功能": "主流程",
    "异常": "异常输入",
    "边界": "边界值",
    "接口": "接口契约",
    "兼容": "兼容性",
}
PRIORITIES = ("高", "中", "低")
GROUNDINGS = ("strong", "weak", "none")

MIN_STEPS = 3
MIN_EXPECTED = 1

# 只有 grounding=none（占位模式）才允许出现的空话
PLACEHOLDERS = (
    "执行正常操作",
    "结果与预期一致",
    "过程中无报错、无脏数据",
)


def _text(items: object) -> str:
    if isinstance(items, list):
        return " ".join(str(item) for item in items)
    return str(items or "")


def check_case(case: dict) -> list[dict]:
    """单条用例的问题清单（空列表 = 合格）。"""
    issues: list[dict] = []
    title = str(case.get("title") or "").strip()
    grounding = str(case.get("grounding") or "none")
    case_type = str(case.get("case_type") or "")

    def add(field: str, problem: str) -> None:
        issues.append({"title": title, "field": field, "problem": problem})

    if not title:
        add("title", "标题为空")
    if case_type not in CASE_TYPES:
        add("case_type", f"类型 {case_type!r} 不在固定枚举里")
    elif not title.endswith(TYPE_SUFFIX[case_type]):
        add("title", f"标题后缀应为 {TYPE_SUFFIX[case_type]}")
    if str(case.get("priority") or "") not in PRIORITIES:
        add("priority", "优先级只能取 高/中/低")
    if grounding not in GROUNDINGS:
        add("grounding", f"grounding {grounding!r} 不合法")
    if not str(case.get("precondition") or "").strip():
        add("precondition", "前置条件为空")

    steps = case.get("steps") or []
    expected = case.get("expected") or []
    if len(steps) < MIN_STEPS:
        add("steps", f"步骤不足 {MIN_STEPS} 条（当前 {len(steps)}）")
    if len(expected) < MIN_EXPECTED:
        add("expected", "预期为空")
    if any(not str(step).strip() for step in steps):
        add("steps", "存在空步骤")

    steps_text = _text(steps)
    expected_text = _text(expected)

    if grounding != "none":
        for phrase in PLACEHOLDERS:
            if phrase in steps_text or phrase in expected_text:
                add("wording", f"有依据的用例里出现了空话「{phrase}」")

    if grounding == "strong":
        numbers = (case.get("evidence") or {}).get("numbers") or []
        if not numbers:
            add("evidence", "grounding=strong 但没有原文数值")
        elif not any(str(number) in steps_text or str(number) in expected_text for number in numbers):
            add("steps", "grounding=strong 时步骤/预期必须出现原文数值")

    return issues


def check_cases(cases: list[dict]) -> dict:
    """整批用例的校验结果：`{ok, checked, issues, by_field}`。"""
    issues: list[dict] = []
    for case in cases:
        issues.extend(check_case(case))
    by_field: dict[str, int] = {}
    for issue in issues:
        by_field[issue["field"]] = by_field.get(issue["field"], 0) + 1
    return {
        "ok": not issues,
        "checked": len(cases),
        "issues": issues[:20],
        "by_field": by_field,
    }
