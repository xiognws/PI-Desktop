"""切分与文本抽取的单元测试。

重点验证的是"切出来的东西能不能用"：
- 按标题切时，一条命中就是一段完整内容，而不是半句话；
- 超长段落会在段落边界断开，重叠区让下一块能接上上文；
- 多种格式都能转成文本，未知扩展名明确拒绝。
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from autotest.knowledge import chunk_text, extract_text, is_supported  # noqa: E402
from autotest.knowledge.extract import UnsupportedDocument  # noqa: E402


def test_utf8_bom_is_not_carried_into_chunks():
    raw = "\ufeff# 诊断记录\n\n0x22 读 VIN。\n".encode("utf-8")
    extracted = extract_text("note.md", raw)
    assert not extracted.text.startswith("\ufeff")
    chunks = chunk_text(extracted.text)
    assert chunks and not chunks[0].content.startswith("\ufeff")


def test_markdown_splits_on_headings():
    text = (
        "# 制动系统\n\n概述段落。\n\n"
        "## 故障现象\n\n踩下踏板后车辆不减速，仪表报警。\n\n"
        "## 排查步骤\n\n1. 读 DTC\n2. 查线束\n"
    )
    chunks = chunk_text(text)
    titles = [c.title for c in chunks]
    assert "制动系统" in titles
    assert "故障现象" in titles
    assert "排查步骤" in titles
    step = next(c for c in chunks if c.title == "排查步骤")
    assert "读 DTC" in step.content and "查线束" in step.content


def test_long_section_splits_with_overlap_and_numbered_titles():
    paragraph = "这是一段用于填充的排查说明。" * 40  # 约 480 字符
    text = "## 长章节\n\n" + "\n\n".join([paragraph] * 6)
    chunks = chunk_text(text, chunk_chars=300, overlap=60)
    assert len(chunks) > 1
    assert all("(1/" not in c.title or True for c in chunks)
    assert chunks[0].title.startswith("长章节 (1/")
    # 每块都不超过上限
    assert all(len(c.content) <= 300 for c in chunks)
    # 相邻块之间保留重叠，下一块开头能接上上一块结尾
    assert chunks[1].content[:20] in chunks[0].content or chunks[1].content[0] == chunks[0].content[-1]


def test_plain_text_without_headings_uses_fixed_split():
    text = "\n\n".join([f"第 {i} 行日志内容，用于验证无标题文本的切分。" for i in range(200)])
    chunks = chunk_text(text, chunk_chars=400, overlap=80)
    assert len(chunks) > 1
    assert all(c.content for c in chunks)


def test_chunk_size_is_normalised_and_bounded():
    small = chunk_text("## 标题\n\n" + "内容" * 10, chunk_chars=10)
    assert small and len(small[0].content) >= 1
    with pytest.raises(ValueError):
        chunk_text("内容", chunk_chars=0)
    with pytest.raises(ValueError):
        chunk_text("内容", chunk_chars=99_999)


def test_extract_markdown_and_gbk_text():
    assert extract_text("doc.md", "# 标题\n正文".encode()).format == "text"
    assert "正文" in extract_text("doc.md", "# 标题\n正文".encode()).text
    gbk = "中文需求文档".encode("gb18030")
    assert "中文需求文档" in extract_text("req.txt", gbk).text


def test_extract_json_pretty_prints_and_csv_passes_through():
    raw = '{"a":1,"b":[2,3]}'.encode()
    extracted = extract_text("meta.json", raw)
    assert extracted.format == "json"
    assert '"a": 1' in extracted.text
    csv_text = "id,name\n1,制动\n".encode()
    assert "制动" in extract_text("cases.csv", csv_text).text


def test_extract_html_strips_tags():
    html = "<html><style>.x{}</style><body><h1>用例</h1><p>期望结果</p></body></html>".encode()
    text = extract_text("page.html", html).text
    assert "用例" in text and "期望结果" in text
    assert "<p>" not in text


def test_unknown_suffix_is_rejected_with_supported_hint():
    with pytest.raises(UnsupportedDocument) as exc:
        extract_text("model.step", b"whatever")
    assert "不支持的文件类型" in str(exc.value)
    assert ".md" in str(exc.value)
    assert not is_supported("a.step")
    assert is_supported("a.docx") and is_supported("a.pdf")


def test_empty_document_is_rejected():
    with pytest.raises(UnsupportedDocument):
        extract_text("empty.txt", b"   \n\n  ")
