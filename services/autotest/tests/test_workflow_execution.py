"""P3 执行闭环的契约测试：投递 → 轮询 → 日志归因 → 报告。

真实执行一个必然失败的脚本，验证失败证据能一路走到报告里；
这正是方案 P3 的验收条件。
"""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from autotest.api import server  # noqa: E402
from autotest.api.server import app  # noqa: E402

SAMPLE = """# 座舱 HMI

## 功能需求
- 主页应展示导航、音乐、电话三个卡片
"""

FAILING_SCRIPT = '''def test_manual_fail():
    assert 1 == 2


if __name__ == "__main__":
    test_manual_fail()
'''


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def _start_run(client) -> tuple[str, str]:
    cis = client.post("/api/projects", json={"name": "P3", "type": "api"}).json()
    project_id = cis["id"]
    parsed = client.post(
        f"/api/projects/{project_id}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    return project_id, parsed["data"]["run_id"]


def _wait_for(client, project_id: str, run_id: str, tool: str, timeout_s: float = 40.0) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        data = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/status").json()["data"]
        if any(step["tool"] == tool for step in data["steps"]):
            return data
        time.sleep(0.3)
    pytest.fail(f"等待 {tool} 超时")


def _add_manual_script(project_id: str, content: str, name: str) -> str:
    scripts_dir = (server.WORKSPACE / project_id / "scripts")
    scripts_dir.mkdir(parents=True, exist_ok=True)
    path = scripts_dir / name
    path.write_text(content, encoding="utf-8")
    script_id = f"script_manual_{name.split('.')[0]}"
    conn = sqlite3.connect(server.get_project_db(project_id))
    conn.execute(
        "INSERT INTO scripts (id, case_id, name, language, status, filepath) VALUES (?, ?, ?, ?, ?, ?)",
        (script_id, "", name, "python", "就绪", str(path)),
    )
    conn.commit()
    conn.close()
    return script_id


def test_execute_status_and_report_over_http(client):
    project_id, run_id = _start_run(client)
    client.post(f"/api/projects/{project_id}/workflow/case-design", json={"run_id": run_id, "types": ["功能"]})
    authored = client.post(
        f"/api/projects/{project_id}/workflow/script-author", json={"run_id": run_id}
    ).json()
    assert authored["data"]["script_total"] == 1

    started = client.post(
        f"/api/projects/{project_id}/workflow/runs/{run_id}/execute", json={"timeout_s": 30}
    ).json()
    assert started["data"]["status"] == "started"

    status = _wait_for(client, project_id, run_id, "autotest_run_result")
    assert status["execution"]["total"] == 1
    assert status["status"] != "failed"

    report = client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/report", json={}).json()
    assert report["data"]["counts"]["total"] == 1
    assert Path(report["data"]["path"]).is_file()

    # 出完报告这条流水线就算收尾：阶段前进，状态不能一直挂在 running。
    final = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/status").json()["data"]
    assert final["stage"] == "reported"
    assert final["status"] == "done"

    # 流水线最后一步：报告归档进项目知识库，且能被检索到
    client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/report", json={})
    archive = client.get(
        f"/api/projects/{project_id}/workflow/knowledge/search",
        params={"q": run_id, "limit": 10},
    ).json()["data"]
    titles = [item["title"] for item in archive["records"]]
    assert any(run_id in title for title in titles), titles
    reports = [item for item in archive["records"] if item["record_type"] == "run-report"]
    assert len(reports) == 1  # 重复出报告不能重复归档


def test_failed_script_reaches_analysis_and_report(client):
    project_id, run_id = _start_run(client)
    script_id = _add_manual_script(project_id, FAILING_SCRIPT, "manual_fail.py")

    started = client.post(
        f"/api/projects/{project_id}/workflow/runs/{run_id}/execute",
        json={"script_ids": [script_id], "timeout_s": 30},
    ).json()
    assert started["data"]["status"] == "started"

    status = _wait_for(client, project_id, run_id, "autotest_run_result")
    assert status["execution"]["fail"] == 1
    assert status["failures"][0]["script_name"] == "manual_fail.py"

    conn = sqlite3.connect(server.get_project_db(project_id))
    execution_id = conn.execute("SELECT MAX(id) FROM executions").fetchone()[0]
    conn.close()

    analysis = client.post(
        f"/api/projects/{project_id}/workflow/log-analyze",
        json={"run_id": run_id, "execution_id": execution_id},
    ).json()
    assert analysis["data"]["error"] is not None
    assert analysis["data"]["error"]["type"] == "AssertionError"
    assert analysis["data"]["suggestions"]

    report = client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/report", json={}).json()
    assert report["data"]["counts"]["failed"] == 1
    assert report["data"]["pass_rate"] == "0.0%"
    # 失败用例由后端确定性映射成 bug 单，报告要带上缺陷清单
    assert report["data"]["bug_ids"], report["data"]
    assert report["data"]["counts"]["bugs"] == 1
    markdown = Path(report["data"]["path"]).read_text(encoding="utf-8")
    assert "缺陷清单" in markdown
    assert report["data"]["bug_ids"][0] in markdown
    assert "失败明细" in markdown
    assert "manual_fail.py" in markdown

    # 再出一次报告不能重复建 bug
    again = client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/report", json={}).json()
    assert again["data"]["bug_ids"] == report["data"]["bug_ids"]
    assert again["data"]["counts"]["bugs"] == 1

    # 前端要能读到缺陷单明细与报告正文
    bugs = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/bugs").json()["data"]
    assert bugs["total"] == 1
    assert bugs["bugs"][0]["script_name"] == "manual_fail.py"
    assert bugs["bugs"][0]["severity"] == "major"
    # 缺陷标题要引可读的那一行（断言行），不能是 pytest 的 `____ test ____` 装饰线
    assert "assert" in bugs["bugs"][0]["title"]
    assert bugs["bugs"][0]["error_type"] == "AssertionError"

    body = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/report-content").json()["data"]
    assert body["name"] == report["data"]["path"].rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
    assert "缺陷清单" in body["markdown"]
    assert "失败明细" in body["markdown"]

    # 人工流转缺陷状态：只能在它出现过的 run 里改，非法状态拒绝
    bug_id = bugs["bugs"][0]["id"]
    patched = client.patch(
        f"/api/projects/{project_id}/workflow/runs/{run_id}/bugs/{bug_id}", json={"status": "fixed"}
    ).json()
    assert patched["data"]["status"] == "fixed"
    after = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/bugs").json()["data"]
    assert after["bugs"][0]["status"] == "fixed"
    assert (
        client.patch(
            f"/api/projects/{project_id}/workflow/runs/{run_id}/bugs/{bug_id}", json={"status": "nope"}
        ).status_code
        == 400
    )
    assert (
        client.patch(
            f"/api/projects/{project_id}/workflow/runs/{run_id}/bugs/bug-nope", json={"status": "fixed"}
        ).status_code
        == 404
    )


def test_report_content_requires_report(client):
    project_id, run_id = _start_run(client)
    r = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/report-content")
    assert r.status_code == 409
    assert "还没有生成报告" in r.json()["detail"]


def _run_failing_script(client, project_id: str, script_id: str) -> str:
    run_id = client.post(
        f"/api/projects/{project_id}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()["data"]["run_id"]
    client.post(
        f"/api/projects/{project_id}/workflow/runs/{run_id}/execute",
        json={"script_ids": [script_id], "timeout_s": 30},
    )
    _wait_for(client, project_id, run_id, "autotest_run_result")
    return run_id


def test_same_failure_in_another_run_merges_into_one_bug(client):
    """同一用例在第二次运行里再失败，应归并到同一张缺陷单，而不是新开一条。"""
    project_id, first_run = _start_run(client)
    script_id = _add_manual_script(project_id, FAILING_SCRIPT, "manual_fail.py")

    client.post(
        f"/api/projects/{project_id}/workflow/runs/{first_run}/execute",
        json={"script_ids": [script_id], "timeout_s": 30},
    )
    _wait_for(client, project_id, first_run, "autotest_run_result")
    first = client.post(f"/api/projects/{project_id}/workflow/runs/{first_run}/report", json={}).json()
    assert len(first["data"]["bug_ids"]) == 1

    second_run = _run_failing_script(client, project_id, script_id)
    second = client.post(f"/api/projects/{project_id}/workflow/runs/{second_run}/report", json={}).json()
    assert second["data"]["bug_ids"] == first["data"]["bug_ids"]

    # 第二个 run 也要能列出这张缺陷单（它只在首次运行的 bugs.run_id 里）
    bugs = client.get(f"/api/projects/{project_id}/workflow/runs/{second_run}/bugs").json()["data"]
    assert bugs["total"] == 1
    assert bugs["bugs"][0]["occurrences"] == 2
    assert bugs["bugs"][0]["last_run_id"] == second_run


PASSING_SCRIPT = '''def test_manual_pass():
    assert 1 == 1


if __name__ == "__main__":
    test_manual_pass()
'''


def test_passing_rerun_verifies_the_open_bug(client):
    """同一用例修好后重跑通过，缺陷单应自动变成 verified，而不是一直挂在 open。"""
    project_id, first_run = _start_run(client)
    script_path = _add_manual_script(project_id, FAILING_SCRIPT, "manual_case.py")
    scripts_file = server.WORKSPACE / project_id / "scripts" / "manual_case.py"

    client.post(
        f"/api/projects/{project_id}/workflow/runs/{first_run}/execute",
        json={"script_ids": [script_path], "timeout_s": 30},
    )
    _wait_for(client, project_id, first_run, "autotest_run_result")
    first = client.post(f"/api/projects/{project_id}/workflow/runs/{first_run}/report", json={}).json()
    bug_id = first["data"]["bug_ids"][0]
    assert first["data"]["verified_bug_ids"] == []

    # 修好脚本（同一个脚本 id、同一个用例名），再跑一轮
    scripts_file.write_text(PASSING_SCRIPT, encoding="utf-8")
    second_run = client.post(
        f"/api/projects/{project_id}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()["data"]["run_id"]
    client.post(
        f"/api/projects/{project_id}/workflow/runs/{second_run}/execute",
        json={"script_ids": [script_path], "timeout_s": 30},
    )
    _wait_for(client, project_id, second_run, "autotest_run_result")
    second = client.post(f"/api/projects/{project_id}/workflow/runs/{second_run}/report", json={}).json()
    assert second["data"]["verified_bug_ids"] == [bug_id]
    assert second["data"]["counts"]["bugs"] == 0

    bugs = client.get(f"/api/projects/{project_id}/workflow/runs/{second_run}/bugs").json()["data"]
    assert bugs["total"] == 1
    assert bugs["bugs"][0]["status"] == "verified"


def test_project_level_bug_list_and_status(client):
    """「缺陷」页要按项目列出所有缺陷单，并能不指定 run 直接改状态。"""
    project_id, first_run = _start_run(client)
    script_id = _add_manual_script(project_id, FAILING_SCRIPT, "proj_bug.py")
    client.post(
        f"/api/projects/{project_id}/workflow/runs/{first_run}/execute",
        json={"script_ids": [script_id], "timeout_s": 30},
    )
    _wait_for(client, project_id, first_run, "autotest_run_result")
    first = client.post(f"/api/projects/{project_id}/workflow/runs/{first_run}/report", json={}).json()
    bug_id = first["data"]["bug_ids"][0]

    listing = client.get(f"/api/projects/{project_id}/workflow/bugs").json()
    assert listing["data"]["total"] == 1
    row = listing["data"]["bugs"][0]
    assert row["id"] == bug_id
    assert row["status"] == "open"
    assert row["script_name"] == "proj_bug.py"
    assert row["last_run_id"] == first_run

    fixed = client.patch(
        f"/api/projects/{project_id}/workflow/bugs/{bug_id}", json={"status": "fixed"}
    ).json()
    assert fixed["data"]["status"] == "fixed"

    # 状态过滤与非法值
    assert client.get(
        f"/api/projects/{project_id}/workflow/bugs", params={"status": "fixed"}
    ).json()["data"]["total"] == 1
    assert client.get(
        f"/api/projects/{project_id}/workflow/bugs", params={"status": "open"}
    ).json()["data"]["total"] == 0
    assert client.get(
        f"/api/projects/{project_id}/workflow/bugs", params={"status": "nope"}
    ).status_code == 400
    assert client.patch(
        f"/api/projects/{project_id}/workflow/bugs/{bug_id}", json={"status": "nope"}
    ).status_code == 400
    assert client.patch(
        f"/api/projects/{project_id}/workflow/bugs/bug-nope", json={"status": "fixed"}
    ).status_code == 404


def test_project_bug_list_is_project_scoped(client):
    """A 项目的缺陷单不能出现在 B 项目的清单里，也不能在 B 项目改状态。"""
    a_id, a_run = _start_run(client)
    script_id = _add_manual_script(a_id, FAILING_SCRIPT, "scoped_bug.py")
    client.post(
        f"/api/projects/{a_id}/workflow/runs/{a_run}/execute",
        json={"script_ids": [script_id], "timeout_s": 30},
    )
    _wait_for(client, a_id, a_run, "autotest_run_result")
    report = client.post(f"/api/projects/{a_id}/workflow/runs/{a_run}/report", json={}).json()
    bug_id = report["data"]["bug_ids"][0]

    b_id = client.post("/api/projects", json={"name": "B", "type": "api"}).json()["id"]
    assert client.get(f"/api/projects/{b_id}/workflow/bugs").json()["data"]["total"] == 0
    assert client.patch(
        f"/api/projects/{b_id}/workflow/bugs/{bug_id}", json={"status": "fixed"}
    ).status_code == 404



def test_execute_closes_the_dispatch_step_instead_of_leaving_it_running(client):
    """跑完之后不能还有步骤挂在 running。

    投递时先写一条 `autotest_run`（running），结果由后台线程写 `autotest_run_result`。
    不收尾前者，run 的步骤列表里就永远有一条在跑 —— 界面转圈、轮询的 Agent 也以为没结束。
    """
    project_id, run_id = _start_run(client)
    client.post(f"/api/projects/{project_id}/workflow/case-design", json={"run_id": run_id, "types": ["功能"]})
    client.post(f"/api/projects/{project_id}/workflow/script-author", json={"run_id": run_id})
    client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/execute", json={"timeout_s": 30})

    status = _wait_for(client, project_id, run_id, "autotest_run_result")
    running = [step["tool"] for step in status["steps"] if step["status"] == "running"]
    assert running == [], f"跑完仍有步骤挂在 running: {running}"

    dispatch = [step for step in status["steps"] if step["tool"] == "autotest_run"][0]
    assert dispatch["status"] in ("ok", "warning")
    assert "跑完" in dispatch["summary"]

    # 生命周期仍按设计走：执行完只到 executed，报告出完才收尾成 done
    assert status["stage"] == "executed"
    assert status["status"] == "running"
    client.post(f"/api/projects/{project_id}/workflow/runs/{run_id}/report", json={})
    final = client.get(f"/api/projects/{project_id}/workflow/runs/{run_id}/status").json()["data"]
    assert (final["stage"], final["status"]) == ("reported", "done")
