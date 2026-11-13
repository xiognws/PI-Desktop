"""用例设计要从知识库里取依据，而不是只把功能点名套进模板。

关键是两件事：
1. 有条款原文时，步骤/预期要写具体阈值（"单体电压置 3.70 V，超过原文 3.65 V"）；
2. 检索不到依据时不能编造，要老实退回模板并把自己标成 ungrounded。
"""

from __future__ import annotations

import json
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
from autotest.workflow import grounding  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def _ingest_knowledge(client: TestClient, project_id: str, content: str, title: str) -> None:
    """走真实入库接口：它会同时写 knowledge_records 与 FTS 索引。"""
    response = client.post(
        f"/api/projects/{project_id}/knowledge/documents/text",
        json={"title": title, "content": content, "module": "", "tags": "项目资料"},
    )
    assert response.status_code == 200, response.text


# --------------------------------------------------------------- 单元 ----

def test_numbers_are_extracted_with_units():
    numbers = grounding.extract_numbers("单体电压 > 3.65V 时进入过压保护，恢复阈值 3.60 V，过流 120A。")
    assert [(item["value"], item["unit"]) for item in numbers] == [
        (3.65, "V"),
        (3.60, "V"),
        (120.0, "A"),
    ]


def test_best_sentence_prefers_the_clause_with_a_threshold():
    content = "见下表。\n电压监控应实时上报。\n单体电压大于 3.65V 时应进入过压保护并置故障码。"
    sentence = grounding.best_sentence(content, "电压监控")
    assert "3.65V" in sentence
    assert "过压保护" in sentence


def test_best_sentence_returns_empty_when_nothing_matches():
    """"没有任何一句提到这个功能点时不能硬凑一句当依据。"""
    assert grounding.best_sentence("见下表。本页无内容。", "放电过流保护") == ""


def test_grounded_cases_carry_the_real_threshold():
    evidence = {
        "过流保护": [
            {
                "doc": "CPM低软开发需求0409.docx",
                "quote": "放电电流大于 120A 时应进入过流保护。",
                "numbers": [{"value": 120.0, "unit": "A", "text": "120A"}],
            }
        ]
    }
    result = case_service.design_cases(
        {"function_points": [{"name": "过流保护"}]}, types=["功能", "异常"], evidence=evidence
    )
    assert result["stats"]["grounding"]["strong"] == 2

    functional = result["cases"][0]
    assert functional["grounding"] == "strong"
    assert "120A" in " ".join(functional["steps"])
    assert "《CPM低软开发需求0409.docx》" in functional["precondition"]

    abnormal = result["cases"][1]
    joined = " ".join(abnormal["steps"])
    # 越界值按原文阈值外扩 10%：120A → 132A
    assert "132" in joined
    assert "超出原文阈值 120A" in joined


def test_cases_without_evidence_stay_templated_and_say_so():
    result = case_service.design_cases({"function_points": [{"name": "冷门功能"}]}, types=["功能"])
    case = result["cases"][0]
    assert case["grounding"] == "none"
    assert case["evidence"] is None
    assert "进入“冷门功能”入口" in case["steps"][0]
    assert result["stats"]["grounding"]["none"] == 1


# ------------------------------------------------------------- 端到端 ----

def _start_run(client: TestClient) -> tuple[str, str]:
    project_id = client.post("/api/projects", json={"name": "依据项目", "type": "ECU"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{project_id}/workflow/prd-parse",
        json={"text": "# 电源模块\n\n## 过流保护\n\n放电电流大于 120A 时应进入过流保护。\n", "module": "电源"},
    ).json()
    return project_id, parsed["data"]["run_id"]


def test_case_design_pulls_evidence_from_the_knowledge_base(client):
    project_id, run_id = _start_run(client)
    _ingest_knowledge(
        client,
        project_id,
        "放电电流大于 120A 时应进入过流保护并置故障码，恢复阈值 110A。",
        "CPM低软开发需求0409.docx",
    )

    designed = client.post(
        f"/api/projects/{project_id}/workflow/case-design", json={"run_id": run_id}
    ).json()
    assert designed["data"]["grounding"]["strong"] >= 1, designed
    assert "有知识库依据" in designed["summary"]

    cases = client.get(f"/api/projects/{project_id}/cases").json()["cases"]
    grounded = [item for item in cases if "120A" in json.dumps(item, ensure_ascii=False)]
    assert grounded, cases

    # evidence 也落进了库（用例页据此显示"依据"）
    conn = sqlite3.connect(server.get_project_db(project_id))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT evidence FROM test_cases WHERE COALESCE(evidence, '') != '' LIMIT 1"
    ).fetchone()
    conn.close()
    assert row is not None
    stored = json.loads(row["evidence"])
    assert stored["grounding"] in {"strong", "weak"}
    assert stored["evidence"]["quote"]


def test_case_design_without_knowledge_reports_no_basis(client):
    project_id, run_id = _start_run(client)
    designed = client.post(
        f"/api/projects/{project_id}/workflow/case-design", json={"run_id": run_id}
    ).json()
    assert designed["data"]["grounding"]["none"] >= 1
    assert designed["data"]["grounding"]["strong"] == 0


def test_figure_caption_is_not_read_as_a_threshold():
    """"Figure 4AFE均衡电路" 里的 4A 不是电流阈值，别把它写进用例。

    同一条切片里往往既有图题又有条款，打分要能选中条款。
    """
    assert grounding.extract_numbers("Figure 4AFE均衡电路") == []
    sentence = grounding.best_sentence("Figure 4AFE均衡电路\n均衡电流应限制在 4A 以内。", "均衡")
    assert "4A 以内" in sentence
