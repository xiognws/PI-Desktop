"""一个脚本到底是"真断言"还是"骨架"。

这是产品里最容易被误读的一件事：骨架脚本跑出来也是绿的（skip 被计通过），
执行统计里"34/34 通过"听起来像验证过，其实一条断言都没有。所以"这条用例有没有
真的验过"必须能从产物本身判出来，而不是靠人记得自己改过哪个文件。
"""

from __future__ import annotations

import re

# 骨架的显式标记：模板生成的占位跳过。
# 只看 `pytest.skip(`：模板块尾部的 `print('骨架未实现…')` 在补完断言后可能残留，
# 那是文案噪音，不该把一条真在验的脚本判回骨架（判据是「有跳过」或「零断言」）。
SKELETON_MARKERS = ("pytest.skip(", )

# 恒真断言不算断言
_TAUTOLOGY = re.compile(r"assert\s+(True|1\s*==\s*1)\b")
_ASSERT_LINE = re.compile(r"^\s*assert\s+", re.MULTILINE)


def classify(content: str | None) -> dict:
    """返回 `{state, asserts, has_skip}`。

    state:
      * `asserted` —— 有真实断言且没有占位跳过
      * `skeleton` —— 占位跳过，或者一条断言都没有
      * `missing`  —— 文件不存在/读不到
    """
    text = content or ""
    if not text.strip():
        return {"state": "missing", "asserts": 0, "has_skip": False}

    has_skip = any(marker in text for marker in SKELETON_MARKERS)
    asserts = 0
    for match in _ASSERT_LINE.finditer(text):
        line = text[match.start() : text.find("\n", match.start()) if "\n" in text[match.start():] else len(text)]
        if _TAUTOLOGY.search(line):
            continue
        asserts += 1

    state = "asserted" if asserts > 0 and not has_skip else "skeleton"
    return {"state": state, "asserts": asserts, "has_skip": has_skip}


def merge(states: list[str]) -> str:
    """同一用例挂了多个脚本时取"最好"的那个状态。"""
    for preferred in ("asserted", "skeleton", "missing"):
        if preferred in states:
            return preferred
    return "none"
