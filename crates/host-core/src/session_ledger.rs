//! The session ledger: what this session has already done, kept where neither
//! compaction nor ageing can reach it.
//!
//! A long agent session loses its own history three ways, all of them by design:
//! compaction replaces the transcript with a summary, ageing keeps only the two
//! ends of an old tool result, and a restart drops subagent rows the parent never
//! owned. Each is the right call for the request budget, and together they mean
//! the model can be looking at a conversation that no longer says what was
//! decided or finished — most visibly after the client is closed and reopened,
//! and hardest in smart mode, where most of the work happens in workers whose
//! transcript the parent never sees at all.
//!
//! The ledger is the missing half: short, structured, append-only notes written
//! at boundaries the kernel already detects (a turn ended, a delegation settled),
//! stored beside the session, and prepended to every request. It is not a second
//! transcript — one entry is a few lines, and the request carries only the newest
//! few — so what survives is the conclusion, not the evidence.
//!
//! Ownership: host-core owns the table, the kernel writes and reads it over RPC
//! (`session.ledger.append` / `session.ledger.list`), the renderer reads the same
//! rows when it wants to show the session's progress.

use anyhow::{bail, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{now_ms, Database};

/// Longest entry the store accepts, in characters.
///
/// An entry is a conclusion, not a log: the kernel caps what it writes well below
/// this, and the cap here exists so a caller cannot turn the ledger into a second
/// transcript by accident.
pub const ENTRY_MAX_CHARS: usize = 4_000;

/// Entries kept per session, newest last. Beyond this the oldest go: a session
/// that ran for days should not carry a month of one-line summaries into every
/// request, and the request only ever reads the newest few.
pub const ENTRY_KEEP_PER_SESSION: i64 = 500;

/// One ledger entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntryRecord {
    pub id: i64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// `turn`, `delegation`, `decision` or `pause`. Free-form on purpose: the
    /// kernel adds boundaries as it learns which ones matter, and an unknown kind
    /// must never fail a write the turn already paid for.
    pub kind: String,
    pub text: String,
    pub created_at: i64,
}

/// Append one entry and trim the session's oldest rows.
pub fn append(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    kind: &str,
    text: &str,
) -> Result<LedgerEntryRecord> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        bail!("session id required");
    }
    let kind = kind.trim();
    if kind.is_empty() {
        bail!("ledger entry kind required");
    }
    let text = text.trim();
    if text.is_empty() {
        bail!("ledger entry text required");
    }
    let text: String = text.chars().take(ENTRY_MAX_CHARS).collect();
    let turn_id = turn_id.map(str::trim).filter(|id| !id.is_empty());
    let created_at = now_ms();
    let conn = db.conn();
    conn.execute(
        "INSERT INTO session_ledger (session_id, turn_id, kind, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, turn_id, kind, text, created_at],
    )?;
    let id = conn.last_insert_rowid();
    // Trim inside the same call: an unbounded append-only table is a disk leak,
    // and the entry this turn just wrote is the one that must never be trimmed.
    conn.execute(
        "DELETE FROM session_ledger
         WHERE session_id = ?1 AND id <= ?2",
        params![session_id, id - ENTRY_KEEP_PER_SESSION],
    )?;
    Ok(LedgerEntryRecord {
        id,
        session_id: session_id.to_string(),
        turn_id: turn_id.map(str::to_string),
        kind: kind.to_string(),
        text,
        created_at,
    })
}

/// The newest `limit` entries, oldest first — the order a request reads them in.
pub fn recent(db: &Database, session_id: &str, limit: usize) -> Result<Vec<LedgerEntryRecord>> {
    let limit = limit.clamp(1, 200) as i64;
    let mut stmt = db.conn().prepare_cached(
        "SELECT id, session_id, turn_id, kind, text, created_at
         FROM session_ledger WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![session_id, limit], |row| {
        Ok(LedgerEntryRecord {
            id: row.get(0)?,
            session_id: row.get(1)?,
            turn_id: row.get(2)?,
            kind: row.get(3)?,
            text: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    let mut entries: Vec<LedgerEntryRecord> = rows.collect::<Result<Vec<_>, _>>()?;
    entries.reverse();
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.keep().join("pi.sqlite");
        Database::open(&path).unwrap()
    }

    /// Raw count, so a test can assert the table's own size past the read limit.
    fn stored(db: &Database, session_id: &str) -> i64 {
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM session_ledger WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn an_entry_round_trips_with_its_turn() {
        let db = db();
        let written = append(&db, "s1", Some("t1"), "turn", "ran the tests").unwrap();
        let read = recent(&db, "s1", 10).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0], written);
        assert_eq!(read[0].turn_id.as_deref(), Some("t1"));
        assert_eq!(stored(&db, "s1"), 1);
    }

    #[test]
    fn entries_come_back_oldest_first_and_only_this_sessions() {
        let db = db();
        append(&db, "s1", None, "turn", "first").unwrap();
        append(&db, "s2", None, "turn", "other session").unwrap();
        append(&db, "s1", None, "delegation", "second").unwrap();
        let texts: Vec<String> = recent(&db, "s1", 10)
            .unwrap()
            .into_iter()
            .map(|entry| entry.text)
            .collect();
        assert_eq!(texts, ["first", "second"]);
    }

    #[test]
    fn the_newest_entries_are_the_ones_a_limit_keeps() {
        let db = db();
        for index in 0..5 {
            append(&db, "s1", None, "turn", &format!("entry {index}")).unwrap();
        }
        let texts: Vec<String> = recent(&db, "s1", 2)
            .unwrap()
            .into_iter()
            .map(|entry| entry.text)
            .collect();
        assert_eq!(texts, ["entry 3", "entry 4"]);
    }

    #[test]
    fn an_empty_entry_is_refused_rather_than_stored() {
        let db = db();
        assert!(append(&db, "s1", None, "turn", "   ").is_err());
        assert!(append(&db, "", None, "turn", "text").is_err());
        assert!(append(&db, "s1", None, "  ", "text").is_err());
        assert_eq!(stored(&db, "s1"), 0);
    }

    #[test]
    fn an_over_long_entry_is_cut_instead_of_rejected() {
        let db = db();
        let long = "x".repeat(ENTRY_MAX_CHARS + 500);
        let entry = append(&db, "s1", None, "turn", &long).unwrap();
        assert_eq!(entry.text.chars().count(), ENTRY_MAX_CHARS);
    }

    #[test]
    fn a_session_keeps_a_bounded_number_of_entries() {
        let db = db();
        // The trim is one DELETE per append, so a thousand appends cost a
        // thousand deletes; the assertions are about the surviving window.
        for index in 0..(ENTRY_KEEP_PER_SESSION + 5) {
            append(&db, "s1", None, "turn", &format!("entry {index}")).unwrap();
        }
        assert_eq!(stored(&db, "s1"), ENTRY_KEEP_PER_SESSION);
        let newest = recent(&db, "s1", 1).unwrap();
        assert_eq!(
            newest[0].text,
            format!("entry {}", ENTRY_KEEP_PER_SESSION + 4),
            "the entry just written is never the one trimmed"
        );
    }
}
