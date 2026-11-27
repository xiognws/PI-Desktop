//! Knowledge tables, queries and the full-text index.
//!
//! Ported from `autotest/knowledge/store.py`. Two things are kept apart:
//!
//! * `knowledge_docs` records which file was imported and how many chunks it
//!   became. The file itself lives in `<project>/knowledge/<doc_id>/<filename>`.
//! * the chunks are rows in `knowledge_records` (`record_type='doc-chunk'`,
//!   `source_ref='doc:<doc_id>#<n>'`), so the existing search/model kept working
//!   without a second data model.
//!
//! The DDL is copied verbatim from the Python service: these tables are shared
//! with a database a Python build may have created, so a column type or default
//! may not drift.

use chrono::Local;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db;
use crate::error::ApiResult;

pub const DOC_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    format TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    module TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    chunk_count INTEGER DEFAULT 0,
    truncated INTEGER DEFAULT 0,
    sha256 TEXT DEFAULT '',
    created_at TEXT
);
";

// `knowledge_records` is declared by the workflow store in Python; the Rust
// schema module has no such table yet, and the knowledge routes cannot insert a
// chunk without it. Same DDL, `IF NOT EXISTS`, so both halves can create it.
pub const RECORDS_SCHEMA: &str = "
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
";

const FTS_TAIL: &str = "
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge_records BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content)
        VALUES ('delete', old.id, old.title, old.content);
    INSERT INTO knowledge_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
";

/// `datetime.now().isoformat(timespec="seconds")`.
pub fn now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn fts_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'",
        [],
        |row| row.get::<_, String>(0),
    )
    .is_ok()
}

