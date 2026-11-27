//! Agent-driven run records.
//!
//! The old `pipelines` stage machine (the server advanced steps itself) is gone:
//! this table only records *which tool the agent called, what it got, and where
//! it is waiting for a human*. The runtime order belongs to the agent; the rows
//! exist so the panel and the next session see the same facts.
//!
//! Ported from `workflow/store.py`; the DDL is copied verbatim because an
//! existing project database must be migrated in place, not recreated.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::ApiResult;

use super::bugs::bug_signature as bug_signature_of;

// The bug routes and the report call these through `store`, which is where they
// lived before the split by topic.
pub use super::bugs::{
    bug_exists, bug_in_project, bug_signature, bug_visible_in_run, create_bug,
    find_bug_by_signature, list_bugs, list_project_bugs, record_occurrence, update_bug_status,
    NewBug,
};

pub const WORKFLOW_SCHEMA: &str = r#"
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
"#;

/// Columns added to `bugs` after the table shipped. `ALTER TABLE ADD COLUMN` is
/// idempotent only after a `PRAGMA table_info` check, so the caller passes the
/// existing names in.
pub const BUG_COLUMNS: [(&str, &str); 4] = [
    ("signature", "TEXT DEFAULT ''"),
    ("occurrences", "INTEGER DEFAULT 1"),
    ("last_run_id", "TEXT DEFAULT ''"),
    ("last_seen_at", "TEXT"),
];

/// `datetime.now().isoformat(timespec="seconds")` — the timestamp format the
/// stage ledger and the report body were written with.
pub fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn table_columns(conn: &Connection, table: &str) -> ApiResult<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row?);
    }
    Ok(names)
}

/// Every route that opens a project database calls this first, exactly like
/// Python's `_project_conn`. A workflow table that is missing would otherwise
/// turn the first write of a fresh project into a 500.
pub fn ensure_workflow_tables(conn: &Connection) -> ApiResult<()> {
    conn.execute_batch(WORKFLOW_SCHEMA)?;

    let existing = table_columns(conn, "bugs")?;
    for (name, declaration) in BUG_COLUMNS {
        if !existing.iter().any(|column| column == name) {
            conn.execute(&format!("ALTER TABLE bugs ADD COLUMN {name} {declaration}"), [])?;
        }
    }

    // Bugs written before the merge columns existed have no signature; compute
    // it from script name + case, or they never merge with a later run.
    let unmerged: Vec<(String, String, String)> = conn
        .prepare("SELECT id, COALESCE(script_name, ''), COALESCE(case_id, '') FROM bugs WHERE COALESCE(signature, '') = ''")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (bug_id, script_name, case_id) in unmerged {
        conn.execute(
            "UPDATE bugs SET signature = ?1 WHERE id = ?2",
            rusqlite::params![bug_signature_of(&script_name, &case_id), bug_id],
        )?;
    }

    // …and no occurrence row, so they are invisible to `list_bugs`.
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, created_at) \
         SELECT b.id, b.run_id, b.script_name, b.created_at FROM bugs b \
         WHERE NOT EXISTS (SELECT 1 FROM bug_occurrences o WHERE o.bug_id = b.id)",
        [],
    )?;
    Ok(())
}

