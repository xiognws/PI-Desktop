//! Schema v31's reply-text repair, kept beside the chain it belongs to.
//!
//! It carries its own placeholder constants and the two pure text helpers they
//! need, so the version chain file stays about the steps themselves.

use super::*;

/// The non-empty stand-in a strict DeepSeek-compatible relay is fed for a turn
/// whose thinking was never retained. Mirrors
/// `DEEPSEEK_REASONING_REPLAY_PLACEHOLDER` in `@pi-workspace/shared`.
const REASONING_REPLAY_PLACEHOLDERS: [&str; 2] = [
    "[reasoning not retained for this turn]",
    "[reasoning retained for this turn]",
];

/// Bytes consumed by one leading `<thinking>…</thinking>` block whose body is
/// nothing but echoed replay placeholder(s), or `None` when the text does not
/// start with one.
///
/// A block that wraps authored text returns `None`: dropping a model's real
/// words would be far worse than leaving a stray tag in a stored row.
pub(super) fn echoed_placeholder_block_len(text: &str) -> Option<usize> {
    let mut rest = text.trim_start().strip_prefix("<thinking")?;
    if !rest.starts_with('>') {
        rest = &rest[rest.find('>')?..];
    }
    let mut body = rest.strip_prefix('>')?.trim_start();
    let mut matched = false;
    while let Some(after) = REASONING_REPLAY_PLACEHOLDERS
        .iter()
        .find_map(|placeholder| body.strip_prefix(placeholder))
    {
        body = after.trim_start();
        matched = true;
    }
    if !matched {
        return None;
    }
    let tail = body.strip_prefix("</thinking>")?;
    Some(text.len() - tail.len())
}

/// Reply text without a leading run of echoed-placeholder `<thinking>` blocks,
/// or `None` when there is nothing to strip.
pub(super) fn without_echoed_placeholder_text(text: &str) -> Option<String> {
    let mut rest = text;
    let mut stripped = false;
    while let Some(consumed) = echoed_placeholder_block_len(rest) {
        rest = &rest[consumed..];
        stripped = true;
    }
    if !stripped {
        return None;
    }
    Some(rest.trim_start().to_string())
}

/// Schema v31 repairs stored reply text that carried the replayed reasoning
/// placeholder (#1945).
///
/// A strict DeepSeek-compatible relay needs non-empty `reasoning_content` on
/// every historical assistant message, so turns whose thinking was never
/// retained are replayed with a placeholder. Models read that as their own
/// previous reasoning, continued it, and emitted it inside literal
/// `<thinking>` tags at the head of their **reply text**. Markdown hides the
/// unknown tag but keeps the body, so users saw a stray
/// "[reasoning not retained for this turn]" line once per replayed turn.
///
/// The write path now strips it before storing, and the renderer strips it on
/// the live stream, so this migration only rewrites rows written before either
/// fix. It is a text repair, not a schema change, but it rewrites rows — hence
/// the usual backup and version bump. The `messages_au` trigger keeps the FTS
/// index in sync with every `UPDATE OF text`.
pub(crate) fn migrate_v30_to_v31_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let mut statement = tx.prepare(
        "SELECT mid, text FROM messages
          WHERE text LIKE '%<thinking>%' AND text LIKE '%retained for this turn]%'",
    )?;
    let candidates: Vec<(i64, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (mid, text) in candidates {
        let Some(repaired) = without_echoed_placeholder_text(&text) else {
            continue;
        };
        if repaired != text {
            tx.execute(
                "UPDATE messages SET text = ?1 WHERE mid = ?2",
                params![repaired, mid],
            )?;
        }
    }
    tx.pragma_update(None, "user_version", 31i64)?;
    Ok(())
}

pub(crate) fn migrate_v30_to_v31(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 30)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v30_to_v31_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v30 to v31 echoed reasoning placeholder repair; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
