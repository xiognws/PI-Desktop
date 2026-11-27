//! One SQLite database per project, one for the platform, opened the same way
//! the Python service opened them.
//!
//! Reading a row into JSON is a first-class operation here: the Vue app was
//! written against `dict(row)` (every column, snake_case, SQLite's own
//! rendering), so rows are converted column-by-column instead of through
//! hand-written structs. Hand-written structs would silently drop a column the
//! UI reads.

use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, Row};
use serde_json::{Map, Value};

use crate::error::ApiResult;
use crate::schema;

pub fn open(path: &Path) -> ApiResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    // A second connection may be writing (a cancellation, a background run).
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    Ok(conn)
}

pub fn ensure_platform_db(path: &Path) -> ApiResult<()> {
    let conn = open(path)?;
    conn.execute_batch(schema::PLATFORM_SCHEMA)?;
    Ok(())
}

/// Create `data.db` for a project that has none, then bring an existing one up
/// to the current shape. Both paths end in the same migration, so a brand new
/// database and a three-release-old database behave identically.
pub fn ensure_project_db(project_dir: &Path) -> ApiResult<Connection> {
    std::fs::create_dir_all(project_dir)?;
    let db_path = project_dir.join("data.db");
    let conn = open(&db_path)?;
    conn.execute_batch(schema::PROJECT_SCHEMA)?;
    conn.execute_batch(schema::AGENT_CALL_SCHEMA)?;
    migrate_project(&conn, &project_dir.join("scripts"))?;
    Ok(conn)
}

/// Idempotent migrations for databases created by an older build.
pub fn migrate_project(conn: &Connection, scripts_dir: &Path) -> ApiResult<Vec<String>> {
    let mut changes = Vec::new();

    let columns = table_columns(conn, "scripts")?;
    if !columns.is_empty() && !columns.iter().any(|name| name == "filepath") {
        conn.execute("ALTER TABLE scripts ADD COLUMN filepath TEXT", [])?;
        changes.push("scripts.filepath".to_string());
        let backfilled = backfill_script_paths(conn, scripts_dir)?;
        if backfilled > 0 {
            changes.push(format!("scripts.filepath backfilled x{backfilled}"));
        }
    }

    let deduped = dedupe_script_names(conn)?;
    if deduped > 0 {
        changes.push(format!("scripts deduped x{deduped}"));
    }

    // Executor columns: `executions` shipped without them, and older project
    // databases still have the narrow table.
    let execution_columns = table_columns(conn, "executions")?;
    for (name, ddl) in schema::EXECUTION_EXTRA_COLUMNS {
        if !execution_columns.iter().any(|column| column == name) {
            conn.execute(ddl, [])?;
            changes.push(format!("executions.{name}"));
        }
    }

    Ok(changes)
}

pub fn table_columns(conn: &Connection, table: &str) -> ApiResult<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row?);
    }
    Ok(names)
}

fn backfill_script_paths(conn: &Connection, scripts_dir: &Path) -> ApiResult<usize> {
    let mut statement = conn.prepare("SELECT id, name FROM scripts WHERE filepath IS NULL")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut filled = 0;
    for (script_id, name) in rows {
        let candidate = scripts_dir.join(&name);
        if candidate.is_file() {
            let absolute = candidate
                .canonicalize()
                .unwrap_or_else(|_| candidate.clone());
            conn.execute(
                "UPDATE scripts SET filepath = ? WHERE id = ?",
                rusqlite::params![absolute.to_string_lossy(), script_id],
            )?;
            filled += 1;
        }
    }
    Ok(filled)
}

/// Same file name means the same script: regenerating a script used to insert a
/// second row, so the count doubled and the assertion totals were wrong.
fn dedupe_script_names(conn: &Connection) -> ApiResult<usize> {
    let duplicates: Vec<String> = conn
        .prepare("SELECT name FROM scripts GROUP BY name HAVING count(*) > 1")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut removed = 0;
    for name in duplicates {
        let ids: Vec<String> = conn
            .prepare(
                "SELECT id FROM scripts WHERE name = ? \
                 ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC",
            )?
            .query_map([&name], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for stale in ids.into_iter().skip(1) {
            conn.execute("DELETE FROM scripts WHERE id = ?", [&stale])?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// One SQLite row as the JSON object the frontend already expects: every column
/// by name, integers as numbers, integers stored in a TEXT column as numbers
/// (SQLite's dynamic typing is how `favorite` arrives as `0`), blobs as text.
pub fn row_to_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut map = Map::new();
    for (index, name) in row.as_ref().column_names().iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(number) => Value::from(number),
            ValueRef::Real(number) => serde_json::Number::from_f64(number)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
            ValueRef::Blob(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        };
        map.insert(name.to_string(), value);
    }
    Ok(Value::Object(map))
}

pub fn query_rows(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ApiResult<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let mut rows = statement.query(params)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(row_to_value(row)?);
    }
    Ok(out)
}

/// `SELECT *` for one id, as the JSON object the detail routes return.
pub fn query_one(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> ApiResult<Option<Value>> {
    let mut rows = query_rows(conn, sql, params)?;
    Ok(rows.pop())
}

/// Count that tolerates a missing table: older project databases predate
/// `executions`, and a count of "unknown" is reported as zero rather than 500.
pub fn count_or_zero(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}
