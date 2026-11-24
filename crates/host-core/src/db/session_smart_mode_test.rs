//! Coverage for the v33 -> v34 Smart-mode column.
//!
//! Two things can go wrong with an additive column and both are checked here:
//! an existing database must gain it without losing a session, and a database
//! that is already at the newest stamp but lacks the column (a profile touched
//! by two lines of development) must converge instead of failing on the first
//! query that names it.

use rusqlite::Connection;

use super::{ensure_smart_mode_column, migrate_v33_to_v34};
use crate::db::{Database, SCHEMA_VERSION};
use crate::sessions;
use std::path::Path;

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(-1)
}

fn has_smart_mode_column(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'smart_mode_json')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        == 1
}

/// A database that reached this build, holding one session, then rewound to the
/// v33 shape: no Smart-mode column, stamp 33.
fn v33_database_with_a_session(path: &Path) -> String {
    let db = Database::open(path).expect("open a current database");
    let session = sessions::create_session_with_thinking(
        &db,
        Some("Existing chat".into()),
        Some("agent".into()),
        Some("provider-1".into()),
        Some("model-1".into()),
        None,
        None,
    )
    .expect("create a session");
    db.conn()
        .execute_batch(
            "ALTER TABLE sessions DROP COLUMN smart_mode_json;
             PRAGMA user_version = 33;",
        )
        .expect("rewind to the v33 shape");
    assert!(!has_smart_mode_column(db.conn()));
    session.id
}

#[test]
fn an_existing_session_keeps_its_data_and_gains_the_column() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    let session_id = v33_database_with_a_session(&path);

    let db = Database::open(&path).expect("upgrade to the current version");
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert!(has_smart_mode_column(db.conn()));

    let summary = sessions::session_summary(&db, &session_id)
        .expect("read the summary")
        .expect("the session survived the migration");
    assert_eq!(summary.title, "Existing chat");
    assert_eq!(summary.model_id.as_deref(), Some("model-1"));
    // NULL is the whole meaning of "smart mode off".
    assert!(summary.smart_mode.is_none());
}

#[test]
fn the_shape_converges_on_a_database_stamped_newest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    let session_id = v33_database_with_a_session(&path);
    // The stamp says newest, the shape does not: converging is the only thing
    // that can repair it, because the version chain skips every step.
    let conn = Connection::open(&path).expect("open raw");
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .expect("stamp newest");
    drop(conn);

    let db = Database::open(&path).expect("converge the shape");
    assert!(has_smart_mode_column(db.conn()));
    assert!(sessions::session_summary(&db, &session_id)
        .expect("read")
        .is_some());
}

#[test]
fn the_column_step_is_idempotent_and_leaves_a_backup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("pi.sqlite");
    v33_database_with_a_session(&path);

    let conn = Connection::open(&path).expect("open raw");
    migrate_v33_to_v34(&conn, &path).expect("run the step with a backup");
    assert_eq!(version(&conn), 34);
    assert!(has_smart_mode_column(&conn));
    // Re-running the shape guard must not fail on an existing column.
    let tx = conn.unchecked_transaction().expect("transaction");
    ensure_smart_mode_column(&tx).expect("re-assert the column");
    tx.commit().expect("commit");

    let backups: Vec<String> = std::fs::read_dir(dir.path())
        .expect("list the directory")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains("v33") || name.contains("backup"))
        .collect();
    assert!(
        !backups.is_empty(),
        "a schema step leaves a pre-migration copy"
    );
}
