//! Durable agent memory (ADR 0371).
//!
//! One SQLite table holds every memory; a separate FTS5 table holds a
//! *normalised copy* of the searchable text. Splitting the index out of the
//! content table is deliberate: SQLite's bundled tokenizers cannot segment
//! CJK, so the write path inserts one token per ideograph and the read path
//! normalises the query the same way. A memory therefore stays greppable in
//! Chinese and English without shipping a segmenter.
//!
//! Scopes are the three budgets the runtime injects:
//!
//! * `global`  — cross-project preferences; injected every turn (small).
//! * `project` — facts about one checkout; injected for that project.
//! * `session` — notes for one conversation; recalled only inside it.
//!
//! Writes are model-free. Extraction (deciding *what* is worth remembering)
//! belongs to a later stage; this module owns storage, dedupe, supersession
//! and keyword recall only — the same boundary `@memharness/core` draws.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{now_ms, Database};

mod tidy;
#[allow(unused_imports)] // TidyOutcome is the documented return type
pub use tidy::{TidyOutcome, TidyPolicy};

/// Title characters kept (matches the schema CHECK).
pub const MAX_TITLE_CHARS: usize = 200;
/// Body bytes kept (matches the schema CHECK).
pub const MAX_BODY_BYTES: usize = 8000;
/// Default recall size; the injector asks for fewer.
pub const DEFAULT_RECALL_LIMIT: usize = 8;
/// Hard cap so one caller cannot pull the whole table into a prompt.
pub const MAX_RECALL_LIMIT: usize = 50;
/// Upper bound on pinned memories, which are injected unconditionally.
pub const MAX_PINNED: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    Global,
    Project,
    Session,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
            Self::Session => "session",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "global" => Ok(Self::Global),
            "project" => Ok(Self::Project),
            "session" => Ok(Self::Session),
            other => Err(anyhow!("unknown memory scope: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Fact,
    Preference,
    Decision,
    Pitfall,
    Procedure,
}

impl MemoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Decision => "decision",
            Self::Pitfall => "pitfall",
            Self::Procedure => "procedure",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "fact" => Ok(Self::Fact),
            "preference" => Ok(Self::Preference),
            "decision" => Ok(Self::Decision),
            "pitfall" => Ok(Self::Pitfall),
            "procedure" => Ok(Self::Procedure),
            other => Err(anyhow!("unknown memory kind: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemorySource {
    Agent,
    User,
    Import,
}

impl MemorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::User => "user",
            Self::Import => "import",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "agent" => Ok(Self::Agent),
            "user" => Ok(Self::User),
            "import" => Ok(Self::Import),
            other => Err(anyhow!("unknown memory source: {other}")),
        }
    }
}

/// A memory as returned to callers (RPC and UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub scope: MemoryScope,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub confidence: f64,
    pub pinned: bool,
    pub use_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub valid_from: i64,
    pub valid_until: Option<i64>,
    pub superseded_by: Option<String>,
}

impl MemoryRecord {
    /// Whether this memory is still believed (not superseded).
    #[allow(dead_code)] // the stage-2 injector and the memory panel read it
    pub fn is_live(&self) -> bool {
        self.superseded_by.is_none()
    }
}

/// Write input. Scopes and paths are validated before any state changes.
#[derive(Debug, Clone)]
pub struct NewMemory {
    pub scope: MemoryScope,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub kind: MemoryKind,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source: MemorySource,
    pub confidence: f64,
    pub pinned: bool,
}

