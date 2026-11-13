"""Agent 原生工具链的契约测试（PRD 解析 → 用例 → 评审 → 待确认）。

只测确定性的部分：同一份文档每次切出同样的功能点，用例字段形状固定，
评审能识别不可测/重复，决策能落到同一行并被前端和下一次会话读到。
"""

from __future__ import annotations

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
from autotest.workflow import cases as case_service  # noqa: E402
from autotest.workflow import prd as prd_service  # noqa: E402
from autotest.workflow import review as review_service  # noqa: E402

SAMPLE = """# 深蓝S7 座舱HMI 需求

## 功能需求
- 主页应展示导航、音乐、电话三个卡片
- 支持语音唤醒，唤醒词必须可配置
- 空调面板应支持双区温度独立调节
- 禁止在行车中打开视频应用

## 性能要求
- 主页冷启动响应时间不超过 2 秒

## 依赖与风险
- 依赖 T-BOX 提供车辆状态
- 风险：语音唤醒在噪声环境下识别率待确认
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


def test_parse_prd_splits_function_points():
    result = prd_service.parse_prd(SAMPLE, module="座舱HMI")
    names = [point["name"] for point in result["function_points"]]
    assert len(names) == 4
    assert names[0].startswith("主页应展示导航")
    assert result["function_points"][0]["priority"] == "中"
    # “必须” → 高优先级
    assert result["function_points"][1]["priority"] == "高"
    # 第一行同时被收集为条目，但功能点 id 稳定
    assert result["function_points"][0]["id"].startswith("fp-001-")


def test_parse_prd_collects_non_functional_dependency_risk():
    result = prd_service.parse_prd(SAMPLE)
    assert [item["category"] for item in result["non_functional"]] == ["性能"]
    assert len(result["dependencies"]) == 1
    assert len(result["risks"]) == 1
    assert result["stats"]["function_points"] == 4


def test_parse_prd_is_deterministic_and_bounded():
    first = prd_service.parse_prd("## 功能需求\n- " + "很长" * 200)
    second = prd_service.parse_prd("## 功能需求\n- " + "很长" * 200)
    assert first == second
    assert len(first["function_points"][0]["detail"]) <= 200


def test_parse_prd_empty_document():
    result = prd_service.parse_prd("")
    assert result["function_points"] == []
    assert result["stats"]["chars"] == 0


def test_design_cases_shape_and_limit():
    prd_result = {
        "function_points": [
            {"name": f"功能{i}", "priority": "中"} for i in range(60)
        ]
    }
    # 这两个用例测的是模板生成本身（没有知识库依据），所以显式关掉"跳过无依据"
    result = case_service.design_cases(
        prd_result, ["功能", "异常", "边界"], skip_ungrounded=False
    )
    assert result["stats"]["total"] <= 200
    assert result["stats"]["by_type"] == {"功能": 60, "异常": 60, "边界": 60}
    case = result["cases"][0]
    assert case["title"].endswith("主流程")
    assert len(case["steps"]) == 3
    assert case["steps"][0].startswith("进入")


def test_design_cases_defaults_to_functional_and_negative():
    result = case_service.design_cases(
        {"function_points": [{"name": "登录", "priority": "高"}]}, skip_ungrounded=False
    )
    assert [case["case_type"] for case in result["cases"]] == ["功能", "异常"]


def test_review_flags_duplicates_and_untestable():
    cases = [
        {"title": "登录-主流程", "steps": ["1", "2"], "expected": ["ok"], "priority": "高"},
        {"title": "登录-主流程", "steps": ["1", "2"], "expected": ["ok"], "priority": "高"},
        {"title": "无预期", "steps": ["1", "2"], "expected": [], "priority": "中"},
    ]
    result = review_service.review_cases(cases, module="登录")
    assert result["verdict"] == "needs_fix"
    assert len(result["duplicates"]) == 1
    assert len(result["untestable"]) == 1


def test_api_prd_parse_then_case_design(client):
    project = client.post("/api/projects", json={"name": "座舱"}).json()

    parsed = client.post(
        f"/api/projects/{project['id']}/workflow/prd-parse",
        json={"text": SAMPLE, "module": "座舱HMI"},
    )
    assert parsed.status_code == 200
    body = parsed.json()
    assert body["ok"] is True
    assert body["data"]["function_point_total"] == 4
    run_id = body["data"]["run_id"]

    # 无依据的用例现在不生成，所以先让知识库里有这几条需求原文
    client.post(
        f"/api/projects/{project['id']}/knowledge/documents/text",
        json={
            "title": "深蓝S7 座舱HMI 需求.docx",
            "content": """主页应展示导航、音乐、电话三个卡片。
