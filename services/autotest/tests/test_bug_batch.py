"""缺陷单批量流转（缺陷页多选后一次改多张）。

断言的是「逐条处理、分别回报」这条语义：一张不存在的单不该让整批回滚，
跨项目的单也不能被顺手改掉。
"""

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
from autotest.workflow import store  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def _project(client, name: str) -> str:
    return client.post("/api/projects", json={"name": name, "type": "ECU"}).json()["id"]


def _seed_bug(project_id: str, run_id: str, bug_id: str, status: str = "open") -> None:
    """直接把 run / bug / 出现记录写进项目库：批量接口只依赖这三张表。"""
    server.init_project_db(project_id)
    conn = sqlite3.connect(server.get_project_db(project_id))
    store.ensure_workflow_tables(conn)
    conn.execute(
        "INSERT OR IGNORE INTO workflow_runs (id, project_id, module, stage, status, created_at, updated_at)"
        " VALUES (?, ?, '座舱', 'reported', 'done', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
        (run_id, project_id),
    )
    conn.execute(
        "INSERT OR REPLACE INTO bugs (id, run_id, script_name, title, status, severity, created_at)"
        " VALUES (?, ?, 'case_x.py', ?, ?, 'major', '2026-01-01 00:00:00')",
        (bug_id, run_id, f"缺陷 {bug_id}", status),
    )
    conn.execute(
        "INSERT OR IGNORE INTO bug_occurrences (bug_id, run_id, execution_id) VALUES (?, ?, 0)",
        (bug_id, run_id),
    )
    conn.commit()
    conn.close()


def _status_of(project_id: str, bug_id: str) -> str:
    conn = sqlite3.connect(server.get_project_db(project_id))
    row = conn.execute("SELECT status FROM bugs WHERE id = ?", (bug_id,)).fetchone()
    conn.close()
    return row[0] if row else ""


def test_batch_updates_every_selected_bug(client):
    pid = _project(client, "批量A")
    for index in (1, 2):
        _seed_bug(pid, f"wf-{index}", f"bug-{index}")

    body = client.post(
        f"/api/projects/{pid}/workflow/bugs/status",
        json={"ids": ["bug-1", "bug-2"], "status": "verified"},
    ).json()
    assert body["data"]["updated"] == ["bug-1", "bug-2"]
    assert body["data"]["failed"] == []
    assert _status_of(pid, "bug-1") == "verified"
    assert _status_of(pid, "bug-2") == "verified"


def test_batch_reports_missing_and_foreign_bugs_without_rolling_back(client):
    owner = _project(client, "批量B")
    other = _project(client, "别人的项目")
    _seed_bug(owner, "wf-own", "bug-own")
    _seed_bug(other, "wf-foreign", "bug-foreign")

    body = client.post(
        f"/api/projects/{owner}/workflow/bugs/status",
        json={"ids": ["bug-own", "bug-foreign", "bug-missing"], "status": "wontfix"},
    ).json()
    assert body["data"]["updated"] == ["bug-own"]
    reasons = {item["id"]: item["reason"] for item in body["data"]["failed"]}
    assert set(reasons) == {"bug-foreign", "bug-missing"}
    # 同批里成功的那张仍然生效，跨项目的那张没被动过
    assert _status_of(owner, "bug-own") == "wontfix"
    assert _status_of(other, "bug-foreign") == "open"
    assert "2 张失败" in body["summary"]


def test_batch_rejects_bad_input(client):
    pid = _project(client, "批量C")
    _seed_bug(pid, "wf-c", "bug-c")

    assert client.post(
        f"/api/projects/{pid}/workflow/bugs/status", json={"ids": [], "status": "fixed"}
    ).status_code == 400
    assert client.post(
        f"/api/projects/{pid}/workflow/bugs/status", json={"ids": ["bug-c"], "status": "nope"}
    ).status_code == 200  # 非法状态走逐条失败，不整批 500
    body = client.post(
        f"/api/projects/{pid}/workflow/bugs/status", json={"ids": ["bug-c"], "status": "nope"}
    ).json()
    assert body["data"]["updated"] == []
    assert body["data"]["failed"][0]["reason"].startswith("非法缺陷状态")
    assert _status_of(pid, "bug-c") == "open"
