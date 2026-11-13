"""HTTP 面：每个阶段产出都要带"用的是哪一版固定提示词"，目录可查。

没有这条链路，"固定提示词"就只是仓库里几个没人引用的 md：Agent 生成完只回一句
"生成成功"，事后无法判断这批用例是按哪一版规则产出的。
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
from autotest.prompts import STAGES  # noqa: E402

SAMPLE = """# 座舱 HMI

## 1.1 主页卡片
主页应展示导航、音乐、电话三个卡片。

## 1.2 语音唤醒
支持语音唤醒，唤醒词必须可配置。
"""

# 依据检索按"功能点名"命中：入库正文必须出现功能点名，否则该功能点一律判无依据被跳过。
KNOWLEDGE = """## 主页卡片
主页卡片应展示导航、音乐、电话三个卡片。
## 语音唤醒
语音唤醒词必须可配置。"""


@pytest.fixture()
def client(tmp_path, monkeypatch):
    ws = tmp_path / "workspace" / "projects"
    ws.mkdir(parents=True)
    monkeypatch.setattr(server, "WORKSPACE", ws)
    monkeypatch.setattr(server, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(server, "DIST", tmp_path / "no_dist")
    with TestClient(app) as c:
        yield c


def test_prompt_catalog_endpoint_lists_every_stage(client: TestClient) -> None:
    project = client.post("/api/projects", json={"name": "提示词", "type": "api"}).json()
    body = client.get(f"/api/projects/{project['id']}/workflow/prompts").json()

    prompts = body["data"]["prompts"]
    assert {item["stage"] for item in prompts} == set(STAGES)
    for item in prompts:
        assert item["ref"] == f"{item['id']}@{item['version']}"
        assert len(item["digest"]) == 12


def test_prd_parse_and_case_design_报告提示词版本(client: TestClient) -> None:
    project = client.post("/api/projects", json={"name": "提示词2", "type": "api"}).json()
    pid = project["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    assert parsed["data"]["prompt"]["ref"] == "autotest.prd-parse@1.0.0"

    # 有依据才设计用例（没依据的功能点会被跳过）
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    designed = client.post(
        f"/api/projects/{pid}/workflow/case-design",
        json={"run_id": parsed["data"]["run_id"]},
    ).json()

    assert designed["data"]["prompt"]["ref"] == "autotest.case-design@1.0.0"
    judgement = designed["data"]["consistency"]
    assert judgement["checked"] >= 1
    # 确定性模板产出的用例必须过自家的规则，否则规则本身就写歪了
    assert judgement["ok"] is True, judgement["issues"]


def test_script_author_and_review_carry_prompt_ref(client: TestClient) -> None:
    project = client.post("/api/projects", json={"name": "提示词3", "type": "api"}).json()
    pid = project["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    run_id = parsed["data"]["run_id"]
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": run_id})

    reviewed = client.post(f"/api/projects/{pid}/workflow/case-review", json={"run_id": run_id}).json()
    assert reviewed["data"]["prompt"]["ref"] == "autotest.case-review@1.0.0"

    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()
    assert authored["data"]["prompt"]["ref"] == "autotest.script-author@1.1.0"
    # 脚本规则同样可判定：骨架必须 skip、文件名/函数名/常量齐备
    assert authored["data"]["consistency"]["ok"] is True, authored["data"]["consistency"]


def test_log_analyze_carries_prompt_ref(client: TestClient) -> None:
    project = client.post("/api/projects", json={"name": "提示词4", "type": "api"}).json()
    pid = project["id"]
    body = client.post(
        f"/api/projects/{pid}/workflow/log-analyze",
        json={"raw_log": 'File "tests/case_x.py", line 7, in test_case_x\nAssertionError: 1 != 2'},
    ).json()
    assert body["data"]["prompt"]["ref"] == "autotest.log-analyze@1.0.0"
