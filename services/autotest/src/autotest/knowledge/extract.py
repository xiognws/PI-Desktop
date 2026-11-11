"""按扩展名把文件读成纯文本。

原则：不猜格式、不静默降级。

* 已知结构化格式（Markdown / 纯文本 / 代码 / CSV / JSON / YAML / XML）按文本读，
  编码依次尝试 utf-8、utf-8-sig、gb18030 —— 车载项目的文档经常是 GBK。
* HTML 用 BeautifulSoup 抽正文，PDF 用 pdfplumber 按页抽，Word 用 python-docx
  抽段落和表格。这三类依赖缺失时报错并给出安装命令，而不是让上传成功却切出空壳。
* 未知扩展名直接拒绝：让用户知道"这个文件吃不了"，而不是把它当文本塞进去。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

MAX_FILE_BYTES = 40 * 1024 * 1024
MAX_CHARS = 3_000_000

TEXT_SUFFIXES = {
    ".md", ".markdown", ".txt", ".log", ".csv", ".tsv", ".json", ".jsonl",
    ".yaml", ".yml", ".xml", ".ini", ".cfg", ".conf", ".properties",
    ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".c", ".h", ".cpp", ".cs",
    ".sql", ".sh", ".ps1", ".bat", ".robot", ".feature",
}
HTML_SUFFIXES = {".html", ".htm", ".xhtml"}
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}  # .doc 是旧二进制格式，python-docx 读不了

SUPPORTED_SUFFIXES = TEXT_SUFFIXES | HTML_SUFFIXES | PDF_SUFFIXES | DOCX_SUFFIXES

_ENCODINGS = ("utf-8", "utf-8-sig", "gb18030")

_PDF_HINT = (
    "缺少 pdfplumber，无法读取 PDF。请在打包机/开发机执行："
    "pip install --target services/autotest/.deps pdfplumber"
)
_DOCX_HINT = (
    "缺少 python-docx，无法读取 .docx。请执行："
    "pip install --target services/autotest/.deps python-docx"
)
_HTML_HINT = (
    "缺少 beautifulsoup4，无法读取 HTML。请执行："
    "pip install --target services/autotest/.deps beautifulsoup4"
)


class UnsupportedDocument(ValueError):
    """扩展名不在可解析集合里，或文件内容无法转成文本。"""


@dataclass(frozen=True)
class ExtractedText:
    text: str
    format: str
    truncated: bool = False


def is_supported(filename: str) -> bool:
    return Path(filename).suffix.lower() in SUPPORTED_SUFFIXES


def _decode(raw: bytes) -> str:
    for encoding in _ENCODINGS:
        try:
            # utf-8 解码会保留 BOM，先把 BOM 去掉再进切分，否则每条切分都以 \ufeff 开头
            return raw.decode(encoding).lstrip("\ufeff")
        except UnicodeDecodeError:
            continue
    raise UnsupportedDocument("文件不是 UTF-8 / GB18030 文本，且格式未识别")


def _clip(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_CHARS:
        return text, False
    keep = text[:MAX_CHARS]
    note = f"\n\n[内容超过 {MAX_CHARS} 字符，已截断]"
    return keep + note, True


def _html_to_text(raw: bytes) -> str:
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - 依赖缺失路径
        raise UnsupportedDocument(_HTML_HINT) from exc

    soup = BeautifulSoup(_decode(raw), "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    blocks = [line.strip() for line in soup.get_text("\n").splitlines()]
    return "\n".join(b for b in blocks if b)


def _pdf_to_text(raw: bytes) -> str:
    try:
        import io

        import pdfplumber
    except ImportError as exc:  # pragma: no cover - 依赖缺失路径
        raise UnsupportedDocument(_PDF_HINT) from exc

    pages: list[str] = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            body = (page.extract_text() or "").strip()
            if body:
                pages.append(f"[第 {number} 页]\n{body}")
    return "\n\n".join(pages)


def _docx_to_text(raw: bytes) -> str:
    try:
        import io

        import docx
    except ImportError as exc:  # pragma: no cover - 依赖缺失路径
        raise UnsupportedDocument(_DOCX_HINT) from exc

    document = docx.Document(io.BytesIO(raw))
    parts: list[str] = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = (paragraph.style.name or "").lower() if paragraph.style else ""
        if style.startswith("heading"):
            level = "".join(ch for ch in style if ch.isdigit()) or "1"
            parts.append("#" * int(level) + " " + text)
        else:
            parts.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                parts.append("| " + " | ".join(cells) + " |")
    return "\n\n".join(parts)


def extract_text(filename: str, raw: bytes) -> ExtractedText:
    """把文件字节读成纯文本，附带格式标签与是否截断。"""
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        supported = ", ".join(sorted(SUPPORTED_SUFFIXES))
        raise UnsupportedDocument(f"不支持的文件类型 {suffix or '(无扩展名)'}；支持：{supported}")
    if len(raw) > MAX_FILE_BYTES:
        raise UnsupportedDocument(
            f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)} MB，请拆分后再导入"
        )

    if suffix in HTML_SUFFIXES:
        text, fmt = _html_to_text(raw), "html"
    elif suffix in PDF_SUFFIXES:
        text, fmt = _pdf_to_text(raw), "pdf"
    elif suffix in DOCX_SUFFIXES:
        text, fmt = _docx_to_text(raw), "docx"
    else:
        text = _decode(raw)
        fmt = "json" if suffix in {".json", ".jsonl"} else "text"
        if fmt == "json":
            try:
                text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                pass  # JSONL 或带注释的配置，按原文本走

    text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise UnsupportedDocument("文件里没有可读文本（可能是扫描版 PDF 或空文档）")
    text, truncated = _clip(text)
    return ExtractedText(text=text, format=fmt, truncated=truncated)
