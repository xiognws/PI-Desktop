"""SQLite 存储"""
import sqlite3
from pathlib import Path
from contextlib import contextmanager

DEFAULT_DB = Path("data/autotest.db")

SCHEMA = """
-- 项目表
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'ECU',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active DATE DEFAULT CURRENT_DATE
);

-- 模块表（项目结构）
CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

-- 测试点表
CREATE TABLE IF NOT EXISTS test_points (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module_id TEXT,
    description TEXT NOT NULL,
    target TEXT,
    priority TEXT DEFAULT '中',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 测试用例表
CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    test_point_id TEXT,
    module_id TEXT,
    title TEXT NOT NULL,
    precondition TEXT,
    steps TEXT,
    expected TEXT,
    case_type TEXT DEFAULT '正向',
    priority TEXT DEFAULT '中',
    status TEXT DEFAULT '未执行',
    tags TEXT DEFAULT '[]',
    favorite BOOLEAN DEFAULT 0,
    review_status TEXT DEFAULT '待评审',
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用例版本历史
CREATE TABLE IF NOT EXISTS case_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT,
    steps TEXT,
    expected TEXT,
    author TEXT DEFAULT 'AI',
    changes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 脚本表
CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    case_id TEXT,
    name TEXT NOT NULL,
    language TEXT DEFAULT 'python',
    content TEXT,
    status TEXT DEFAULT '就绪',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 测试计划表
CREATE TABLE IF NOT EXISTS test_plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cron TEXT,
    case_count INTEGER DEFAULT 0,
    last_run TIMESTAMP,
    last_result TEXT,
    status TEXT DEFAULT 'enabled',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 执行记录表
CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
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

-- 执行用例明细
CREATE TABLE IF NOT EXISTS execution_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    case_id TEXT NOT NULL,
    result TEXT DEFAULT '未执行',
    duration_ms INTEGER,
    error_message TEXT
);

-- 测试报告表
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    pass_rate TEXT,
    execution_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 需求文档表
CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    size INTEGER,
    status TEXT DEFAULT '已上传',
    analyzed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


"""


@contextmanager
def get_conn(db_path: Path = DEFAULT_DB):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(db_path: Path = DEFAULT_DB):
    with get_conn(db_path) as conn:
        conn.executescript(SCHEMA)
