"""AutoTest 后端 API 契约测试（不依赖 LLM / 网络 / 真实 workspace）。

覆盖范围：
- /api/health：状态 + 版本指纹
- 项目 CRUD：创建 / 列表 / 不存在 / 非法 ID（占位符 :projectId、路径穿越 ../..）→ 404
- 用例 CRUD：在真实创建的项目上增删查改，字段回显一致
- /api/backend/restart：spawn 目标正确（mock，不真起进程）

跑法（项目根目录）：
    .venv\\Scripts\\python -m pytest tests/test_api_contract.py -v
"""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# 让 tests/ 能 import autotest.*（项目根入 sys.path）
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from autotest.api import server  # noqa: E402
from autotest.api.server import app  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """把 workspace 与主库都指到临时目录，起 TestClient（会触发 startup 事件）。"""
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    # 关键：把 DIST 指向不存在目录，阻止 StaticFiles 兜底挂到 "/" 上
    # （仓库里 ui/dist 真实存在，否则未命中路由全被它 404 掉）
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


# ---------- health ----------

def test_health_returns_status_and_version(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert isinstance(body["version"], str) and body["version"]


# ---------- 项目 ----------

def test_create_project_scaffolds_dirs_and_metadata(client):
    r = client.post("/api/projects", json={"name": "契约测试项目", "type": "ECU"})
    assert r.status_code == 200
    body = r.json()
    pid = body["id"]
    assert pid.startswith("proj_")
    assert body["name"] == "契约测试项目"
    assert body["type"] == "ECU"


def test_list_projects_includes_created(client):
    created = client.post("/api/projects", json={"name": "P1"}).json()
    listed = client.get("/api/projects").json()["projects"]
    ids = [p["id"] for p in listed]
    assert created["id"] in ids


def test_missing_project_returns_404(client):
    for ep in (
        "/api/projects/nope/cases",
        "/api/projects/nope/scripts",
        "/api/projects/nope/executions",
        "/api/projects/nope/reports",
        "/api/projects/nope/plans",
    ):
        assert client.get(ep).status_code == 404, ep


@pytest.mark.parametrize("bad_id", [":projectId", "..", "..\\..", "a/b", ""])
def test_invalid_project_id_returns_404_not_500(client, bad_id):
    """2026-10-19 线上 bug 回归：字面占位符/路径穿越不得 500，不得在 workspace 落目录。"""
    r = client.get(f"/api/projects/{bad_id}/cases")
    assert r.status_code == 404, f"bad_id={bad_id!r} → {r.status_code}"
    r2 = client.get(f"/api/projects/{bad_id}/scripts")
    assert r2.status_code == 404
    # workspace 下不得因此产生任何新目录
    leftovers = [p.name for p in server.WORKSPACE.iterdir()] if server.WORKSPACE.exists() else []
    assert all(not n.startswith(":") for n in leftovers)
    assert ".." not in leftovers


# ---------- 用例 CRUD ----------

def _make_project(client) -> str:
    return client.post("/api/projects", json={"name": "用例CRUD"}).json()["id"]


def test_case_crud_roundtrip(client):
    pid = _make_project(client)

    # create
    payload = {
        "name": "TC-001 上电自检",
        "module": "",
        "precondition": "ECU 上电",
        "steps": "1. 读取 DID\n2. 断言",
        "expected": "返回 62",
        "type": "正向",
        "priority": "高",
        "tags": ["DID", "上电"],
    }
    r = client.post(f"/api/projects/{pid}/cases", json=payload)
    assert r.status_code == 200, r.text
    case = r.json()
    cid = case["id"]
    assert cid.startswith("case_")
    assert case["name"] == payload["name"]
    assert case["tags"] == payload["tags"]

    # list
    listed = client.get(f"/api/projects/{pid}/cases").json()
    assert listed["total"] == 1
    assert listed["cases"][0]["id"] == cid

    # read
    got = client.get(f"/api/projects/{pid}/cases/{cid}").json()
    assert got["id"] == cid
    assert got["precondition"] == "ECU 上电"

    # update
    upd = dict(got)
    upd["status"] = "通过"
    upd["name"] = "TC-001 上电自检(v2)"
    ru = client.put(f"/api/projects/{pid}/cases/{cid}", json=upd)
    assert ru.status_code == 200, ru.text
    assert ru.json()["status"] == "通过"

    # delete
    rd = client.delete(f"/api/projects/{pid}/cases/{cid}")
    assert rd.status_code == 200
    assert client.get(f"/api/projects/{pid}/cases").json()["total"] == 0


def test_get_nonexistent_case_returns_404(client):
    pid = _make_project(client)
    assert client.get(f"/api/projects/{pid}/cases/case_00000000").status_code == 404


# ---------- backend restart ----------

def test_backend_restart_spawns_run_backend_bat(client, monkeypatch):
    monkeypatch.setattr(server.os, "name", "nt")
    spawned = {}

    class _P:
        pid = 4242

    def _fake_popen(cmd, **kw):
        spawned["cmd"] = cmd
        spawned["kw"] = kw
        return _P()

    monkeypatch.setattr(server.subprocess, "Popen", _fake_popen)
    r = client.post("/api/backend/restart")
    assert r.status_code == 200, r.text
    assert r.json()["pid"] == 4242
    assert "run-backend.bat" in " ".join(spawned["cmd"])
    assert spawned["kw"].get("creationflags")  # 脱离控制台标志位