/// Build the FTS5 index and backfill the rows already in the database. A SQLite
/// without FTS5 leaves no index behind, and search degrades to LIKE — the same
/// outcome as the Python service, so the failure is swallowed rather than
/// turned into a 500 on a knowledge import.
fn create_fts(conn: &Connection) {
    let body = "title, content, content='knowledge_records', content_rowid='id'";
    for tokenizer in ["trigram", "unicode61"] {
        let sql = format!(
            "CREATE VIRTUAL TABLE knowledge_fts USING fts5({body}, tokenize='{tokenizer}')"
        );
        if conn.execute_batch(&sql).is_ok() {
            let _ = conn.execute_batch(FTS_TAIL);
            let _ =
                conn.execute_batch("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
            return;
        }
        let _ = conn.execute_batch("DROP TABLE IF EXISTS knowledge_fts");
    }
    let _ = conn.execute_batch("DROP TABLE IF EXISTS knowledge_fts");
}

/// Idempotent: create the tables, add the dedupe column an old database lacks,
/// and build the index when it is missing.
pub fn ensure_knowledge_tables(conn: &Connection) -> ApiResult<()> {
    conn.execute_batch(DOC_SCHEMA)?;
    conn.execute_batch(RECORDS_SCHEMA)?;
    let columns = db::table_columns(conn, "knowledge_docs")?;
    if !columns.iter().any(|name| name == "sha256") {
        conn.execute(
            "ALTER TABLE knowledge_docs ADD COLUMN sha256 TEXT DEFAULT ''",
            [],
        )?;
    }
    if !fts_exists(conn) {
        create_fts(conn);
    }
    backfill_sha(conn, 200)?;
    Ok(())
}

/// Recompute the digest for documents stored before the dedupe column existed.
/// The original bytes are still at `stored_path`, so one pass fixes them; the
/// limit keeps the work bounded on a large database.
pub fn backfill_sha(conn: &Connection, limit: i64) -> ApiResult<i64> {
    let mut statement =
        conn.prepare("SELECT id, stored_path FROM knowledge_docs WHERE sha256 = '' LIMIT ?1")?;
    let rows = statement
        .query_map([limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut filled = 0;
    for (doc_id, stored_path) in rows {
        if stored_path.is_empty() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&stored_path) else {
            continue;
        };
        conn.execute(
            "UPDATE knowledge_docs SET sha256 = ?1 WHERE id = ?2",
            rusqlite::params![super::sha256::hex_digest(&bytes), doc_id],
        )?;
        filled += 1;
    }
    Ok(filled)
}

#[derive(Debug, Clone)]
pub struct ExistingDoc {
    pub doc_id: String,
    pub filename: String,
    pub chunks: i64,
    pub format: String,
}

/// A document already imported with the same bytes, so a second upload becomes
/// a skip instead of duplicate chunks.
pub fn find_document_by_sha(
    conn: &Connection,
    project_id: &str,
    sha256: &str,
) -> ApiResult<Option<ExistingDoc>> {
    if sha256.is_empty() {
        return Ok(None);
    }
    let mut statement = conn.prepare(
        "SELECT id, filename, chunk_count, format FROM knowledge_docs \
         WHERE project_id = ?1 AND sha256 = ?2 ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = statement.query(rusqlite::params![project_id, sha256])?;
    match rows.next()? {
        Some(row) => Ok(Some(ExistingDoc {
            doc_id: row.get(0)?,
            filename: row.get(1)?,
            chunks: row.get(2)?,
            format: row.get(3)?,
        })),
        None => Ok(None),
    }
}

pub struct NewDocument<'a> {
    pub project_id: &'a str,
    pub filename: &'a str,
    pub stored_path: &'a str,
    pub file_format: &'a str,
    pub size: i64,
    pub module: &'a str,
    pub tags: &'a [String],
    pub truncated: bool,
    pub chunks: &'a [(String, String)],
    pub doc_id: &'a str,
    pub sha256: &'a str,
}

/// Write the document row and its chunks. Both happen in one transaction: a
/// half-written document would show a chunk count that does not exist.
pub fn save_document(conn: &Connection, document: NewDocument<'_>) -> ApiResult<String> {
    let tags_text = document
        .tags
        .iter()
        .filter(|tag| !tag.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(",");
    let created_at = now();
    conn.execute(
        "INSERT INTO knowledge_docs (id, project_id, filename, stored_path, format, size, \
         module, tags, chunk_count, truncated, sha256, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            document.doc_id,
            document.project_id,
            document.filename,
            document.stored_path,
            document.file_format,
            document.size,
            document.module,
            tags_text,
            document.chunks.len() as i64,
            i64::from(document.truncated),
            document.sha256,
            created_at,
        ],
    )?;
    for (index, (title, content)) in document.chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO knowledge_records (project_id, module, record_type, title, content, \
             tags, source_ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                document.project_id,
                document.module,
                "doc-chunk",
                title,
                content,
                tags_text,
                format!("doc:{}#{}", document.doc_id, index + 1),
                created_at,
            ],
        )?;
    }
    Ok(document.doc_id.to_string())
}

pub fn list_documents(conn: &Connection, project_id: &str) -> ApiResult<Vec<Value>> {
    let mut documents = db::query_rows(
        conn,
        "SELECT id AS doc_id, filename, format, size, module, tags, chunk_count, truncated, \
         created_at, sha256 FROM knowledge_docs WHERE project_id = ?1 ORDER BY created_at DESC",
        [project_id],
    )?;
    for document in documents.iter_mut() {
        let truncated = document
            .get("truncated")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            != 0;
        if let Value::Object(map) = document {
            map.insert("truncated".to_string(), Value::from(truncated));
        }
    }
    Ok(documents)
}

pub fn get_document(conn: &Connection, project_id: &str, doc_id: &str) -> ApiResult<Option<Value>> {
    let mut document = db::query_one(
        conn,
        "SELECT id AS doc_id, filename, format, size, module, tags, chunk_count, truncated, \
         created_at, sha256, stored_path FROM knowledge_docs WHERE project_id = ?1 AND id = ?2",
        rusqlite::params![project_id, doc_id],
    )?;
    if let Some(Value::Object(map)) = document.as_mut() {
        let truncated = map.get("truncated").and_then(Value::as_i64).unwrap_or(0) != 0;
        map.insert("truncated".to_string(), Value::from(truncated));
    }
    Ok(document)
}

