"""Agent 驱动的运行记录。

旧 `pipelines` 阶段机（服务端自己推进 step）已经删除，这里只记录
"Agent 调了哪个工具、拿到什么、卡在哪个待人工确认的决策"。
运行时序由 Agent 决定，这张表只负责让前端和下一次会话看见同一份事实。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime

WORKFLOW_SCHEMA = """
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module TEXT DEFAULT '',
    requirement_ref TEXT DEFAULT '',
    stage TEXT DEFAULT 'created',
    status TEXT DEFAULT 'running',
    session_id TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    tool TEXT NOT NULL,
    stage TEXT DEFAULT '',
    status TEXT DEFAULT 'ok',
    summary TEXT DEFAULT '',
    payload_json TEXT,
    error_code TEXT,
    started_at TEXT,
    ended_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id INTEGER,
    prompt TEXT NOT NULL,
    options TEXT DEFAULT '[]',
    answer TEXT DEFAULT '',
    note TEXT DEFAULT '',
    status TEXT DEFAULT 'waiting',
    created_at TEXT,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    module TEXT DEFAULT '',
    record_type TEXT NOT NULL,
    title TEXT DEFAULT '',
    content TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    source_ref TEXT DEFAULT '',
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS bugs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    script_name TEXT DEFAULT '',
    case_id TEXT DEFAULT '',
    title TEXT NOT NULL,
    severity TEXT DEFAULT 'major',
    status TEXT DEFAULT 'open',
    error_type TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    repro TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    occurrences INTEGER DEFAULT 1,
    last_run_id TEXT DEFAULT '',
    last_seen_at TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS bug_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bug_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    script_name TEXT DEFAULT '',
    execution_id TEXT DEFAULT '',
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bug_occurrences_run ON bug_occurrences(run_id);
"""

RUN_STAGES = ("created", "parsed", "designed", "reviewed", "authored", "executed", "reported")
RUN_STATUS = ("running", "waiting_human", "done", "failed", "cancelled")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


BUG_COLUMNS = {
    "signature": "TEXT DEFAULT ''",
    "occurrences": "INTEGER DEFAULT 1",
    "last_run_id": "TEXT DEFAULT ''",
    "last_seen_at": "TEXT",
}


def ensure_workflow_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(WORKFLOW_SCHEMA)
    # 老库的 bugs 表没有归并用的列，逐个补（ADD COLUMN 是幂等的，先查再补）
    existing = {row[1] for row in conn.execute("PRAGMA table_info(bugs)").fetchall()}
    for name, decl in BUG_COLUMNS.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE bugs ADD COLUMN {name} {decl}")
    # 补列前的老 bug 没有 signature，按脚本名 + 用例补算，否则永远归并不上
    rows = conn.execute("SELECT id, script_name, case_id FROM bugs WHERE signature = ''").fetchall()
    for bug_id, script_name, case_id in rows:
        conn.execute(
            "UPDATE bugs SET signature = ? WHERE id = ?",
            (_bug_signature(script_name or "", case_id or ""), bug_id),
        )
    # 老 bug 没有 occurrence 记录，补一条指向它自己的首次运行
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, created_at)"
        " SELECT b.id, b.run_id, b.script_name, b.created_at FROM bugs b"
        " WHERE NOT EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id)"
    )


def create_run(
    conn: sqlite3.Connection,
    project_id: str,
    module: str = "",
    requirement_ref: str = "",
    session_id: str = "",
) -> str:
    run_id = f"wf-{uuid.uuid4().hex[:10]}"
    now = _now()
    conn.execute(
        "INSERT INTO workflow_runs (id, project_id, module, requirement_ref, stage, status, session_id, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, 'created', 'running', ?, ?, ?)",
        (run_id, project_id, module, requirement_ref, session_id, now, now),
    )
    return run_id


def touch_run(conn: sqlite3.Connection, run_id: str, stage: str | None = None, status: str | None = None) -> None:
    sets = ["updated_at = ?"]
    values: list[object] = [_now()]
    if stage:
        sets.append("stage = ?")
        values.append(stage)
    if status:
        sets.append("status = ?")
        values.append(status)
    values.append(run_id)
    conn.execute(f"UPDATE workflow_runs SET {', '.join(sets)} WHERE id = ?", values)


def append_step(
    conn: sqlite3.Connection,
    run_id: str,
    tool: str,
    stage: str = "",
    status: str = "ok",
    summary: str = "",
    payload: dict | None = None,
    error_code: str = "",
    started_at: str | None = None,
) -> int:
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM workflow_steps WHERE run_id = ?", (run_id,)
    ).fetchone()[0]
    cursor = conn.execute(
        "INSERT INTO workflow_steps (run_id, seq, tool, stage, status, summary, payload_json, error_code, started_at, ended_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            run_id,
            seq,
            tool,
            stage,
            status,
            summary,
            json.dumps(payload, ensure_ascii=False) if payload is not None else None,
            error_code,
            started_at or _now(),
            _now(),
        ),
    )
    return int(cursor.lastrowid)


def close_latest_step(
    conn: sqlite3.Connection,
    run_id: str,
    tool: str,
    status: str = "ok",
    summary: str | None = None,
) -> int:
    """把某个工具最近一条「还挂在 running」的步骤收尾，返回受影响行数。

    投递执行时会先追加一条 `autotest_run`（status=running），真正的结果稍后由后台
    线程写成独立的 `autotest_run_result`。没有这一步收尾，run 的步骤列表里那条会
    永远停在 running，界面/Agent 都会以为还在跑。
    """
    row = conn.execute(
        "SELECT id FROM workflow_steps WHERE run_id = ? AND tool = ? AND status = 'running'"
        " ORDER BY seq DESC LIMIT 1",
        (run_id, tool),
    ).fetchone()
    if row is None:
        return 0
    if summary is None:
        conn.execute(
            "UPDATE workflow_steps SET status = ?, ended_at = ? WHERE id = ?",
            (status, _now(), row[0]),
        )
    else:
        conn.execute(
            "UPDATE workflow_steps SET status = ?, summary = ?, ended_at = ? WHERE id = ?",
            (status, summary, _now(), row[0]),
        )
    return 1


def create_decision(
    conn: sqlite3.Connection,
    run_id: str,
    prompt: str,
    options: list[str],
    step_id: int | None = None,
) -> str:
    decision_id = f"dec-{uuid.uuid4().hex[:8]}"
    conn.execute(
        "INSERT INTO workflow_decisions (id, run_id, step_id, prompt, options, answer, note, status, created_at)"
        " VALUES (?, ?, ?, ?, ?, '', '', 'waiting', ?)",
        (decision_id, run_id, step_id, prompt, json.dumps(options, ensure_ascii=False), _now()),
    )
    touch_run(conn, run_id, status="waiting_human")
    return decision_id


def decide(conn: sqlite3.Connection, decision_id: str, answer: str, note: str = "") -> dict | None:
    row = conn.execute("SELECT * FROM workflow_decisions WHERE id = ?", (decision_id,)).fetchone()
    if row is None:
        return None
    conn.execute(
        "UPDATE workflow_decisions SET answer = ?, note = ?, status = 'decided', decided_at = ? WHERE id = ?",
        (answer, note, _now(), decision_id),
    )
    run_id = row[1]
    remaining = conn.execute(
        "SELECT COUNT(*) FROM workflow_decisions WHERE run_id = ? AND status = 'waiting'", (run_id,)
    ).fetchone()[0]
    touch_run(conn, run_id, status="running" if remaining == 0 else "waiting_human")
    return {"id": decision_id, "run_id": run_id, "answer": answer, "status": "decided"}


def pending_decisions(conn: sqlite3.Connection, run_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, run_id, step_id, prompt, options, status, created_at"
        " FROM workflow_decisions WHERE run_id = ? AND status = 'waiting' ORDER BY created_at",
        (run_id,),
    ).fetchall()
    return [
        {
            "id": row[0],
            "run_id": row[1],
            "step_id": row[2],
            "prompt": row[3],
            "options": json.loads(row[4] or "[]"),
            "status": row[5],
            "created_at": row[6],
        }
        for row in rows
    ]


def get_run(conn: sqlite3.Connection, run_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    columns = [item[1] for item in conn.execute("PRAGMA table_info(workflow_runs)").fetchall()]
    run = dict(zip(columns, row))
    steps = conn.execute(
        "SELECT id, seq, tool, stage, status, summary, payload_json, error_code, started_at, ended_at"
        " FROM workflow_steps WHERE run_id = ? ORDER BY seq",
        (run_id,),
    ).fetchall()
    run["steps"] = [
        {
            "id": step[0],
            "seq": step[1],
            "tool": step[2],
            "stage": step[3],
            "status": step[4],
            "summary": step[5],
            "payload": json.loads(step[6]) if step[6] else None,
            "error_code": step[7],
            "started_at": step[8],
            "ended_at": step[9],
        }
        for step in steps
    ]
    run["pending"] = pending_decisions(conn, run_id)
    return run


def last_payload(conn: sqlite3.Connection, run_id: str, tool: str) -> dict | None:
    row = conn.execute(
        "SELECT payload_json FROM workflow_steps WHERE run_id = ? AND tool = ? ORDER BY seq DESC LIMIT 1",
        (run_id, tool),
    ).fetchone()
    if row is None or not row[0]:
        return None
    return json.loads(row[0])


def find_payload(conn: sqlite3.Connection, run_id: str, tool: str, key: str) -> dict | None:
    """同一个工具可能写多条步骤（如 report 的正文步骤与归档步骤），按 key 找到真正带数据的那条。"""
    rows = conn.execute(
        "SELECT payload_json FROM workflow_steps WHERE run_id = ? AND tool = ? ORDER BY seq DESC",
        (run_id, tool),
    ).fetchall()
    for row in rows:
        if not row[0]:
            continue
        try:
            payload = json.loads(row[0])
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get(key):
            return payload
    return None


def list_runs(conn: sqlite3.Connection, project_id: str, limit: int = 20) -> list[dict]:
    rows = conn.execute(
        "SELECT id, module, requirement_ref, stage, status, created_at, updated_at"
        " FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
        (project_id, limit),
    ).fetchall()
    return [
        {
            "id": row[0],
            "module": row[1],
            "requirement_ref": row[2],
            "stage": row[3],
            "status": row[4],
            "created_at": row[5],
            "updated_at": row[6],
        }
        for row in rows
    ]


def bug_signature(script_name: str, case_id: str) -> str:
    """同一用例反复失败应归并成一张缺陷单：脚本名 + 用例名（去掉每次运行的随机后缀）。"""
    key = f"{script_name.strip()}|{case_id.strip()}".encode("utf-8")
    return hashlib.sha1(key).hexdigest()[:16]


_bug_signature = bug_signature


def find_bug_by_signature(conn: sqlite3.Connection, signature: str) -> str | None:
    """找同一签名的缺陷单（只挑仍在追踪的状态，verified/wontfix 不再被子运行改写）。"""
    row = conn.execute(
        "SELECT id FROM bugs WHERE signature = ? AND status IN ('open', 'fixed')"
        " ORDER BY created_at ASC LIMIT 1",
        (signature,),
    ).fetchone()
    return row[0] if row else None


def create_bug(
    conn: sqlite3.Connection,
    run_id: str,
    title: str,
    script_name: str = "",
    case_id: str = "",
    severity: str = "major",
    error_type: str = "",
    summary: str = "",
    repro: str = "",
) -> str:
    """为一个失败用例记缺陷单；同一签名（脚本 + 用例）跨 run 归并，返回同一个 bug id。"""
    signature = _bug_signature(script_name, case_id)
    now = _now()
    existing = conn.execute(
        "SELECT id FROM bugs WHERE signature = ? AND status IN ('open', 'fixed')"
        " ORDER BY created_at ASC LIMIT 1",
        (signature,),
    ).fetchone()
    if existing is not None:
        bug_id = existing[0]
        conn.execute(
            "UPDATE bugs SET occurrences = occurrences + 1, last_run_id = ?, last_seen_at = ?,"
            " error_type = ?, summary = ?, repro = ? WHERE id = ?",
            (run_id, now, error_type, summary, repro, bug_id),
        )
        conn.execute(
            "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (bug_id, run_id, script_name, repro, now),
        )
        return bug_id

    bug_id = f"bug-{uuid.uuid4().hex[:8]}"
    conn.execute(
        "INSERT INTO bugs (id, run_id, script_name, case_id, title, severity, status,"
        " error_type, summary, repro, signature, occurrences, last_run_id, last_seen_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, ?, ?, ?)",
        (
            bug_id,
            run_id,
            script_name,
            case_id,
            title,
            severity,
            error_type,
            summary,
            repro,
            signature,
            run_id,
            now,
            now,
        ),
    )
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (bug_id, run_id, script_name, repro, now),
    )
    return bug_id


def bug_exists(conn: sqlite3.Connection, run_id: str, script_name: str) -> bool:
    """这个 run 的这个脚本是否已经记过缺陷（归并后 run_id 可能不是 bug 的首次运行）。"""
    row = conn.execute(
        "SELECT 1 FROM bug_occurrences WHERE run_id = ? AND script_name = ? LIMIT 1",
        (run_id, script_name),
    ).fetchone()
    return row is not None


BUG_STATUSES = ("open", "fixed", "verified", "wontfix")


def update_bug_status(conn: sqlite3.Connection, bug_id: str, status: str) -> bool:
    """人工流转缺陷状态；返回是否命中。"""
    if status not in BUG_STATUSES:
        raise ValueError(f"非法缺陷状态: {status}")
    row = conn.execute("SELECT 1 FROM bugs WHERE id = ?", (bug_id,)).fetchone()
    if row is None:
        return False
    conn.execute("UPDATE bugs SET status = ?, last_seen_at = ? WHERE id = ?", (status, _now(), bug_id))
    return True


def bug_visible_in_run(conn: sqlite3.Connection, bug_id: str, run_id: str) -> bool:
    """只允许改当前 run 里出现过的缺陷单，避免跨 run 误改。"""
    row = conn.execute(
        "SELECT 1 FROM bug_occurrences WHERE bug_id = ? AND run_id = ? LIMIT 1", (bug_id, run_id)
    ).fetchone()
    return row is not None


def record_occurrence(
    conn: sqlite3.Connection, bug_id: str, run_id: str, script_name: str, execution_id: str = ""
) -> None:
    """记一次「这张缺陷单在本 run 里被看到」（失败命中或修复验证都算）。"""
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (bug_id, run_id, script_name, execution_id, _now()),
    )


_BUG_COLUMNS = (
    "SELECT b.id, b.run_id, b.script_name, b.case_id, b.title, b.severity, b.status,"
    " b.error_type, b.summary, b.repro, b.created_at, b.occurrences, b.last_run_id,"
    " b.last_seen_at, b.signature FROM bugs b"
)

_BUG_IN_PROJECT = (
    " EXISTS (SELECT 1 FROM bug_occurrences o JOIN workflow_runs r ON r.id = o.run_id"
    " WHERE o.bug_id = b.id AND r.project_id = ?)"
)


def _bug_row(row: tuple) -> dict:
    return {
        "id": row[0],
        "run_id": row[1],
        "script_name": row[2],
        "case_id": row[3],
        "title": row[4],
        "severity": row[5],
        "status": row[6],
        "error_type": row[7],
        "summary": row[8],
        "repro": row[9],
        "created_at": row[10],
        "occurrences": row[11] or 1,
        "last_run_id": row[12] or row[1],
        "last_seen_at": row[13] or row[10],
        "signature": row[14] or "",
    }


def list_bugs(conn: sqlite3.Connection, run_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT b.id, b.run_id, b.script_name, b.case_id, b.title, b.severity, b.status,"
        " b.error_type, b.summary, b.repro, b.created_at, b.occurrences, b.last_run_id,"
        " b.last_seen_at, b.signature FROM bugs b"
        " JOIN bug_occurrences o ON o.bug_id = b.id"
        " WHERE o.run_id = ? GROUP BY b.id ORDER BY b.created_at ASC",
        (run_id,),
    ).fetchall()
    return [_bug_row(row) for row in rows]


def list_project_bugs(
    conn: sqlite3.Connection, project_id: str, status: str | None = None, limit: int = 100
) -> list[dict]:
    """项目级缺陷清单：按「最近一次出现」倒序，可选按状态过滤。"""
    if status is not None and status not in BUG_STATUSES:
        raise ValueError(f"非法缺陷状态: {status}")
    sql = _BUG_COLUMNS + " WHERE" + _BUG_IN_PROJECT
    params: list[object] = [project_id]
    if status:
        sql += " AND b.status = ?"
        params.append(status)
    sql += " ORDER BY b.last_seen_at DESC, b.created_at DESC LIMIT ?"
    params.append(max(1, min(int(limit), 500)))
    rows = conn.execute(sql, tuple(params)).fetchall()
    return [_bug_row(row) for row in rows]


def bug_in_project(conn: sqlite3.Connection, bug_id: str, project_id: str) -> bool:
    """缺陷单是否属于该项目的任意一次运行（跨 run 改状态时用）。"""
    row = conn.execute(
        "SELECT 1 FROM bugs b WHERE b.id = ? AND" + _BUG_IN_PROJECT, (bug_id, project_id)
    ).fetchone()
    return row is not None



def save_knowledge(
    conn: sqlite3.Connection,
    project_id: str,
    record_type: str,
    title: str,
    content: str,
    module: str = "",
    tags: list[str] | None = None,
    source_ref: str = "",
) -> int:
    cursor = conn.execute(
        "INSERT INTO knowledge_records (project_id, module, record_type, title, content, tags, source_ref, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (project_id, module, record_type, title, content, ",".join(tags or []), source_ref, _now()),
    )
    return int(cursor.lastrowid)


def search_knowledge(
    conn: sqlite3.Connection,
    project_id: str,
    query: str = "",
    module: str = "",
    tags: str = "",
    limit: int = 20,
) -> list[dict]:
    where = ["project_id = ?"]
    values: list[object] = [project_id]
    if module:
        where.append("module = ?")
        values.append(module)
    if tags:
        where.append("tags LIKE ?")
        values.append(f"%{tags}%")
    if query:
        where.append("(title LIKE ? OR content LIKE ?)")
        values.extend([f"%{query}%", f"%{query}%"])
    rows = conn.execute(
        f"SELECT id, module, record_type, title, substr(content, 1, 400), tags, source_ref, created_at"
        f" FROM knowledge_records WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT ?",
        (*values, limit),
    ).fetchall()
    return [
        {
            "id": row[0],
            "module": row[1],
            "record_type": row[2],
            "title": row[3],
            "excerpt": row[4],
            "tags": [item for item in str(row[5] or "").split(",") if item],
            "source_ref": row[6],
            "created_at": row[7],
        }
        for row in rows
    ]


def list_pending(conn: sqlite3.Connection, project_id: str, limit: int = 50) -> list[dict]:
    """项目级待办：跨 run 的所有 waiting 决策，带上它所属 run 的上下文。

    审批页只关心「现在等我点什么」，所以一次查全项目，不让前端按 run 逐个拉。
    """
    rows = conn.execute(
        "SELECT d.id, d.run_id, d.step_id, d.prompt, d.options, d.created_at,"
        " r.module, r.stage, r.status"
        " FROM workflow_decisions d JOIN workflow_runs r ON r.id = d.run_id"
        " WHERE r.project_id = ? AND d.status = 'waiting'"
        " ORDER BY d.created_at LIMIT ?",
        (project_id, limit),
    ).fetchall()
    return [
        {
            "id": row[0],
            "run_id": row[1],
            "step_id": row[2],
            "prompt": row[3],
            "options": json.loads(row[4] or "[]"),
            "created_at": row[5],
            "module": row[6],
            "stage": row[7],
            "run_status": row[8],
        }
        for row in rows
    ]
