"""执行器通道与 RunEvent v1 契约测试（不依赖 LLM / 网络 / 真实 workspace）。

覆盖范围：
- events：七类事件的必填字段、seq 单调、非法事件拒收
- python-native：成功 / 非零退出 / 超时，响应仍保留旧字段
- e2e-node：运行未就绪时的失败落地、伪 runner 的 NDJSON 逐行翻译
- 存储：execution_events 落库顺序、read_events 回放、executions 汇总列

跑法（项目根目录）：
    .venv\\Scripts\\python.exe -m pytest tests/test_executors.py -v
"""

import json
import shutil
import sqlite3
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from autotest.executors import events  # noqa: E402
from autotest.executors.service import execute_script, read_events  # noqa: E402

MINIMAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT,
    name TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    running INTEGER DEFAULT 0,
    status TEXT DEFAULT '执行中',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);
"""


def make_project(tmp_path: Path) -> tuple[Path, Path]:
    project_dir = tmp_path / "proj_test"
    project_dir.mkdir(parents=True, exist_ok=True)
    db_path = project_dir / "data.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(MINIMAL_SCHEMA)
    conn.commit()
    conn.close()
    return project_dir, db_path


def script_row(path: Path, language: str = "python", case_id: str | None = None) -> dict:
    return {
        "id": "scr_1",
        "name": path.name,
        "filepath": str(path),
        "language": language,
        "case_id": case_id,
    }


def event_types(result: dict) -> list[str]:
    return [event["type"] for event in result["events"]]


# ---------------------------------------------------------------- events ----


def test_event_builders_satisfy_the_contract(tmp_path):
    _, db_path = make_project(tmp_path)
    conn = sqlite3.connect(db_path)
    events.ensure_execution_tables(conn)
    conn.close()

    log = events.RunEventLog(db_path, 1)
    run_id = events.new_run_id()
    built = [
        events.run_start(run_id, "proj_test", ["case_1"], "api"),
        events.case_start(run_id, "case_1"),
        events.step_start(run_id, "case_1", "s1", 0, "driver", "do it"),
        events.step_end(run_id, "case_1", "s1", "pass", 12.5),
        events.artifact(run_id, "case_1", "report", "out/report.html", 42),
        events.case_end(run_id, "case_1", "pass", 20),
        events.run_end(run_id, "pass", {"pass": 1, "fail": 0, "skip": 0}, 25),
    ]
    for event in built:
        assert events.validate({**event, "seq": 0, "ts": events.now_iso()}) == []

    stamped = [log.append(event) for event in built]
    assert [event["seq"] for event in stamped] == list(range(len(built)))
    assert all(event["ts"] for event in stamped)


def test_invalid_event_is_refused(tmp_path):
    _, db_path = make_project(tmp_path)
    conn = sqlite3.connect(db_path)
    events.ensure_execution_tables(conn)
    conn.close()

    log = events.RunEventLog(db_path, 1)
    with pytest.raises(ValueError):
        log.append({"type": "step.end", "runId": "run_x"})  # 缺字段
    with pytest.raises(ValueError):
        log.append({"type": "nope", "runId": "run_x"})


# --------------------------------------------------------- python native ----


def test_python_script_passes_and_keeps_legacy_fields(tmp_path):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "pass.py"
    script.write_text('print("hello from case")\n', encoding="utf-8")

    result = execute_script(db_path, "proj_test", script_row(script), project_dir=project_dir)

    assert result["success"] is True
    assert result["returncode"] == 0
    assert "hello from case" in result["stdout"]
    assert result["executor"] == "python-native"
    assert event_types(result) == [
        "run.start",
        "case.start",
        "step.start",
        "step.end",
        "case.end",
        "run.end",
    ]
    assert result["events"][-1]["counts"] == {"pass": 1, "fail": 0, "skip": 0}

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM executions WHERE id = ?", (result["execution_id"],)).fetchone()
    assert row["status"] == "已完成"
    assert row["passed"] == 1
    assert row["executor"] == "python-native"


def test_python_script_failure_is_reported(tmp_path):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "fail.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys
            print("about to fail")
            sys.exit(3)
            """
        ),
        encoding="utf-8",
    )

    result = execute_script(db_path, "proj_test", script_row(script), project_dir=project_dir)

    assert result["success"] is False
    assert result["returncode"] == 3
    assert result["status"] == "fail"
    assert "about to fail" in result["stdout"]
    assert result["events"][-1]["counts"] == {"pass": 0, "fail": 1, "skip": 0}

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT status FROM executions WHERE id = ?", (result["execution_id"],)).fetchone()
    assert row["status"] == "失败"