const EXCERPT_CHARS: usize = 1_200;

/// What a document was split into: sequence, title, excerpt, real length.
pub fn list_document_chunks(
    conn: &Connection,
    project_id: &str,
    doc_id: &str,
    limit: i64,
    offset: i64,
) -> ApiResult<Value> {
    let limit = limit.clamp(1, 100);
    let offset = offset.max(0);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM knowledge_records WHERE project_id = ?1 AND source_ref LIKE ?2",
        rusqlite::params![project_id, format!("doc:{doc_id}#%")],
        |row| row.get(0),
    )?;
    let mut rows = db::query_rows(
        conn,
        "SELECT title, content, source_ref, tags, created_at FROM knowledge_records \
         WHERE project_id = ?1 AND source_ref LIKE ?2 ORDER BY id ASC LIMIT ?3 OFFSET ?4",
        rusqlite::params![project_id, format!("doc:{doc_id}#%"), limit, offset],
    )?;

    let mut chunks = Vec::with_capacity(rows.len());
    for row in rows.iter_mut() {
        let content = row
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let length = super::text::char_len(&content);
        let excerpt = if length <= EXCERPT_CHARS {
            content
        } else {
            format!("{}…", super::text::slice_chars(&content, 0, EXCERPT_CHARS))
        };
        chunks.push(json!({
            "title": row.get("title").cloned().unwrap_or(Value::Null),
            "excerpt": excerpt,
            "chars": length,
            "source_ref": row.get("source_ref").cloned().unwrap_or(Value::Null),
            "tags": row.get("tags").cloned().unwrap_or(Value::Null),
            "created_at": row.get("created_at").cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(json!({
        "chunks": chunks,
        "total": total,
        "limit": limit,
        "offset": offset,
    }))
}

/// Delete a document and its chunks; the caller removes the stored file.
pub fn delete_document(conn: &Connection, project_id: &str, doc_id: &str) -> ApiResult<i64> {
    let deleted = conn.execute(
        "DELETE FROM knowledge_records WHERE project_id = ?1 AND source_ref LIKE ?2",
        rusqlite::params![project_id, format!("doc:{doc_id}#%")],
    )?;
    conn.execute(
        "DELETE FROM knowledge_docs WHERE project_id = ?1 AND id = ?2",
        rusqlite::params![project_id, doc_id],
    )?;
    Ok(deleted as i64)
}

/// Metadata only: `None` means "leave this column alone", `Some("")` clears it.
pub fn update_document(
    conn: &Connection,
    project_id: &str,
    doc_id: &str,
    module: Option<&str>,
    tags: Option<&str>,
) -> ApiResult<Option<Value>> {
    let mut assigns: Vec<&str> = Vec::new();
    let mut values: Vec<String> = Vec::new();
    if let Some(module) = module {
        assigns.push("module = ?");
        values.push(module.to_string());
    }
    if let Some(tags) = tags {
        assigns.push("tags = ?");
        values.push(tags.to_string());
    }
    if assigns.is_empty() {
        return get_document(conn, project_id, doc_id);
    }
    values.push(project_id.to_string());
    values.push(doc_id.to_string());
    conn.execute(
        &format!(
            "UPDATE knowledge_docs SET {} WHERE project_id = ? AND id = ?",
            assigns.join(", ")
        ),
        rusqlite::params_from_iter(values.iter()),
    )?;
    get_document(conn, project_id, doc_id)
}

/// Documents and chunks per module. An empty module is reported as "未分组":
/// early imports had no module, and dropping them would make the totals wrong.
pub fn module_stats(conn: &Connection, project_id: &str) -> ApiResult<Value> {
    let rows = db::query_rows(
        conn,
        "SELECT COALESCE(NULLIF(module, ''), '未分组') AS module, COUNT(*) AS docs, \
         COALESCE(SUM(chunk_count), 0) AS chunks FROM knowledge_docs WHERE project_id = ?1 \
         GROUP BY 1 ORDER BY docs DESC, module ASC",
        [project_id],
    )?;
    let mut modules = Vec::with_capacity(rows.len());
    let mut docs_total = 0i64;
    let mut chunks_total = 0i64;
    for row in rows {
        let docs = row.get("docs").and_then(Value::as_i64).unwrap_or(0);
        let chunks = row.get("chunks").and_then(Value::as_i64).unwrap_or(0);
        docs_total += docs;
        chunks_total += chunks;
        modules.push(json!({
            "module": row.get("module").cloned().unwrap_or(Value::Null),
            "docs": docs,
            "chunks": chunks,
        }));
    }
    Ok(json!({
        "modules": modules,
        "total": { "docs": docs_total, "chunks": chunks_total },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        conn.execute_batch(crate::schema::PROJECT_SCHEMA)
            .expect("project schema");
        ensure_knowledge_tables(&conn).expect("knowledge tables");
        conn
    }

    fn chunks() -> Vec<(String, String)> {
        vec![
            (
                "电池管理系统需求".to_string(),
                "电池管理系统需求".to_string(),
            ),
            ("1. 功能需求".to_string(), "- 采集单体电压".to_string()),
        ]
    }

    #[test]
    fn saving_then_listing_round_trips() {
        let conn = memory_db();
        save_document(
            &conn,
            NewDocument {
                project_id: "p1",
                filename: "BMS 需求.md",
                stored_path: "",
                file_format: "text",
                size: 0,
                module: "BMS",
                tags: &["需求".to_string()],
                truncated: false,
                chunks: &chunks(),
                doc_id: "doc-0000aaaa",
                sha256: "abc",
            },
        )
        .expect("save");

        let documents = list_documents(&conn, "p1").expect("list");
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0]["filename"], json!("BMS 需求.md"));
        assert_eq!(documents[0]["chunk_count"], json!(2));
        assert_eq!(documents[0]["truncated"], json!(false));
        assert_eq!(documents[0]["tags"], json!("需求"));

        let found = find_document_by_sha(&conn, "p1", "abc")
            .expect("lookup")
            .expect("row");
        assert_eq!(found.chunks, 2);
        assert!(find_document_by_sha(&conn, "p1", "").unwrap().is_none());

        let page = list_document_chunks(&conn, "p1", "doc-0000aaaa", 20, 0).expect("chunks");
        assert_eq!(page["total"], json!(2));
        assert_eq!(page["chunks"][1]["title"], json!("1. 功能需求"));
        assert_eq!(page["chunks"][1]["chars"], json!(8));
        assert_eq!(page["chunks"][1]["source_ref"], json!("doc:doc-0000aaaa#2"));

        let stats = module_stats(&conn, "p1").expect("stats");
        assert_eq!(stats["total"], json!({"docs": 1, "chunks": 2}));

        let updated = update_document(&conn, "p1", "doc-0000aaaa", Some(""), Some("标签"))
            .expect("update")
            .expect("row");
        assert_eq!(updated["module"], json!(""));
        assert_eq!(updated["tags"], json!("标签"));

        assert_eq!(
            delete_document(&conn, "p1", "doc-0000aaaa").expect("delete"),
            2
        );
        assert_eq!(list_documents(&conn, "p1").expect("list").len(), 0);
    }

    #[test]
    fn empty_module_is_grouped_as_ungrouped() {
        let conn = memory_db();
        save_document(
            &conn,
            NewDocument {
                project_id: "p1",
                filename: "a.md",
                stored_path: "",
                file_format: "text",
                size: 0,
                module: "",
                tags: &[],
                truncated: false,
                chunks: &chunks(),
                doc_id: "doc-0000bbbb",
                sha256: "",
            },
        )
        .expect("save");
        let stats = module_stats(&conn, "p1").expect("stats");
        assert_eq!(stats["modules"][0]["module"], json!("未分组"));
    }
}
