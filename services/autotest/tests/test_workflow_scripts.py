"""脚本生成与日志分析的契约测试（P1 补齐 + P3 的前半步）。

覆盖点：日志分析的确定性形状与大文件截断、生成脚本能被 Python 解析、
脚本必须真正落库落盘（执行器只认 scripts 表）。
"""

from __future__ import annotations

import ast
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from autotest.api import server  # noqa: E402
from autotest.api.server import app  # noqa: E402
from autotest.workflow import analysis as analysis_service  # noqa: E402
from autotest.workflow import scripts as script_service  # noqa: E402

SAMPLE = """# 座舱 HMI

## 功能需求
- 主页应展示导航、音乐、电话三个卡片
- 支持语音唤醒，唤醒词必须可配置
"""

FAILED_LOG = """2026-11-09 10:12:01,002 INFO  boot workspace
2026-11-09 10:12:03,150 ERROR step 2 failed: assert 0 == 1
Traceback (most recent call last):
  File "/svc/tests/case_ab12.py", line 7, in test_case_ab12
    assert response.status_code == 200
AssertionError: assert 500 == 200
"""

CASE = {
    "title": "语音唤醒-主流程",
    "function_point": "支持语音唤醒",
    "case_type": "功能",
    "priority": "高",
    "precondition": "语音服务已启动",
    "steps": ["唤醒设备", "说“打开导航”", "检查导航是否打开"],
    "expected": ["导航被打开", "无报错"],
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def test_analyze_log_finds_error_timeline_and_suspects():
    result = analysis_service.analyze_log(FAILED_LOG, trace_id="t-1", module="座舱")
    assert result["error"]["type"] == "AssertionError"
    assert "assert 500 == 200" in result["error"]["message"]
    assert result["suspects"] == [{"file": "/svc/tests/case_ab12.py", "line": 7, "function": "test_case_ab12"}]
    assert [item["time"] for item in result["timeline"]][:2] == ["2026-11-09 10:12:01,002", "2026-11-09 10:12:03,150"]
    assert any("断言" in item for item in result["suggestions"])
    assert result["stats"]["truncated"] is False
    assert result["stats"]["trace_id"] == "t-1"


def test_analyze_log_is_deterministic_and_survives_empty_input():
    assert analysis_service.analyze_log(FAILED_LOG) == analysis_service.analyze_log(FAILED_LOG)
    empty = analysis_service.analyze_log("")
    assert empty["summary"] == "日志为空"
    assert empty["error"] is None
    assert empty["stats"]["lines"] == 1


def test_analyze_log_truncates_a_20mb_log():
    # 20MB 的噪声日志：只保留尾部，结论仍来自最后那条错误。
    big = ("noise line, nothing to see\n" * 800_000) + "2026-11-09 10:12:03,150 ERROR TimeoutError: gateway timed out\n"
    assert len(big) > 20 * 1024 * 1024
    result = analysis_service.analyze_log(big)
    assert result["stats"]["truncated"] is True
    assert result["error"]["type"] == "TimeoutError"
    assert len(result["timeline"]) <= analysis_service.MAX_TIMELINE


def test_author_script_produces_parsable_pytest_file():
    script = script_service.author_script(CASE)
    ast.parse(script["content"])  # 语法必须正确，否则执行器收集阶段就会失败
    assert script["name"].endswith(".py")
    assert "def test_case_" in script["content"]
    assert "pytest.skip" in script["content"]
    assert "支持语音唤醒" in script["content"]
    assert script["stats"]["steps"] == 3


def test_author_script_rejects_unknown_sdk_and_caps_batch():
    with pytest.raises(ValueError):
        script_service.author_script(CASE, sdk="robotframework")
    batch = script_service.author_scripts([CASE] * 300)
    assert batch["stats"]["total"] == 200


def test_script_author_and_log_analyze_over_http(client, tmp_path):
    project = client.post("/api/projects", json={"name": "S7", "type": "api"}).json()
    project_id = project["id"]

    parsed = client.post(f"/api/projects/{project_id}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}).json()
    run_id = parsed["data"]["run_id"]
    client.post(f"/api/projects/{project_id}/workflow/case-design", json={"run_id": run_id, "types": ["功能"]})

    authored = client.post(f"/api/projects/{project_id}/workflow/script-author", json={"run_id": run_id}).json()
    assert authored["ok"] is True
    assert authored["data"]["script_total"] == 2

    db_path = server.get_project_db(project_id)
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT id, name, filepath FROM scripts").fetchall()
    conn.close()
    assert len(rows) == 2
    for _script_id, _name, filepath in rows:
        assert Path(filepath).is_file()

    analyzed = client.post(
        f"/api/projects/{project_id}/workflow/log-analyze",
        json={"run_id": run_id, "raw_log": FAILED_LOG, "trace_id": "t-2"},
    ).json()
    assert analyzed["data"]["error"]["type"] == "AssertionError"
    assert analyzed["data"]["stats"]["trace_id"] == "t-2"

    rejected = client.post(f"/api/projects/{project_id}/workflow/log-analyze", json={"raw_log": "   "})
    assert rejected.status_code == 400


def test_case_design_lands_in_the_case_table_and_scripts_link_to_it(client):
    """设计的用例必须落进 test_cases：用例页、执行状态回写、脚本关联都读那张表。"""
    project_id = client.post("/api/projects", json={"name": "S8", "type": "api"}).json()["id"]
    run_id = (
        client.post(
            f"/api/projects/{project_id}/workflow/prd-parse",
            json={"text": SAMPLE, "module": "座舱"},
        ).json()["data"]["run_id"]
    )

    designed = client.post(
        f"/api/projects/{project_id}/workflow/case-design",
        json={"run_id": run_id, "types": ["功能"]},
    ).json()
    assert designed["ok"] is True
    case_total = designed["data"]["case_total"]
    assert case_total == 2

    listed = client.get(f"/api/projects/{project_id}/cases").json()
    assert listed["total"] == case_total
    first = listed["cases"][0]
    assert first["module"] == "座舱"
    assert first["type"] == "功能"
    assert "→ 预期" in first["steps"]

    # 同一个标题重新设计只更新、不新增（module + title 幂等）
    client.post(
        f"/api/projects/{project_id}/workflow/case-design",
        json={"run_id": run_id, "types": ["功能"]},
    )
    assert client.get(f"/api/projects/{project_id}/cases").json()["total"] == case_total

    client.post(f"/api/projects/{project_id}/workflow/script-author", json={"run_id": run_id})
    conn = sqlite3.connect(server.get_project_db(project_id))
    linked = [row[0] for row in conn.execute("SELECT case_id FROM scripts").fetchall()]
    case_ids = {row[0] for row in conn.execute("SELECT id FROM test_cases").fetchall()}
    conn.close()
    assert linked, "script-author 应该落下脚本"
    assert all(case_id in case_ids for case_id in linked), linked
