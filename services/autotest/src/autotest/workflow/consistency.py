"""用例一致性校验：把 `prompts/case-design.md` 的硬性规则变成可执行的检查。

生成用例的代码是确定性的，但用例也会来自 Agent / 以后接入的模型 —— 光有提示词
文本约束不了任何东西。这里把"不合格"具体化成可判定的问题，产出里带上结论，
评审阶段和界面据此拦下来。
"""

from __future__ import annotations

import re

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


def check_review(review: dict, cases: list[dict]) -> dict:
    """`prompts/case-review.md` 的规则落到评审结论上。

    评审是"用例进脚本前"的最后一道闸。结论为空、条目定位不到、或者把无依据的
    用例判成可测，都会让不可测的用例一路流到执行阶段。
    """
    issues: list[dict] = []

    def add(field: str, problem: str) -> None:
        issues.append({"field": field, "problem": problem})

    verdict = str(review.get("verdict") or "")
    untestable = review.get("untestable") or []
    duplicates = review.get("duplicates") or []
    if verdict not in ("ok", "needs_fix"):
        add("verdict", f"verdict {verdict!r} 只能取 ok / needs_fix")
    if verdict == "needs_fix" and not untestable and not duplicates:
        add("verdict", "needs_fix 却没有任何明细，等于空结论")
    if verdict == "ok" and (untestable or duplicates):
        add("verdict", "有不可测/重复明细却给了 ok")

    for item in [*untestable, *duplicates]:
        index = item.get("index")
        if not isinstance(index, int) or not 0 <= index < len(cases):
            add("index", f"明细里的 index {index!r} 定位不到输入用例")

    ungrounded = [
        index
        for index, case in enumerate(cases)
        if str(case.get("grounding") or "") == "none"
    ]
    reported = {item.get("index") for item in untestable}
    for index in ungrounded:
        if index not in reported:
            title = str((cases[index] or {}).get("title") or index)
            add("grounding", f"无依据用例「{title}」没有被判为不可测")

    by_field: dict[str, int] = {}
    for issue in issues:
        by_field[issue["field"]] = by_field.get(issue["field"], 0) + 1
    return {
        "ok": not issues,
        "checked": len(cases),
        "issues": issues[:20],
        "by_field": by_field,
    }


REPORT_COLUMNS = ("总数", "通过", "跳过", "失败", "异常", "取消", "通过率", "总耗时")


def check_report(markdown: str, counts: dict, pass_rate: str) -> dict:
    """`prompts/report.md` 的规则落到生成的报告文本上。

    报告是唯一对外交付物，最容易出现"数字和明细对不上但没人发现"。这里不改报告，
    只把三件必须成立的事校验出来：表头顺序固定、表内数字等于 counts、跳过与通过率
    的措辞守规矩。
    """
    issues: list[dict] = []

    def add(field: str, problem: str) -> None:
        issues.append({"field": field, "problem": problem})

    text = str(markdown or "")
    total = int(counts.get("total") or 0)
    passed = int(counts.get("passed") or 0)
    skipped = int(counts.get("skipped") or 0)
    failed = int(counts.get("failed") or 0)
    errored = int(counts.get("errored") or 0)
    cancelled = int(counts.get("cancelled") or 0)
    asserted = max(total - skipped, 0)

    header = "| " + " | ".join(REPORT_COLUMNS) + " |"
    if header not in text:
        add("table", "结果汇总表头列顺序不符合报告规则")

    row = re.search(r"^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", text, re.MULTILINE)
    if row is None:
        add("table", "找不到结果汇总数据行")
    else:
        numbers = [int(value) for value in row.groups()]
        expected = [total, passed, skipped, failed, errored, cancelled]
        if numbers != expected:
            add("table", f"表内数字 {numbers} 与执行统计 {expected} 不一致")

    if skipped > 0 and "未计通过" not in text:
        add("skip", "有跳过用例，但报告没有声明「未计通过」")
    if skipped > 0 and "断言覆盖" not in text:
        add("skip", "有骨架跳过，但报告没有写出「真断言 / 骨架」的覆盖条数")

    if asserted == 0:
        if pass_rate != "—（全部跳过）":
            add("pass_rate", f"全部跳过时通过率应为「—（全部跳过）」，实际 {pass_rate!r}")
        if "不能据此判定" not in text:
            add("pass_rate", "全部跳过时没有说明不能据此判定功能通过")
    else:
        want = f"{passed / asserted * 100:.1f}%"
        if pass_rate != want:
            add("pass_rate", f"通过率应为 {want}（{passed}/{asserted}），实际 {pass_rate!r}")
        if want not in text:
            add("pass_rate", "正文里没有写出通过率数字")

    by_field: dict[str, int] = {}
    for issue in issues:
        by_field[issue["field"]] = by_field.get(issue["field"], 0) + 1
    return {
        "ok": not issues,
        "checked": 1,
        "issues": issues[:20],
        "by_field": by_field,
    }


def check_scripts(scripts: list[dict]) -> dict:
    """`prompts/script-author.md` 的硬规则落到生成的脚本文本上。

    这一层要防的是"假通过"：骨架写成 `assert True` 或者干脆不 skip，
    pytest 一跑就是绿的，报告里却什么都没验证。脚本是唯一会被执行器直接跑的产物，
    规则必须可判定。
    """
    issues: list[dict] = []
    for item in scripts:
        name = str(item.get("name") or "")
        content = str(item.get("content") or "")

        def add(field: str, problem: str) -> None:
            issues.append({"script": name, "field": field, "problem": problem})

        slug = name[:-3] if name.endswith(".py") else name
        if not re.fullmatch(r"case_[0-9a-f]{8}\.py", name):
            add("name", "文件名应为 case_<8 位短哈希>.py")
        if f"def test_{slug}(" not in content:
            add("function", f"缺少函数 def test_{slug}()")
        if 'if __name__ == "__main__":' not in content:
            add("standalone", "缺少 __main__ 入口，无法直接 python 执行")
        if "生成方式：" not in content:
            add("header", "文件头未写明生成方式")
        if "STEPS =" not in content or "EXPECTED =" not in content:
            add("constants", "步骤/预期未作为常量写进脚本，脚本无法脱离用例库自查")
        if "assert True" in content or re.search(r"assert\s+1\s*==\s*1", content):
            add("tautology", "出现恒真断言，等于伪装通过")
        # 骨架必须显式跳过；补全后的脚本才允许有真实断言
        if "pytest.skip(" not in content:
            assertions = re.findall(r"^\s+assert\s+(?!True\b)", content, flags=re.MULTILINE)
            if not assertions:
                add("skeleton", "既没有 pytest.skip 也没有真实断言")

    by_field: dict[str, int] = {}
    for issue in issues:
        by_field[issue["field"]] = by_field.get(issue["field"], 0) + 1
    return {
        "ok": not issues,
        "checked": len(scripts),
        "issues": issues[:20],
        "by_field": by_field,
    }


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
