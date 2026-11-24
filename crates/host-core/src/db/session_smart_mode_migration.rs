use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// v34 stores the session's Smart-mode snapshot.
///
/// Smart mode is one conversation served by a pair of models (strong `main`,
/// cheap `sub`) plus the routing policy that decided each turn. The snapshot is
/// a copy of the app-level template, not a reference to it: editing a template
/// afterwards must not rewrite conversations that already ran on the old pair.
///
/// `NULL` is the whole meaning of "off", so every existing session keeps the
/// single-model behaviour with no backfill.
pub(crate) fn ensure_smart_mode_column(tx: &Transaction<'_>) -> Result<()> {
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'smart_mode_json')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN smart_mode_json TEXT;")?;
    }
    Ok(())
}

fn migrate_v33_to_v34_tx(tx: &Transaction<'_>) -> Result<()> {
    ensure_smart_mode_column(tx)?;
    tx.pragma_update(None, "user_version", 34i64)?;
    Ok(())
}

pub(crate) fn migrate_v33_to_v34(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 33)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v33_to_v34_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v33 to v34 smart-mode migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "session_smart_mode_test.rs"]
mod tests;
