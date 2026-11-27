//! Knowledge-base lookup for the workflow routes.
//!
//! `knowledge_records` is shared with the knowledge routes (which own ingestion);
//! this shim only reads it. BM25 ranking when the FTS5 index exists and can
//! express the query, `LIKE` otherwise — the same two-tier behaviour as
//! `knowledge/store.py:search_records`, because a two-character Chinese query
//! ("过压") cannot be expressed to the trigram tokenizer at all.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::ApiResult;

fn fts_ready(conn: &Connection) -> bool {
    let found: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    found.is_some()
}

/// A safe FTS phrase query, or `None` when the terms are too short to index.
///
/// Mixed queries ("读 DTC") would hand "读" to the trigram tokenizer and match
/// nothing, so only terms of at least 3 characters survive; if none do, the
/// whole query degrades to `LIKE`.
fn fts_query(query: &str) -> Option<String> {
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|token| token.chars().count() >= 3)
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub fn search_records(
    conn: &Connection,
    project_id: &str,
    query: &str,
    module: &str,
    tags: &str,
    limit: i64,
) -> ApiResult<Vec<Value>> {
    let limit = limit.clamp(1, 200);
    let fts = if !query.is_empty() && fts_ready(conn) {
        fts_query(query)
    } else {
        None
    };
    let Some(fts) = fts else {
        return super::store::search_knowledge(conn, project_id, query, module, tags, limit);
    };

    let mut where_clause = vec!["r.project_id = ?".to_string(), "knowledge_fts MATCH ?".to_string()];
    let mut values: Vec<rusqlite::types::Value> = vec![project_id.to_string().into(), fts.into()];
    if !module.is_empty() {
        where_clause.push("r.module = ?".to_string());
        values.push(module.to_string().into());
    }
    if !tags.is_empty() {
        where_clause.push("r.tags LIKE ?".to_string());
        values.push(format!("%{tags}%").into());
    }
    values.push(limit.into());
    let sql = format!(
        "SELECT r.id, r.module, r.record_type, r.title, substr(r.content, 1, 400), \
         r.tags, r.source_ref, r.created_at, bm25(knowledge_fts) AS score \
         FROM knowledge_fts JOIN knowledge_records r ON r.id = knowledge_fts.rowid \
         WHERE {} ORDER BY score ASC, r.created_at DESC LIMIT ?",
        where_clause.join(" AND ")
    );

    let mut statement = match conn.prepare(&sql) {
        Ok(statement) => statement,
        // A database without FTS5 support answers "no such module": degrade
        // instead of failing the route.
        Err(_) => return super::store::search_knowledge(conn, project_id, query, module, tags, limit),
    };
    let rows = statement.query_map(rusqlite::params_from_iter(values), |row| {
        Ok(json!({
            "id": row.get::<_, i64>(0)?,
            "module": row.get::<_, Option<String>>(1)?,
            "record_type": row.get::<_, Option<String>>(2)?,
            "title": row.get::<_, Option<String>>(3)?,
            "excerpt": row.get::<_, Option<String>>(4)?,
            "tags": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "source_ref": row.get::<_, Option<String>>(6)?,
            "created_at": row.get::<_, Option<String>>(7)?,
            "score": round4(row.get::<_, Option<f64>>(8)?.unwrap_or(0.0)),
        }))
    });
    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => return super::store::search_knowledge(conn, project_id, query, module, tags, limit),
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(value) => out.push(value),
            Err(_) => return super::store::search_knowledge(conn, project_id, query, module, tags, limit),
        }
    }
    Ok(out)
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// Chunks store only a block index as their title; the document name has to be
/// looked up from `source_ref` (`doc:<id>#<n>`), because that name is what the
/// case text quotes.
pub fn document_name(conn: &Connection, record: &Value) -> String {
    let reference = record
        .get("source_ref")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(rest) = reference.strip_prefix("doc:") {
        let doc_id = rest.split('#').next().unwrap_or("");
        let found: Option<Option<String>> = conn
            .query_row(
                "SELECT filename FROM knowledge_docs WHERE id = ?1",
                [doc_id],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None);
        if let Some(Some(filename)) = found {
            if !filename.is_empty() {
                return filename;
            }
        }
    }
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !title.is_empty() {
        return title;
    }
    if !reference.is_empty() {
        return reference;
    }
    "项目资料".to_string()
}
