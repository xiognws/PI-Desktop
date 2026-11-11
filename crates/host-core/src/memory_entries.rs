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
use crate::memory::{MemoryKind, MemoryScope, MemorySource, NewMemory};

/// Longest title the import derives from an entry's first line. Titles exist so
/// the memory page and a retrieval hit can name a row; a paragraph is a body.
const MAX_IMPORT_TITLE_CHARS: usize = 80;

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

    /// One-way migration of the retired scored store into the list the model reads.
    ///
    /// `memories` (ADR 0371) has had no writer since ADR 0380 moved the agent's
    /// memory to this table — nothing in the app calls `memory.remember` any more —
    /// so the rows left in it are whatever a past release recorded. Keeping them
    /// behind a second, invisible store is what made the memory page look empty
    /// while the agent had plenty to say.
    ///
    /// Only rows that are still live and not already migrated are read;
    /// `kind = preference` describes the person and goes to `user`, everything
    /// else to `memory`. A row that would blow the character budget is left
    /// behind rather than truncated, and is retried on the next launch after the
    /// agent frees space. Copied rows are stamped, so this runs once per row.
    ///
    /// ADR 0393 reversed the direction: the structured store is now the store and
    /// this list retires, so nothing calls this any more. It stays for one release
    /// so a database written by a newer build still opens here without its list
    /// being rewritten from half-migrated rows.
    #[allow(dead_code)]
    pub fn migrate_legacy_memories(&self) -> Result<usize> {
        let now = now_ms() as i64;
        let conn = self.conn();
        let mut statement = conn.prepare(
            "SELECT id, kind, title, body FROM memories
             WHERE superseded_by IS NULL
               AND (valid_until IS NULL OR valid_until > ?1)
             ORDER BY created_at ASC",
        )?;
        let collected = statement
            .query_map([now], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let rows: Vec<(String, String, String, String)> = collected;
        if rows.is_empty() {
            return Ok(0);
        }

        let mut user_entries = self.memory_entries(MemoryTarget::User)?;
        let mut memory_entries = self.memory_entries(MemoryTarget::Memory)?;
        let mut migrated: Vec<String> = Vec::new();

        for (id, kind, title, body) in rows {
            let target = if kind.eq_ignore_ascii_case("preference") {
                MemoryTarget::User
            } else {
                MemoryTarget::Memory
            };
            let title = title.trim();
            let body = body.trim();
            let text = if !title.is_empty() && !body.is_empty() && title != body {
                format!("{title}: {body}")
            } else if !body.is_empty() {
                body.to_string()
            } else {
                title.to_string()
            };
            let entries = match target {
                MemoryTarget::User => &mut user_entries,
                MemoryTarget::Memory => &mut memory_entries,
            };
            if text.is_empty() || entries.iter().any(|existing| existing.trim() == text) {
                migrated.push(id);
                continue;
            }
            let mut candidate = entries.clone();
            candidate.push(text);
            if char_count(&candidate) > target.char_limit() {
                // No room yet: leave it pending so a later launch can take it.
                continue;
            }
            *entries = candidate;
            migrated.push(id);
        }

        self.write_memory_entries(MemoryTarget::User, &user_entries)?;
        self.write_memory_entries(MemoryTarget::Memory, &memory_entries)?;
        if !migrated.is_empty() {
            let mut update = self
                .conn()
                .prepare("UPDATE memories SET superseded_by = 'memory_entries' WHERE id = ?1")?;
            for id in &migrated {
                update.execute([id])?;
            }
        }
        Ok(migrated.len())
    }

    /// Import the retiring flat list into the structured store (ADR 0393).
    ///
    /// The list held what the agent had to say and `memories` held nothing, so
    /// this is the direction migration now runs: every entry becomes one memory,
    /// with the target deciding its kind (`user` describes the person, so
    /// `preference`; `memory` is the agent's own notes, so `fact`).
    ///
    /// Rows are never deleted or rewritten: the list stays readable for one
    /// release, and a wrong migration costs nothing because the text is still
    /// there. `content_hash` makes the import idempotent — a second launch finds
    /// each memory live and identical, and reports it as deduped rather than
    /// inserted. One bad entry (an oversized body, say) is logged and skipped;
    /// aborting would strand every later entry behind it.
    ///
    /// Returns how many memories were newly inserted.
    pub fn migrate_entries_into_memories(&self) -> Result<usize> {
        let mut inserted = 0usize;
        for target in [MemoryTarget::User, MemoryTarget::Memory] {
            let kind = match target {
                MemoryTarget::User => MemoryKind::Preference,
                MemoryTarget::Memory => MemoryKind::Fact,
            };
            for entry in self.memory_entries(target)? {
                let text = entry.trim();
                if text.is_empty() {
                    continue;
                }
                let mut input = NewMemory::new(
                    MemoryScope::Global,
                    kind,
                    import_title(text),
                    text.to_string(),
                );
                input.source = MemorySource::Import;
                match self.remember(input) {
                    Ok(outcome) if !outcome.deduped => inserted += 1,
                    Ok(_) => {}
                    Err(error) => tracing::warn!(
                        %error,
                        target = target.as_str(),
                        "could not import a memory entry"
                    ),
                }
            }
        }
        Ok(inserted)
    }
}

