"""被测件契约 + 断言生成：把"补断言"变成可重复的生成动作。

骨架一直是骨架，是因为流水线不知道被测件怎么驱动、判定从哪里读。契约把这件事
说清一次，生成器就能按条款数值产出真断言。这里锁住四件事：

1. 坏契约被拒绝（宁可不出断言，也不要出一批假断言）；
2. 断言里的数字**来自条款**，不写死字面量；
3. 没有契约的功能点进"待补接口"，不静默出空断言；
4. 生成的脚本真能跑，且断言不是恒真的（改了条款数值就会红）。
"""

from __future__ import annotations

import subprocess
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
from autotest.workflow import assertion_gen, dut_contract, script_state  # noqa: E402

SAMPLE = """# 座舱 HMI

## 过压保护
单体电压超过 3.65V 时置过压保护。
"""

KNOWLEDGE = """## 过压保护
单体过压阈值 3.65V，超过时置过压保护并上报故障码。"""

CONTRACT = {
    "driver": "_support/dut_sim.py",
    "imports": ["AfeSim"],
    "entries": [
        {
            "function_point": "过压保护",
            "factory": "AfeSim()",
            # 条款是"超过 3.65V 才置位"，所以驱动值要越过阈值，不能正好压线
            "arrange": ["dut.set_cell_voltage(0, {{number}} * 1.02)"],
            "observe": "dut.read()['faults']['ov']",
            "expect": {"kind": "bool", "value": True},
        }
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


# ---------- 契约校验 ----------


def test_contract_rejects_incomplete_entry() -> None:
    with pytest.raises(dut_contract.ContractError) as problem:
        dut_contract.parse({"entries": [{"function_point": "x", "factory": "Dut()"}]})
    assert "缺少字段" in str(problem.value)


def test_contract_rejects_unknown_expect_kind() -> None:
    with pytest.raises(dut_contract.ContractError) as problem:
        dut_contract.parse(
            {
                "entries": [
                    {
                        "function_point": "x",
                        "factory": "Dut()",
                        "arrange": ["dut.go()"],
                        "observe": "dut.state",
                        "expect": {"kind": "看起来像在验", "value": 1},
                    }
                ]
            }
        )
    assert "expect.kind" in str(problem.value)


def test_contract_rejects_duplicate_function_point() -> None:
    entry = {
        "function_point": "x",
        "factory": "Dut()",
        "arrange": ["dut.go()"],
        "observe": "dut.state",
        "expect": {"kind": "bool", "value": True},
    }
    with pytest.raises(dut_contract.ContractError):
        dut_contract.parse({"entries": [entry, dict(entry)]})


# ---------- 生成 ----------


def _case() -> dict:
    return {
        "title": "过压保护-主流程",
        "function_point": "过压保护",
        "case_type": "功能",
        "evidence": {"numbers": ["3.65V"]},
    }


def _entry() -> dut_contract.Entry:
    return dut_contract.parse(CONTRACT).entries["过压保护"]


def test_numbers_come_from_the_clause_not_hardcoded() -> None:
    generated = assertion_gen.generate(_case(), _entry())
    body = "\n".join(generated.body)
    # 条款里的 "3.65V" 写进代码要变成裸数字，否则生成的是语法错误
    assert "set_cell_voltage(0, 3.65 * 1.02)" in body, body
    assert "3.65V" not in body, body
    # 数字来自 evidence：换一个条款数值，断言跟着变
    other = _case()
    other["evidence"] = {"numbers": ["4.20V"]}
    assert "set_cell_voltage(0, 4.20 * 1.02)" in "\n".join(
        assertion_gen.generate(other, _entry()).body
    )


def test_number_without_digits_is_rejected() -> None:
    case = _case()
    case["evidence"] = {"numbers": ["若干伏"]}
    with pytest.raises(assertion_gen.GenerationError):
        assertion_gen.generate(case, _entry())


def test_case_without_numbers_cannot_generate() -> None:
    case = _case()
    case["evidence"] = {"numbers": []}
    with pytest.raises(assertion_gen.GenerationError):
        assertion_gen.generate(case, _entry())


def test_raises_kind_wraps_arrange_in_pytest_raises() -> None:
    entry = dut_contract.parse(
        {
            "entries": [
                {
                    "function_point": "过压保护",
                    "factory": "AfeSim()",
                    "arrange": ["dut.set_cell_voltage(0, 9.9)"],
                    "observe": "None",
                    "expect": {"kind": "raises", "value": "ValueError"},
                }
            ]
        }
    ).entries["过压保护"]
    body = "\n".join(assertion_gen.generate(_case(), entry).body)
    assert "with pytest.raises(ValueError)" in body


# ---------- 接口 + 真能跑 ----------


def _prepare(client: TestClient) -> tuple[str, str]:
    pid = client.post("/api/projects", json={"name": "契约", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱需求.docx", "content": KNOWLEDGE},
    )
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": parsed["data"]["run_id"]})
    return pid, parsed["data"]["run_id"]


def test_contract_roundtrip_and_bad_payload_is_400(client: TestClient) -> None:
    pid, _ = _prepare(client)
    saved = client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT)
    assert saved.status_code == 200

    got = client.get(f"/api/projects/{pid}/workflow/dut-contract").json()
    assert got["data"]["total"] == 1
    assert got["data"]["driver"] == "_support/dut_sim.py"

    bad = client.put(
        f"/api/projects/{pid}/workflow/dut-contract",
        json={"entries": [{"function_point": "过压保护"}]},
    )
    assert bad.status_code == 400


def test_script_author_generates_assertions_when_contract_exists(client: TestClient) -> None:
    pid, run_id = _prepare(client)
    client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT)

    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()

    assert authored["data"]["asserted_generated"] >= 1
    listing = client.get(f"/api/projects/{pid}/scripts").json()
    assert listing["asserted_total"] >= 1, listing
    # 生成出来的脚本必须真的被判成"有断言"，而不是又变回骨架
    asserted = [s for s in listing["scripts"] if s["assertion_state"] == "asserted"]
    assert asserted


def test_without_contract_everything_stays_skeleton_and_is_reported(client: TestClient) -> None:
    pid, run_id = _prepare(client)
    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"}
    ).json()

    assert authored["data"]["asserted_generated"] == 0
    notes = authored["data"]["contract_notes"]
    assert notes and notes[0]["reason"] == "missing_contract"


