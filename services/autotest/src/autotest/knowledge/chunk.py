"""把长文本切成可检索、可引用的条目。

两级切分：

1. **结构级**：Markdown 标题（`#`~`######`）优先，一个标题下的一段内容是一个
   语义单元 —— 车载文档里"故障现象"和"排查步骤"经常各自成一个标题，按标题切
   才能让检索命中的是一条完整的排查步骤，而不是半句话。
2. **长度级**：单个语义单元超过 `chunk_chars` 时，先按空行拆段，再贪心拼到上限，
   相邻块之间保留 `overlap` 个字符，避免把跨段的一句话从中间切断。

没有标题的纯文本（日志、CSV、JSON）直接走第二级。所有条目都带标题，
检索结果里人一眼能看出它来自文档的哪一节。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
MIN_CHUNK_CHARS = 200
MAX_CHUNK_CHARS = 8000
DEFAULT_OVERLAP = 120
MAX_CHUNKS = 5000


@dataclass(frozen=True)
class Chunk:
    title: str
    content: str


def _sections(text: str) -> list[tuple[str, str]]:
    """按标题切段，返回 (标题, 正文)。标题前的引言归到第一个空标题段。"""
    lines = text.split("\n")
    sections: list[tuple[str, list[str]]] = [("", [])]
    for line in lines:
        match = HEADING_RE.match(line)
        if match:
            sections.append((match.group(2).strip(), []))
        else:
            sections[-1][1].append(line)
    return [(title, "\n".join(body).strip()) for title, body in sections]


def _pack(text: str, limit: int, overlap: int) -> list[str]:
    """按空行段落贪心装箱；单段超限时硬切并带重叠。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return []

    pieces: list[str] = []
    buffer = ""
    for paragraph in paragraphs:
        if len(paragraph) > limit:
            if buffer:
                pieces.append(buffer)
                buffer = ""
            step = max(1, limit - overlap)
            for start in range(0, len(paragraph), step):
                pieces.append(paragraph[start : start + limit])
                if start + limit >= len(paragraph):
                    break
            continue
        candidate = f"{buffer}\n\n{paragraph}" if buffer else paragraph
        if len(candidate) <= limit:
            buffer = candidate
        else:
            pieces.append(buffer)
            tail = buffer[-overlap:] if overlap and buffer else ""
            buffer = f"{tail}\n{paragraph}" if tail else paragraph
    if buffer:
        pieces.append(buffer)
    return [p.strip() for p in pieces if p.strip()]


def chunk_text(
    text: str,
    chunk_chars: int = 1200,
    overlap: int = DEFAULT_OVERLAP,
) -> list[Chunk]:
    """切分文本。返回的条目数超过 `MAX_CHUNKS` 时抛 ValueError，避免误传大文件。"""
    if not 0 < chunk_chars <= MAX_CHUNK_CHARS:
        raise ValueError(f"chunk_chars 必须在 1~{MAX_CHUNK_CHARS} 之间")
    if chunk_chars < MIN_CHUNK_CHARS:
        chunk_chars = MIN_CHUNK_CHARS
    overlap = max(0, min(overlap, chunk_chars // 3))

    chunks: list[Chunk] = []
    for title, body in _sections(text):
        if not body:
            if title:
                chunks.append(Chunk(title=title, content=title))
            continue
        if len(body) <= chunk_chars:
            chunks.append(Chunk(title=title or "", content=body))
            continue
        pieces = _pack(body, chunk_chars, overlap)
        total = len(pieces)
        for index, piece in enumerate(pieces, start=1):
            label = title or "正文"
            chunks.append(Chunk(title=f"{label} ({index}/{total})", content=piece))

    if len(chunks) > MAX_CHUNKS:
        raise ValueError(
            f"切分后条目 {len(chunks)} 条，超过上限 {MAX_CHUNKS}；请先拆分文档或调大 chunk_chars"
        )
    return chunks
