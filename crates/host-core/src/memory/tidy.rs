//! Retention for the durable memory store (ADR 0371, stage 2b).
//!
//! Two rules, both explainable to a user staring at their memory list:
//!
//! 1. **Expiry** — a memory that was never recalled, carries low confidence,
//!    is not pinned, and has not been touched for a long time is removed.
//!    "Never recalled" is the important half: a memory the agent keeps using
//!    survives no matter how old it is.
//! 2. **Overflow** — above a hard cap on live rows the least valuable memories
//!    go first (`pinned`, then `use_count`, then `confidence`, then age).
//!    Pinned memories are never removed by either rule.
//!
//! Superseded rows are exempt: they are the history of a memory that replaced
//! them, and `forget` is the only thing that removes history.

use anyhow::Result;
use rusqlite::params;

use crate::db::{now_ms, Database};

const DAY_MS: i64 = 24 * 3600 * 1000;

/// Retention policy. Defaults are deliberately conservative; a user who never
/// opens the memory panel should not lose a memory they would miss.
#[derive(Debug, Clone)]
pub struct TidyPolicy {
    /// Age after which an unused, low-confidence memory expires.
    pub max_age_ms: i64,
    /// Confidence below which an unused memory may expire.
    pub min_confidence: f64,
    /// Hard cap on live memories; the least valuable are removed beyond it.
    pub max_live: usize,
    /// When false, only the overflow rule runs.
    pub expire: bool,
}

