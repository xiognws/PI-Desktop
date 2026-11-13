//! Retire the flat entry list (ADR 0393): import it into the store, then drop
//! the tables.
//!
//! Schema v30 created `memories` and v32 rebuilt its keyword index; the agent's
//! tool was pointed at the store the same release, so the two-column list
//! (`target`, `ordinal`, `content`) stopped receiving rows. What is left in it is
//! what earlier builds wrote, part of it already copied in by the startup import
//! this step replaces.
//!
//! This step makes that copy the only one. It imports again — the table may have
//! taken rows since the last launch, and the dedupe index makes a repeat a no-op
//! — and then drops `memory_entries`, so the release after this one cannot read a
//! store that nothing writes.
//!
//! `memory_proposals` (the approval queue ADR 0371 described) had no reader, no
//! writer and no DDL in this repository at any point: dropping it is a guarded
//! no-op for a database that never had one, and it keeps the whole retirement in
//! a single step instead of two.
//!
//! Both statements run in one transaction: a database that still holds entries
//! gets them imported *and* loses the table, or keeps both. A fresh database
//! never creates either table, so this step is unreachable there (it stamps the
//! current version directly).

use super::*;

pub(crate) fn migrate_v32_to_v33_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    // A stamp is not proof of shape: converge the store before importing into
    // it, so the import cannot fail on a fixture whose tables were dropped
    // without resetting `user_version`.
    tx.execute_batch(MEMORIES_DDL)?;
    tx.execute_batch(MEMORIES_FTS_DDL)?;
    if table_exists(tx, "memory_entries")? {
        let imported = crate::memory::import_retired_entries_tx(tx)?;
        if imported > 0 {
            tracing::info!(
                count = imported,
                "imported the retired memory entries into the memory store"
            );
        }
    }
    tx.execute_batch(
        "DROP TABLE IF EXISTS memory_entries;
         DROP TABLE IF EXISTS memory_proposals;",
    )?;
    tx.pragma_update(None, "user_version", 33i64)?;
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )?)
}

/// Schema v31 drops the two tables that are not the store.
///
/// Backed up before the transaction like every step that rewrites rows: the
/// entries are copied first, but a copy is not the original, and this is the last
/// release where a wrong migration can still be undone from the file.
pub(crate) fn migrate_v32_to_v33(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 32)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v32_to_v33_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v32 to v33 memory-entry retirement; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "memory_entries_retire_test.rs"]
mod tests;
