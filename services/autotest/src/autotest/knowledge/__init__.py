"""本地项目知识库：文件 → 文本 → 切分 → 条目 → BM25 检索。

设计口径（与工作台整体一致，不要在这里引入新概念）：

* 知识库是**项目级、本地**的。原文随项目走（`<project>/knowledge/<doc_id>/`），
  切分后的条目落项目库 `knowledge_records`，检索只在同一个项目内。
* 不做 embedding、不建向量库。排序用 SQLite FTS5 的 BM25，FTS5 不可用
  或查询太短（trigram 至少要 3 个字符）时退化为 LIKE。
* 切分粒度服务于"人看、Agent 引用"：标题段优先，超长段落再按字数切，
  重叠一小段避免把一句话切两半。
"""

from autotest.knowledge.chunk import chunk_text, Chunk
from autotest.knowledge.extract import (
    MAX_CHARS,
    MAX_FILE_BYTES,
    SUPPORTED_SUFFIXES,
    ExtractedText,
    extract_text,
    is_supported,
)

__all__ = [
    "Chunk",
    "ExtractedText",
    "MAX_CHARS",
    "MAX_FILE_BYTES",
    "SUPPORTED_SUFFIXES",
    "chunk_text",
    "extract_text",
    "is_supported",
]