def test_generated_script_runs_and_fails_on_a_wrong_threshold(client: TestClient, tmp_path) -> None:
    """端到端：生成的断言能跑通；把被测件阈值改错，它必须红。"""
    pid, run_id = _prepare(client)
    client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT)
    client.post(f"/api/projects/{pid}/workflow/script-author", json={"run_id": run_id, "sdk": "pytest"})

    scripts_dir = tmp_path / "workspace" / "projects" / pid / "scripts"
    targets = [p for p in scripts_dir.glob("*.py")]
    assert targets, "没生成脚本"

    support = scripts_dir / "_support"
    support.mkdir(exist_ok=True)
    (support / "dut_sim.py").write_text(
        '''
class AfeSim:
    def __init__(self):
        self._cell = 3.3
    def set_cell_voltage(self, index, volts):
        self._cell = volts
    def read(self):
        return {"faults": {"ov": self._cell > THRESHOLD}}
'''.replace("THRESHOLD", "3.65"),
        encoding="utf-8",
    )

    def run(script: Path) -> int:
        return subprocess.run(
            [sys.executable, "-m", "pytest", str(script), "-q", "--no-header", "-p", "no:cacheprovider"],
            capture_output=True,
            text=True,
            cwd=str(scripts_dir),
            timeout=120,
        ).returncode

    generated = next(p for p in targets if script_state.classify(p.read_text(encoding="utf-8"))["state"] == "asserted")
    assert run(generated) == 0, "生成的断言应该能通过（3.65V 触发保护）"

    (support / "dut_sim.py").write_text(
        (support / "dut_sim.py").read_text(encoding="utf-8").replace("3.65", "9.9"),
        encoding="utf-8",
    )
    assert run(generated) != 0, "阈值改错后断言必须失败，否则这条断言是空的"