pub fn create_run(
    conn: &Connection,
    project_id: &str,
    module: &str,
    requirement_ref: &str,
    session_id: &str,
) -> ApiResult<String> {
    let run_id = format!(
        "wf-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    );
    let stamp = now();
    conn.execute(
        "INSERT INTO workflow_runs (id, project_id, module, requirement_ref, stage, status, session_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 'created', 'running', ?5, ?6, ?7)",
        rusqlite::params![run_id, project_id, module, requirement_ref, session_id, stamp, stamp],
    )?;
    Ok(run_id)
}

pub fn touch_run(
    conn: &Connection,
    run_id: &str,
    stage: Option<&str>,
    status: Option<&str>,
) -> ApiResult<()> {
    conn.execute(
        "UPDATE workflow_runs SET \
         updated_at = ?1, \
         stage = COALESCE(?2, stage), \
         status = COALESCE(?3, status) \
         WHERE id = ?4",
        rusqlite::params![now(), stage, status, run_id],
    )?;
    Ok(())
}

/// Append one step. `seq` is per run and dense, so the panel can render the
/// stage ledger without sorting on timestamps that only have second precision.
pub fn append_step(
    conn: &Connection,
    run_id: &str,
    tool: &str,
    stage: &str,
    status: &str,
    summary: &str,
    payload: Option<&Value>,
) -> ApiResult<i64> {
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM workflow_steps WHERE run_id = ?1",
        [run_id],
        |row| row.get(0),
    )?;
    let payload_json = payload.map(|value| value.to_string());
    let stamp = now();
    conn.execute(
        "INSERT INTO workflow_steps (run_id, seq, tool, stage, status, summary, payload_json, error_code, started_at, ended_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?8)",
        rusqlite::params![run_id, seq, tool, stage, status, summary, payload_json, stamp],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Close the newest `running` step of one tool. Used when a background run
/// finishes: the submission step would otherwise stay `running` forever.
pub fn close_latest_step(
    conn: &Connection,
    run_id: &str,
    tool: &str,
    status: &str,
    summary: Option<&str>,
) -> ApiResult<usize> {
    let step_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM workflow_steps WHERE run_id = ?1 AND tool = ?2 AND status = 'running' \
             ORDER BY seq DESC LIMIT 1",
            rusqlite::params![run_id, tool],
            |row| row.get(0),
        )
        .optional()?;
    let Some(step_id) = step_id else {
        return Ok(0);
    };
    match summary {
        Some(text) => conn.execute(
            "UPDATE workflow_steps SET status = ?1, summary = ?2, ended_at = ?3 WHERE id = ?4",
            rusqlite::params![status, text, now(), step_id],
        )?,
        None => conn.execute(
            "UPDATE workflow_steps SET status = ?1, ended_at = ?2 WHERE id = ?3",
            rusqlite::params![status, now(), step_id],
        )?,
    };
    Ok(1)
}

pub fn create_decision(
    conn: &Connection,
    run_id: &str,
    prompt: &str,
    options: &[String],
    step_id: Option<i64>,
) -> ApiResult<String> {
    let decision_id = format!(
        "dec-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    conn.execute(
        "INSERT INTO workflow_decisions (id, run_id, step_id, prompt, options, answer, note, status, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, '', '', 'waiting', ?6)",
        rusqlite::params![
            decision_id,
            run_id,
            step_id,
            prompt,
            serde_json::to_string(options).unwrap_or_else(|_| "[]".to_string()),
            now()
        ],
    )?;
    touch_run(conn, run_id, None, Some("waiting_human"))?;
    Ok(decision_id)
}

pub fn decide(
    conn: &Connection,
    decision_id: &str,
    answer: &str,
    note: &str,
) -> ApiResult<Option<Value>> {
    let run_id: Option<String> = conn
        .query_row(
            "SELECT run_id FROM workflow_decisions WHERE id = ?1",
            [decision_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(run_id) = run_id else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE workflow_decisions SET answer = ?1, note = ?2, status = 'decided', decided_at = ?3 WHERE id = ?4",
        rusqlite::params![answer, note, now(), decision_id],
    )?;
    let remaining: i64 = conn.query_row(
        "SELECT COUNT(*) FROM workflow_decisions WHERE run_id = ?1 AND status = 'waiting'",
        [&run_id],
        |row| row.get(0),
    )?;
    touch_run(
        conn,
        &run_id,
        None,
        Some(if remaining == 0 { "running" } else { "waiting_human" }),
    )?;
    Ok(Some(json!({
        "id": decision_id,
        "run_id": run_id,
        "answer": answer,
        "status": "decided",
    })))
}

pub fn pending_decisions(conn: &Connection, run_id: &str) -> ApiResult<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, step_id, prompt, options, status, created_at \
         FROM workflow_decisions WHERE run_id = ?1 AND status = 'waiting' ORDER BY created_at",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, run_id, step_id, prompt, options, status, created_at) = row?;
        out.push(json!({
            "id": id,
            "run_id": run_id,
            "step_id": step_id,
            "prompt": prompt,
            "options": parse_json_list(&options),
            "status": status,
            "created_at": created_at,
        }));
    }
    Ok(out)
}