def test_python_script_timeout_keeps_the_existing_message(tmp_path):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "slow.py"
    script.write_text("import time\ntime.sleep(5)\n", encoding="utf-8")

    result = execute_script(
        db_path, "proj_test", script_row(script), project_dir=project_dir, timeout_s=0.5
    )

    assert result["success"] is False
    assert "脚本执行超时" in result["stderr"]
    assert result["events"][-1]["status"] == "fail"


# ------------------------------------------------------------- e2e node ----


def test_e2e_without_runtime_fails_with_a_provenance_message(tmp_path, monkeypatch):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "case.e2e.ts"
    script.write_text("// placeholder\n", encoding="utf-8")
    monkeypatch.delenv("AUTOTEST_E2E_RUNNER", raising=False)

    result = execute_script(
        db_path, "proj_test", script_row(script, language="e2e"), project_dir=project_dir
    )

    assert result["success"] is False
    assert result["executor"] == "e2e-node"
    assert "not provisioned" in (result["failure"] or "")
    assert event_types(result)[-2:] == ["case.end", "run.end"]
    assert result["events"][-2]["status"] == "error"


def test_e2e_runner_stream_is_translated(tmp_path, monkeypatch):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "case.e2e.ts"
    script.write_text("// @target http://127.0.0.1:9999\n// placeholder\n", encoding="utf-8")

    fake_home = tmp_path / "e2e-home"
    (fake_home / "node_modules" / "e2e").mkdir(parents=True)
    (fake_home / "node_modules" / "e2e" / "package.json").write_text("{}", encoding="utf-8")

    fake_runner = tmp_path / "fake-runner.mjs"
    fake_runner.write_text(
        textwrap.dedent(
            """
            const lines = [
              { type: "step.start", caseId: "x", stepId: "open", index: 1, kind: "act", label: "open /" },
              { type: "step.end", caseId: "x", stepId: "open", status: "pass", durationMs: 41, replayHit: true },
              { type: "artifact", caseId: "x", kind: "screenshot", path: "shot.png", bytes: 10 },
              { type: "case.end", caseId: "x", status: "pass", durationMs: 55 },
            ];
            for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
            """
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("AUTOTEST_E2E_RUNNER", str(fake_runner))
    monkeypatch.setenv("AUTOTEST_E2E_HOME", str(fake_home))
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not on PATH")
    monkeypatch.setenv("AUTOTEST_E2E_NODE", node)

    result = execute_script(
        db_path, "proj_test", script_row(script, language="e2e"), project_dir=project_dir
    )

    assert result["executor"] == "e2e-node"
    translated = [event for event in result["events"] if event["type"] == "artifact"]
    assert translated and translated[0]["path"] == "shot.png"
    assert any(event["replayHit"] for event in result["events"] if event["type"] == "step.end")
    # 伪 runner 用 node.exe 启动时可能不存在 → 仅断言翻译链路，不绑定退出码
    assert result["events"][-1]["type"] == "run.end"


def test_relative_script_path_is_resolved(tmp_path, monkeypatch):
    """create_script 曾把相对路径写进 filepath；执行端必须按 cwd 解析成绝对路径。"""
    project_dir, db_path = make_project(tmp_path)
    (project_dir / "rel.py").write_text('print("rel ok")\n', encoding="utf-8")
    monkeypatch.chdir(project_dir)

    result = execute_script(
        db_path,
        "proj_test",
        {"id": "s_rel", "name": "rel.py", "filepath": "rel.py", "language": "python", "case_id": None},
        project_dir=project_dir,
    )

    assert result["success"] is True
    assert "rel ok" in result["stdout"]


# ------------------------------------------------------------ cancelling ----


def test_running_case_can_be_cancelled(tmp_path):
    """取消要在轮询粒度内生效：脚本还在跑时发取消，run 以 cancelled 收尾。"""
    import threading
    import time

    from autotest.executors.service import RUNNING, cancel_execution

    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "long.py"
    script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")

    result: dict = {}

    def run_case():
        result.update(
            execute_script(
                db_path,
                "proj_test",
                script_row(script),
                project_dir=project_dir,
                timeout_s=60,
            )
        )

    worker = threading.Thread(target=run_case, daemon=True)
    worker.start()

    key = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and key is None:
        key = next(iter(RUNNING), None)
        time.sleep(0.05)
    assert key, "the run never registered itself"

    execution_id = int(key.split(":")[1])
    started_cancel = time.monotonic()
    assert cancel_execution("proj_test", execution_id) is True
    worker.join(timeout=10)
    cancel_latency = time.monotonic() - started_cancel

    assert not worker.is_alive(), "the run ignored the cancel"
    assert cancel_latency < 5, f"cancellation took {cancel_latency:.1f}s"
    assert result["status"] == "cancelled"
    assert result["events"][-1]["status"] == "cancelled"
    assert result["events"][-1]["counts"] == {"pass": 0, "fail": 0, "skip": 1}

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT status FROM executions WHERE id = ?", (execution_id,)
        ).fetchone()
    assert row["status"] == "已取消"


def test_cancelling_a_finished_run_reports_false(tmp_path):
    from autotest.executors.service import cancel_execution

    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "ok.py"
    script.write_text("print('done')\n", encoding="utf-8")
    result = execute_script(db_path, "proj_test", script_row(script), project_dir=project_dir)

    assert cancel_execution("proj_test", result["execution_id"]) is False


# --------------------------------------------------------------- storage ----


def test_events_are_persisted_in_seq_order(tmp_path):
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "pass.py"
    script.write_text('print("ok")\n', encoding="utf-8")

    result = execute_script(db_path, "proj_test", script_row(script), project_dir=project_dir)
    replayed = read_events(db_path, result["execution_id"])

    assert [event["seq"] for event in replayed] == list(range(len(result["events"])))
    assert replayed == result["events"]
    for event in replayed:
        assert events.validate(event) == []


def test_case_result_is_written_back_to_execution_cases(tmp_path):
    """执行结束要把结果写到 execution_cases 和 test_cases.status（以前两处都没写）。"""
    project_dir, db_path = make_project(tmp_path)
    script = project_dir / "fail.py"
    script.write_text("assert False, 'expected 1 got 0'\n", encoding="utf-8")

    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS test_cases (id TEXT PRIMARY KEY, title TEXT, status TEXT, "
        "module_id TEXT, case_type TEXT, priority TEXT, tags TEXT, favorite INTEGER, "
        "precondition TEXT, steps TEXT, expected TEXT, updated_at TIMESTAMP)"
    )
    conn.execute("INSERT INTO test_cases (id, title, status) VALUES ('case_1', '首页展示', '未执行')")
    conn.commit()
    conn.close()

    result = execute_script(
        db_path, "proj_test", script_row(script, case_id="case_1"), project_dir=project_dir
    )
    assert result["status"] == "fail"

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT case_id, result, error_message FROM execution_cases WHERE execution_id = ?",
        (result["execution_id"],),
    ).fetchone()
    status = conn.execute("SELECT status FROM test_cases WHERE id = 'case_1'").fetchone()[0]
    conn.close()

    assert row[0] == "case_1"
    assert row[1] == "失败"
    assert "expected 1 got 0" in (row[2] or "")
    assert status == "失败"
