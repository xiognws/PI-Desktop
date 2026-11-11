"""知识库导入/检索/删除的 API 契约测试。

跑在临时 workspace 上，不碰真实项目数据。
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

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
    body = client.post("/api/projects", json={"name": "知识库项目", "type": "ECU"}).json()
    return body["id"]


DOC = """# UDS 诊断

## 0x22 读数据

用 0x22 服务读取 ECU 的 VIN 与软件版本号，响应首字节是 data identifier。

## 0x19 读 DTC

0x19 服务读取故障码，子功能 0x02 返回状态掩码与 DTC 列表。遇到 DTC 泛滥时先看
通信中断计数，再排查线束与供电。
"""


def _upload(client, project_id, name, content, module="uds", tags="诊断,排查"):
    return client.post(
        f"/api/projects/{project_id}/knowledge/documents",
        files={"file": (name, content.encode("utf-8"), "text/markdown")},
        data={"module": module, "tags": tags, "chunk_chars": "600"},
    )


def test_upload_splits_markdown_and_lists_document(client, project_id):
    r = _upload(client, project_id, "uds.md", DOC)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["data"]["chunks"] >= 2
    doc_id = body["data"]["doc_id"]
    assert doc_id.startswith("doc-")
    assert (server.WORKSPACE / project_id / "knowledge" / doc_id / "uds.md").is_file()

    listed = client.get(f"/api/projects/{project_id}/knowledge/documents").json()
    docs = listed["data"]["documents"]
    assert len(docs) == 1
    assert docs[0]["doc_id"] == doc_id
    assert docs[0]["chunk_count"] == body["data"]["chunks"]
    assert docs[0]["module"] == "uds"


def test_search_uses_headings_as_titles_and_bm25_ranking(client, project_id):
    _upload(client, project_id, "uds.md", DOC)
    r = client.get(
        f"/api/projects/{project_id}/workflow/knowledge/search",
        params={"q": "读 DTC"},
    )
    assert r.status_code == 200, r.text
    records = r.json()["data"]["records"]
    assert records, "BM25/trigram 应该命中标题或正文"
    assert any("DTC" in (rec["title"] + rec["excerpt"]) for rec in records)
    assert "score" in records[0]
    # 来源可回溯到文档与条目序号
    assert records[0]["source_ref"].startswith("doc:doc-")


def test_short_chinese_query_falls_back_to_like(client, project_id):
    _upload(client, project_id, "uds.md", DOC)
    r = client.get(
        f"/api/projects/{project_id}/workflow/knowledge/search",
        params={"q": "线束"},  # 2 个字，trigram 无能为力
    )
    assert r.status_code == 200
    records = r.json()["data"]["records"]
    assert records and any("线束" in (rec["title"] + rec["excerpt"]) for rec in records)


def test_text_document_can_be_imported_without_a_file(client, project_id):
    r = client.post(
        f"/api/projects/{project_id}/knowledge/documents/text",
        json={
            "title": "踩坑记录：DTC 泛滥",
            "content": "现象：0x19 返回大量 DTC。\n\n结论：先查通信中断计数，再看供电。",
            "module": "uds",
            "tags": "经验",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["chunks"] >= 1
    docs = client.get(f"/api/projects/{project_id}/knowledge/documents").json()["data"]["documents"]
    assert docs[0]["format"] == "text"


def test_delete_removes_chunks_and_file(client, project_id):
    body = _upload(client, project_id, "uds.md", DOC).json()
    doc_id = body["data"]["doc_id"]
    total = client.get(
        f"/api/projects/{project_id}/workflow/knowledge/search", params={"q": ""}
    ).json()["data"]["total"]
    assert total >= 2

    r = client.delete(f"/api/projects/{project_id}/knowledge/documents/{doc_id}")
    assert r.status_code == 200
    assert r.json()["data"]["deleted_chunks"] >= 2

    after = client.get(
        f"/api/projects/{project_id}/workflow/knowledge/search", params={"q": ""}
    ).json()["data"]["total"]
    assert after == 0
    assert not (server.WORKSPACE / project_id / "knowledge" / doc_id).exists()


def test_unsupported_file_is_rejected(client, project_id):
    r = client.post(
        f"/api/projects/{project_id}/knowledge/documents",
        files={"file": ("model.step", b"ISO-10303-21;", "application/octet-stream")},
    )
    assert r.status_code == 400
    assert "不支持的文件类型" in r.json()["detail"]


def test_same_bytes_are_not_imported_twice(client, project_id):
    first = _upload(client, project_id, "uds.md", DOC).json()
    second = _upload(client, project_id, "uds-copy.md", DOC).json()
    assert second["data"]["skipped"] is True
    assert second["data"]["doc_id"] == first["data"]["doc_id"]
    docs = client.get(f"/api/projects/{project_id}/knowledge/documents").json()["data"]["documents"]
    assert len(docs) == 1


def test_text_document_dedupes_by_content(client, project_id):
    body = {"title": "经验一", "content": "同样的内容", "module": "uds", "tags": "x"}
    first = client.post(f"/api/projects/{project_id}/knowledge/documents/text", json=body).json()
    second = client.post(
        f"/api/projects/{project_id}/knowledge/documents/text",
        json={**body, "title": "经验一（改名）"},
    ).json()
    assert second["data"]["skipped"] is True
    assert second["data"]["doc_id"] == first["data"]["doc_id"]


def test_batch_upload_mixed_formats_keeps_going_on_failure(client, project_id):
    json_body = ('{"module": "uds", "note": "' + "诊断响应超时" * 40 + '"}').encode()
    files = [
        ("files", ("a.md", DOC.encode(), "text/markdown")),
        ("files", ("b.json", json_body, "application/json")),
        ("files", ("c.step", b"ISO-10303-21;", "application/octet-stream")),
    ]
    r = client.post(
        f"/api/projects/{project_id}/knowledge/documents/batch",
        files=files,
        data={"module": "spec", "tags": "batch"},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [item["filename"] for item in data["imported"]] == ["a.md", "b.json"]
    assert [item["filename"] for item in data["failed"]] == ["c.step"]

    again = client.post(
        f"/api/projects/{project_id}/knowledge/documents/batch",
        files=files[:2],
        data={"module": "spec"},
    ).json()["data"]
    assert again["imported"] == []
    assert sorted(item["filename"] for item in again["skipped"]) == ["a.md", "b.json"]


def test_batch_upload_rejects_empty_request(client, project_id):
    r = client.post(f"/api/projects/{project_id}/knowledge/documents/batch", data={"module": "x"})
    assert r.status_code == 422


def test_import_from_specs_indexes_uploaded_requirements(client, project_id):
    # 走真实的需求上传路由，模拟"PRD 已经上传到 specs/"
    r = client.post(
        f"/api/projects/{project_id}/requirements/upload",
        files={"file": ("prd.md", DOC.encode(), "text/markdown")},
    )
    assert r.status_code == 200, r.text

    imported = client.post(
        f"/api/projects/{project_id}/knowledge/documents/from-specs",
        json={"module": "spec", "tags": "prd"},
    ).json()
    assert imported["ok"] is True
    assert len(imported["data"]["imported"]) == 1
    assert imported["data"]["imported"][0]["filename"] == "prd.md"

    again = client.post(
        f"/api/projects/{project_id}/knowledge/documents/from-specs", json={}
    ).json()
    assert again["data"]["imported"] == []
    assert again["data"]["skipped"] == ["prd.md"]


def test_chunk_preview_lists_split_chunks(client, project_id):
    doc_id = _upload(client, project_id, "uds.md", DOC).json()["data"]["doc_id"]

    r = client.get(f"/api/projects/{project_id}/knowledge/documents/{doc_id}/chunks")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["document"]["filename"] == "uds.md"
    assert data["total"] >= 2
    assert data["chunks"][0]["source_ref"] == f"doc:{doc_id}#1"
    assert data["chunks"][0]["title"]
    assert data["chunks"][0]["chars"] > 0
    assert data["chunks"][0]["excerpt"]

    # 分页不能越界也不能重复
    page = client.get(
        f"/api/projects/{project_id}/knowledge/documents/{doc_id}/chunks",
        params={"limit": 1, "offset": 1},
    ).json()["data"]
    assert len(page["chunks"]) == 1
    assert page["chunks"][0]["source_ref"] == f"doc:{doc_id}#2"


def test_chunk_preview_unknown_document_is_404(client, project_id):
    r = client.get(f"/api/projects/{project_id}/knowledge/documents/doc-missing/chunks")
    assert r.status_code == 404
    assert "文档不存在" in r.json()["detail"]
