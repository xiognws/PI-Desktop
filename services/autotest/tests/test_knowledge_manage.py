"""知识库元数据管理：模块统计 / 改模块标签 / 批量删除。

这些操作只动元数据与文档行，所以能在临时 workspace 上用真实导入的文档验证。
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

DOC = """# 座舱语音

## 唤醒词

说“你好小智”唤醒，1 秒内应有应答，误唤醒率低于千分之一。

## 连续对话

唤醒后 30 秒内可直接下达指令，超时需重新唤醒。
"""


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
    return client.post("/api/projects", json={"name": "知识管理", "type": "HMI"}).json()["id"]


def _upload(client, project_id, name, module="", tags="", content=DOC):
    r = client.post(
        f"/api/projects/{project_id}/knowledge/documents",
        files={"file": (name, content.encode("utf-8"), "text/markdown")},
        data={"module": module, "tags": tags, "chunk_chars": "600"},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["doc_id"]


def _unique(name, module="", tags=""):
    """内容唯一：库里按 sha256 去重，重复内容会返回已有 doc_id 而不是新建。"""
    return f"{DOC}\n\n<!-- {name} -->\n"


def test_stats_group_by_module_and_count_ungrouped(client, project_id):
    _upload(client, project_id, "a.md", module="座舱", content=_unique("a"))
    _upload(client, project_id, "b.md", module="座舱", content=_unique("b"))
    _upload(client, project_id, "c.md", content=_unique("c"))

    body = client.get(f"/api/projects/{project_id}/knowledge/documents/stats").json()["data"]
    modules = {item["module"]: item for item in body["modules"]}
    assert set(modules) == {"座舱", "未分组"}
    assert modules["座舱"]["docs"] == 2
    assert modules["未分组"]["docs"] == 1
    # 总数与分组求和一致，切分数不丢
    assert body["total"]["docs"] == 3
    assert body["total"]["chunks"] == sum(item["chunks"] for item in body["modules"])
    assert body["total"]["chunks"] > 0


def test_patch_updates_module_and_tags_without_touching_chunks(client, project_id):
    doc_id = _upload(client, project_id, "wake.md", module="旧模块", tags="a,b")
    chunks_before = client.get(
        f"/api/projects/{project_id}/knowledge/documents/{doc_id}/chunks"
    ).json()["data"]["total"]

    body = client.patch(
        f"/api/projects/{project_id}/knowledge/documents/{doc_id}",
        json={"module": "座舱", "tags": "语音,唤醒"},
    ).json()
    assert body["data"]["document"]["module"] == "座舱"
    assert body["data"]["document"]["tags"] == "语音,唤醒"

    chunks_after = client.get(
        f"/api/projects/{project_id}/knowledge/documents/{doc_id}/chunks"
    ).json()["data"]["total"]
    assert chunks_after == chunks_before

    # 只传一个字段时另一个不被清空（None == 不改）
    client.patch(f"/api/projects/{project_id}/knowledge/documents/{doc_id}", json={"tags": ""})
    doc = client.get(f"/api/projects/{project_id}/knowledge/documents").json()["data"]["documents"][0]
    assert doc["module"] == "座舱"
    assert doc["tags"] == ""


def test_patch_unknown_document_is_404(client, project_id):
    r = client.patch(
        f"/api/projects/{project_id}/knowledge/documents/doc-missing", json={"module": "x"}
    )
    assert r.status_code == 404


def test_same_bytes_reuse_the_existing_document(client, project_id):
    first = _upload(client, project_id, "same.md", module="座舱")
    again = client.post(
        f"/api/projects/{project_id}/knowledge/documents",
        files={"file": ("same-again.md", DOC.encode("utf-8"), "text/markdown")},
        data={"module": "座舱", "chunk_chars": "600"},
    ).json()["data"]
    assert again["skipped"] is True
    assert again["doc_id"] == first
    docs = client.get(f"/api/projects/{project_id}/knowledge/documents").json()["data"]["documents"]
    assert len(docs) == 1


def test_batch_delete_reports_deleted_and_missing(client, project_id):
    keep = _upload(client, project_id, "keep.md", module="座舱", content=_unique("keep"))
    a = _upload(client, project_id, "a.md", module="座舱", content=_unique("a"))
    b = _upload(client, project_id, "b.md", content=_unique("b"))

    body = client.post(
        f"/api/projects/{project_id}/knowledge/documents/delete-batch",
        json={"ids": [a, b, "doc-missing"]},
    ).json()
    assert body["ok"] is True
    assert sorted(body["data"]["deleted"]) == sorted([a, b])
    assert [item["doc_id"] for item in body["data"]["failed"]] == ["doc-missing"]
    assert body["data"]["deleted_chunks"] > 0

    remaining = client.get(f"/api/projects/{project_id}/knowledge/documents").json()["data"]
    assert [doc["doc_id"] for doc in remaining["documents"]] == [keep]

    # 检索不应再命中被删文档的内容
    hits = client.get(
        f"/api/projects/{project_id}/knowledge/search", params={"query": "误唤醒率"}
    ).json()
    srcs = [hit["source_ref"] for hit in (hits.get("data") or {}).get("hits", [])]
    assert all(a not in src for src in srcs)
