//! Entry-list memory (ADR 0378), ported from Hermes' `MemoryStore`.
//!
//! The earlier design (ADR 0371) stored memories as structured rows —
//! title/body/kind/scope — and decided *what* to remember with a post-turn
//! extraction pass whose output a person had to review. That queue is what made
//! the feature cost attention instead of saving it, and in practice nothing
//! reached the store at all.
//!
//! This module stores memory the way a person keeps a note file: a flat list of
//! entries, two targets (`memory` for the agent's own notes, `user` for who the
//! user is), each with a whole-store character budget. Both targets are rendered
//! into the system prompt, so the budget is small on purpose.
//!
//! Writes are the agent's own: it calls the `memory` tool and the change lands
//! immediately. There is no proposal queue and no approval step, because a
//! memory the agent cannot write without a human in the loop is a memory it
//! stops trying to write.
//!
//! The editing semantics (add/replace/patch/remove, tolerant matching, batch
//! atomicity) live in `@pi-workspace/agent-runtime` (`memory-store.ts`) where the
//! model-facing tool runs. This module owns only persistence: a whole-list read
//! and a whole-list write, both bounded by the target's budget.

use anyhow::{anyhow, Result};
use rusqlite::params;

use crate::db::{now_ms, Database};

/// Separates entries in the stored document. Mirrors `ENTRY_DELIMITER` in
/// `@pi-workspace/agent-runtime`.
pub const ENTRY_DELIMITER: &str = "\n§\n";

/// Whole-store character budgets. Mirrors `MEMORY_CHAR_LIMIT` / `USER_CHAR_LIMIT`
/// in `@pi-workspace/agent-runtime`; the two must not drift, or the tool accepts a
/// write the host then refuses.
pub const MEMORY_CHAR_LIMIT: usize = 2200;
pub const USER_CHAR_LIMIT: usize = 1375;

/// Upper bound on entries per target. Not in Hermes, but a whole-list write is
/// one transaction and an unbounded list would be an unbounded transaction.
pub const MAX_ENTRIES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTarget {
    /// The agent's own notes.
    Memory,
    /// Who the user is.
    User,
}

impl MemoryTarget {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "memory" => Some(Self::Memory),
            "user" => Some(Self::User),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::User => "user",
        }
    }

    pub fn char_limit(self) -> usize {
        match self {
            Self::Memory => MEMORY_CHAR_LIMIT,
            Self::User => USER_CHAR_LIMIT,
        }
    }
}

/// Characters the entries occupy, measured the way the budget is measured.
pub fn char_count(entries: &[String]) -> usize {
    entries.join(ENTRY_DELIMITER).chars().count()
}

impl Database {
    /// Entries for one target, in stored order.
    pub fn memory_entries(&self, target: MemoryTarget) -> Result<Vec<String>> {
        let mut statement = self
            .conn()
            .prepare("SELECT content FROM memory_entries WHERE target = ?1 ORDER BY ordinal ASC")?;
        let rows = statement.query_map([target.as_str()], |row| row.get::<_, String>(0))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    }

