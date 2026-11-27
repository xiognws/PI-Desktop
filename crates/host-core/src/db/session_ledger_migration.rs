use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Schema v35 adds the session ledger: what a session has already done, written
/// by the kernel at boundaries it already detects and prepended to later requests.
///
/// Additive and empty by default. An existing session behaves exactly as it did
/// until its next turn ends, and a database that never runs the kernel again just
/// carries an empty table.
pub(crate) const SESSION_LEDGER_DDL: &str = "\
CREATE TABLE IF NOT EXISTS session_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id    TEXT,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_ledger_session ON session_ledger (session_id, id);
";

pub(crate) fn ensure_session_ledger_table(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(SESSION_LEDGER_DDL)?;
    Ok(())
}

fn migrate_v34_to_v35_tx(tx: &Transaction<'_>) -> Result<()> {
    ensure_session_ledger_table(tx)?;
    tx.pragma_update(None, "user_version", 35i64)?;
    Ok(())
}

pub(crate) fn migrate_v34_to_v35(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 34)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v34_to_v35_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v34 to v35 session ledger; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "session_ledger_test.rs"]
mod tests;
