"""Test pipeline: the rule layer between the Desktop agent and the platform.

A pipeline is a durable, inspectable state machine. The model work happens in
the plugin (it borrows the Desktop model via `pi.agent.complete`); this module
owns the stage order, the output schemas, the retry/stop rules and the audit
rows, so a bad model answer can never silently advance the run.

Stage order for this batch: analyze → design → author → gate → ready.
`execute / judge / repair / report` land in the next batch.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

STAGES: tuple[str, ...] = (
    "analyze",
    "design",
    "author",
    "gate",
    "execute",
    "judge",
    "repair",
    "report",
)
# 修复轮上限：超过就带着失败进报告，绝不无限重试
MAX_REPAIR_ROUNDS = 2
VERDICTS = ("pass", "fail", "error", "cancelled")
TARGET_HEADER = "// @target"

CHECKPOINT_POLICIES: dict[str, tuple[str, ...]] = {
    # pause after these stages; everything else keeps running
    "auto": (),
    "analyze": ("analyze",),
    "analyze_author": ("analyze", "author"),
}

MAX_FUNCTION_POINTS = 200
MAX_CASES = 200
MAX_SCRIPTS = 200

PIPELINE_SCHEMA = """
CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    requirement_filename TEXT,
    status TEXT DEFAULT 'running',
    current_stage TEXT,
    checkpoint_policy TEXT DEFAULT 'analyze',
    model_key TEXT,
    target_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pipeline_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    attempt INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    input_json TEXT,
    output_json TEXT,
    error TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    started_at TIMESTAMP,
    finished_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_run ON pipeline_stages (pipeline_id, stage);
CREATE TABLE IF NOT EXISTS agent_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id TEXT,
    stage TEXT,
    model_key TEXT,
    prompt_hash TEXT,
    output_hash TEXT,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    accepted INTEGER DEFAULT 0,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


class PipelineRuleError(ValueError):
    """A stage output or transition broke a rule; the run must not advance."""


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]


def mark_interrupted_runs(db_path: Path) -> int:
    """收尾上一个进程留下的 running 行。

    后端被强杀时没有任何人写结束状态，于是流水线会永远"在跑"：面板时间线、
    状态栏、定时监督器全都在等一个不存在的执行。启动时把这类行判成失败，
    并保留出错阶段，比让它们假装还活着诚实。
    """
    if not db_path.exists():
        return 0
    conn = sqlite3.connect(db_path)
    try:
        pending = conn.execute(
            "SELECT COUNT(*) FROM pipelines WHERE status = 'running'"
        ).fetchone()[0]
        if not pending:
            return 0
        conn.execute(
            "UPDATE pipelines SET status = 'failed', finished_at = CURRENT_TIMESTAMP "
            "WHERE status = 'running'"
        )
        conn.execute(
            "UPDATE pipeline_stages SET status = 'failed', "
            "error = COALESCE(error, 'backend restarted while this stage was running'), "
            "finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) "
            "WHERE status = 'running'"
        )
        conn.commit()
        return int(pending)
    except sqlite3.Error:
        return 0
    finally:
        conn.close()


def ensure_pipeline_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(PIPELINE_SCHEMA)
    # 老库补列：target_url 是后加的（e2e 用例必须知道被测应用地址）
    columns = {row[1] for row in conn.execute("PRAGMA table_info(pipelines)").fetchall()}
    if columns and "target_url" not in columns:
        conn.execute("ALTER TABLE pipelines ADD COLUMN target_url TEXT")


def next_stage(stage: str) -> str | None:
    try:
        index = STAGES.index(stage)
    except ValueError:
        return None
    return STAGES[index + 1] if index + 1 < len(STAGES) else None


def successor(stage: str, output: dict[str, Any], repair_rounds: int) -> str | None:
    """Where the run goes after ``stage`` finished.

    ``judge`` is the only branch point: failures send the run to ``repair`` (at
    most ``MAX_REPAIR_ROUNDS`` times), otherwise straight to ``report``. A repair
    round always goes back to ``execute`` — a patch without a re-run is not
    evidence.
    """
    if stage == "judge":
        counts = output.get("counts") or {}
        broken = int(counts.get("fail") or 0) + int(counts.get("error") or 0)
        if broken and repair_rounds < MAX_REPAIR_ROUNDS:
            return "repair"
        return "report"
    if stage == "repair":
        return "execute"
    if stage == "report":
        return None
    return next_stage(stage)


