"""契约脚手架：把"还缺被测件接口"的功能点一次性列成可编辑条目。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from autotest.api import server
from autotest.api.server import app


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
def project(client) -> dict:
    body = client.post("/api/projects", json={"name": "契约脚手架", "type": "ECU"}).json()
    return {"id": body["id"], "name": body.get("name", "")}


TEXT = """# CPM 低软需求

## 功能要求
- AFE过压保护：采样电压超过 5.5V 时进入保护并上报故障
- CAN报文监控：超过 500ms 未收到报文时判定通信超时
"""


def _design_run(client, project: dict) -> str:
    """跑一遍解析 + 设计，让项目里有功能点与异常用例。"""
    pid = project["id"]
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "CPM低软开发需求0409.docx", "content": TEXT},
    )
    run_id = client.post(f"/api/projects/{pid}/workflow/prd-parse", json={"text": TEXT}).json()["data"][
        "run_id"
    ]
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id})
    return run_id


def test_scaffold_lists_missing_points_with_raises_shape(client, project):
    _design_run(client, project)
    body = client.get(f"/api/projects/{project['id']}/workflow/dut-contract/scaffold").json()
    data = body["data"]
    assert data["missing_total"] >= 1
    assert data["covered_total"] == 0
    entry = data["entries"][0]
    assert entry["function_point"]
    # 有异常用例的功能点，脚手架直接给出 raises 形状，省得人再猜
    assert entry["expect"]["kind"] == "raises"
    assert "TODO" in entry["factory"]


def test_scaffold_shrinks_after_contract_is_written(client, project):
    _design_run(client, project)
    first = client.get(f"/api/projects/{project['id']}/workflow/dut-contract/scaffold").json()["data"]
    entry = first["entries"][0]
    payload = {
        "driver": "_support/dut.py",
        "imports": ["Dut", "DutError"],
        "entries": [
            {
                "function_point": entry["function_point"],
                "factory": "Dut()",
                "arrange": ["dut.setup()"],
                "observe": "dut.state",
                "expect": {"kind": "raises", "value": "DutError"},
            }
        ],
    }
    written = client.put(f"/api/projects/{project['id']}/workflow/dut-contract", json=payload)
    assert written.status_code == 200

    after = client.get(f"/api/projects/{project['id']}/workflow/dut-contract/scaffold").json()["data"]
    assert after["covered_total"] == 1
    assert after["missing_total"] == first["missing_total"] - 1


def test_script_author_summary_names_the_missing_contract(client, project):
    """摘要要能直接说出"卡在缺契约"，而不是只报生成了多少个骨架。"""
    run_id = _design_run(client, project)
    body = client.post(
        f"/api/projects/{project['id']}/workflow/script-author", json={"run_id": run_id}
    ).json()
    assert body["data"]["contract_missing_total"] >= 1
    assert body["data"]["contract_missing_points"]
    assert "还缺被测件契约" in body["summary"]