fn parse_json_list(raw: &Option<String>) -> Value {
    match raw {
        Some(text) if !text.is_empty() => serde_json::from_str(text).unwrap_or_else(|_| json!([])),
        _ => json!([]),
    }
}

pub fn get_run(conn: &Connection, run_id: &str) -> ApiResult<Option<Value>> {
    let columns = table_columns(conn, "workflow_runs")?;
    let row = conn
        .query_row("SELECT * FROM workflow_runs WHERE id = ?1", [run_id], |row| {
            crate::db::row_to_value(row)
        })
        .optional()?;
    let Some(run) = row else {
        return Ok(None);
    };
    // `SELECT *` already returns the snake_case object the UI reads; the column
    // list is only used to keep the field order stable for debugging.
    let _ = columns;
    let mut object = match run {
        Value::Object(map) => map,
        other => return Ok(Some(other)),
    };

    let mut statement = conn.prepare(
        "SELECT id, seq, tool, stage, status, summary, payload_json, error_code, started_at, ended_at \
         FROM workflow_steps WHERE run_id = ?1 ORDER BY seq",
    )?;
    let rows = statement.query_map([run_id], |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "seq": row.get::<_, i64>(1)?,
            "tool": row.get::<_, String>(2)?,
            "stage": row.get::<_, Option<String>>(3)?,
            "status": row.get::<_, String>(4)?,
            "summary": row.get::<_, Option<String>>(5)?,
            "payload": row.get::<_, Option<String>>(6)?.filter(|text| !text.is_empty())
                .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
            "error_code": row.get::<_, Option<String>>(7)?,
            "started_at": row.get::<_, Option<String>>(8)?,
            "ended_at": row.get::<_, Option<String>>(9)?,
        }))
    })?;
    let mut steps = Vec::new();
    for step in rows {
        steps.push(step?);
    }
    object.insert("steps".to_string(), Value::Array(steps));
    object.insert(
        "pending".to_string(),
        Value::Array(pending_decisions(conn, run_id)?),
    );
    Ok(Some(Value::Object(object)))
}

pub fn last_payload(conn: &Connection, run_id: &str, tool: &str) -> ApiResult<Option<Value>> {
    let raw: Option<Option<String>> = conn
        .query_row(
            "SELECT payload_json FROM workflow_steps WHERE run_id = ?1 AND tool = ?2 ORDER BY seq DESC LIMIT 1",
            rusqlite::params![run_id, tool],
            |row| row.get(0),
        )
        .optional()?;
    let Some(Some(text)) = raw else {
        return Ok(None);
    };
    if text.is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&text).ok())
}

/// One tool can write several steps (report body, then archive note); find the
/// one that actually carries `key`.
pub fn find_payload(
    conn: &Connection,
    run_id: &str,
    tool: &str,
    key: &str,
) -> ApiResult<Option<Value>> {
    let mut statement = conn.prepare(
        "SELECT payload_json FROM workflow_steps WHERE run_id = ?1 AND tool = ?2 ORDER BY seq DESC",
    )?;
    let rows = statement.query_map(rusqlite::params![run_id, tool], |row| {
        row.get::<_, Option<String>>(0)
    })?;
    for row in rows {
        let Some(text) = row? else { continue };
        let Ok(payload) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if payload.get(key).map(|value| !value.is_null()).unwrap_or(false) {
            return Ok(Some(payload));
        }
    }
    Ok(None)
}

