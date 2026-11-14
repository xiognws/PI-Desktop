"""变异抽查：断言必须"能失败"。

一条断言如果不能失败，就等于没写 —— 它让报告变绿，却不阻挡任何缺陷。抽查把每条
断言的**期望写反**再跑一次：真在验的断言此时必然失败，还通过的就是空壳。

这里锁四件事：真断言被判"合格"、恒真断言被判"空断言"、没有契约的用例不进抽查、
抽查用的变异体文件跑完即删（不污染项目 scripts 目录）。
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
from autotest.workflow import assertion_gen, dut_contract, vacuity  # noqa: E402

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
            "arrange": ["dut.set_cell_voltage(0, {{number}} * 1.02)"],
            "observe": "dut.read()['faults']['ov']",
            "expect": {"kind": "bool", "value": True},
        }
    ],
}

DRIVER = '''
class AfeSim:
    def __init__(self):
        self._cell = 3.3
    def set_cell_voltage(self, index, volts):
        self._cell = volts
    def read(self):
        return {"faults": {"ov": self._cell > 3.65}}
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


def _case() -> dict:
    return {
        "title": "过压保护-主流程",
        "function_point": "过压保护",
        "case_type": "功能",
        "steps": ["准备", "加压", "读状态"],
        "expected": ["保护置位"],
        "evidence": {"numbers": ["3.65V"]},
    }


class _FakeRunner:
    """假 pytest：按预设输出判定结果，让抽查逻辑本身可单测。"""

    def __init__(self, passing: set[str] | None = None, failing: set[str] | None = None) -> None:
        self.passing = passing or set()
        self.failing = failing or set()

    def __call__(self, argv, cwd, capture_output, text, timeout):
        names = [Path(arg).name for arg in argv if str(arg).endswith(".py")]
        lines = [
            f"PASSED {name}::test_case_x" for name in names if name in self.passing
        ] + [f"FAILED {name}::test_case_x" for name in names if name in self.failing]

        class _Result:
            stdout = "\n".join(lines)
            stderr = ""
            returncode = 1 if self.failing else 0

        return _Result()


def test_real_assertion_is_not_flagged(tmp_path) -> None:
    contract = dut_contract.parse(CONTRACT)
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir()
    normal = assertion_gen.generate(_case(), contract.entries["过压保护"], driver="_support/dut_sim.py", imports=["AfeSim"])
    mutant_name = f"_mutant_{__import__('autotest.workflow.scripts', fromlist=['x']).author_script(_case(), 'pytest', normal.body)['name']}"

    report = vacuity.check(
        scripts_dir,
        [_case()],
        contract,
        runner=_FakeRunner(failing={mutant_name}),
    )

    assert report["checked"] == 1
    assert report["vacuous"] == []
    assert report["errors"] == []
    # 变异体文件跑完必须删掉，不能留在项目里
    assert list(scripts_dir.glob("_mutant_*.py")) == []


def test_vacuous_assertion_is_flagged(tmp_path) -> None:
    """变异体通过 = 期望写反了还能过 = 这条断言没有判定力。"""
    contract = dut_contract.parse(CONTRACT)
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir()
    name = __import__("autotest.workflow.scripts", fromlist=["x"]).author_script(_case(), "pytest")["name"]
    mutant_name = f"_mutant_{name}"

    report = vacuity.check(
        scripts_dir,
        [_case()],
        contract,
        runner=_FakeRunner(passing={mutant_name}),
    )

    assert report["vacuous"] == ["过压保护-主流程"]


def test_cases_without_contract_are_skipped_not_flagged(tmp_path) -> None:
    contract = dut_contract.parse({"entries": []})
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir()

    report = vacuity.check(scripts_dir, [_case()], contract, runner=_FakeRunner())

    assert report["checked"] == 0
    assert report["skipped"] == [{"title": "过压保护-主流程", "reason": "missing_contract"}]


def test_invert_flips_the_expectation_not_the_input(tmp_path) -> None:
    contract = dut_contract.parse(CONTRACT)
    entry = contract.entries["过压保护"]
    normal = "\n".join(assertion_gen.generate(_case(), entry, driver="_support/dut_sim.py", imports=["AfeSim"]).body)
    mutant = "\n".join(assertion_gen.invert(_case(), entry, driver="_support/dut_sim.py", imports=["AfeSim"]))

    # 驱动输入保持一致（3.65 * 1.02），只有期望被写反
    assert "set_cell_voltage(0, 3.65 * 1.02)" in normal
    assert "set_cell_voltage(0, 3.65 * 1.02)" in mutant
    assert "is True" in normal
    assert "is False" in mutant


def test_script_author_reports_vacuity(client: TestClient) -> None:
    ws = server.WORKSPACE
    pid = client.post("/api/projects", json={"name": "抽查", "type": "api"}).json()["id"]
    parsed = client.post(
        f"/api/projects/{pid}/workflow/prd-parse", json={"text": SAMPLE, "module": "座舱"}
    ).json()
    client.post(
        f"/api/projects/{pid}/knowledge/documents/text",
        json={"title": "座舱需求.docx", "content": KNOWLEDGE},
    )
    client.post(f"/api/projects/{pid}/workflow/case-design", json={"run_id": parsed["data"]["run_id"]})
    client.put(f"/api/projects/{pid}/workflow/dut-contract", json=CONTRACT)

    # 放一份驱动进去，抽查才能真的跑起来
    scripts_dir = Path(ws) / pid / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    support = scripts_dir / "_support"
    support.mkdir(exist_ok=True)
    (support / "dut_sim.py").write_text(DRIVER, encoding="utf-8")

    authored = client.post(
        f"/api/projects/{pid}/workflow/script-author",
        json={"run_id": parsed["data"]["run_id"], "sdk": "pytest"},
    ).json()

    report = authored["data"]["vacuity"]
    assert report["checked"] >= 1, report
    assert report["vacuous"] == [], report
    # 抽查不留下变异体文件
    assert list(scripts_dir.glob("_mutant_*.py")) == []
