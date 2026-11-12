"""项目与需求的生命周期：改名、删除（回收，不是真删）、删单份需求。

删除项目会带走需求/用例/脚本/执行产物/报告，所以这里的断言除了"列表里没了"，
还包括"目录还能在 .trash 里捡回来"和"没有二次确认不许删"。
"""

import json
import sqlite3
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
    return client.post("/api/projects", json={"name": "生命周期", "type": "ECU"}).json()["id"]


def _upload(client, project_id, name="需求.md", content="# 需求\n\n- 打开空调 2 秒内制冷\n"):
    return client.post(
        f"/api/projects/{project_id}/requirements/upload",
        files={"file": (name, content.encode("utf-8"), "text/markdown")},
    )


def test_rename_updates_config_and_list(client, project_id):
    body = client.patch(
        f"/api/projects/{project_id}", json={"name": "改名后", "description": "新描述"}
    ).json()
    assert body["name"] == "改名后"
    assert body["description"] == "新描述"

    listed = client.get("/api/projects").json()["projects"]
    entry = [item for item in listed if item["id"] == project_id][0]
    assert entry["name"] == "改名后"

    on_disk = json.loads((server.WORKSPACE / project_id / "project.json").read_text(encoding="utf-8"))
    assert on_disk["name"] == "改名后"


def test_rename_rejects_empty_name_and_unknown_project(client, project_id):
    assert client.patch(f"/api/projects/{project_id}", json={"name": "   "}).status_code == 400
    assert client.patch("/api/projects/proj_missing", json={"name": "x"}).status_code == 404


def test_delete_requires_the_project_id_as_confirmation(client, project_id):
    assert client.delete(f"/api/projects/{project_id}").status_code == 400
    assert client.delete(f"/api/projects/{project_id}?confirm=wrong").status_code == 400
    # 拒绝之后项目必须还在
    assert client.get("/api/projects").json()["projects"]


def test_delete_moves_the_project_into_trash_instead_of_erasing_it(client, project_id):
    _upload(client, project_id)
    money_path = server.WORKSPACE / project_id / "project.json"
    assert money_path.is_file()

    body = client.delete(f"/api/projects/{project_id}?confirm={project_id}").json()
    trashed = Path(body["trashed_to"])
    assert trashed.is_dir()
    assert ".trash" in trashed.parts
    # 数据没丢：配置文件、需求文件都还在回收目录里
    assert (trashed / "project.json").is_file()
    assert (trashed / "specs" / "需求.md").is_file()
    # 列表里没了
    assert [item["id"] for item in client.get("/api/projects").json()["projects"]] == []
    # 再删一次 = 404（已经不在 workspace）
    assert client.delete(f"/api/projects/{project_id}?confirm={project_id}").status_code == 404


def test_delete_is_refused_while_a_run_is_executing(client, project_id):
    from autotest.executors.service import RUNNING

    RUNNING[f"{project_id}:1"] = object()
    try:
        response = client.delete(f"/api/projects/{project_id}?confirm={project_id}")
        assert response.status_code == 409
        assert "执行在跑" in response.json()["detail"]
    finally:
        RUNNING.pop(f"{project_id}:1", None)


def test_requirement_can_be_deleted_file_and_record(client, project_id):
    assert _upload(client, project_id).status_code == 200
    listed = client.get(f"/api/projects/{project_id}/requirements").json()["requirements"]
    assert [item["filename"] for item in listed] == ["需求.md"]

    body = client.delete(f"/api/projects/{project_id}/requirements/需求.md").json()
    assert body["file_removed"] is True
    assert body["records_removed"] == 1
    assert (server.WORKSPACE / project_id / "specs" / "需求.md").exists() is False

    with sqlite3.connect(server.get_project_db(project_id)) as conn:
        assert conn.execute("SELECT COUNT(*) FROM requirements").fetchone()[0] == 0
    assert client.delete(f"/api/projects/{project_id}/requirements/需求.md").status_code == 404


def test_requirement_delete_rejects_path_traversal(client, project_id):
    outside = server.WORKSPACE / project_id / "secret.txt"
    outside.write_text("不要被删", encoding="utf-8")
    for name in ("..%2Fsecret.txt", "..", "."):
        response = client.delete(f"/api/projects/{project_id}/requirements/{name}")
        assert response.status_code in (400, 404), name
    assert outside.is_file()