pub fn list_runs(conn: &Connection, project_id: &str, limit: i64) -> ApiResult<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT id, module, requirement_ref, stage, status, created_at, updated_at \
         FROM workflow_runs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![project_id, limit], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "module": row.get::<_, Option<String>>(1)?,
            "requirement_ref": row.get::<_, Option<String>>(2)?,
            "stage": row.get::<_, Option<String>>(3)?,
            "status": row.get::<_, Option<String>>(4)?,
            "created_at": row.get::<_, Option<String>>(5)?,
            "updated_at": row.get::<_, Option<String>>(6)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn save_knowledge(
    conn: &Connection,
    project_id: &str,
    record_type: &str,
    title: &str,
    content: &str,
    module: &str,
    tags: &[String],
    source_ref: &str,
) -> ApiResult<i64> {
    conn.execute(
        "INSERT INTO knowledge_records (project_id, module, record_type, title, content, tags, source_ref, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            project_id,
            module,
            record_type,
            title,
            content,
            tags.join(","),
            source_ref,
            now()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// LIKE search over `knowledge_records`. Used directly by the workflow search
/// route, and by grounding whenever the FTS index cannot express the query.
pub fn search_knowledge(
    conn: &Connection,
    project_id: &str,
    query: &str,
    module: &str,
    tags: &str,
    limit: i64,
) -> ApiResult<Vec<Value>> {
    let mut where_clause = vec!["project_id = ?".to_string()];
    let mut values: Vec<rusqlite::types::Value> = vec![project_id.to_string().into()];
    if !module.is_empty() {
        where_clause.push("module = ?".to_string());
        values.push(module.to_string().into());
    }
    if !tags.is_empty() {
        where_clause.push("tags LIKE ?".to_string());
        values.push(format!("%{tags}%").into());
    }
    if !query.is_empty() {
        where_clause.push("(title LIKE ? OR content LIKE ?)".to_string());
        values.push(format!("%{query}%").into());
        values.push(format!("%{query}%").into());
    }
    values.push(limit.into());
    let sql = format!(
        "SELECT id, module, record_type, title, substr(content, 1, 400), tags, source_ref, created_at \
         FROM knowledge_records WHERE {} ORDER BY created_at DESC LIMIT ?",
        where_clause.join(" AND ")
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
        let tags_text: Option<String> = row.get(5)?;
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "module": row.get::<_, Option<String>>(1)?,
            "record_type": row.get::<_, Option<String>>(2)?,
            "title": row.get::<_, Option<String>>(3)?,
            "excerpt": row.get::<_, Option<String>>(4)?,
            "tags": tags_text
                .unwrap_or_default()
                .split(',')
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect::<Vec<_>>(),
            "source_ref": row.get::<_, Option<String>>(6)?,
            "created_at": row.get::<_, Option<String>>(7)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Project-wide inbox: every waiting decision, with the run it belongs to. The
/// approval page fetches the whole project at once instead of walking runs.
pub fn list_pending(conn: &Connection, project_id: &str, limit: i64) -> ApiResult<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT d.id, d.run_id, d.step_id, d.prompt, d.options, d.created_at, r.module, r.stage, r.status \
         FROM workflow_decisions d JOIN workflow_runs r ON r.id = d.run_id \
         WHERE r.project_id = ?1 AND d.status = 'waiting' \
         ORDER BY d.created_at LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![project_id, limit], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "run_id": row.get::<_, String>(1)?,
            "step_id": row.get::<_, Option<i64>>(2)?,
            "prompt": row.get::<_, String>(3)?,
            "options": row.get::<_, Option<String>>(4)?
                .filter(|text| !text.is_empty())
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .unwrap_or_else(|| json!([])),
            "created_at": row.get::<_, Option<String>>(5)?,
            "module": row.get::<_, Option<String>>(6)?,
            "stage": row.get::<_, Option<String>>(7)?,
            "run_status": row.get::<_, Option<String>>(8)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

