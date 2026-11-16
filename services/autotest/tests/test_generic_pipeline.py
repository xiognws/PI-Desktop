"""整条流水线必须与项目无关：换一个完全不同领域的项目也要能跑通。

这里用「账号登录 + 会话」这种和车载完全无关的需求，验证：
解析 → 设计（含失效模式）→ 契约 → 脚本（真断言）→ 评审 → 报告，
全部只依赖本项目自己的资料与契约，不依赖任何内置的业务名词。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from autotest.api import server
from autotest.api.server import app

TEXT = """# 账号服务需求

## 功能要求
- 登录失败锁定：连续 5 次密码错误后锁定该账号 300 秒
- 会话续期：令牌有效期 1800 秒，到期前需刷新

## 接口说明
- 登录接口返回 token，参数用户名与密码
"""

CONTRACT = {
    "driver": "_support/auth_dut.py",
    "imports": ["AuthDut", "AuthError"],
    "entries": [
        {
            "function_point": "登录失败锁定",
            "factory": "AuthDut()",
            "arrange": ["dut.fail_login(times={{number}})"],
            "observe": "dut.locked",
            "expect": {"kind": "raises", "value": "AuthError"},
        },
        {
            "function_point": "会话续期",
            "factory": "AuthDut()",
            "arrange": ["dut.set_expiry({{number}})"],
            "observe": "dut.needs_refresh",
            "expect": {"kind": "bool", "value": True},
        },
    ],
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


@pytest.fixture()
def project(client) -> dict:
    return client.post("/api/projects", json={"name": "账号服务"}).json()


def test_pipeline_runs_on_a_project_with_no_vehicle_terms(client, project):
    pid = project["id"]
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "账号服务需求.docx", "content": TEXT},
    )
    parsed = client.post(f"/api/projects/{pid}/workflow/prd-parse", json={"text": TEXT}).json()
    run_id = parsed["data"]["run_id"]
    points = {point["name"] for point in parsed["data"]["function_points"]}
    assert any("登录失败锁定" in name for name in points)

    designed = client.post(
        f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id}
    ).json()["data"]
    classes = designed["by_exception_class"]
    # 条款里有"连续 5 次""300 秒"这类阈值，越界/边界必须出现
    assert classes.get("out_of_range"), classes
    assert classes.get("boundary"), classes

    written = client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT)
    assert written.status_code == 200

    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id}
    ).json()
    data = authored["data"]
    assert data["asserted_generated"] >= 2, data["contract_notes"]
    assert data["asserted_by_type"].get("异常"), "异常用例也要拿到真断言"

    # 带真断言的脚本里必须出现"断言被拒绝 + 按阈值算出的值"，而不是合法值。
    # 注意：pytest.raises 本身就是断言，脚本状态必须把它算成 asserted。
    scripts = client.get(f"/api/projects/{pid}/scripts").json()["scripts"]
    asserted = [s for s in scripts if s.get("assertion_state") == "asserted"]
    assert len(asserted) >= 2, [s["name"] for s in scripts]
    contents = "\n".join(
        client.get(f"/api/projects/{pid}/scripts/{s['id']}/content").json()["content"] for s in asserted
    )
    assert "pytest.raises(AuthError)" in contents, contents[:400]
    # 阈值 5 → 越界值 6（+10% 取整），不能沿用合法值
    assert "fail_login(times=6" in contents or "fail_login(times=6.0" in contents


def test_report_and_review_do_not_assume_a_domain(client, project):
    pid = project["id"]
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "账号服务需求.docx", "content": TEXT},
    )
    run_id = client.post(f"/api/projects/{pid}/workflow/prd-parse", json={"text": TEXT}).json()["data"][
        "run_id"
    ]
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id})
    reviewed = client.post(f"/api/projects/{pid}/workflow/case-review", json={"run_id": run_id}).json()
    coverage = reviewed["data"]["exception_coverage"]
    assert coverage, "评审要回报失效模式覆盖"
    assert reviewed["data"]["consistency"]["ok"], reviewed["data"]["consistency"]["issues"]
