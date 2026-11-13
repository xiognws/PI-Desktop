"""固定提示词：把"每个阶段该按什么规则产出"落成仓库里的版本化文件。

为什么要有这一层：流水线的每个阶段（解析 / 用例 / 评审 / 脚本 / 日志 / 报告）
以前只有代码里的隐式规则，Agent 侧靠自己发挥，同一份需求两次产出可能完全不同。
现在规则以 markdown + frontmatter 固定在 `services/autotest/prompts/`，每次产出都会
记录 `id@version`，改规则必须升版本 —— 可追溯，也能被测试锁住。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parents[3] / "prompts"

REQUIRED_KEYS = ("id", "version", "stage")

# 每个阶段只认这一份提示词；加新阶段要在这里登记，避免"随便一个 md 就生效"。
STAGES: dict[str, str] = {
    "prd-parse": "prd-parse.md",
    "case-design": "case-design.md",
    "case-review": "case-review.md",
    "script-author": "script-author.md",
    "log-analyze": "log-analyze.md",
    "report": "report.md",
}


class PromptError(RuntimeError):
    """提示词缺失或格式不合法。宁可启动即报错，也不要静默用空规则跑。"""


@dataclass(frozen=True)
class Prompt:
    stage: str
    prompt_id: str
    version: str
    updated: str
    body: str
    path: Path

    @property
    def ref(self) -> str:
        """可写进 payload 的稳定引用：`autotest.case-design@1.0.0`。"""
        return f"{self.prompt_id}@{self.version}"

    @property
    def digest(self) -> str:
        """正文指纹：版本号忘了改但内容变了，也能被发现。"""
        return hashlib.sha256(self.body.encode("utf-8")).hexdigest()[:12]


def _parse(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        raise PromptError("提示词缺少 frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise PromptError("提示词 frontmatter 没有闭合")
    meta: dict[str, str] = {}
    for line in parts[1].strip().splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip()
    return meta, parts[2].strip()


@lru_cache(maxsize=None)
def load(stage: str) -> Prompt:
    filename = STAGES.get(stage)
    if filename is None:
        raise PromptError(f"未知阶段 {stage}；已登记：{', '.join(sorted(STAGES))}")
    path = PROMPT_DIR / filename
    if not path.is_file():
        raise PromptError(f"提示词文件不存在：{path}")
    meta, body = _parse(path.read_text(encoding="utf-8"))
    missing = [key for key in REQUIRED_KEYS if not meta.get(key)]
    if missing:
        raise PromptError(f"{path.name} 缺少 frontmatter 字段：{', '.join(missing)}")
    if meta["stage"] != stage:
        raise PromptError(f"{path.name} 的 stage 写成 {meta['stage']}，与注册的 {stage} 不一致")
    return Prompt(
        stage=stage,
        prompt_id=meta["id"],
        version=meta["version"],
        updated=meta.get("updated", ""),
        body=body,
        path=path,
    )


def ref(stage: str) -> str:
    """给产出打版本标记用；缺文件时抛 PromptError，由调用方决定怎么降级。"""
    return load(stage).ref


def catalog() -> list[dict[str, str]]:
    """所有阶段的当前版本，接口与界面用来展示"这次用的是哪一版规则"。"""
    items: list[dict[str, str]] = []
    for stage in STAGES:
        prompt = load(stage)
        items.append(
            {
                "stage": stage,
                "id": prompt.prompt_id,
                "version": prompt.version,
                "updated": prompt.updated,
                "ref": prompt.ref,
                "digest": prompt.digest,
            }
        )
    return items
