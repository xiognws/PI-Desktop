"""Per-project schema migrations.

Project databases are created once and live in the user's workspace, so a
column added later must be added in place. Every step here is idempotent and
safe on a database created by an older build.

Why ``scripts.filepath`` matters: the create route always wrote the file and
inserted its absolute path, but the table definition omitted the column, so
every script route (list / content / save / run) failed with
``no such column: filepath`` on a project created by the current schema. The
migration adds the column and backfills it from ``<project>/scripts/<name>``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from autotest.executors.events import ensure_execution_tables
from autotest.workflow.store import ensure_workflow_tables


def ensure_project_schema(
    conn: sqlite3.Connection, scripts_dir: Path | None = None
) -> list[str]:
    """Bring one project database up to the current shape; return changes made."""
    changes: list[str] = []
    columns = {row[1] for row in conn.execute("PRAGMA table_info(scripts)").fetchall()}
    if columns and "filepath" not in columns:
        conn.execute("ALTER TABLE scripts ADD COLUMN filepath TEXT")
        changes.append("scripts.filepath")
        if scripts_dir is not None:
            backfilled = _backfill_script_paths(conn, Path(scripts_dir))
            if backfilled:
                changes.append(f"scripts.filepath backfilled x{backfilled}")
    ensure_execution_tables(conn)
    # 模型调用账本：老项目库里已经有这张表，新库要补建
    from autotest.pipelines.ledger import ensure_agent_call_table

    ensure_agent_call_table(conn)
    # Agent 驱动的运行记录（runs / steps / decisions / knowledge）
    ensure_workflow_tables(conn)
    return changes


def _backfill_script_paths(conn: sqlite3.Connection, scripts_dir: Path) -> int:
    rows = conn.execute("SELECT id, name FROM scripts WHERE filepath IS NULL").fetchall()
    filled = 0
    for script_id, name in rows:
        candidate = scripts_dir / str(name)
        if candidate.is_file():
            conn.execute(
                "UPDATE scripts SET filepath = ? WHERE id = ?", (str(candidate.resolve()), script_id)
            )
            filled += 1
    return filled
