//! Regression coverage for the v32 -> v33 retirement of the flat entry list.

use rusqlite::Connection;

use super::{migrate_v32_to_v33, migrate_v32_to_v33_tx};
use crate::db::{Database, SCHEMA_VERSION};
use std::path::Path;

/// The retired table exactly as the boot path used to create it.
const RETIRED_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS memory_entries (
   target     TEXT NOT NULL CHECK (target IN ('memory', 'user')),
   ordinal    INTEGER NOT NULL,
   content    TEXT NOT NULL,
   updated_at INTEGER NOT NULL,
   PRIMARY KEY (target, ordinal)
 ) WITHOUT ROWID";

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        == 1
}

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(-1)
}

/// A database that was current at v32 and still holds two entry lists.
fn v32_database_with_entries(path: &Path) {
    let db = Database::open(path).expect("open a current database");
    db.conn()
        .execute_batch(RETIRED_TABLE_DDL)
        .expect("recreate the retired table");
    db.conn()
        .execute_batch(
            "INSERT INTO memory_entries(target, ordinal, content, updated_at) VALUES
               ('memory', 0, 'cache root\nD:/PiWorkspace/cache holds scratch files', 1),
               ('memory', 1, 'project uses pnpm workspaces', 1),
               ('user',   0, 'prefers terse Chinese replies', 1);
             PRAGMA user_version = 32;",
        )
        .expect("seed the retired lists");
}

#[test]
fn entries_are_imported_into_the_store_before_the_table_goes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    v32_database_with_entries(&path);

    let db = Database::open(&path).expect("upgrade to the current version");
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert!(!table_exists(db.conn(), "memory_entries"));
    assert!(!table_exists(db.conn(), "memory_proposals"));

    let (memories, total) = db.list_memories(&Default::default()).expect("list");
    assert_eq!(total, 3);
    assert_eq!(memories.len(), 3);
    // A `user`-target entry describes the person; the agent's own notes are facts.
    let preference = memories
        .iter()
        .find(|memory| memory.body == "prefers terse Chinese replies")
        .expect("the user entry was imported");
    assert_eq!(preference.kind.as_str(), "preference");
    assert_eq!(preference.source.as_str(), "import");
    let fact = memories
        .iter()
        .find(|memory| memory.body == "project uses pnpm workspaces")
        .expect("the memory entry was imported");
    assert_eq!(fact.kind.as_str(), "fact");
    // The first line names the row; the whole entry is the body.
    let multi_line = memories
        .iter()
        .find(|memory| memory.body.starts_with("cache root"))
        .expect("the multi-line entry was imported");
    assert_eq!(multi_line.title, "cache root");

    // The import feeds the index too, so recall finds what was migrated.
    let hits = db
        .recall(crate::memory::RecallQuery {
            query: "pnpm".to_string(),
            ..Default::default()
        })
        .expect("recall");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory.body, "project uses pnpm workspaces");
}

#[test]
fn a_fresh_database_has_neither_retired_table() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = Database::open(&dir.path().join("pi.sqlite")).expect("fresh database");
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert!(!table_exists(db.conn(), "memory_entries"));
    assert!(!table_exists(db.conn(), "memory_proposals"));
}

#[test]
fn the_step_is_idempotent_and_never_duplicates_a_memory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    v32_database_with_entries(&path);
    let db = Database::open(&path).expect("upgrade to the current version");
    let before = db.list_memories(&Default::default()).expect("list").1;

    // A second pass over a database that no longer has the table changes nothing.
    let tx = db.conn().unchecked_transaction().expect("transaction");
    migrate_v32_to_v33_tx(&tx).expect("re-run the step");
    tx.commit().expect("commit");
    assert_eq!(
        db.list_memories(&Default::default()).expect("list").1,
        before
    );
    assert!(!table_exists(db.conn(), "memory_entries"));
}

#[test]
fn an_entry_already_in_the_store_is_not_copied_twice() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).expect("open a current database");
    // The same text the retired table will hold, already stored: the dedupe
    // index has to win over the import.
    db.remember(crate::memory::NewMemory::new(
        crate::memory::MemoryScope::Global,
        crate::memory::MemoryKind::Fact,
        "project uses pnpm workspaces",
        "project uses pnpm workspaces",
    ))
    .expect("seed the store");
    db.conn()
        .execute_batch(RETIRED_TABLE_DDL)
        .expect("recreate");
    db.conn()
        .execute_batch(
            "INSERT INTO memory_entries(target, ordinal, content, updated_at)
               VALUES ('memory', 0, 'project uses pnpm workspaces', 1);
             PRAGMA user_version = 32;",
        )
        .expect("seed the retired list");
    drop(db);

    let db = Database::open(&path).expect("upgrade to the current version");
    let (memories, total) = db.list_memories(&Default::default()).expect("list");
    assert_eq!(total, 1);
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].source.as_str(), "agent");
}

#[test]
fn the_backup_is_written_before_the_rows_move() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    v32_database_with_entries(&path);
    let conn = Connection::open(&path).expect("open");
    migrate_v32_to_v33(&conn, &path).expect("run the step with a backup");
    assert_eq!(version(&conn), 33);
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .expect("list the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains("v32") || name.contains("backup"))
        .collect();
    assert!(
        !backups.is_empty(),
        "a step that rewrites rows leaves a pre-migration copy"
    );
}