/// Title derived from an entry: its first line, or the beginning of the entry
/// when the first line is blank. Clipped by characters, not bytes, so a Chinese
/// title is not cut mid-character.
fn import_title(entry: &str) -> String {
    let first_line = entry.lines().next().unwrap_or("").trim();
    let source = if first_line.is_empty() {
        entry.trim()
    } else {
        first_line
    };
    source
        .chars()
        .take(MAX_IMPORT_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests_migrate;
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

    #[test]
    fn migrates_the_retired_store_into_the_entry_list_once() {
        use crate::memory::{MemoryKind, MemoryScope, NewMemory};

        let (_dir, db) = database();
        db.remember(NewMemory::new(
            MemoryScope::Global,
            MemoryKind::Fact,
            "Cache root",
            "D:/PiWorkspace/cache holds the scratch files",
        ))
        .unwrap();
        db.remember(NewMemory::new(
            MemoryScope::Global,
            MemoryKind::Preference,
            "Replies",
            "prefers terse Chinese replies",
        ))
        .unwrap();

        assert_eq!(db.migrate_legacy_memories().unwrap(), 2);
        assert_eq!(
            db.memory_entries(MemoryTarget::Memory).unwrap(),
            vec!["Cache root: D:/PiWorkspace/cache holds the scratch files".to_string()]
        );
        assert_eq!(
            db.memory_entries(MemoryTarget::User).unwrap(),
            vec!["Replies: prefers terse Chinese replies".to_string()]
        );

        // Stamped, so a second launch copies nothing.
        assert_eq!(db.migrate_legacy_memories().unwrap(), 0);
        assert_eq!(db.memory_entries(MemoryTarget::Memory).unwrap().len(), 1);
    }

    #[test]
    fn a_legacy_row_that_does_not_fit_stays_behind_for_a_later_launch() {
        use crate::memory::{MemoryKind, MemoryScope, NewMemory};

        let (_dir, db) = database();
        let full = "x".repeat(MEMORY_CHAR_LIMIT - 20);
        db.write_memory_entries(MemoryTarget::Memory, &[full])
            .unwrap();
        db.remember(NewMemory::new(
            MemoryScope::Global,
            MemoryKind::Fact,
            "Too big",
            "y".repeat(60),
        ))
        .unwrap();

        assert_eq!(db.migrate_legacy_memories().unwrap(), 0);
        // Still pending: nothing was stamped, so freeing space and launching
        // again takes it.
        db.write_memory_entries(MemoryTarget::Memory, &[]).unwrap();
        assert_eq!(db.migrate_legacy_memories().unwrap(), 1);
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
