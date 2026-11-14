"""重新生成脚本不能给同一个文件再加一行。

旧实现是纯 `INSERT`：同一个用例重新出脚本，`scripts` 表就多一条同名记录。
后果是连锁的 —— 脚本数虚高（36 个文件显示成 72 个）、断言覆盖计数翻倍、
执行历史里的 `script_id` 漂移，最后没人知道哪条记录才是当前那份文件。

现在 `script-author` 按文件名覆盖（保留原 id），老库由迁移清理一次。
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
from autotest.storage.migrations import ensure_project_schema  # noqa: E402
from autotest.storage.sqlite import init_db  # noqa: E402

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


def _run_with_cases(client: TestClient) -> tuple[str, str]:
    pid = client.post("/api/projects", json={"name": "重生成", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱 HMI 需求.docx", "content": KNOWLEDGE},
    )
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": parsed["data"]["run_id"]})
    return pid, parsed["data"]["run_id"]


def test_regenerating_scripts_reuses_the_same_rows(client: TestClient) -> None:
    pid, run_id = _run_with_cases(client)

    first = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()
    first_listing = client.get(f"/api/projects/{pid}/scripts").json()

    second = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()
    second_listing = client.get(f"/api/projects/{pid}/scripts").json()

    assert first["data"]["script_total"] == second["data"]["script_total"] >= 1
    # 关键：数量不涨、id 不变、文件名不变
    assert second_listing["total"] == first_listing["total"]
    assert {s["id"] for s in second_listing["scripts"]} == {s["id"] for s in first_listing["scripts"]}
    assert {s["name"] for s in second_listing["scripts"]} == {s["name"] for s in first_listing["scripts"]}


def test_regenerating_updates_the_file_on_disk(client: TestClient) -> None:
    """没有真实断言的脚本（含只有恒真断言的）仍按模板重出：它们不是人的工作，是产物。"""
    pid, run_id = _run_with_cases(client)
    client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"})
    listing = client.get(f"/api/projects/{pid}/scripts").json()
    victim = listing["scripts"][0]

    # 只有恒真断言 = 还没真验，允许被覆盖
    client.put(
        f"/api/projects/{pid}/scripts/{victim['id']}/content",
        json={"content": "def test_x():\n    assert True\n"},
    )
    client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"})

    content = client.get(f"/api/projects/{pid}/scripts/{victim['id']}/content").json()["content"]
    assert "pytest.skip(" in content, "重新生成应把文件写回骨架"
    after = client.get(f"/api/projects/{pid}/scripts").json()
    assert after["total"] == listing["total"], "重新生成不应新增脚本记录"


def test_regenerating_keeps_hand_filled_scripts(client: TestClient) -> None:
    """重新生成只该重出骨架，不能把已补断言的脚本覆盖回去。

    流水线里点一下「生成脚本」就会走这条路径；把几天的断言补充顺手抹掉是不可接受的。
    """
    pid, run_id = _run_with_cases(client)
    client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"})
    listing = client.get(f"/api/projects/{pid}/scripts").json()
    victim = listing["scripts"][0]
    filled = "def test_x():\n    assert 3.60 < 3.65\n"
    client.put(f"/api/projects/{pid}/scripts/{victim['id']}/content", json={"content": filled})

    again = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()

    assert again["data"]["preserved_total"] >= 1
    assert victim["name"] in again["data"]["preserved"]
    # 文件保持原样
    assert client.get(f"/api/projects/{pid}/scripts/{victim['id']}/content").json()["content"] == filled
    after = client.get(f"/api/projects/{pid}/scripts").json()
    assert after["asserted_total"] >= 1, "已补断言的脚本应仍是真断言状态"
    assert after["total"] == listing["total"]


def test_explicit_overwrite_regenerates_even_filled_scripts(client: TestClient) -> None:
    pid, run_id = _run_with_cases(client)
    client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"})
    victim = client.get(f"/api/projects/{pid}/scripts").json()["scripts"][0]
    client.put(
        f"/api/projects/{pid}/scripts/{victim['id']}/content",
        json={"content": "def test_x():\n    assert 1 == 2\n"},
    )

    again = client.post(
        f"/api/projects/{pid}/workflow/script-author",
        json={"run_id": run_id, "sdk": "pytest", "overwrite": True},
    ).json()

    assert again["data"]["preserved_total"] == 0
    content = client.get(f"/api/projects/{pid}/scripts/{victim['id']}/content").json()["content"]
    assert "pytest.skip(" in content


def test_migration_collapses_existing_duplicates(tmp_path) -> None:
    """老库里已经攒下的同名记录（36 文件显示成 72 条）由迁移清理。"""
    db = tmp_path / "data.db"
    init_db(db)  # 真实项目库的结构：迁移要能在完整库上跑
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    insert = "INSERT INTO scripts (id, project_id, case_id, name, updated_at) VALUES (?, 'proj_x', ?, ?, ?)"
    conn.execute(insert, ("s1", "c1", "case_aaaa1111.py", "2026-11-13 04:34:00"))
    conn.execute(insert, ("s2", "c1", "case_aaaa1111.py", "2026-11-13 11:57:00"))
    conn.execute(insert, ("s3", "c2", "case_bbbb2222.py", "2026-11-13 11:57:00"))

    changes = ensure_project_schema(conn, tmp_path / "scripts")
    rows = [dict(r) for r in conn.execute("SELECT id, name FROM scripts ORDER BY name")]

    assert any("scripts deduped" in change for change in changes), changes
    assert [r["name"] for r in rows] == ["case_aaaa1111.py", "case_bbbb2222.py"]
    # 保留最新那条（s2），不是任意一条
    assert [r["id"] for r in rows] == ["s2", "s3"]


def test_migration_is_idempotent(tmp_path) -> None:
    db = tmp_path / "data.db"
    init_db(db)
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO scripts (id, project_id, name) VALUES ('s1', 'proj_x', 'case_cccc3333.py')"
    )
    assert not any("deduped" in change for change in ensure_project_schema(conn, tmp_path / "scripts"))