    /// Replace one target's whole entry list atomically.
    ///
    /// A whole-list write rather than per-entry deltas: the model already holds
    /// the list (it is in its prompt), the batch semantics that let it free space
    /// and spend it are computed on the complete result, and one transaction
    /// means a failure cannot leave a half-applied edit behind.
    pub fn write_memory_entries(
        &self,
        target: MemoryTarget,
        entries: &[String],
    ) -> Result<Vec<String>> {
        let cleaned: Vec<String> = entries
            .iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        if cleaned.len() > MAX_ENTRIES {
            return Err(anyhow!(
                "memory holds at most {MAX_ENTRIES} entries, got {}",
                cleaned.len()
            ));
        }
        if let Some(entry) = cleaned.iter().find(|entry| entry.contains('\u{0}')) {
            return Err(anyhow!("entry contains a NUL byte: {entry:.40}"));
        }
        let total = char_count(&cleaned);
        let limit = target.char_limit();
        if total > limit {
            return Err(anyhow!(
                "{} would hold {total}/{limit} chars: free at least {} chars",
                target.as_str(),
                total - limit
            ));
        }
        let now = now_ms();
        let tx = self.conn().unchecked_transaction()?;
        tx.execute(
            "DELETE FROM memory_entries WHERE target = ?1",
            [target.as_str()],
        )?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO memory_entries (target, ordinal, content, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (ordinal, content) in cleaned.iter().enumerate() {
                insert.execute(params![target.as_str(), ordinal as i64, content, now])?;
            }
        }
        tx.commit()?;
        Ok(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    #[test]
    fn writes_and_reads_entries_in_order() {
        let (_dir, db) = database();
        let entries = vec!["first".to_string(), "second".to_string()];
        db.write_memory_entries(MemoryTarget::Memory, &entries)
            .unwrap();
        assert_eq!(db.memory_entries(MemoryTarget::Memory).unwrap(), entries);
        // Targets do not leak into each other.
        assert!(db.memory_entries(MemoryTarget::User).unwrap().is_empty());
    }

    #[test]
    fn a_whole_list_write_replaces_everything() {
        let (_dir, db) = database();
        db.write_memory_entries(MemoryTarget::Memory, &["a".into(), "b".into()])
            .unwrap();
        db.write_memory_entries(MemoryTarget::Memory, &["c".into()])
            .unwrap();
        assert_eq!(
            db.memory_entries(MemoryTarget::Memory).unwrap(),
            vec!["c".to_string()]
        );
    }

    #[test]
    fn trims_and_drops_blank_entries() {
        let (_dir, db) = database();
        let written = db
            .write_memory_entries(
                MemoryTarget::Memory,
                &["  spaced  ".to_string(), "   ".to_string()],
            )
            .unwrap();
        assert_eq!(written, vec!["spaced".to_string()]);
    }

    #[test]
    fn refuses_a_list_over_the_budget() {
        let (_dir, db) = database();
        let huge = "x".repeat(USER_CHAR_LIMIT + 1);
        let error = db
            .write_memory_entries(MemoryTarget::User, &[huge])
            .unwrap_err();
        assert!(error.to_string().contains("would hold"), "{error}");
        // Nothing was written.
        assert!(db.memory_entries(MemoryTarget::User).unwrap().is_empty());
    }

    #[test]
    fn the_two_targets_use_their_own_budgets() {
        let (_dir, db) = database();
        // Between the two limits: refused for `user`, accepted for `memory`.
        let sizeable = "y".repeat(USER_CHAR_LIMIT + 100);
        assert!(db
            .write_memory_entries(MemoryTarget::User, std::slice::from_ref(&sizeable))
            .is_err());
        assert!(db
            .write_memory_entries(MemoryTarget::Memory, &[sizeable])
            .is_ok());
    }

    #[test]
    fn measures_the_delimiter_towards_the_budget() {
        let (_dir, db) = database();
        let half = (MEMORY_CHAR_LIMIT - ENTRY_DELIMITER.chars().count()) / 2;
        let entries = vec!["a".repeat(half), "b".repeat(half)];
        assert!(char_count(&entries) <= MEMORY_CHAR_LIMIT);
        db.write_memory_entries(MemoryTarget::Memory, &entries)
            .unwrap();
        assert_eq!(db.memory_entries(MemoryTarget::Memory).unwrap().len(), 2);
    }

    #[test]
    fn refuses_a_nul_byte_entry() {
        let (_dir, db) = database();
        let error = db
            .write_memory_entries(MemoryTarget::Memory, &["bad\u{0}entry".to_string()])
            .unwrap_err();
        assert!(error.to_string().contains("NUL"), "{error}");
    }
}

/// One entry that matched a recall query.
///
/// Recall used to read only the scored `memories` table, which nothing has
/// written since the agent started keeping flat entry lists (ADR 0378) — so a
/// note the agent wrote reached the next session through the prompt snapshot and
/// was invisible to every query. These hits are the missing half: the same text,
/// searched where it actually lives.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryHit {
    /// `memory` (the agent's notes) or `user` (who the user is).
    pub target: String,
    /// Position in that target's list, so a caller can name the entry it means.
    pub index: usize,
    pub text: String,
    /// Share of the query's terms this entry contains, `0 < score <= 1`.
    pub score: f64,
}

/// Terms of a query, matching the index's own normalisation: every CJK ideograph
/// is a term, Latin words stay whole, case is ignored.
fn query_terms(query: &str) -> Vec<String> {
    crate::memory::normalise_search_text(query)
        .to_lowercase()
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

/// Search both entry lists for the terms of `query`.
///
/// Ranking is deliberately simple and explainable, because the corpus is tiny
/// (two lists, 200 entries and a few thousand characters at most): more of the
/// query's terms first, then the shorter entry — the shorter text is the one that
/// is *about* the terms rather than a paragraph that happens to mention them.
pub fn search_entries(
    memory: &[String],
    user: &[String],
    query: &str,
    limit: usize,
) -> Vec<EntryHit> {
    let terms = query_terms(query);
    if terms.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut hits: Vec<EntryHit> = Vec::new();
    for (target, entries) in [("memory", memory), ("user", user)] {
        for (index, text) in entries.iter().enumerate() {
            let normalised = crate::memory::normalise_search_text(text).to_lowercase();
            let matched = terms
                .iter()
                .filter(|term| normalised.split_whitespace().any(|word| word == *term))
                .count();
            if matched == 0 {
                continue;
            }
            hits.push(EntryHit {
                target: target.to_string(),
                index,
                text: text.clone(),
                score: matched as f64 / terms.len() as f64,
            });
        }
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.text.chars().count().cmp(&b.text.chars().count()))
            .then(a.target.cmp(&b.target))
            .then(a.index.cmp(&b.index))
    });
    hits.truncate(limit);
    hits
}

