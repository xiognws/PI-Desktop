"""孤儿脚本：关联用例被删了，脚本还在库里。

这会发生得很自然：资料缺口导致某个功能点的用例被跳过，`case-design` 会清掉旧空壳，
于是那批脚本指向的 `case_id` 不再存在。脚本不能连带删除（它可能已经被人补过断言，
是真实资产），但界面必须能看出来 —— 否则执行结果对不回任何一条需求，也没人知道
该不该重新生成。
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

SAMPLE = """# 座舱 HMI

## 主页卡片
主页应展示导航、音乐、电话三个卡片。

## 语音唤醒
支持语音唤醒，唤醒词必须可配置。
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


def _project_with_scripts(client: TestClient) -> tuple[str, list[dict]]:
    pid = client.post("/api/projects", json={"name": "孤儿脚本", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    designed = client.post(
        f"/api/projects/{pid}/workflow/case-design", json={"run_id": parsed["data"]["run_id"]}
    ).json()
    assert designed["data"]["case_total"] >= 2
    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author",
        json={"run_id": parsed["data"]["run_id"], "sdk": "pytest"},
    ).json()
    assert authored["data"]["script_total"] >= 2
    return pid, client.get(f"/api/projects/{pid}/scripts").json()["scripts"]


def test_linked_scripts_are_not_marked_as_orphans(client: TestClient) -> None:
    pid, scripts = _project_with_scripts(client)
    listing = client.get(f"/api/projects/{pid}/scripts").json()

    assert listing["orphan_total"] == 0
    assert all(script["case_missing"] is False for script in listing["scripts"])


def test_deleting_the_case_clears_the_link_instead_of_orphaning(client: TestClient) -> None:
    """人工删用例是"解除关联"：脚本留着、`case_id` 清空，界面显示「未关联」。

    悬空 `case_id` 只会出现在"重新设计时清掉无依据空壳"这条路径上（见下一个用例）。
    """
    pid, scripts = _project_with_scripts(client)
    victim = scripts[0]

    deleted = client.delete(f"/api/projects/{pid}/cases/{victim['case_id']}")
    assert deleted.status_code == 200

    listing = client.get(f"/api/projects/{pid}/scripts").json()
    after = {item["id"]: item for item in listing["scripts"]}

    assert after[victim["id"]]["case_id"] == ""
    assert after[victim["id"]]["case_missing"] is False
    assert listing["orphan_total"] == 0


def test_stale_drop_leaves_the_script_marked_and_intact(client: TestClient) -> None:
    """重新设计清掉"没依据"的空壳时，脚本会悬空 —— 必须标出来，且文件不能丢。"""
    pid = client.post("/api/projects", json={"name": "孤儿2", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    run_id = parsed["data"]["run_id"]

    # 先带占位生成（"语音唤醒"没有依据），再出脚本
    first = client.post(
        f"/api/projects/{pid}/workflow/case-design",
        json={"run_id": run_id, "skip_ungrounded": False},
    ).json()
    assert first["data"]["grounding"]["none"] >= 1
    client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    )

    # 重新设计：默认跳过无依据用例，旧空壳被清掉 → 对应脚本悬空
    again = client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id}).json()
    assert again["data"]["removed_stale"] >= 1

    listing = client.get(f"/api/projects/{pid}/scripts").json()
    orphans = [script for script in listing["scripts"] if script["case_missing"]]
    assert orphans, "清掉占位用例后，对应脚本必须被标成孤儿"
    assert listing["orphan_total"] == len(orphans)

    # 脚本本身没被删，内容还能读（这是用户资产，可能已补过断言）
    content = client.get(f"/api/projects/{pid}/scripts/{orphans[0]['id']}/content")
    assert content.status_code == 200
