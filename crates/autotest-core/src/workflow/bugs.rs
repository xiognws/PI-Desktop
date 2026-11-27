//! Bug tickets: one merged ticket per failing case, across runs.
//!
//! Ported out of `store.rs` (which keeps the run/step/decision ledger) so each file
//! stays readable; `store` re-exports these, so call sites are unchanged.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

use super::hashes;
use super::store::now;

pub const BUG_STATUSES: [&str; 4] = ["open", "fixed", "verified", "wontfix"];

/// One failing case should stay one bug across runs: key on script name + case
/// name, which no run randomises.
pub fn bug_signature(script_name: &str, case_id: &str) -> String {
    let key = format!("{}|{}", script_name.trim(), case_id.trim());
    hashes::sha1_prefix(key.as_bytes(), 16)
}

pub fn find_bug_by_signature(conn: &Connection, signature: &str) -> ApiResult<Option<String>> {
    // Only bugs still being tracked: a verified/wontfix bug must not be pulled
    // back to open by a later run of the same case.
    Ok(conn
        .query_row(
            "SELECT id FROM bugs WHERE signature = ?1 AND status IN ('open', 'fixed') \
             ORDER BY created_at ASC LIMIT 1",
            [signature],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

pub struct NewBug<'a> {
    pub run_id: &'a str,
    pub title: &'a str,
    pub script_name: &'a str,
    pub case_id: &'a str,
    pub severity: &'a str,
    pub error_type: &'a str,
    pub summary: &'a str,
    pub repro: &'a str,
}

pub fn create_bug(conn: &Connection, bug: NewBug<'_>) -> ApiResult<String> {
    let signature = bug_signature(bug.script_name, bug.case_id);
    let stamp = now();
    if let Some(bug_id) = find_bug_by_signature(conn, &signature)? {
        conn.execute(
            "UPDATE bugs SET occurrences = occurrences + 1, last_run_id = ?1, last_seen_at = ?2, \
             error_type = ?3, summary = ?4, repro = ?5 WHERE id = ?6",
            rusqlite::params![
                bug.run_id,
                stamp,
                bug.error_type,
                bug.summary,
                bug.repro,
                bug_id
            ],
        )?;
        conn.execute(
            "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![bug_id, bug.run_id, bug.script_name, bug.repro, stamp],
        )?;
        return Ok(bug_id);
    }

    let bug_id = format!(
        "bug-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    conn.execute(
        "INSERT INTO bugs (id, run_id, script_name, case_id, title, severity, status, \
         error_type, summary, repro, signature, occurrences, last_run_id, last_seen_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, 1, ?2, ?11, ?11)",
        rusqlite::params![
            bug_id,
            bug.run_id,
            bug.script_name,
            bug.case_id,
            bug.title,
            bug.severity,
            bug.error_type,
            bug.summary,
            bug.repro,
            signature,
            stamp
        ],
    )?;
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![bug_id, bug.run_id, bug.script_name, bug.repro, stamp],
    )?;
    Ok(bug_id)
}

pub fn bug_exists(conn: &Connection, run_id: &str, script_name: &str) -> ApiResult<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM bug_occurrences WHERE run_id = ?1 AND script_name = ?2 LIMIT 1",
            rusqlite::params![run_id, script_name],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

pub fn update_bug_status(conn: &Connection, bug_id: &str, status: &str) -> ApiResult<bool> {
    if !BUG_STATUSES.contains(&status) {
        // A typo must not silently park a bug in a state nothing queries by.
        return Err(ApiError::bad_request(format!("非法缺陷状态: {status}")));
    }
    let found: Option<i64> = conn
        .query_row("SELECT 1 FROM bugs WHERE id = ?1", [bug_id], |row| row.get(0))
        .optional()?;
    if found.is_none() {
        return Ok(false);
    }
    conn.execute(
        "UPDATE bugs SET status = ?1, last_seen_at = ?2 WHERE id = ?3",
        rusqlite::params![status, now(), bug_id],
    )?;
    Ok(true)
}

pub fn bug_visible_in_run(conn: &Connection, bug_id: &str, run_id: &str) -> ApiResult<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM bug_occurrences WHERE bug_id = ?1 AND run_id = ?2 LIMIT 1",
            rusqlite::params![bug_id, run_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

pub fn record_occurrence(
    conn: &Connection,
    bug_id: &str,
    run_id: &str,
    script_name: &str,
    execution_id: &str,
) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO bug_occurrences (bug_id, run_id, script_name, execution_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![bug_id, run_id, script_name, execution_id, now()],
    )?;
    Ok(())
}

const BUG_COLUMNS_SELECT: &str = "SELECT b.id, b.run_id, b.script_name, b.case_id, b.title, b.severity, b.status, \
     b.error_type, b.summary, b.repro, b.created_at, b.occurrences, b.last_run_id, \
     b.last_seen_at, b.signature FROM bugs b";

const BUG_IN_PROJECT: &str = " EXISTS (SELECT 1 FROM bug_occurrences o JOIN workflow_runs r ON r.id = o.run_id \
     WHERE o.bug_id = b.id AND r.project_id = ?)";

fn bug_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let run_id: Option<String> = row.get(1)?;
    let created_at: Option<String> = row.get(10)?;
    let occurrences: Option<i64> = row.get(11)?;
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "run_id": run_id,
        "script_name": row.get::<_, Option<String>>(2)?,
        "case_id": row.get::<_, Option<String>>(3)?,
        "title": row.get::<_, String>(4)?,
        "severity": row.get::<_, Option<String>>(5)?,
        "status": row.get::<_, Option<String>>(6)?,
        "error_type": row.get::<_, Option<String>>(7)?,
        "summary": row.get::<_, Option<String>>(8)?,
        "repro": row.get::<_, Option<String>>(9)?,
        "created_at": created_at,
        "occurrences": occurrences.unwrap_or(1),
        "last_run_id": row.get::<_, Option<String>>(12)?.or(run_id),
        "last_seen_at": row.get::<_, Option<String>>(13)?.or(created_at),
        "signature": row.get::<_, Option<String>>(14)?.unwrap_or_default(),
    }))
}