def should_wait(policy: str, stage: str) -> bool:
    return stage in CHECKPOINT_POLICIES.get(policy, CHECKPOINT_POLICIES["analyze"])


# --------------------------------------------------------------- validation ----


def _require_list(payload: dict[str, Any], key: str, limit: int) -> list[Any]:
    value = payload.get(key)
    if not isinstance(value, list) or not value:
        raise PipelineRuleError(f"{key} must be a non-empty array")
    if len(value) > limit:
        raise PipelineRuleError(f"{key} has {len(value)} entries, limit is {limit}")
    return value


def validate_analyze(payload: dict[str, Any]) -> dict[str, Any]:
    points = _require_list(payload, "function_points", MAX_FUNCTION_POINTS)
    normalized: list[dict[str, Any]] = []
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            raise PipelineRuleError(f"function_points[{index}] must be an object")
        name = str(point.get("name", "")).strip()
        if not name:
            raise PipelineRuleError(f"function_points[{index}].name is required")
        normalized.append(
            {
                "name": name,
                "module": str(point.get("module", "")).strip(),
                "description": str(point.get("description", "")).strip(),
                "priority": str(point.get("priority", "中")).strip() or "中",
            }
        )
    return {"function_points": normalized}


def validate_design(payload: dict[str, Any]) -> dict[str, Any]:
    cases = _require_list(payload, "cases", MAX_CASES)
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, case in enumerate(cases):
        if not isinstance(case, dict):
            raise PipelineRuleError(f"cases[{index}] must be an object")
        title = str(case.get("title", "")).strip()
        if not title:
            raise PipelineRuleError(f"cases[{index}].title is required")
        if title in seen:
            raise PipelineRuleError(f"duplicate case title: {title}")
        seen.add(title)
        steps = case.get("steps")
        if isinstance(steps, list):
            steps_text = "\n".join(str(step).strip() for step in steps if str(step).strip())
        else:
            steps_text = str(steps or "").strip()
        if not steps_text:
            raise PipelineRuleError(f"cases[{index}].steps is required")
        expected = str(case.get("expected", "")).strip()
        if not expected:
            raise PipelineRuleError(f"cases[{index}].expected is required")
        normalized.append(
            {
                "title": title,
                "function_point": str(case.get("function_point", "")).strip(),
                "steps": steps_text,
                "expected": expected,
                "priority": str(case.get("priority", "中")).strip() or "中",
                "scene": str(case.get("scene", "正向")).strip() or "正向",
                "case_type": str(case.get("case_type", "正向")).strip() or "正向",
            }
        )
    return {"cases": normalized}


