"""按契约从条款数值生成真断言。

输入是"用例 + 它在契约里的那一条"，输出是可以直接写进脚本的断言块。三条硬规则：

1. **数字只能来自条款**（`evidence.numbers`），不写死字面量 —— 条款改了断言跟着改。
2. **形态只有四种**：`== `（布尔/数值）、`in`（包含）、`pytest.raises`（应被拒绝），
   加上数值容差。不生成"看起来在验"的复合表达式。
3. **必须能失败**：生成器同时给出 `mutation` 版本（把条款数值挪动一点），
   由调用方跑一次；变异版还能过，说明这条断言是空的。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from autotest.workflow.dut_contract import Entry

PLACEHOLDER = re.compile(r"\{\{number(?::(\d+))?\}\}")

# 变异检查时数值挪动的相对幅度：足够让阈值判定翻转，又不至于把输入挪出量程
MUTATION_RATIO = 0.2


class GenerationError(ValueError):
    """这条用例没法按契约生成断言（缺数值、形态不支持等）。"""


@dataclass
class Generated:
    body: list[str]
    mutation: list[str]
    numbers: list[str]


def _numbers(case: dict) -> list[str]:
    evidence = case.get("evidence") or {}
    numbers = [str(item) for item in (evidence.get("numbers") or []) if item]
    if not numbers:
        raise GenerationError("用例没有条款数值，不能生成断言")
    return numbers


def _numeric(text: str) -> str:
    """条款数值是带单位的字符串（`3.65V`），写进代码时必须只留数字。"""
    match = re.match(r"\s*(-?\d+(?:\.\d+)?)", str(text))
    if match is None:
        raise GenerationError(f"条款数值 {text!r} 里没有可用的数字")
    return match.group(1)


def _substitute(line: str, numbers: list[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        index = int(match.group(1) or 0)
        if index >= len(numbers):
            raise GenerationError(f"占位符引用了第 {index + 1} 个数值，但条款只有 {len(numbers)} 个")
        return _numeric(numbers[index])

    return PLACEHOLDER.sub(replace, line)


def _nudged(line: str) -> str:
    """把行里的数字整体挪动一点，用于变异检查。"""

    def bump(match: re.Match[str]) -> str:
        value = float(match.group(0))
        if value == 0:
            return "1"
        shifted = value * (1 + MUTATION_RATIO)
        return f"{shifted:.4f}".rstrip("0").rstrip(".")

    return re.sub(r"\d+\.\d+|\d+", bump, line)


def _preamble(driver: str, imports: list[str], factory: str) -> list[str]:
    """脚本开头：把被测件接进来并实例化。

    没有这一段，生成的断言调的是一个不存在的 `dut`，脚本连收集都过不去。
    """
    module = Path(driver).stem if driver else ""
    lines = [
        "    import sys",
        "    from pathlib import Path",
        f'    sys.path.insert(0, str(Path(__file__).resolve().parent / "{Path(driver).parent.name or "_support"}"))',
    ]
    if module and imports:
        lines.append(f"    from {module} import {', '.join(imports)}")
    lines.append(f"    dut = {factory}")
    return lines


def generate(
    case: dict,
    entry: Entry,
    *,
    driver: str = "",
    imports: list[str] | None = None,
) -> Generated:
    """生成断言块；body 与 mutation 都是缩进 4 空格的语句行。"""
    numbers = _numbers(case)
    prelude = _preamble(driver, list(imports or []), entry.factory)
    arrange = [f"    {_substitute(line, numbers)}" for line in entry.arrange]
    observe = entry.observe
    kind = entry.kind
    value = entry.value
    label = entry.function_point

    if kind == "raises":
        # 异常类是裸名字，不能加引号（`pytest.raises('ValueError')` 跑不起来）
        exception = str(value)
        body = [
            *prelude,
            "    import pytest",
            f"    with pytest.raises({exception}):",
            *[f"        {line.strip()}" for line in arrange],
        ]
    elif kind == "bool":
        expected = "True" if value else "False"
        body = [
            *prelude,
            *arrange,
            f'    assert {observe} is {expected}, "{label} 的判定应为 {expected}"',
        ]
    elif kind == "contains":
        body = [
            *prelude,
            *arrange,
            f'    assert {json_literal(value)} in {observe}, "{label} 的判定应包含 {value}"',
        ]
    elif kind == "number":
        literal = json_literal(value)
        if entry.tolerance:
            body = [
                *prelude,
                *arrange,
                f"    assert abs({observe} - {literal}) <= {entry.tolerance}, "
                f'f"{label} 的判定应在 {literal} ± {entry.tolerance} 内"',
            ]
        else:
            body = [
                *prelude,
                *arrange,
                f'    assert {observe} == {literal}, f"{label} 的判定应为 {literal}"',
            ]
    else:  # 契约解析已挡住，这里只防御
        raise GenerationError(f"不支持的 expect.kind：{kind}")

    return Generated(body=body, mutation=[_nudged(line) for line in body], numbers=numbers)


def json_literal(value: object) -> str:
    """把契约里的值写成 Python 字面量（字符串要带引号）。"""
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return str(value)
    return repr(value)
