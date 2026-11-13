"""真实 Word 文档的需求解析契约。

需求文档几乎都是 .docx：它是 ZIP 容器，直接按文本解码只会得到一段乱码，
于是 ``prd-parse`` 曾经恒定返回「解析出 0 个功能点」——链路看起来通了，
实际上每个项目都是空的。这里用一份带标题样式、带目录项的 docx 锁住这条路径。
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import docx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from autotest.api import server  # noqa: E402
from autotest.api.server import app  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def project_id(client):
    return client.post("/api/projects", json={"name": "电源项目", "type": "ECU"}).json()["id"]


def _docx_bytes() -> bytes:
    """一份最小但形状真实的 PRD：目录页 + 两级标题 + 条款列表 + 表格。"""
    document = docx.Document()

    toc_entry = document.add_paragraph("1.2.1\t电源模块\t5")
    from docx.enum.style import WD_STYLE_TYPE

    try:
        toc_style = document.styles["TOC 3"]
    except KeyError:  # 默认模板没有 TOC 样式，真实 PRD 里是 Word 自动生成的
        toc_style = document.styles.add_style("TOC 3", WD_STYLE_TYPE.PARAGRAPH)
    toc_entry.style = toc_style

    document.add_heading("1 功能要求及技术指标", level=1)
    document.add_heading("1.2.1 电源模块", level=2)
    document.add_paragraph("系统应支持 12V/24V 双电压输入。")
    document.add_paragraph("电源模块必须在上电后 200ms 内完成自检。")
    document.add_heading("1.2.2 MCU 模块", level=2)
    listed = document.add_paragraph("支持 CANFD 收发，波特率可配置")
    listed.style = document.styles["List Bullet"]

    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "指标"
    table.cell(0, 1).text = "要求"
    table.cell(1, 0).text = "静态电流"
    table.cell(1, 1).text = "应小于 100uA"

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


@pytest.fixture()
def uploaded_docx(client, project_id):
    response = client.post(
        f"/api/projects/{project_id}/requirements/upload",
        files={
            "file": (
                "电源模块需求.docx",
                _docx_bytes(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert response.status_code == 200
    return "电源模块需求.docx"


def test_prd_parse_reads_a_real_docx_instead_of_decoding_the_zip(client, project_id, uploaded_docx):
    """上传 .docx 之后 prd-parse 必须真解析出功能点，而不是 0。"""
    response = client.post(
        f"/api/projects/{project_id}/workflow/prd-parse",
        json={"requirement_ref": uploaded_docx, "module": "电源"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    data = body["data"]

    assert data["function_point_total"] > 0, body
    names = " ".join(str(item.get("name", "")) for item in data["function_points"])
    assert "电源模块" in names or "MCU" in names, names
    # 目录页是标题副本，不该被当成独立小节再切一遍
    assert "\t5" not in names
    assert data["stats"]["sections"] >= 3


def test_requirement_text_is_readable_for_docx(client, project_id, uploaded_docx):
    """底层的文本读取也必须走抽取器：ZIP 魔数 'PK' 不能出现在结果里。"""
    from autotest.knowledge import extract

    raw = _docx_bytes()
    extracted = extract.extract_text(uploaded_docx, raw)
    assert extracted.format == "docx"
    assert "电源模块" in extracted.text
    assert not extracted.text.startswith("PK")


def test_xlsx_sheet_becomes_rows_of_text():
    """Excel 规格表也要能读：一张表一节、一行一条。"""
    from autotest.knowledge import extract

    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "指标"
    sheet.append(["指标", "要求"])
    sheet.append(["静态电流", "应小于 100uA"])
    sheet.append([None, None])
    sheet.append(["唤醒时间", "必须小于 200ms"])
    buffer = io.BytesIO()
    workbook.save(buffer)

    extracted = extract.extract_text("指标表.xlsx", buffer.getvalue())
    assert extracted.format == "xlsx"
    assert "# 指标" in extracted.text
    assert "| 静态电流 | 应小于 100uA |" in extracted.text
    assert "| 唤醒时间 | 必须小于 200ms |" in extracted.text