pub fn list_bugs(conn: &Connection, run_id: &str) -> ApiResult<Vec<Value>> {
    let sql = format!(
        "{BUG_COLUMNS_SELECT} JOIN bug_occurrences o ON o.bug_id = b.id \
         WHERE o.run_id = ? GROUP BY b.id ORDER BY b.created_at ASC"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([run_id], bug_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_project_bugs(
    conn: &Connection,
    project_id: &str,
    status: Option<&str>,
    limit: i64,
) -> ApiResult<Vec<Value>> {
    if let Some(value) = status {
        if !BUG_STATUSES.contains(&value) {
            return Err(ApiError::bad_request(format!("非法缺陷状态: {value}")));
        }
    }
    let mut sql = format!("{BUG_COLUMNS_SELECT} WHERE{BUG_IN_PROJECT}");
    let mut values: Vec<rusqlite::types::Value> = vec![project_id.to_string().into()];
    if let Some(value) = status.filter(|value| !value.is_empty()) {
        sql.push_str(" AND b.status = ?");
        values.push(value.to_string().into());
    }
    sql.push_str(" ORDER BY b.last_seen_at DESC, b.created_at DESC LIMIT ?");
    values.push(limit.clamp(1, 500).into());
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values), bug_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn bug_in_project(conn: &Connection, bug_id: &str, project_id: &str) -> ApiResult<bool> {
    let sql = format!("SELECT 1 FROM bugs b WHERE b.id = ? AND{BUG_IN_PROJECT}");
    let found: Option<i64> = conn
        .query_row(&sql, rusqlite::params![bug_id, project_id], |row| row.get(0))
        .optional()?;
    Ok(found.is_some())
}
