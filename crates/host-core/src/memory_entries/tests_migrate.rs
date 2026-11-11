//! Migration of the retired flat entry list into the structured store
//! (ADR 0393).
//!
//! The list is what the agent actually wrote to, so the import has to be exact
//! about which field becomes which: a `user` entry is a preference about the
//! person, a `memory` entry is a fact the agent noted, the first line is the
//! title and the whole entry stays the body. It also has to be safe to run on
//! every launch — the list is never rewritten, and `content_hash` is what stops
//! a second run from duplicating what the first one stored.

use super::*;
use crate::memory::{ListFilter, MemoryScope, MemorySource};

fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = Database::open(&dir.path().join("pi.sqlite")).expect("open database");
    (dir, db)
}

/// Every stored memory, newest first — the order `list_memories` uses is by
/// `created_at`, which two rows written in the same millisecond share, so tests
/// look rows up by title instead of by position.
fn memories(db: &Database) -> Vec<crate::memory::MemoryRecord> {
    let (rows, total) = db
        .list_memories(&ListFilter::default())
        .expect("list memories");
    assert_eq!(rows.len() as i64, total);
    rows
}

#[test]
fn entries_of_both_targets_become_memories() {
    let (_dir, db) = database();
    db.write_memory_entries(
        MemoryTarget::User,
        &["Prefers terse Chinese replies".to_string()],
    )
    .expect("write user entries");
    db.write_memory_entries(
        MemoryTarget::Memory,
        &[
            "Cache root\nD:/PiWorkspace/cache holds the scratch files".to_string(),
            "The desktop app is Electron plus a Rust host core".to_string(),
        ],
    )
    .expect("write memory entries");

    assert_eq!(db.migrate_entries_into_memories().expect("migrate"), 3);

    let stored = memories(&db);
    assert_eq!(stored.len(), 3);

    let preference = stored
        .iter()
        .find(|memory| memory.title == "Prefers terse Chinese replies")
        .expect("user entry imported");
    assert_eq!(preference.kind, MemoryKind::Preference);
    assert_eq!(preference.body, "Prefers terse Chinese replies");
    assert_eq!(preference.scope, MemoryScope::Global);
    assert_eq!(preference.source, MemorySource::Import);

    let fact = stored
        .iter()
        .find(|memory| memory.title == "Cache root")
        .expect("memory entry imported");
    assert_eq!(fact.kind, MemoryKind::Fact);
    // Title is the first line; the body is the whole entry.
    assert_eq!(
        fact.body,
        "Cache root\nD:/PiWorkspace/cache holds the scratch files"
    );
    assert_eq!(fact.source, MemorySource::Import);

    // A single-line entry is its own title and body.
    let single = stored
        .iter()
        .find(|memory| memory.title == "The desktop app is Electron plus a Rust host core")
        .expect("single-line entry imported");
    assert_eq!(single.kind, MemoryKind::Fact);
    assert_eq!(single.body, single.title);
}

#[test]
fn a_second_run_inserts_nothing() {
    let (_dir, db) = database();
    db.write_memory_entries(MemoryTarget::Memory, &["project uses pnpm".to_string()])
        .expect("write entries");
    db.write_memory_entries(MemoryTarget::User, &["speaks Chinese".to_string()])
        .expect("write entries");

    assert_eq!(db.migrate_entries_into_memories().expect("first run"), 2);
    // Deduped on content_hash: the same rows are already live.
    assert_eq!(db.migrate_entries_into_memories().expect("second run"), 0);
    assert_eq!(memories(&db).len(), 2);
}

#[test]
fn an_empty_entry_is_skipped_and_the_rest_still_run() {
    let (_dir, db) = database();
    // Blank entries cannot be written through the API, so plant one the way a
    // database hand-edited by an older build would hold it.
    db.conn()
        .execute(
            "INSERT INTO memory_entries (target, ordinal, content, updated_at)
             VALUES ('memory', 0, '   ', 0)",
            [],
        )
        .expect("insert blank entry");
    db.conn()
        .execute(
            "INSERT INTO memory_entries (target, ordinal, content, updated_at)
             VALUES ('memory', 1, 'after the blank one', 0)",
            [],
        )
        .expect("insert real entry");

    assert_eq!(db.migrate_entries_into_memories().expect("migrate"), 1);
    let stored = memories(&db);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].title, "after the blank one");
}

#[test]
fn the_entry_list_is_left_exactly_as_it_was() {
    let (_dir, db) = database();
    let user = vec!["prefers terse replies".to_string()];
    let memory = vec![
        "first note".to_string(),
        "second note\nwith a second line".to_string(),
    ];
    db.write_memory_entries(MemoryTarget::User, &user)
        .expect("write user entries");
    db.write_memory_entries(MemoryTarget::Memory, &memory)
        .expect("write memory entries");

    db.migrate_entries_into_memories().expect("migrate");

    // Readable for one release: same rows, same order, nothing deleted.
    assert_eq!(
        db.memory_entries(MemoryTarget::User).expect("read user"),
        user
    );
    assert_eq!(
        db.memory_entries(MemoryTarget::Memory)
            .expect("read memory"),
        memory
    );
}
