"""用例 → pytest 脚本（确定性模板）。

生成的脚本是"可收集、可运行、待填实现"的骨架：用例的步骤与预期写进常量，
测试函数留一个显式跳过的占位。这样 Agent/人补实现时不用重写文件头，
执行器也能立刻收集到用例，报告里的用例数与设计阶段对得上。
"""

from __future__ import annotations

import hashlib

MAX_SCRIPT_CASE_CHARS = 200

_HEADER = '''"""自动生成：{title}

功能点：{function_point}
类型：{case_type}    优先级：{priority}
生成方式：workflow author_script（确定性模板，未调用模型）

两种运行方式都支持：
  pytest <file>          收集为用例（骨架阶段 skip）
  python <file>          直接执行（骨架阶段打印提示后退出 0）
"""

import os

CASE_TITLE = {title_literal}
FUNCTION_POINT = {function_point_literal}
CASE_TYPE = {case_type_literal}
PRIORITY = {priority_literal}
PRECONDITION = {precondition_literal}
STEPS = {steps_literal}
EXPECTED = {expected_literal}


def test_{slug}():
    """{title}"""
    # 前置：{precondition_text}
    # 步骤：
{steps_comment}
    # 预期：
{expected_comment}
    # 判定用 env 而不是 sys.modules：本文件自己 import 过 pytest 也不算
    # "在 pytest 里跑"；PYTEST_CURRENT_TEST 只在 pytest 执行用例时存在。
    if "PYTEST_CURRENT_TEST" in os.environ:
        import pytest

        pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")
    print("骨架未实现：{title}")


if __name__ == "__main__":
    test_{slug}()
'''


def _clip(value: object) -> str:
    text = str(value or "").strip()
    return text if len(text) <= MAX_SCRIPT_CASE_CHARS else text[:MAX_SCRIPT_CASE_CHARS] + "…"


def _slug(case: dict) -> str:
    seed = f"{case.get('title')}|{case.get('function_point')}|{case.get('case_type')}"
    return "case_" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8]


def author_script(case: dict, sdk: str = "pytest") -> dict:
    """把一条用例落成脚本文本。

    目前只有 pytest 一种 SDK；保留 `sdk` 参数是为了后续接其它执行器时
    调用方签名不变。
    """
    if sdk != "pytest":
        raise ValueError(f"unsupported script sdk: {sdk}")

    title = _clip(case.get("title")) or "未命名用例"
    function_point = _clip(case.get("function_point"))
    case_type = _clip(case.get("case_type")) or "功能"
    priority = _clip(case.get("priority")) or "中"
    precondition = _clip(case.get("precondition")) or "测试环境就绪"

    steps = [(_clip(item) or "-") for item in (case.get("steps") or [])]
    expected = [(_clip(item) or "-") for item in (case.get("expected") or [])]
    steps_comment = "\n".join(f"    #   {index}. {step}" for index, step in enumerate(steps, start=1)) or "    #   （用例未给出步骤）"
    expected_comment = "\n".join(f"    #   - {item}" for item in expected) or "    #   （用例未给出预期）"

    content = _HEADER.format(
        title=title,
        function_point=function_point or "未标注",
        case_type=case_type,
        priority=priority,
        slug=_slug(case),
        title_literal=repr(title),
        function_point_literal=repr(function_point),
        case_type_literal=repr(case_type),
        priority_literal=repr(priority),
        precondition_literal=repr(precondition),
        precondition_text=precondition,
        steps_literal=repr(steps),
        expected_literal=repr(expected),
        steps_comment=steps_comment,
        expected_comment=expected_comment,
    )

    return {
        "name": f"{_slug(case)}.py",
        "language": "python",
        "content": content,
        "case_ref": {
            "title": title,
            "function_point": function_point,
            "case_type": case_type,
            "priority": priority,
        },
        "stats": {"steps": len(steps), "expected": len(expected), "lines": content.count("\n")},
    }


def author_scripts(cases: list[dict], sdk: str = "pytest") -> dict:
    """批量生成，超过 200 条的部分丢弃（与用例上限一致）。"""
    scripts = [author_script(case, sdk) for case in cases[:200]]
    return {
        "scripts": scripts,
        "stats": {"total": len(scripts), "sdk": sdk, "lines": sum(item["stats"]["lines"] for item in scripts)},
    }
