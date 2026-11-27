//! Coverage for the v34 -> v35 ledger table.
//!
//! Two ways an additive table goes wrong, and both are checked here: an existing
//! database must gain it without losing a session, and a database that is already
//! at the newest stamp but lacks the table — a profile touched by two lines of
//! development — must converge instead of failing the first write.

use rusqlite::Connection;

use super::migrate_v34_to_v35;
use crate::db::{Database, SCHEMA_VERSION};
use crate::sessions;
use std::path::Path;

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(-1)
}

fn has_ledger(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_ledger')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        == 1
}

/// A database that reached this build, holding one session, then rewound to the
/// v34 shape: no ledger table, stamp 34.
fn v34_database_with_a_session(path: &Path) -> String {
    let db = Database::open(path).expect("open a current database");
    let session =
        sessions::create_session(&db, Some("Existing chat".into()), None, None, None, None)
            .expect("create a session");
    db.conn()
        .execute_batch("DROP TABLE session_ledger;")
        .expect("rewind to the v34 shape");
    db.conn()
        .pragma_update(None, "user_version", 34i64)
        .expect("stamp v34");
    drop(db);
    session.id
}

#[test]
fn a_v34_database_gains_the_ledger_and_keeps_its_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.keep().join("pi.sqlite");
    let session_id = v34_database_with_a_session(&path);

    let db = Database::open(&path).expect("upgrade the database in place");
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert!(
        has_ledger(db.conn()),
        "the ledger table must exist after the step"
    );
    assert!(
        sessions::get_session(&db, &session_id)
            .expect("read the session back")
            .is_some(),
        "an additive table must not cost an existing session"
    );
    crate::session_ledger::append(&db, &session_id, None, "turn", "first entry")
        .expect("the upgraded database accepts a ledger write");
}

/// The step itself, driven on a connection rather than through `Database::open`,
/// so the migration is proven without the converge path covering for it.
#[test]
fn the_step_creates_the_table_and_stamps_the_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.keep().join("pi.sqlite");
    let session_id = v34_database_with_a_session(&path);

    let conn = Connection::open(&path).unwrap();
    migrate_v34_to_v35(&conn, &path).expect("run the step with a backup");
    assert!(has_ledger(&conn), "the step creates the table");
    assert_eq!(version(&conn), 35);
    drop(conn);

    let db = Database::open(&path).expect("reopen");
    crate::session_ledger::append(&db, &session_id, Some("t1"), "turn", "after the step")
        .expect("a written entry lands in the upgraded table");
}

/// A profile stamped at the newest version but missing the table: the converge
/// pass has to re-assert the shape, because the version chain skips every step
/// for a current stamp.
#[test]
fn a_current_stamp_without_the_table_converges() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.keep().join("pi.sqlite");
    let session_id = v34_database_with_a_session(&path);
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .expect("stamp the newest version");
    drop(conn);

    let db = Database::open(&path).expect("converge a current database");
    assert!(
        has_ledger(db.conn()),
        "a newest-stamp database without the table must be repaired on open"
    );
    crate::session_ledger::append(&db, &session_id, None, "turn", "converged")
        .expect("the converged database accepts a ledger write");
}