#[cfg(test)]
mod search_tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn a_cjk_phrase_matches_inside_a_sentence() {
        // The index splits every ideograph, so a two-character query is two terms.
        let memory = list(&["上下文压缩时保留最近 20000 tokens"]);
        let hits = search_entries(&memory, &[], "压缩", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].target, "memory");
        assert_eq!(hits[0].index, 0);
    }

    #[test]
    fn latin_terms_ignore_case_and_whole_words() {
        let user = list(&["Prefers Chinese replies; never restarts the desktop app"]);
        assert_eq!(search_entries(&[], &user, "DESKTOP", 5).len(), 1);
        // A term inside a longer word is not a match: "app" must not hit "apple".
        assert!(search_entries(&[], &user, "apple", 5).is_empty());
    }

    #[test]
    fn more_matched_terms_rank_first_then_the_shorter_entry() {
        let memory = list(&[
            "compression keeps the recent tail of the transcript",
            "compression tail",
            "unrelated note",
        ]);
        let hits = search_entries(&memory, &[], "compression tail", 5);
        assert_eq!(hits.len(), 2);
        // Both match both terms; the shorter entry is the one about them.
        assert_eq!(hits[0].text, "compression tail");
        assert_eq!(hits[0].score, 1.0);
        assert!(hits[1].score < 1.0 || hits[1].text.starts_with("compression keeps"));
    }

    #[test]
    fn an_empty_or_unmatched_query_returns_nothing() {
        let memory = list(&["something"]);
        assert!(search_entries(&memory, &[], "   ", 5).is_empty());
        assert!(search_entries(&memory, &[], "nothing-here", 5).is_empty());
        assert!(search_entries(&memory, &[], "something", 0).is_empty());
    }

    #[test]
    fn the_limit_cuts_the_tail_of_the_ranking() {
        let memory = list(&["alpha one", "alpha two", "alpha three"]);
        assert_eq!(search_entries(&memory, &[], "alpha", 2).len(), 2);
    }

    #[test]
    fn both_lists_are_searched_and_keep_their_own_index() {
        let memory = list(&["project uses pnpm"]);
        let user = list(&["speaks Chinese", "uses pnpm workspaces"]);
        let hits = search_entries(&memory, &user, "pnpm", 5);
        assert_eq!(hits.len(), 2);
        let user_hit = hits.iter().find(|hit| hit.target == "user").unwrap();
        assert_eq!(user_hit.index, 1);
    }
}