支持语音唤醒，唤醒词必须可配置。
空调面板应支持双区温度独立调节。
禁止在行车中打开视频应用。""",
        },
    )

    designed = client.post(
        f"/api/projects/{project['id']}/workflow/case-design",
        json={"run_id": run_id, "types": ["功能", "异常"]},
    )
    assert designed.status_code == 200
    assert designed.json()["data"]["case_total"] == 8

    run = client.get(f"/api/projects/{project['id']}/workflow/runs/{run_id}").json()["data"]
    assert run["stage"] == "designed"
    assert [step["tool"] for step in run["steps"]] == [
        "autotest_prd_parse",
        "autotest_case_design",
    ]


def test_api_requires_prd_before_design(client):
    project = client.post("/api/projects", json={"name": "空跑"}).json()
    run = client.post(
        f"/api/projects/{project['id']}/workflow/prd-parse",
        json={"text": "   "},
    )
    assert run.status_code == 400

    missing = client.post(
        f"/api/projects/{project['id']}/workflow/case-design",
        json={"run_id": "wf-missing"},
    )
    assert missing.status_code == 404


def test_api_decision_roundtrip(client):
    project = client.post("/api/projects", json={"name": "审批"}).json()
    parsed = client.post(
        f"/api/projects/{project['id']}/workflow/prd-parse", json={"text": SAMPLE}
    ).json()
    run_id = parsed["data"]["run_id"]

    pending = client.post(
        f"/api/projects/{project['id']}/workflow/runs/{run_id}/pending",
        json={"prompt": "确认 4 个功能点？", "options": ["approve", "reject"]},
    )
    assert pending.status_code == 200
    decision_id = pending.json()["data"]["decision_id"]

    run = client.get(f"/api/projects/{project['id']}/workflow/runs/{run_id}").json()["data"]
    assert run["status"] == "waiting_human"
    assert [item["id"] for item in run["pending"]] == [decision_id]

    # 项目级待办列表：审批页只拉这一个接口
    board = client.get(f"/api/projects/{project['id']}/workflow/pending").json()["data"]
    assert board["total"] == 1
    assert board["decisions"][0]["id"] == decision_id
    assert board["decisions"][0]["run_id"] == run_id
    assert board["decisions"][0]["options"] == ["approve", "reject"]

    decided = client.post(
        f"/api/projects/{project['id']}/workflow/runs/{run_id}/pending/{decision_id}/decide",
        json={"answer": "approve", "note": "去掉 P2"},
    )
    assert decided.status_code == 200

    after = client.get(f"/api/projects/{project['id']}/workflow/runs/{run_id}").json()["data"]
    assert after["status"] == "running"
    assert after["pending"] == []
    # 批完之后待办列表要立刻空掉，否则审批页会一直显示已处理的项
    assert client.get(f"/api/projects/{project['id']}/workflow/pending").json()["data"]["total"] == 0


def test_knowledge_search_matches_tags_and_text(client, tmp_path):
    project = client.post("/api/projects", json={"name": "知识"}).json()
    db_path = server.WORKSPACE / project["id"] / "data.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO knowledge_records (project_id, module, record_type, title, content, tags, source_ref, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (project["id"], "座舱", "bug", "语音唤醒噪声失败", "噪声环境下识别率低", "voice,noise", "wf-1", "2026-11-09"),
    )
    conn.commit()
    conn.close()

    hit = client.get(
        f"/api/projects/{project['id']}/workflow/knowledge/search",
        params={"q": "噪声", "module": "座舱"},
    ).json()
    assert hit["data"]["total"] == 1
    assert hit["data"]["records"][0]["tags"] == ["voice", "noise"]

    miss = client.get(
        f"/api/projects/{project['id']}/workflow/knowledge/search",
        params={"q": "完全不相干"},
    ).json()
    assert miss["data"]["total"] == 0
