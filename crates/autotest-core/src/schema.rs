//! Table definitions, copied verbatim from the Python service.
//!
//! Every statement is `IF NOT EXISTS`/idempotent because both databases already
//! exist in user installations: a project directory carries `data.db` created by
//! an older build, and the platform database carries the cross-project tables.
//! Changing a column here without a migration step would strand that data.

/// Platform database: cross-project tables. Newer builds keep per-project data
/// in `<workspace>/<project>/data.db`, so only `projects`-era rows live here.
pub const PLATFORM_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT DEFAULT 'ECU',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active DATE DEFAULT CURRENT_DATE
);
CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS test_points (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module_id TEXT,
    description TEXT NOT NULL,
    target TEXT,
    priority TEXT DEFAULT '中',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
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
CREATE TABLE IF NOT EXISTS execution_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    case_id TEXT NOT NULL,
    result TEXT DEFAULT '未执行',
    duration_ms INTEGER,
    error_message TEXT
);
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
"#;

/// One project's own database. `project.json` in the same directory is the
/// registry; the path is the identity, so rows here carry no `project_id`.
pub const PROJECT_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS case_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    author TEXT DEFAULT 'AI',
    changes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    case_id TEXT,
    name TEXT NOT NULL,
    language TEXT DEFAULT 'python',
    content TEXT,
    filepath TEXT,
    status TEXT DEFAULT '就绪',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS test_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cron TEXT,
    case_count INTEGER DEFAULT 0,
    last_run TIMESTAMP,
    last_result TEXT,
    status TEXT DEFAULT 'enabled',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
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
CREATE TABLE IF NOT EXISTS execution_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    case_id TEXT NOT NULL,
    result TEXT DEFAULT '未执行',
    duration_ms INTEGER,
    error_message TEXT
);
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    pass_rate TEXT,
    execution_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    size INTEGER,
    status TEXT DEFAULT '已上传',
    analyzed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_execution_events_run ON execution_events (execution_id, seq);
"#;

/// Model-call ledger: what the workflow spent, per project.
pub const AGENT_CALL_SCHEMA: &str = r#"
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
"#;

/// Columns the executor added to `executions` after the table shipped.
pub const EXECUTION_EXTRA_COLUMNS: [(&str, &str); 4] = [
    (
        "executor",
        "ALTER TABLE executions ADD COLUMN executor TEXT",
    ),
    (
        "channel",
        "ALTER TABLE executions ADD COLUMN channel TEXT DEFAULT 'ui'",
    ),
    (
        "replay_hits",
        "ALTER TABLE executions ADD COLUMN replay_hits INTEGER DEFAULT 0",
    ),
    (
        "model_calls",
        "ALTER TABLE executions ADD COLUMN model_calls INTEGER DEFAULT 0",
    ),
];