impl Default for TidyPolicy {
    fn default() -> Self {
        Self {
            max_age_ms: 90 * DAY_MS,
            min_confidence: 0.4,
            max_live: 50_000,
            expire: true,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyOutcome {
    /// Removed because they were never recalled, low confidence, and long idle.
    pub expired: usize,
    /// Removed because the live store exceeded its cap.
    pub overflow: usize,
}

impl TidyOutcome {
    pub fn total(&self) -> usize {
        self.expired + self.overflow
    }
}

impl Database {
    /// Apply the retention policy. Returns how many rows were removed; every
    /// removal also drops the matching FTS row.
    pub fn tidy_memories(&self, policy: &TidyPolicy) -> Result<TidyOutcome> {
        let now = now_ms();
        let mut outcome = TidyOutcome::default();

        if policy.expire {
            let cutoff = now - policy.max_age_ms.max(0);
            let ids = self.collect_ids(
                "SELECT rowid FROM memories
                  WHERE pinned = 0
                    AND superseded_by IS NULL
                    AND use_count = 0
                    AND confidence < ?1
                    AND created_at < ?2
                  LIMIT 5000",
                params![policy.min_confidence, cutoff],
            )?;
            outcome.expired = self.delete_rowids(&ids)?;
        }

        let live: i64 = self.conn.query_row(
            "SELECT count(*) FROM memories WHERE superseded_by IS NULL",
            [],
            |row| row.get(0),
        )?;
        // Pinned rows are excluded from the overflow query below, so the cap
        // applies to unpinned rows only and needs no pinned floor.
        let cap = policy.max_live.max(1) as i64;
        if live > cap {
            let excess = live - cap;
            let ids = self.collect_ids(
                "SELECT rowid FROM memories
                  WHERE pinned = 0 AND superseded_by IS NULL
                  ORDER BY use_count ASC, confidence ASC, created_at ASC
                  LIMIT ?1",
                params![excess],
            )?;
            outcome.overflow = self.delete_rowids(&ids)?;
        }

        Ok(outcome)
    }

    fn collect_ids(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, |row| row.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn delete_rowids(&self, rowids: &[i64]) -> Result<usize> {
        if rowids.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.unchecked_transaction()?;
        let mut removed = 0;
        for rowid in rowids {
            tx.execute("DELETE FROM memories_fts WHERE rowid = ?1", params![rowid])?;
            removed += tx.execute("DELETE FROM memories WHERE rowid = ?1", params![rowid])?;
        }
        tx.commit()?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{MemoryKind, MemoryScope, NewMemory};

    fn db() -> (Database, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (db, dir)
    }

    fn write(db: &Database, title: &str, confidence: f64, pinned: bool) -> String {
        let mut input = NewMemory::new(
            MemoryScope::Project,
            MemoryKind::Fact,
            title,
            "body text for recall",
        )
        .in_project("/w/pi")
        .pinned(pinned);
        input.confidence = confidence;
        db.remember(input).unwrap().memory.id
    }

    fn age(db: &Database, id: &str, created_ms: i64) {
        db.conn
            .execute(
                "UPDATE memories SET created_at = ?1 WHERE id = ?2",
                params![created_ms, id],
            )
            .unwrap();
    }

    fn count(db: &Database) -> i64 {
        db.conn
            .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn an_old_unused_low_confidence_memory_expires() {
        let (db, _dir) = db();
        let id = write(&db, "stale note", 0.2, false);
        age(&db, &id, now_ms() - 200 * DAY_MS);

        let outcome = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(outcome.expired, 1);
        assert_eq!(count(&db), 0);
    }

    #[test]
    fn a_used_memory_never_expires_however_old() {
        let (db, _dir) = db();
        let id = write(&db, "used note", 0.2, false);
        age(&db, &id, now_ms() - 400 * DAY_MS);
        db.conn
            .execute(
                "UPDATE memories SET use_count = 3 WHERE id = ?1",
                params![id],
            )
            .unwrap();

        let outcome = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(outcome.expired, 0);
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn a_pinned_memory_never_expires() {
        let (db, _dir) = db();
        let id = write(&db, "pinned rule", 0.1, true);
        age(&db, &id, now_ms() - 400 * DAY_MS);

        let outcome = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(outcome.expired, 0);
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn a_confident_recent_memory_survives() {
        let (db, _dir) = db();
        write(&db, "fresh note", 0.9, false);
        let outcome = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(outcome.total(), 0);
        assert_eq!(count(&db), 1);
    }

    #[test]
    fn superseded_history_is_never_expired() {
        let (db, _dir) = db();
        let old = write(&db, "deploy host v1", 0.2, false);
        let new = write(&db, "deploy host v2", 0.9, false);
        db.supersede_memory(&old, &new).unwrap();
        age(&db, &old, now_ms() - 400 * DAY_MS);

        let outcome = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(outcome.expired, 0);
        assert_eq!(count(&db), 2);
    }

    #[test]
    fn overflow_removes_the_least_valuable_and_keeps_pinned() {
        let (db, _dir) = db();
        let pinned = write(&db, "pinned", 0.9, true);
        let used = write(&db, "used", 0.9, false);
        db.conn
            .execute(
                "UPDATE memories SET use_count = 5 WHERE id = ?1",
                params![used],
            )
            .unwrap();
        let idle = write(&db, "idle", 0.9, false);

        let policy = TidyPolicy {
            max_live: 2,
            expire: false,
            ..Default::default()
        };
        let outcome = db.tidy_memories(&policy).unwrap();
        assert_eq!(outcome.overflow, 1);
        let left: Vec<String> = {
            let mut stmt = db
                .conn
                .prepare("SELECT id FROM memories ORDER BY id")
                .unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
            rows.map(|row| row.unwrap()).collect()
        };
        assert!(left.contains(&pinned));
        assert!(left.contains(&used));
        assert!(!left.contains(&idle));
    }

    #[test]
    fn expiry_drops_the_index_row_too() {
        let (db, _dir) = db();
        let id = write(&db, "stale deploys", 0.2, false);
        age(&db, &id, now_ms() - 200 * DAY_MS);
        db.tidy_memories(&TidyPolicy::default()).unwrap();

        let hits = db
            .recall(crate::memory::RecallQuery {
                query: "stale".into(),
                project_path: Some("/w/pi".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn tidying_twice_is_stable() {
        let (db, _dir) = db();
        let id = write(&db, "stale note", 0.2, false);
        age(&db, &id, now_ms() - 200 * DAY_MS);
        let first = db.tidy_memories(&TidyPolicy::default()).unwrap();
        let second = db.tidy_memories(&TidyPolicy::default()).unwrap();
        assert_eq!(first.total(), 1);
        assert_eq!(second.total(), 0);
    }

    #[test]
    fn expire_can_be_disabled() {
        let (db, _dir) = db();
        let id = write(&db, "stale note", 0.2, false);
        age(&db, &id, now_ms() - 400 * DAY_MS);
        let policy = TidyPolicy {
            expire: false,
            ..Default::default()
        };
        assert_eq!(db.tidy_memories(&policy).unwrap().total(), 0);
        assert_eq!(count(&db), 1);
    }
}