#[allow(dead_code)] // builder helpers used by tests and the stage-2 extractor
impl NewMemory {
    pub fn new(
        scope: MemoryScope,
        kind: MemoryKind,
        title: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            scope,
            project_path: None,
            session_id: None,
            kind,
            title: title.into(),
            body: body.into(),
            tags: Vec::new(),
            source: MemorySource::Agent,
            confidence: 0.7,
            pinned: false,
        }
    }

    pub fn in_project(mut self, path: impl Into<String>) -> Self {
        self.project_path = Some(path.into());
        self
    }

    pub fn in_session(mut self, id: impl Into<String>) -> Self {
        self.session_id = Some(id.into());
        self
    }

    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    pub fn pinned(mut self, pinned: bool) -> Self {
        self.pinned = pinned;
        self
    }

    fn validate(&self) -> Result<()> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(anyhow!("memory title is empty"));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(anyhow!("memory title exceeds {MAX_TITLE_CHARS} characters"));
        }
        if self.body.trim().is_empty() {
            return Err(anyhow!("memory body is empty"));
        }
        if self.body.len() > MAX_BODY_BYTES {
            return Err(anyhow!("memory body exceeds {MAX_BODY_BYTES} bytes"));
        }
        if !(0.0..=1.0).contains(&self.confidence) {
            return Err(anyhow!("memory confidence must be within 0..=1"));
        }
        match self.scope {
            MemoryScope::Project => {
                if self.project_path.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(anyhow!("project-scoped memory needs projectPath"));
                }
                if self.session_id.is_some() {
                    return Err(anyhow!("project-scoped memory cannot carry sessionId"));
                }
            }
            MemoryScope::Session => {
                if self.session_id.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(anyhow!("session-scoped memory needs sessionId"));
                }
                if self.project_path.is_some() {
                    return Err(anyhow!("session-scoped memory cannot carry projectPath"));
                }
            }
            MemoryScope::Global => {
                if self.project_path.is_some() || self.session_id.is_some() {
                    return Err(anyhow!(
                        "global memory cannot carry projectPath or sessionId"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Outcome of a write; `deduped` means an identical live memory already
/// existed and was refreshed instead of duplicated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberOutcome {
    pub memory: MemoryRecord,
    pub deduped: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RecallQuery {
    pub query: String,
    pub scope: Option<MemoryScope>,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub memory: MemoryRecord,
    /// BM25 score; lower is more relevant (SQLite convention).
    pub score: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub scope: Option<MemoryScope>,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub kind: Option<MemoryKind>,
    pub pinned: Option<bool>,
    pub include_superseded: bool,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total: i64,
    pub live: i64,
    pub pinned: i64,
    pub by_scope: serde_json::Value,
    pub by_kind: serde_json::Value,
}

/// Normalise text for the keyword index: every CJK ideograph becomes its own
/// token so `压缩` matches `上下文压缩` without a segmenter. Latin words are
/// left untouched. Runs of whitespace collapse to one space.
pub fn normalise_search_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if is_cjk(ch) {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push(ch);
            out.push(' ');
            pending_space = false;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30FF      // kana
            | 0x3400..=0x4DBF // CJK ext A
            | 0x4E00..=0x9FFF // CJK unified
            | 0xF900..=0xFAFF // compatibility ideographs
            | 0x20000..=0x2FA1F // CJK ext B+
    )
}

/// Build an FTS5 MATCH expression from free text. Every term is quoted, so
/// FTS5 operators a user might type (`*`, `-`, `:`, `OR`) are inert, and terms
/// are AND-ed: a memory must contain all of them.
pub fn fts_match_query(query: &str) -> String {
    let normalised = normalise_search_text(query);
    let mut terms: Vec<String> = Vec::new();
    for raw in normalised.split_whitespace() {
        let cleaned: String = raw
            .chars()
            .filter(|c| c.is_alphanumeric() || is_cjk(*c) || *c == '_')
            .collect();
        if cleaned.is_empty() {
            continue;
        }
        terms.push(format!("\"{cleaned}\""));
        if terms.len() >= 16 {
            break;
        }
    }
    terms.join(" AND ")
}

/// Dedupe key: identical title+body writes the same hash regardless of scope.
pub fn content_hash(title: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(title.trim().as_bytes());
    hasher.update(b"\n");
    hasher.update(body.trim().as_bytes());
    hex::encode(hasher.finalize())
}

impl Database {
    /// Store a memory, or refresh an identical one that is still live.
    pub fn remember(&self, input: NewMemory) -> Result<RememberOutcome> {
        input.validate()?;
        let now = now_ms();
        let hash = content_hash(&input.title, &input.body);
        let project_path = input.project_path.as_deref().map(str::trim);
        let session_id = input.session_id.as_deref().map(str::trim);

        let existing: Option<(String, f64, i64)> = self
            .conn
            .query_row(
                "SELECT id, confidence, pinned FROM memories
                  WHERE content_hash = ?1 AND scope = ?2
                    AND ifnull(project_path, '') = ifnull(?3, '')
                    AND ifnull(session_id, '') = ifnull(?4, '')
                    AND superseded_by IS NULL",
                params![
                    hash,
                    input.scope.as_str(),
                    project_path.unwrap_or(""),
                    session_id.unwrap_or("")
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        if let Some((id, old_confidence, old_pinned)) = existing {
            let confidence = if input.confidence > old_confidence {
                input.confidence
            } else {
                old_confidence
            };
            let pinned = if input.pinned || old_pinned != 0 {
                1
            } else {
                0
            };
            self.conn.execute(
                "UPDATE memories SET confidence = ?1, pinned = ?2, updated_at = ?3 WHERE id = ?4",
                params![confidence, pinned, now, id],
            )?;
            self.sync_fts_for(&id)?;
            return Ok(RememberOutcome {
                memory: self.get_memory(&id)?,
                deduped: true,
            });
        }

        if input.pinned {
            self.enforce_pinned_budget()?;
        }

        let id = uuid::Uuid::new_v4().to_string();
        let tags = serde_json::to_string(&input.tags)?;
        self.conn.execute(
            "INSERT INTO memories (
                id, scope, project_path, session_id, kind, title, body, tags, source,
                confidence, pinned, content_hash, use_count, created_at, updated_at,
                last_used_at, valid_from, valid_until, superseded_by
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?13, NULL, ?13, NULL, NULL)",
            params![
                id,
                input.scope.as_str(),
                project_path,
                session_id,
                input.kind.as_str(),
                input.title.trim(),
                input.body.trim(),
                tags,
                input.source.as_str(),
                input.confidence,
                if input.pinned { 1 } else { 0 },
                hash,
                now
            ],
        )?;
        self.sync_fts_for(&id)?;
        Ok(RememberOutcome {
            memory: self.get_memory(&id)?,
            deduped: false,
        })
    }

    /// Keyword recall. Scope filtering is part of the query, not a post-filter:
    /// a project session must never see another project's memories.
    pub fn recall(&self, query: RecallQuery) -> Result<Vec<MemoryHit>> {
        let match_expr = fts_match_query(&query.query);
        if match_expr.is_empty() {
            return Ok(Vec::new());
        }
        let limit = query
            .limit
            .unwrap_or(DEFAULT_RECALL_LIMIT)
            .clamp(1, MAX_RECALL_LIMIT) as i64;
        let scope = query.scope.map(MemoryScope::as_str);
        let sql = "SELECT m.id, m.scope, m.project_path, m.session_id, m.kind, m.title, m.body,
                          m.tags, m.source, m.confidence, m.pinned, m.use_count, m.created_at,
                          m.updated_at, m.last_used_at, m.valid_from, m.valid_until, m.superseded_by,
                          bm25(memories_fts) AS score
                     FROM memories_fts
                     JOIN memories m ON m.rowid = memories_fts.rowid
                    WHERE memories_fts MATCH ?1
                      AND m.superseded_by IS NULL
                      AND (?2 IS NULL OR m.scope = ?2)
                      AND (
                            m.scope = 'global'
                            OR (m.scope = 'project' AND m.project_path = ?3)
                            OR (m.scope = 'session' AND m.session_id = ?4)
                          )
                    ORDER BY m.pinned DESC, score ASC, m.use_count DESC, m.created_at DESC
                    LIMIT ?5";
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![
                match_expr,
                scope,
                query.project_path.as_deref(),
                query.session_id.as_deref(),
                limit
            ],
            |row| Ok((row_to_memory(row)?, row.get::<_, f64>(18)?)),
        )?;
        let mut hits = Vec::new();
        let mut touched = Vec::new();
        for row in rows {
            let (memory, score) = row?;
            touched.push(memory.id.clone());
            hits.push(MemoryHit { memory, score });
        }
        drop(stmt);
        self.mark_used(&touched)?;
        Ok(hits)
    }

    pub fn get_memory(&self, id: &str) -> Result<MemoryRecord> {
        self.conn
            .query_row(
                "SELECT id, scope, project_path, session_id, kind, title, body, tags, source,
                        confidence, pinned, use_count, created_at, updated_at, last_used_at,
                        valid_from, valid_until, superseded_by
                   FROM memories WHERE id = ?1",
                params![id],
                row_to_memory,
            )
            .map_err(|e| anyhow!("memory {id} not found: {e}"))
    }

    /// List memories for the UI. Returns the page and the total row count that
    /// matches the filter, so the panel can paginate without guessing.
    pub fn list_memories(&self, filter: &ListFilter) -> Result<(Vec<MemoryRecord>, i64)> {
        let limit = filter.limit.unwrap_or(50).clamp(1, 500) as i64;
        let offset = filter.offset.unwrap_or(0) as i64;
        let scope = filter.scope.map(MemoryScope::as_str);
        let kind = filter.kind.map(MemoryKind::as_str);
        let pinned = filter.pinned.map(|value| if value { 1 } else { 0 });
        let where_sql = "WHERE (?1 IS NULL OR scope = ?1)
                           AND (?2 IS NULL OR kind = ?2)
                           AND (?3 IS NULL OR pinned = ?3)
                           AND (?4 IS NULL OR project_path = ?4)
                           AND (?5 IS NULL OR session_id = ?5)
                           AND (?6 = 1 OR superseded_by IS NULL)";
        let total: i64 = self.conn.query_row(
            &format!("SELECT count(*) FROM memories {where_sql}"),
            params![
                scope,
                kind,
                pinned,
                filter.project_path.as_deref(),
                filter.session_id.as_deref(),
                if filter.include_superseded { 1 } else { 0 }
            ],
            |row| row.get(0),
        )?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, scope, project_path, session_id, kind, title, body, tags, source,
                    confidence, pinned, use_count, created_at, updated_at, last_used_at,
                    valid_from, valid_until, superseded_by
               FROM memories {where_sql}
              ORDER BY pinned DESC, created_at DESC
              LIMIT ?7 OFFSET ?8"
        ))?;
        let rows = stmt.query_map(
            params![
                scope,
                kind,
                pinned,
                filter.project_path.as_deref(),
                filter.session_id.as_deref(),
                if filter.include_superseded { 1 } else { 0 },
                limit,
                offset
            ],
            row_to_memory,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok((out, total))
    }

    /// Patch a memory in place. `None` means "leave unchanged".
    pub fn update_memory(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        tags: Option<&[String]>,
        confidence: Option<f64>,
        pinned: Option<bool>,
    ) -> Result<MemoryRecord> {
        let current = self.get_memory(id)?;
        let next_title = title.map(str::trim).unwrap_or(&current.title).to_string();
        let next_body = body.map(str::trim).unwrap_or(&current.body).to_string();
        let next_title = if next_title.is_empty() {
            return Err(anyhow!("memory title is empty"));
        } else {
            next_title
        };
        let next_body = if next_body.is_empty() {
            return Err(anyhow!("memory body is empty"));
        } else {
            next_body
        };
        if next_title.chars().count() > MAX_TITLE_CHARS {
            return Err(anyhow!("memory title exceeds {MAX_TITLE_CHARS} characters"));
        }
        if next_body.len() > MAX_BODY_BYTES {
            return Err(anyhow!("memory body exceeds {MAX_BODY_BYTES} bytes"));
        }
        let next_confidence = confidence.unwrap_or(current.confidence);
        if !(0.0..=1.0).contains(&next_confidence) {
            return Err(anyhow!("memory confidence must be within 0..=1"));
        }
        let next_tags = match tags {
            Some(values) => serde_json::to_string(values)?,
            None => serde_json::to_string(&current.tags)?,
        };
        let next_pinned = pinned.unwrap_or(current.pinned);
        if next_pinned && !current.pinned {
            self.enforce_pinned_budget()?;
        }
        let hash = content_hash(&next_title, &next_body);
        self.conn.execute(
            "UPDATE memories
                SET title = ?1, body = ?2, tags = ?3, confidence = ?4, pinned = ?5,
                    content_hash = ?6, updated_at = ?7
              WHERE id = ?8",
            params![
                next_title,
                next_body,
                next_tags,
                next_confidence,
                if next_pinned { 1 } else { 0 },
                hash,
                now_ms(),
                id
            ],
        )?;
        self.sync_fts_for(id)?;
        self.get_memory(id)
    }

    /// Delete one memory (hard delete, index included). Returns whether a row
    /// existed.
    pub fn forget_memory(&self, id: &str) -> Result<bool> {
        let rowid: Option<i64> = self
            .conn
            .query_row(
                "SELECT rowid FROM memories WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(rowid) = rowid else {
            return Ok(false);
        };
        self.conn
            .execute("DELETE FROM memories_fts WHERE rowid = ?1", params![rowid])?;
        self.conn
            .execute("DELETE FROM memories WHERE id = ?1", params![id])?;
        Ok(true)
    }

    /// Forget everything a session taught the agent ("forget that session").
    pub fn forget_memories_for_session(&self, session_id: &str) -> Result<usize> {
        let ids: Vec<(String, i64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, rowid FROM memories WHERE session_id = ?1 OR (scope = 'session' AND session_id = ?1)",
            )?;
            let rows = stmt.query_map(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if ids.is_empty() {
            return Ok(0);
        }
        for (_, rowid) in &ids {
            self.conn
                .execute("DELETE FROM memories_fts WHERE rowid = ?1", params![rowid])?;
        }
        self.conn.execute(
            "DELETE FROM memories WHERE session_id = ?1 OR (scope = 'session' AND session_id = ?1)",
            params![session_id],
        )?;
        Ok(ids.len())
    }

    /// Close an old fact and point it at its replacement, instead of
    /// overwriting history.
    pub fn supersede_memory(&self, old_id: &str, new_id: &str) -> Result<()> {
        let now = now_ms();
        let changed = self.conn.execute(
            "UPDATE memories SET superseded_by = ?1, valid_until = ?2, updated_at = ?2
              WHERE id = ?3 AND superseded_by IS NULL",
            params![new_id, now, old_id],
        )?;
        if changed == 0 {
            return Err(anyhow!("memory {old_id} is missing or already superseded"));
        }
        self.conn.execute(
            "UPDATE memories SET valid_from = ?1 WHERE id = ?2 AND valid_from > ?1",
            params![now, new_id],
        )?;
        Ok(())
    }

    pub fn memory_stats(&self) -> Result<MemoryStats> {
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))?;
        let live: i64 = self.conn.query_row(
            "SELECT count(*) FROM memories WHERE superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        let pinned: i64 = self.conn.query_row(
            "SELECT count(*) FROM memories WHERE pinned = 1",
            [],
            |row| row.get(0),
        )?;
        let mut by_scope = serde_json::Map::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT scope, count(*) FROM memories GROUP BY scope")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (scope, count) = row?;
                by_scope.insert(scope, serde_json::json!(count));
            }
        }
        let mut by_kind = serde_json::Map::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT kind, count(*) FROM memories GROUP BY kind")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                let (kind, count) = row?;
                by_kind.insert(kind, serde_json::json!(count));
            }
        }
        Ok(MemoryStats {
            total,
            live,
            pinned,
            by_scope: serde_json::Value::Object(by_scope),
            by_kind: serde_json::Value::Object(by_kind),
        })
    }

    /// Memories that are injected unconditionally: pinned first, then the most
    /// used, inside one scope window.
    pub fn pinned_memories(
        &self,
        project_path: Option<&str>,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>> {
        let limit = limit.clamp(1, MAX_PINNED) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, project_path, session_id, kind, title, body, tags, source,
                    confidence, pinned, use_count, created_at, updated_at, last_used_at,
                    valid_from, valid_until, superseded_by
               FROM memories
              WHERE pinned = 1 AND superseded_by IS NULL
                AND (scope = 'global'
                     OR (scope = 'project' AND project_path = ?1)
                     OR (scope = 'session' AND session_id = ?2))
              ORDER BY use_count DESC, created_at DESC
              LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![project_path, session_id, limit], row_to_memory)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn mark_used(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        for id in ids {
            self.conn.execute(
                "UPDATE memories SET use_count = use_count + 1, last_used_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
        Ok(())
    }

    /// Keep pinned memories inside `MAX_PINNED` by unpinning the least used.
    fn enforce_pinned_budget(&self) -> Result<()> {
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM memories WHERE pinned = 1 AND superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        if count < MAX_PINNED as i64 {
            return Ok(());
        }
        self.conn.execute(
            "UPDATE memories SET pinned = 0
              WHERE id IN (
                SELECT id FROM memories WHERE pinned = 1 AND superseded_by IS NULL
                 ORDER BY use_count ASC, created_at ASC LIMIT 1
              )",
            [],
        )?;
        Ok(())
    }

    /// Rebuild the index row for one memory from its stored text.
    fn sync_fts_for(&self, id: &str) -> Result<()> {
        let row: Option<(i64, String, String, String)> = self
            .conn
            .query_row(
                "SELECT rowid, title, body, tags FROM memories WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((rowid, title, body, tags)) = row else {
            return Ok(());
        };
        self.conn
            .execute("DELETE FROM memories_fts WHERE rowid = ?1", params![rowid])?;
        let tags_text = serde_json::from_str::<Vec<String>>(&tags)
            .unwrap_or_default()
            .join(" ");
        self.conn.execute(
            "INSERT INTO memories_fts (rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
            params![
                rowid,
                normalise_search_text(&title),
                normalise_search_text(&body),
                normalise_search_text(&tags_text)
            ],
        )?;
        Ok(())
    }
}

fn row_to_memory(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let scope: String = row.get(1)?;
    let kind: String = row.get(4)?;
    let tags: String = row.get(7)?;
    let source: String = row.get(8)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        scope: MemoryScope::parse(&scope).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, e.into())
        })?,
        project_path: row.get(2)?,
        session_id: row.get(3)?,
        kind: MemoryKind::parse(&kind).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, e.into())
        })?,
        title: row.get(5)?,
        body: row.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        source: MemorySource::parse(&source).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, e.into())
        })?,
        confidence: row.get(9)?,
        pinned: row.get::<_, i64>(10)? != 0,
        use_count: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        last_used_at: row.get(14)?,
        valid_from: row.get(15)?,
        valid_until: row.get(16)?,
        superseded_by: row.get(17)?,
    })
}

#[cfg(test)]
mod tests;
