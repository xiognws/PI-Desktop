"""PRD 结构切分。

这一层刻意不做语义推理：模型该做的判断留给 Agent，这里只保证同一份文档
每次切出同一份结构（用例追溯、报告统计都依赖这个确定性）。

输出契约（工具和前端共用，加字段只能追加）：

    {
      "function_points": [{"id", "name", "detail", "priority", "source"}],
      "non_functional":  [{"category", "item"}],
      "dependencies":    [{"item"}],
      "risks":           [{"item"}],
      "stats":           {"chars", "sections", "function_points"}
    }
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

MAX_FUNCTION_POINTS = 200
MAX_ITEM_CHARS = 200
MAX_ITEMS_PER_GROUP = 60

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_NUMBERED_HEADING = re.compile(r"^(?:第[一二三四五六七八九十百]+[章节部分]|[一二三四五六七八九十]+、|\d+\.\d*)\s*(.+)$")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)、]|\(\d+\))\s+(.+)$")
_REQUIREMENT = re.compile(r"(应|必须|需要|支持|能够|可以|允许|提供|禁止|不得|保证)")

_FUNCTIONAL_SECTION = ("功能", "需求", "流程", "页面", "交互", "接口", "业务", "操作", "场景")
_NON_FUNCTIONAL = (
    ("性能", ("性能", "响应时间", "并发", "吞吐", "延迟", "帧率", "耗时")),
    ("安全", ("安全", "权限", "鉴权", "加密", "越权", "审计", "合规")),
    ("兼容", ("兼容", "适配", "版本", "机型", "分辨率", "平台")),
    ("可用性", ("可用性", "容错", "降级", "重试", "断网", "异常恢复")),
    ("可维护性", ("日志", "监控", "告警", "可观测", "埋点")),
)
_DEPENDENCY = ("依赖", "前置", "上游", "第三方", "联调", "接口提供", "需由", "由.*提供")
_RISK = ("风险", "待确认", "待定", "tbd", "疑问", "约束", "限制", "不确定", "待评审")


def _normalize(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\u3000", " ")


def _trim(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    return value[:MAX_ITEM_CHARS]


def _priority(text: str) -> str:
    lowered = text.lower()
    if any(word in text for word in ("必须", "核心", "P0", "阻塞")) or "p0" in lowered:
        return "高"
    if any(word in text for word in ("可选", "建议", "P2", "锦上添花")) or "p2" in lowered:
        return "低"
    return "中"


def _matches(text: str, patterns: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(re.search(pattern, text) or pattern in lowered for pattern in patterns)


@dataclass
class _Section:
    title: str
    body: list[str]
    level: int = 0


def _split_sections(lines: list[str]) -> list[_Section]:
    sections: list[_Section] = []
    current = _Section(title="", body=[])
    for line in lines:
        heading = _HEADING.match(line)
        numbered = None if heading else _NUMBERED_HEADING.match(line)
        if heading or numbered:
            if current.body or current.title:
                sections.append(current)
            title = (heading.group(2) if heading else numbered.group(1)).strip()
            level = len(heading.group(1)) if heading else 0
            current = _Section(title=title, body=[], level=level)
        else:
            current.body.append(line)
    if current.body or current.title:
        sections.append(current)
    return sections


def _collect_items(section: _Section) -> list[str]:
    items: list[str] = []
    for line in section.body:
        stripped = line.strip()
        if not stripped:
            continue
        listed = _LIST_ITEM.match(line)
        if listed:
            items.append(listed.group(1).strip())
        elif _REQUIREMENT.search(stripped) and len(stripped) <= MAX_ITEM_CHARS * 2:
            items.append(stripped)
    return items


def _fp_id(index: int, name: str) -> str:
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:6]
    return f"fp-{index:03d}-{digest}"


def parse_prd(text: str, module: str = "") -> dict:
    """把 PRD 切成功能点、非功能、依赖、风险。

    `module` 只用于统计与调用方标识，不参与切分——同一份文档在任何模块下
    都应当得到同样的功能点集合。
    """
    normalized = _normalize(text or "")
    lines = normalized.split("\n")
    sections = _split_sections(lines)

    function_points: list[dict] = []
    non_functional: list[dict] = []
    dependencies: list[dict] = []
    risks: list[dict] = []
    seen_names: set[str] = set()

    for section in sections:
        title = section.title
        items = _collect_items(section)

        for item in items:
            if _matches(item, _RISK):
                if len(risks) < MAX_ITEMS_PER_GROUP:
                    risks.append({"item": _trim(item)})
            elif _matches(item, _DEPENDENCY):
                if len(dependencies) < MAX_ITEMS_PER_GROUP:
                    dependencies.append({"item": _trim(item)})
            for category, words in _NON_FUNCTIONAL:
                if _matches(item, words) and len(non_functional) < MAX_ITEMS_PER_GROUP:
                    non_functional.append({"category": category, "item": _trim(item)})
                    break

        in_functional_section = any(word in title for word in _FUNCTIONAL_SECTION)
        if not in_functional_section:
            continue
        # 文档大标题（h1）只是容器，不当作功能点；一节没有条目时用它的 h2+ 标题兜底。
        heading_usable = section.level >= 2 or section.level == 0

        candidates = items or ([title] if title and heading_usable else [])
        for item in candidates:
            name = _trim(item)
            if not name or len(name) < 4:
                continue
            key = name.lower()
            if key in seen_names:
                continue
            seen_names.add(key)
            if len(function_points) >= MAX_FUNCTION_POINTS:
                break
            function_points.append(
                {
                    "id": _fp_id(len(function_points) + 1, name),
                    "name": name[:60],
                    "detail": name,
                    "priority": _priority(item),
                    "source": title or "正文",
                }
            )

    if not function_points:
        # 文档没有显式章节：退化为标题+条目，保证工具总能给出可用的骨架，
        # 但把这一事实放在 stats 里，免得调用方以为解析到了完整结构。
        for section in sections:
            if not section.title or section.level == 1:
                continue
            name = _trim(section.title)
            if len(name) < 4 or name.lower() in seen_names:
                continue
            seen_names.add(name.lower())
            function_points.append(
                {
                    "id": _fp_id(len(function_points) + 1, name),
                    "name": name[:60],
                    "detail": name,
                    "priority": _priority(name),
                    "source": "heading",
                }
            )
            if len(function_points) >= MAX_FUNCTION_POINTS:
                break

    return {
        "function_points": function_points,
        "non_functional": non_functional,
        "dependencies": dependencies,
        "risks": risks,
        "stats": {
            "chars": len(normalized),
            "sections": len(sections),
            "function_points": len(function_points),
            "module": module,
        },
    }
