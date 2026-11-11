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


# ---------- 用例执行（用例 → 脚本） ----------

def _make_case(client, pid: str, name: str = "TC-100 用例执行") -> str:
    r = client.post(f"/api/projects/{pid}/cases", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_run_case_without_script_is_409(client):
    pid = _make_project(client)
    cid = _make_case(client, pid)
    r = client.post(f"/api/projects/{pid}/cases/{cid}/run")
    assert r.status_code == 409
    assert "脚本" in r.json()["detail"]


def test_run_case_unknown_case_is_404(client):
    pid = _make_project(client)
    r = client.post(f"/api/projects/{pid}/cases/case_00000000/run")
    assert r.status_code == 404


def test_run_case_executes_its_scripts_and_writes_case_status(client):
    """用例「执行」按钮的后端：跑关联脚本，并把结果回写到用例状态。

    脚本用 python 语言、内容只打印一行，走真实执行器（不 mock），
    这样事件流、executions 行和 test_cases.status 的回写都被覆盖。
    """
    pid = _make_project(client)
    cid = _make_case(client, pid)
    r = client.post(
        f"/api/projects/{pid}/scripts",
        json={
            "name": "case_run.py",
            "language": "python",
            "case_id": cid,
            "content": "print('case run ok')\n",
        },
    )
    assert r.status_code == 200, r.text

    run = client.post(f"/api/projects/{pid}/cases/{cid}/run")
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["case_id"] == cid
    assert len(body["runs"]) == 1

    cases = client.get(f"/api/projects/{pid}/cases").json()["cases"]
    assert cases[0]["status"] in ("通过", "失败", "异常", "已取消")

    executions = client.get(f"/api/projects/{pid}/executions").json()["executions"]
    assert len(executions) == 1


def test_deleting_a_case_unlinks_its_scripts(client):
    pid = _make_project(client)
    cid = _make_case(client, pid)
    client.post(
        f"/api/projects/{pid}/scripts",
        json={"name": "orphan.py", "language": "python", "case_id": cid, "content": ""},
    )
    assert client.delete(f"/api/projects/{pid}/cases/{cid}").status_code == 200

    scripts = client.get(f"/api/projects/{pid}/scripts").json()["scripts"]
    assert len(scripts) == 1, "脚本是用户资产，删用例不能删脚本"
    assert scripts[0]["case_id"] == ""


def test_case_stats_counts_live_rows_not_stale_project_json(client):
    """首页统计读的是项目库现算值，不是 project.json 里那个永远为 0 的字段。"""
    pid = _make_project(client)
    assert client.get(f"/api/projects/{pid}/case-stats").json() == {
        "case_count": 0,
        "execution_count": 0,
    }

    _make_case(client, pid)
    _make_case(client, pid)
    stats = client.get(f"/api/projects/{pid}/case-stats").json()
    assert stats["case_count"] == 2
    assert client.get(f"/api/projects/{pid}/case-stats").status_code == 200


# ---------- 平台信息 / 设置 ----------

def test_platform_info_reports_runtime_facts(client):
    """设置页读的就是这个：解释器、workspace、端口、MCP 登记。"""
    body = client.get("/api/platform").json()
    assert body["healthy"] is True
    assert body["version"]
    assert body["workspace"]
    assert body["python"]
    assert isinstance(body["backend_port"], int)
    assert [s["id"] for s in body["mcp_servers"]] == ["mcp_can", "mcp_hmi", "mcp_logger"]
    assert [a["id"] for a in body["agents"]] == ["analyze", "design", "author"]


def test_settings_update_persists_workspace_for_next_start(client, tmp_path, monkeypatch):
    """保存不是就地生效：写进配置文件，由下次启动读取。

    就地改运行中的 WORKSPACE 会让正在跑的执行与新项目指向两个目录。
    """
    settings_file = tmp_path / "platform-settings.json"
    monkeypatch.setattr(server, "SETTINGS_FILE", settings_file)

    target = tmp_path / "elsewhere" / "projects"
    r = client.put("/api/settings", json={"workspace": str(target)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pendingWorkspace"] == str(target)
    # 运行中的 WORKSPACE 不变
    assert body["workspace"] == str(server.WORKSPACE)

    saved = json.loads(settings_file.read_text(encoding="utf-8"))
    assert saved["workspace"] == str(target)


def test_settings_rejects_empty_workspace(client, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "SETTINGS_FILE", tmp_path / "s.json")
    r = client.put("/api/settings", json={"workspace": "   "})
    assert r.status_code == 400


def test_load_platform_settings_never_overrides_the_host_env(monkeypatch, tmp_path):
    """插件宿主传的 AUTOTEST_WORKSPACE 是权威，配置文件不能覆盖它。"""
    settings_file = tmp_path / "platform-settings.json"
    settings_file.write_text(json.dumps({"workspace": str(tmp_path / "from-file")}), encoding="utf-8")
    monkeypatch.setattr(server, "SETTINGS_FILE", settings_file)
    monkeypatch.setenv("AUTOTEST_WORKSPACE", str(tmp_path / "from-env"))

    original = server.WORKSPACE
    server.load_platform_settings()
    try:
        assert server.WORKSPACE == original
        assert server.PENDING_WORKSPACE == str(tmp_path / "from-file")
    finally:
        server.WORKSPACE = original
        server.PENDING_WORKSPACE = ""




# ---------- backend restart ----------

def test_current_port_prefers_the_command_line_over_the_env_default(monkeypatch):
    monkeypatch.setattr(
        server.sys,
        "argv",
        ["uvicorn", "autotest.api.server:app", "--host", "127.0.0.1", "--port", "4019"],
    )
    assert server._current_port() == 4019


def test_current_port_falls_back_to_the_env_default(monkeypatch):
    monkeypatch.setattr(server.sys, "argv", ["pytest", "tests", "-q"])
    assert server._current_port() == server.PORT


def test_backend_restart_spawns_the_same_interpreter(client, monkeypatch):
    monkeypatch.setattr(server.os, "name", "nt")
    monkeypatch.setattr(server, "_port_open", lambda port: False)
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
    assert spawned["cmd"][0] == sys.executable
    assert "uvicorn" in spawned["cmd"]
    assert spawned["kw"].get("creationflags")  # 脱离控制台标志位


def test_backend_restart_is_idempotent_when_the_port_is_listening(client, monkeypatch):
    monkeypatch.setattr(server, "_port_open", lambda port: True)
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: calls.append(a))
    r = client.post("/api/backend/restart")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "already-running"
    assert calls == []
