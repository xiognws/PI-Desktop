//! Migration regression coverage, kept beside the migrations it exercises.

use super::migrations::*;
use crate::db::Database;

const BLOCK: &str = "<thinking>[reasoning not retained for this turn]</thinking>";

#[test]
fn strips_a_leading_run_of_echoed_blocks() {
    assert_eq!(
        without_echoed_placeholder_text(&format!("{BLOCK}\nreal answer")).as_deref(),
        Some("real answer")
    );
    assert_eq!(
        without_echoed_placeholder_text(&format!("{BLOCK}\n{BLOCK}\nreal answer")).as_deref(),
        Some("real answer")
    );
    assert_eq!(
        without_echoed_placeholder_text(&format!("{BLOCK}\n{BLOCK}\n{BLOCK}\nreal answer"))
            .as_deref(),
        Some("real answer")
    );
    // A row that is nothing but the artifact becomes empty.
    assert_eq!(without_echoed_placeholder_text(BLOCK).as_deref(), Some(""));
}

#[test]
fn strips_the_models_rewritten_placeholder() {
    assert_eq!(
        without_echoed_placeholder_text(
            "<thinking>[reasoning retained for this turn]</thinking>\nreal answer"
        )
        .as_deref(),
        Some("real answer")
    );
}

#[test]
fn keeps_authored_text_and_late_echoes() {
    // A block wrapping the model's own words is not a placeholder echo.
    let authored = "<thinking>I should check the encoding first.</thinking>\nreal answer";
    assert_eq!(without_echoed_placeholder_text(authored), None);
    // An echo after real text is not the leading artifact.
    let late = format!("real answer\n{BLOCK}");
    assert_eq!(without_echoed_placeholder_text(&late), None);
    assert_eq!(without_echoed_placeholder_text("real answer"), None);
}

fn seeded_database(path: &Path) {
    let db = Database::open(path).unwrap();
    db.conn()
        .execute_batch(&format!(
            "INSERT INTO sessions(id,title,title_source,provider_id,model_id,last_seq,created_at,updated_at)
               VALUES ('s','Session','manual',NULL,NULL,2,1,1);
             INSERT INTO turns(id,session_id,status,started_at,ended_at)
               VALUES ('t','s','completed',1,2);
             INSERT INTO messages(id,session_id,turn_id,seq,role,text,created_at)
               VALUES ('echoed','s','t',0,'assistant','{BLOCK}\n{BLOCK}\nreal answer',1);
             INSERT INTO messages(id,session_id,turn_id,seq,role,text,created_at)
               VALUES ('authored','s','t',1,'assistant','<thinking>my own words</thinking>\nkept',2);
             PRAGMA user_version=28;"
        ))
        .unwrap();
}

fn text_of(conn: &Connection, id: &str) -> String {
    conn.query_row("SELECT text FROM messages WHERE id = ?1", [id], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn migration_repairs_echoed_rows_and_leaves_authored_rows_alone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seeded_database(&path);
    let db = Database::open(&path).unwrap();
    // `open` already ran the repair, so the version is the latest one.
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    assert_eq!(text_of(db.conn(), "echoed"), "real answer");
    // A tag wrapping authored text is preserved verbatim.
    assert_eq!(
        text_of(db.conn(), "authored"),
        "<thinking>my own words</thinking>\nkept"
    );
    // The FTS trigger followed the update: the artifact is gone from the index.
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"not retained\"'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'answer'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn migration_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    seeded_database(&path);
    let db = Database::open(&path).unwrap();
    let repaired = text_of(db.conn(), "echoed");
    // A second pass over already-repaired text changes nothing.
    let tx = db.conn().unchecked_transaction().unwrap();
    migrate_v30_to_v31_tx(&tx).unwrap();
    tx.commit().unwrap();
    assert_eq!(text_of(db.conn(), "echoed"), repaired);
}
