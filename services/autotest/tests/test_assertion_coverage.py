"""断言覆盖：界面上必须能分清"真验过"和"只是骨架"。

骨架脚本跑起来是绿的（skip 被计通过），所以「34/34 通过」在全是骨架时同样成立。
这条不变量一旦丢失，报告和界面就会一起说谎——因此断言状态要从产物本身判出来
（`workflow.script_state`），并在接口上逐条给出、在统计上汇总。
"""

from __future__ import annotations

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
from autotest.workflow import report as report_service  # noqa: E402
from autotest.workflow import script_state  # noqa: E402
from autotest.workflow.routes import _assertion_counts  # noqa: E402

SAMPLE = """# 座舱 HMI

## 主页卡片
主页应展示导航、音乐、电话三个卡片。
"""

KNOWLEDGE = """## 主页卡片
主页卡片应展示导航、音乐、电话三个卡片。"""


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


# ---------- 分类器 ----------


def test_skeleton_and_asserted_are_distinguished() -> None:
    skeleton = 'def test_x():\n    import pytest\n    pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")\n'
    asserted = 'def test_x():\n    assert 3.60 < 3.65\n    assert result["faults"]["ov"] is True\n'

    assert script_state.classify(skeleton)["state"] == "skeleton"
    assert script_state.classify(skeleton)["asserts"] == 0

    verdict = script_state.classify(asserted)
    assert verdict["state"] == "asserted"
    assert verdict["asserts"] == 2


def test_tautological_assertions_do_not_count() -> None:
    """`assert True` 是伪装通过：不能因为写了它就把脚本算成"真断言"。"""
    text = "def test_x():\n    assert True\n    assert 1 == 1\n"
    verdict = script_state.classify(text)
    assert verdict["asserts"] == 0
    assert verdict["state"] == "skeleton"


def test_completed_script_that_kept_a_skip_still_counts_as_skeleton() -> None:
    """留着占位跳过就说明还有用例没落地，不能算验过。"""
    text = 'def test_x():\n    import pytest\n    pytest.skip("骨架未实现")\n    assert 1 == 1\n'
    assert script_state.classify(text)["state"] == "skeleton"


def test_missing_file_is_reported_not_guessed() -> None:
    assert script_state.classify("")["state"] == "missing"
    assert script_state.classify(None)["state"] == "missing"


def test_merge_prefers_the_best_state() -> None:
    assert script_state.merge(["skeleton", "asserted"]) == "asserted"
    assert script_state.merge(["skeleton", "missing"]) == "skeleton"
    assert script_state.merge([]) == "none"


# ---------- 接口 ----------


def _project_with_scripts(client: TestClient) -> tuple[str, dict]:
    pid = client.post("/api/projects", json={"name": "覆盖度", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": parsed["data"]["run_id"]})
    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author",
        json={"run_id": parsed["data"]["run_id"], "sdk": "pytest"},
    ).json()
    return pid, authored


def test_scripts_endpoint_reports_skeleton_then_asserted(client: TestClient) -> None:
    pid, _ = _project_with_scripts(client)
    listing = client.get(f"/api/projects/{pid}/scripts").json()

    # 刚生成的骨架：全部判 skeleton，界面据此标「骨架（未验）」
    assert listing["total"] >= 1
    assert listing["skeleton_total"] == listing["total"]
    assert listing["asserted_total"] == 0
    assert {s["assertion_state"] for s in listing["scripts"]} == {"skeleton"}

    # 给其中一条补上真断言 → 立刻变成 asserted
    victim = listing["scripts"][0]
    content = client.get(f"/api/projects/{pid}/scripts/{victim['id']}/content").json()["content"]
    filled = content.replace(
        'pytest.skip("自动生成的骨架：补充被测调用与断言后重新执行")',
        'assert len(STEPS) >= 1, "用例步骤不应为空"',
    )
    assert filled != content, "没替换到占位跳过，测试本身失效"
    client.put(f"/api/projects/{pid}/scripts/{victim['id']}/content", json={"content": filled})

    after = client.get(f"/api/projects/{pid}/scripts").json()
    by_id = {s["id"]: s for s in after["scripts"]}
    assert by_id[victim["id"]]["assertion_state"] == "asserted"
    assert by_id[victim["id"]]["assert_count"] == 1
    assert after["asserted_total"] == 1
    assert after["skeleton_total"] == after["total"] - 1


def test_cases_endpoint_carries_script_state(client: TestClient) -> None:
    pid, _ = _project_with_scripts(client)
    body = client.get(f"/api/projects/{pid}/cases").json()

    assert body["total"] >= 1
    assert body["no_script_total"] == 0, "每个用例都该有脚本"
    assert body["skeleton_total"] == body["total"]
    assert {c["script_state"] for c in body["cases"]} == {"skeleton"}


def test_run_status_carries_asserted_and_skeleton_counts() -> None:
    stats = {"total": 10, "pass": 6, "fail": 0, "skip": 4}
    enriched = _assertion_counts(stats)
    assert enriched["asserted_cases"] == 6
    assert enriched["skeleton_cases"] == 4
    # 不改变既有字段
    assert enriched["total"] == 10 and enriched["pass"] == 6
    assert _assertion_counts(None) is None


def test_report_writes_the_coverage_line_and_counts() -> None:
    payload = {
        "stats": {"total": 4, "pass": 2, "skip": 2, "fail": 0, "error": 0, "cancelled": 0, "scripts": 4},
        "results": [],
    }
    built = report_service.build_report("wf-cov", "座舱", payload)
    assert "断言覆盖：真断言 2 条 / 骨架 2 条" in built["markdown"]
    assert built["counts"]["asserted"] == 2
    assert built["counts"]["skeleton"] == 2
