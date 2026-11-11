"""项目库迁移测试：旧 schema（scripts 无 filepath）自愈。

回归来源：create/list/content/run 四条脚本路由都 SELECT filepath，而表定义
里没有该列，任何用当前版本建的项目调用都会 500。迁移必须补列并回填真实路径。
"""

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from autotest.storage.migrations import ensure_project_schema  # noqa: E402

OLD_SCHEMA = """
CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    case_id TEXT,
    name TEXT NOT NULL,
    language TEXT DEFAULT 'python',
    content TEXT,
    status TEXT DEFAULT '就绪',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE executions (
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


def test_migration_adds_filepath_and_backfills(tmp_path):
    project_dir = tmp_path / "proj"
    scripts_dir = project_dir / "scripts"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "check.py").write_text("print('ok')\n", encoding="utf-8")

    db_path = project_dir / "data.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(OLD_SCHEMA)
    conn.execute(
        "INSERT INTO scripts (id, name, language, content) VALUES ('s1', 'check.py', 'python', '')"
    )
    conn.commit()

    changes = ensure_project_schema(conn, scripts_dir)
    conn.commit()

    columns = {row[1] for row in conn.execute("PRAGMA table_info(scripts)")}
    assert "filepath" in columns
    row = conn.execute("SELECT filepath FROM scripts WHERE id = 's1'").fetchone()
    assert row[0] and Path(row[0]).is_file()
    assert "scripts.filepath" in changes

    execution_columns = {row[1] for row in conn.execute("PRAGMA table_info(executions)")}
    assert {"executor", "channel", "replay_hits", "model_calls"} <= execution_columns
    conn.close()


def test_migration_is_idempotent(tmp_path):
    project_dir = tmp_path / "proj"
    (project_dir / "scripts").mkdir(parents=True)
    db_path = project_dir / "data.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(OLD_SCHEMA)
    conn.commit()

    first = ensure_project_schema(conn, project_dir / "scripts")
    second = ensure_project_schema(conn, project_dir / "scripts")
    conn.close()

    assert "scripts.filepath" in first
    assert second == []