def validate_author(payload: dict[str, Any]) -> dict[str, Any]:
    scripts = _require_list(payload, "scripts", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, script in enumerate(scripts):
        if not isinstance(script, dict):
            raise PipelineRuleError(f"scripts[{index}] must be an object")
        name = str(script.get("name", "")).strip()
        content = str(script.get("content", ""))
        if not name:
            raise PipelineRuleError(f"scripts[{index}].name is required")
        language = str(script.get("language", "e2e")).strip().lower()
        if language not in ("python", "e2e"):
            raise PipelineRuleError(f"scripts[{index}].language must be python or e2e")
        if not content.strip():
            raise PipelineRuleError(f"scripts[{index}].content is required")
        if language == "e2e" and TARGET_HEADER not in content.splitlines()[0]:
            raise PipelineRuleError(
                f"scripts[{index}] is e2e but its first line has no `{TARGET_HEADER} <url>`"
            )
        case_ref = script.get("case_title") or script.get("case_id") or script.get("case")
        normalized.append(
            {
                "name": name,
                "language": language,
                "content": content,
                "case_title": str(case_ref or "").strip(),
            }
        )
    return {"scripts": normalized}


def validate_gate(payload: dict[str, Any]) -> dict[str, Any]:
    failures = payload.get("failures") or []
    if not isinstance(failures, list):
        raise PipelineRuleError("gate.failures must be an array")
    ok = bool(payload.get("ok")) and not failures
    return {"ok": ok, "failures": [str(item) for item in failures]}


def validate_execute(payload: dict[str, Any]) -> dict[str, Any]:
    runs = _require_list(payload, "executions", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, run in enumerate(runs):
        if not isinstance(run, dict):
            raise PipelineRuleError(f"executions[{index}] must be an object")
        for field in ("scriptId", "executionId", "status"):
            if run.get(field) in (None, ""):
                raise PipelineRuleError(f"executions[{index}].{field} is required")
        if str(run["status"]) not in VERDICTS:
            raise PipelineRuleError(f"executions[{index}].status must be one of {VERDICTS}")
        counts = run.get("counts") or {}
        normalized.append(
            {
                "scriptId": str(run["scriptId"]),
                "scriptName": str(run.get("scriptName", "")),
                "caseId": str(run.get("caseId", "")),
                "executionId": int(run["executionId"]),
                "status": str(run["status"]),
                "durationMs": float(run.get("durationMs") or 0.0),
                "failure": str(run.get("failure") or ""),
                "artifacts": [
                    {"kind": str(item.get("kind", "log")), "path": str(item.get("path", ""))}
                    for item in (run.get("artifacts") or [])
                    if isinstance(item, dict) and item.get("path")
                ],
                "counts": {
                    "pass": int(counts.get("pass") or 0),
                    "fail": int(counts.get("fail") or 0),
                    "skip": int(counts.get("skip") or 0),
                },
            }
        )
    return {"executions": normalized}


def validate_judge(payload: dict[str, Any]) -> dict[str, Any]:
    results = _require_list(payload, "results", MAX_SCRIPTS)
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            raise PipelineRuleError(f"results[{index}] must be an object")
        verdict = str(item.get("verdict", "")).strip()
        if verdict not in VERDICTS:
            raise PipelineRuleError(f"results[{index}].verdict must be one of {VERDICTS}")
        normalized.append(
            {
                "scriptId": str(item.get("scriptId", "")),
                "scriptName": str(item.get("scriptName", "")),
                "caseId": str(item.get("caseId", "")),
                "caseTitle": str(item.get("caseTitle", "")),
                "verdict": verdict,
                "reason": str(item.get("reason", "")),
                "durationMs": float(item.get("durationMs") or 0.0),
            }
        )
    counts = {"pass": 0, "fail": 0, "error": 0, "cancelled": 0}
    for item in normalized:
        counts[item["verdict"]] += 1
    return {"results": normalized, "counts": counts}


def validate_repair(payload: dict[str, Any]) -> dict[str, Any]:
    patched = payload.get("patched") or []
    if not isinstance(patched, list):
        raise PipelineRuleError("patched must be an array")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(patched):
        if not isinstance(item, dict):
            raise PipelineRuleError(f"patched[{index}] must be an object")
        script_id = str(item.get("scriptId", "")).strip()
        if not script_id:
            raise PipelineRuleError(f"patched[{index}].scriptId is required")
        content = str(item.get("content", ""))
        if not content.strip():
            raise PipelineRuleError(f"patched[{index}].content is required")
        note = str(item.get("note", "")).strip()
        if not note:
            raise PipelineRuleError(
                f"patched[{index}].note is required: a patch must name the failure it fixes"
            )
        normalized.append(
            {
                "scriptId": script_id,
                "scriptName": str(item.get("scriptName", "")),
                "note": note,
                "content": content,
            }
        )
    if not normalized:
        raise PipelineRuleError("repair produced no patched script; nothing to re-run")
    return {"patched": normalized}


def validate_report(payload: dict[str, Any]) -> dict[str, Any]:
    markdown = str(payload.get("markdown", "")).strip()
    if len(markdown) < 80:
        raise PipelineRuleError("report markdown is too short to be evidence")
    counts = payload.get("counts") or {}
    return {
        "name": str(payload.get("name", "测试报告")),
        "markdown": markdown,
        "counts": {
            "pass": int(counts.get("pass") or 0),
            "fail": int(counts.get("fail") or 0),
            "error": int(counts.get("error") or 0),
            "cancelled": int(counts.get("cancelled") or 0),
        },
    }


VALIDATORS = {
    "analyze": validate_analyze,
    "design": validate_design,
    "author": validate_author,
    "gate": validate_gate,
    "execute": validate_execute,
    "judge": validate_judge,
    "repair": validate_repair,
    "report": validate_report,
}


# ------------------------------------------------------------------ storage ----


def _conn(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(Path(db_path))
    conn.row_factory = sqlite3.Row
    ensure_pipeline_tables(conn)
    return conn


def _new_id() -> str:
    return f"pipe_{uuid.uuid4().hex[:10]}"


def create_pipeline(
    db_path: Path,
    project_id: str,
    requirement_filename: str,
    checkpoint_policy: str = "analyze",
    model_key: str = "",
    target_url: str = "",
) -> dict[str, Any]:
    if checkpoint_policy not in CHECKPOINT_POLICIES:
        raise PipelineRuleError(
            f"checkpoint_policy must be one of {sorted(CHECKPOINT_POLICIES)}"
        )
    pipeline_id = _new_id()
    conn = _conn(db_path)
    try:
        conn.execute(
            "INSERT INTO pipelines (id, project_id, requirement_filename, status, current_stage, "
            "checkpoint_policy, model_key, target_url) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)",
            (
                pipeline_id,
                project_id,
                requirement_filename,
                STAGES[0],
                checkpoint_policy,
                model_key,
                target_url,
            ),
        )
        conn.execute(
            "INSERT INTO pipeline_stages (pipeline_id, stage, status, started_at) "
            "VALUES (?, ?, 'running', CURRENT_TIMESTAMP)",
            (pipeline_id, STAGES[0]),
        )
        conn.commit()
    finally:
        conn.close()
    return get_pipeline(db_path, pipeline_id)


def get_pipeline(db_path: Path, pipeline_id: str) -> dict[str, Any]:
    conn = _conn(db_path)
    try:
        row = conn.execute("SELECT * FROM pipelines WHERE id = ?", (pipeline_id,)).fetchone()
        if not row:
            raise PipelineRuleError(f"pipeline not found: {pipeline_id}")
        stages = conn.execute(
            "SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY id",
            (pipeline_id,),
        ).fetchall()
        calls = conn.execute(
            "SELECT stage, model_key, tokens_in, tokens_out, accepted, reason, created_at "
            "FROM agent_calls WHERE pipeline_id = ? ORDER BY id",
            (pipeline_id,),
        ).fetchall()
    finally:
        conn.close()
    return {
        "pipeline": dict(row),
        "stages": [_stage_row(stage) for stage in stages],
        "agent_calls": [dict(call) for call in calls],
    }


def list_pipelines(db_path: Path, project_id: str) -> list[dict[str, Any]]:
    conn = _conn(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM pipelines WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def _stage_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    for key in ("input_json", "output_json"):
        if data.get(key):
            try:
                data[key] = json.loads(data[key])
            except json.JSONDecodeError:
                pass
    return data


def record_agent_call(
    db_path: Path,
    pipeline_id: str,
    stage: str,
    model_key: str,
    prompt: str,
    output: str,
    tokens_in: int,
    tokens_out: int,
    accepted: bool,
    reason: str = "",
) -> None:
    conn = _conn(db_path)
    try:
        conn.execute(
            "INSERT INTO agent_calls (pipeline_id, stage, model_key, prompt_hash, output_hash, "
            "tokens_in, tokens_out, accepted, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                pipeline_id,
                stage,
                model_key,
                hash_text(prompt),
                hash_text(output),
                int(tokens_in),
                int(tokens_out),
                1 if accepted else 0,
                reason,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def report_stage(
    db_path: Path,
    pipeline_id: str,
    stage: str,
    status: str,
    output: dict[str, Any] | None = None,
    error: str = "",
    tokens_in: int = 0,
    tokens_out: int = 0,
) -> dict[str, Any]:
    """Record one stage result and apply the advance rules."""
    current = get_pipeline(db_path, pipeline_id)
    pipeline = current["pipeline"]
    if pipeline["status"] in ("done", "cancelled", "failed"):
        raise PipelineRuleError(f"pipeline is {pipeline['status']}, cannot report {stage}")
    if stage != pipeline["current_stage"]:
        raise PipelineRuleError(
            f"stage {stage} is not current (current: {pipeline['current_stage']})"
        )

    payload = output or {}
    validated: dict[str, Any] = {}
    if status == "done":
        try:
            validated = VALIDATORS[stage](payload)
        except PipelineRuleError as rule_error:
            _fail_stage(db_path, pipeline_id, stage, str(rule_error))
            raise

    conn = _conn(db_path)
    try:
        attempt = conn.execute(
            "SELECT MAX(attempt) FROM pipeline_stages WHERE pipeline_id = ? AND stage = ?",
            (pipeline_id, stage),
        ).fetchone()[0] or 1
        conn.execute(
            "UPDATE pipeline_stages SET status = ?, output_json = ?, error = ?, tokens_in = ?, "
            "tokens_out = ?, finished_at = CURRENT_TIMESTAMP "
            "WHERE pipeline_id = ? AND stage = ? AND attempt = ?",
            (
                status,
                json.dumps(validated, ensure_ascii=False) if validated else None,
                error or None,
                int(tokens_in),
                int(tokens_out),
                pipeline_id,
                stage,
                attempt,
            ),
        )
        if status != "done":
            conn.execute(
                "UPDATE pipelines SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
                (pipeline_id,),
            )
            conn.commit()
            return get_pipeline(db_path, pipeline_id)

        # 静态闸门未通过 = 整条流水线失败：没有"带病进入待执行"这种状态
        if stage == "gate" and not validated.get("ok", False):
            failures = "; ".join(validated.get("failures") or ["静态闸门未通过"])
            conn.execute(
                "UPDATE pipeline_stages SET error = ? WHERE pipeline_id = ? AND stage = ? AND attempt = ?",
                (f"静态闸门未通过：{failures}", pipeline_id, stage, attempt),
            )
            conn.execute(
                "UPDATE pipelines SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
                (pipeline_id,),
            )
            conn.commit()
            return get_pipeline(db_path, pipeline_id)

        if should_wait(str(pipeline["checkpoint_policy"]), stage):
            conn.execute(
                "UPDATE pipelines SET status = 'waiting', current_stage = ? WHERE id = ?",
                (stage, pipeline_id),
            )
            conn.commit()
            return get_pipeline(db_path, pipeline_id)

        rounds = conn.execute(
            "SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id = ? AND stage = 'repair' "
            "AND status = 'done'",
            (pipeline_id,),
        ).fetchone()[0] or 0
        if stage == "report":
            _persist_report(conn, db_path, pipeline_id, validated)
        following = successor(stage, validated, int(rounds))
        if following is None:
            conn.execute(
                "UPDATE pipelines SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
                (pipeline_id,),
            )
        else:
            conn.execute(
                "UPDATE pipelines SET current_stage = ? WHERE id = ?", (following, pipeline_id)
            )
            conn.execute(
                "INSERT INTO pipeline_stages (pipeline_id, stage, attempt, status, started_at) "
                "VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)",
                (pipeline_id, following, _next_attempt(conn, pipeline_id, following)),
            )
        conn.commit()
    finally:
        conn.close()
    return get_pipeline(db_path, pipeline_id)


def _next_attempt(conn: sqlite3.Connection, pipeline_id: str, stage: str) -> int:
    """重复进入同一段（repair → execute 循环）时必须递增 attempt。

    否则第二次 execute/judge 会 UPDATE 掉第一次那行，报告里就只剩最后一轮，
    "修复前后各一份证据"这个要求当场失效。
    """
    row = conn.execute(
        "SELECT MAX(attempt) FROM pipeline_stages WHERE pipeline_id = ? AND stage = ?",
        (pipeline_id, stage),
    ).fetchone()
    return int((row[0] or 0) + 1)


def _persist_report(
    conn: sqlite3.Connection, db_path: Path, pipeline_id: str, report: dict[str, Any]
) -> Path:
    """报告落盘 + 落库：markdown 文件是可点开的证据，reports 行给报告页用。"""
    project_dir = Path(db_path).parent
    reports_dir = project_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    path = reports_dir / f"{pipeline_id}.md"
    path.write_text(str(report.get("markdown", "")), encoding="utf-8")

    counts = report.get("counts") or {}
    passed = int(counts.get("pass") or 0)
    failed = int(counts.get("fail") or 0) + int(counts.get("error") or 0)
    total = passed + failed + int(counts.get("cancelled") or 0)
    rate = (passed / total * 100.0) if total else 0.0
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
            "total INTEGER DEFAULT 0, passed INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, "
            "pass_rate TEXT, execution_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO reports (id, name, total, passed, failed, pass_rate) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (pipeline_id, str(report.get("name", "测试报告")), total, passed, failed, f"{rate:.1f}%"),
        )
    except sqlite3.Error:
        # 报告文件已经写成；报表页缺一行不影响流水线结论
        pass
    return path


def read_report(db_path: Path, pipeline_id: str) -> str | None:
    path = Path(db_path).parent / "reports" / f"{pipeline_id}.md"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def _fail_stage(db_path: Path, pipeline_id: str, stage: str, error: str) -> None:
    conn = _conn(db_path)
    try:
        conn.execute(
            "UPDATE pipeline_stages SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP "
            "WHERE pipeline_id = ? AND stage = ?",
            (error, pipeline_id, stage),
        )
        conn.execute(
            "UPDATE pipelines SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
            (pipeline_id,),
        )
        conn.commit()
    finally:
        conn.close()


def resume(db_path: Path, pipeline_id: str, action: str) -> dict[str, Any]:
    """``approve`` continues from the paused stage, ``retry`` re-runs it."""
    current = get_pipeline(db_path, pipeline_id)
    pipeline = current["pipeline"]
    if pipeline["status"] != "waiting":
        raise PipelineRuleError(f"pipeline is {pipeline['status']}, nothing to {action}")
    stage = pipeline["current_stage"]

    conn = _conn(db_path)
    try:
        if action == "approve":
            approved_output = {}
            row = conn.execute(
                "SELECT output_json FROM pipeline_stages WHERE pipeline_id = ? AND stage = ? "
                "AND status = 'done' ORDER BY id DESC LIMIT 1",
                (pipeline_id, stage),
            ).fetchone()
            if row and row[0]:
                try:
                    approved_output = json.loads(row[0])
                except json.JSONDecodeError:
                    approved_output = {}
            rounds = conn.execute(
                "SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id = ? AND stage = 'repair' "
                "AND status = 'done'",
                (pipeline_id,),
            ).fetchone()[0] or 0
            following = successor(stage, approved_output, int(rounds))
            if following is None:
                conn.execute(
                    "UPDATE pipelines SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (pipeline_id,),
                )
            else:
                conn.execute(
                    "UPDATE pipelines SET status = 'running', current_stage = ? WHERE id = ?",
                    (following, pipeline_id),
                )
                conn.execute(
                    "INSERT INTO pipeline_stages (pipeline_id, stage, attempt, status, started_at) "
                    "VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)",
                    (pipeline_id, following, _next_attempt(conn, pipeline_id, following)),
                )
        elif action == "retry":
            attempt = conn.execute(
                "SELECT MAX(attempt) FROM pipeline_stages WHERE pipeline_id = ? AND stage = ?",
                (pipeline_id, stage),
            ).fetchone()[0] or 1
            conn.execute(
                "UPDATE pipeline_stages SET status = 'superseded', finished_at = CURRENT_TIMESTAMP "
                "WHERE pipeline_id = ? AND stage = ? AND attempt = ?",
                (pipeline_id, stage, attempt),
            )
            conn.execute(
                "INSERT INTO pipeline_stages (pipeline_id, stage, attempt, status, started_at) "
                "VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)",
                (pipeline_id, stage, attempt + 1),
            )
            conn.execute("UPDATE pipelines SET status = 'running' WHERE id = ?", (pipeline_id,))
        else:
            raise PipelineRuleError(f"unknown action: {action}")
        conn.commit()
    finally:
        conn.close()
    return get_pipeline(db_path, pipeline_id)


def cancel(db_path: Path, pipeline_id: str) -> dict[str, Any]:
    conn = _conn(db_path)
    try:
        conn.execute(
            "UPDATE pipelines SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ?",
            (pipeline_id,),
        )
        conn.execute(
            "UPDATE pipeline_stages SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP "
            "WHERE pipeline_id = ? AND status IN ('pending', 'running')",
            (pipeline_id,),
        )
        conn.commit()
    finally:
        conn.close()
    return get_pipeline(db_path, pipeline_id)
