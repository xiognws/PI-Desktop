"""端到端验收：一个项目从需求文本走到报告，全程只用它自己的资料与契约。

这条用例存在的理由：流水线要"对任何项目成立"。以前每次改完都得手工拿某个项目
点一遍，靠的是人记忆；现在换成一个与车载无关的项目（账号服务），并额外做一次
**变异验证** —— 把被测件换成"永远不拒绝"的实现，反面用例必须变成失败。
如果它还是绿的，说明我们生成的是假断言。
"""

from __future__ import annotations

import textwrap

import pytest
from fastapi.testclient import TestClient

from autotest.api import server
from autotest.api.server import app

TEXT = """# 账号服务需求

## 功能要求
- 登录失败锁定：连续 5 次密码错误后锁定该账号 300 秒
- 注册校验：用户名长度 6 到 20 个字符，超长直接拒绝

## 接口说明
- 登录接口参数用户名与密码，请求超时时间 3000 毫秒
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
            "function_point": "注册校验",
            "factory": "AuthDut()",
            "arrange": ["dut.register(name_len={{number}})"],
            "observe": "dut.rejected",
            "expect": {"kind": "raises", "value": "AuthError"},
        },
    ],
}

# 正常被测件：超过阈值就拒绝
DUT_OK = textwrap.dedent(
    '''
    class AuthError(Exception):
        """被测件拒绝输入时抛出。"""


    class AuthDut:
        def __init__(self) -> None:
            self.locked = False
            self.rejected = False
            self._failures = 0

        def fail_login(self, times: float) -> None:
            if times > 5:
                self.locked = True
                raise AuthError("账号已锁定")
            self._failures = int(times)

        def register(self, name_len: float) -> None:
            if name_len > 20 or name_len < 6:
                self.rejected = True
                raise AuthError("用户名长度不合法")
    '''
)

# 变异被测件：永远不拒绝 —— 反面用例必须因此失败
DUT_MUTANT = textwrap.dedent(
    '''
    class AuthError(Exception):
        """被测件拒绝输入时抛出。"""


    class AuthDut:
        def __init__(self) -> None:
            self.locked = False
            self.rejected = False

        def fail_login(self, times: float) -> None:
            self.locked = False

        def register(self, name_len: float) -> None:
            self.rejected = False
    '''
)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def _bootstrap(client, name: str = "账号服务") -> tuple[str, str]:
    """建项目 → 入库资料 → 解析 → 设计 → 评审 → 契约 → 脚本，返回 (pid, run_id)。"""
    pid = client.post("/api/projects", json={"name": name}).json()["id"]
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "账号服务需求.docx", "content": TEXT},
    )
    run_id = client.post(f"/api/projects/{pid}/workflow/prd-parse", json={"text": TEXT}).json()["data"][
        "run_id"
    ]
    designed = client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id}).json()[
        "data"
    ]
    assert designed["case_total"] >= 4
    assert len(designed["by_exception_class"]) >= 2, designed["by_exception_class"]

    reviewed = client.post(f"/api/projects/{pid}/workflow/case-review", json={"run_id": run_id}).json()[
        "data"
    ]
    assert reviewed["consistency"]["ok"], reviewed["consistency"]["issues"]

    assert client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT).status_code == 200
    authored = client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id}).json()[
        "data"
    ]
    assert authored["asserted_generated"] >= 2
    assert authored["asserted_by_type"].get("异常"), authored["contract_notes"]
    return pid, run_id


def _write_dut(client, pid: str, source: str) -> None:
    """把被测件实现放进项目的工作区（脚本按契约里的 driver 路径 import）。"""
    support = server.WORKSPACE / pid / "scripts" / "_support"
    support.mkdir(parents=True, exist_ok=True)
    (support / "auth_dut.py").write_text(source, encoding="utf-8")


def _execute(client, pid: str, run_id: str, timeout_s: float = 180.0) -> dict:
    """投递执行后轮询 run 直到拿到结果步骤（执行是后台任务）。"""
    import time

    client.post(f"/api/projects/{pid}/workflow/runs/{run_id}/execute", json={"timeout_s": 120})
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        run = client.get(f"/api/projects/{pid}/workflow/runs/{run_id}").json()["data"]
        for step in run["steps"]:
            if step["tool"] == "autotest_run_result":
                payload = step.get("payload") or {}
                if payload.get("stats"):
                    return payload
        time.sleep(1)
    raise AssertionError("执行没有在超时内产出结果")


def test_full_pipeline_passes_against_a_correct_device(client):
    pid, run_id = _bootstrap(client)
    _write_dut(client, pid, DUT_OK)
    payload = _execute(client, pid, run_id)
    stats = payload["stats"]
    # 有契约的功能点用真断言，其余仍是骨架 skip：失败必须是 0
    assert stats["fail"] == 0, payload
    assert stats["pass"] >= 1
    assert stats["skip"] >= 1, "没有契约的功能点应当仍是骨架"

    report = client.post(f"/api/projects/{pid}/workflow/runs/{run_id}/report", json={}).json()
    assert report["ok"] is True
    markdown = (server.WORKSPACE / pid / "reports").glob(f"{run_id}-report.md")
    text = next(markdown).read_text(encoding="utf-8")
    assert "## 异常覆盖" in text
    assert "待补资料的失效模式" in text


def test_negative_assertions_fail_when_the_device_never_refuses(client):
    """变异验证：被测件永远不拒绝时，反面用例必须失败 —— 否则断言是假的。"""
    pid, run_id = _bootstrap(client, name="账号服务-变异")
    _write_dut(client, pid, DUT_MUTANT)
    payload = _execute(client, pid, run_id)
    stats = payload["stats"]
    assert stats["fail"] >= 1, f"变异被测件下仍然全绿，说明断言没有真正生效：{stats}"


def test_pipeline_is_reproducible_on_a_second_project(client):
    """同一套代码再建一个不同名项目，结果形状一致（不依赖项目名/历史数据）。"""
    first_pid, _ = _bootstrap(client, name="账号服务-A")
    second_pid, _ = _bootstrap(client, name="账号服务-B")

    def shape(pid: str) -> tuple[int, int]:
        data = client.get(f"/api/projects/{pid}/cases").json()
        scripts = client.get(f"/api/projects/{pid}/scripts").json()
        return data["total"], scripts["asserted_total"]

    assert shape(first_pid) == shape(second_pid)
