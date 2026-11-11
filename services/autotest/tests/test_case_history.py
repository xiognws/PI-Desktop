"""一条用例的历次执行（用例详情抽屉的数据源）。

这里不跑真实执行器：只验证「按 case_id 聚合并按执行时间倒序」这条查询的语义，
以及空历史和 limit 边界不会 500。
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


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def _seed(project_id: str) -> None:
    """三次执行：同一用例 2 次（通过 / 失败），另一次跑别的用例。"""
    server.init_project_db(project_id)
    conn = sqlite3.connect(server.get_project_db(project_id))
    conn.executemany(
        "INSERT INTO executions (id, name, total, passed, failed, status, started_at) "
        "VALUES (?, ?, 1, ?, ?, '已完成', ?)",
        [
            (1, "第一次", 1, 0, "2026-01-01 10:00:00"),
            (2, "第二次", 0, 1, "2026-01-02 10:00:00"),
            (3, "第三次", 1, 0, "2026-01-03 10:00:00"),
        ],
    )
    conn.executemany(
        "INSERT INTO execution_cases (execution_id, case_id, result, duration_ms, error_message) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            (1, "case_a", "通过", 12.5, None),
            (2, "case_a", "失败", 30.0, "AssertionError: 音量没变"),
            (3, "case_b", "通过", 8.0, None),
        ],
    )
    conn.commit()
    conn.close()


def test_history_is_newest_first_and_counts_only_that_case(client):
    project_id = client.post("/api/projects", json={"name": "H1", "type": "api"}).json()["id"]
    _seed(project_id)

    body = client.get(f"/api/projects/{project_id}/cases/case_a/executions").json()
    assert body["case_id"] == "case_a"
    assert (body["total"], body["passed"]) == (2, 1)
    assert [row["execution_id"] for row in body["history"]] == [2, 1]
    assert body["history"][0]["result"] == "失败"
    assert body["history"][0]["error_message"] == "AssertionError: 音量没变"
    assert body["history"][0]["name"] == "第二次"
    assert body["history"][1]["result"] == "通过"


def test_unknown_case_returns_empty_history_instead_of_404(client):
    project_id = client.post("/api/projects", json={"name": "H2", "type": "api"}).json()["id"]
    _seed(project_id)

    body = client.get(f"/api/projects/{project_id}/cases/nope/executions").json()
    assert body == {"case_id": "nope", "total": 0, "passed": 0, "history": []}


def test_limit_is_clamped(client):
    project_id = client.post("/api/projects", json={"name": "H3", "type": "api"}).json()["id"]
    _seed(project_id)

    assert len(client.get(f"/api/projects/{project_id}/cases/case_a/executions?limit=1").json()["history"]) == 1
    # 非法/越界值收敛到 [1,100]，不能 500
    assert client.get(f"/api/projects/{project_id}/cases/case_a/executions?limit=0").status_code == 200
    assert client.get(f"/api/projects/{project_id}/cases/case_a/executions?limit=999").status_code == 200


def test_missing_project_is_404(client):
    assert client.get("/api/projects/proj_does_not_exist/cases/case_a/executions").status_code == 404
