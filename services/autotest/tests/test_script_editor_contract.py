"""脚本编辑器依赖的两个后端契约：静态闸门（/gate）与运行结果（/run）。

编辑器现在会在保存后立刻校验、在运行后展示 status / failure / duration，
所以这两条路径的返回形状属于用户可见契约，值得单独钉住。
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
def script(client, tmp_path):
    project = client.post("/api/projects", json={"name": "编辑器", "type": "api"}).json()
    path = tmp_path / "workspace" / "projects" / project["id"] / "scripts" / "case_x.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("print('hi')\n", encoding="utf-8")
    server.init_project_db(project["id"])
    import sqlite3

    conn = sqlite3.connect(server.get_project_db(project["id"]))
    conn.execute(
        "INSERT INTO scripts (id, name, language, filepath, status) VALUES (?, ?, 'python', ?, '待执行')",
        ("script_t1", "case_x.py", str(path)),
    )
    conn.commit()
    conn.close()
    return project["id"]


def _put(client, project_id, content):
    r = client.put(f"/api/projects/{project_id}/scripts/script_t1/content", json={"content": content})
    assert r.status_code == 200, r.text
    return r.json()


def test_gate_passes_valid_python(client, script):
    _put(client, script, "def test_ok():\n    assert 1 == 1\n")
    body = client.post(f"/api/projects/{script}/scripts/script_t1/gate").json()
    assert body["ok"] is True
    assert body["failures"] == []


def test_gate_blocks_syntax_error_and_empty_content(client, script):
    _put(client, script, "def broken(:\n    pass\n")
    body = client.post(f"/api/projects/{script}/scripts/script_t1/gate").json()
    assert body["ok"] is False
    assert any("Python 语法错误" in item for item in body["failures"])

    _put(client, script, "   \n")
    body = client.post(f"/api/projects/{script}/scripts/script_t1/gate").json()
    assert body["ok"] is False
    assert "脚本内容为空" in body["failures"]


def test_run_reports_status_and_duration(client, script):
    _put(client, script, "def test_ok():\n    assert True\n")
    body = client.post(f"/api/projects/{script}/scripts/script_t1/run").json()
    # 编辑器用这三个字段渲染结果面板，少一个就只能显示一坨 stdout
    assert body["success"] is True
    assert body["status"] == "pass"
    assert body["status_label"] == "通过"
    assert body["duration_ms"] is not None
    assert body["returncode"] == 0


def test_run_marks_failure_with_reason(client, script):
    _put(client, script, "def test_bad():\n    assert False, '音量没有变化'\n")
    body = client.post(f"/api/projects/{script}/scripts/script_t1/run").json()
    assert body["success"] is False
    assert body["status"] in ("fail", "error")
    assert body["status_label"] in ("失败", "异常")
    assert "音量没有变化" in json_dumps(body)
    # failure 的形状两种都允许（执行器给字符串、事件回放给对象），但必须带上原因
    failure = body["failure"]
    reason = failure if isinstance(failure, str) else (failure.get("message") or "")
    assert "音量没有变化" in reason


def json_dumps(value):
    import json

    return json.dumps(value, ensure_ascii=False)
