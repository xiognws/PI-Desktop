//! Boot-time maintenance that runs on every database open.
//!
//! Kept beside the migration chain because it shares its retention constants,
//! but separate from the version steps: these statements are idempotent
//! indexes, prunes, and backfills that must also converge a database whose
//! `user_version` is already the newest one.

use super::*;

const AUDIT_RETENTION_MS: i64 = 90 * 24 * 3600 * 1000;
const TASK_RUNS_KEEP: i64 = 100;

impl Database {
    pub(crate) fn boot_maintenance(&self) -> Result<()> {
        let now = now_ms();
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turns_ended_at ON turns(ended_at DESC)",
            [],
        );
        // Session summaries and session search both ask whether a run owns a
        // session, so the probe wants an index of the sessions that have one.
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id)
             WHERE session_id IS NOT NULL",
            [],
        );
        // Search ranks every result set by `created_at` and cuts it with a
        // LIMIT, so the planner needs that column ordered; this is the same
        // idempotent-addition pattern as `idx_turns_ended_at` above. Both
        // statements only add an index, so no existing row is rewritten and a
        // schema-version bump with a migration backup is unnecessary.
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)",
            [],
        );
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session_created
               ON messages(session_id, created_at DESC, seq DESC, id ASC)",
            [],
        );

        // The write path asks one question about a message over and over: does
        // the last copy of this id still sit in the transcript as a provisional,
        // streaming assistant row? The index row already mirrors that copy — it
        // is inserted with the row and re-stamped whenever the transcript line
        // is replaced — so the answer belongs in a column instead of in a
        // backwards walk over every message line of a session that can hold
        // gigabytes, 64 lines at a time, twice per turn.
        //
        // NULL means "written before this column existed". The read falls back to
        // the transcript there, so an existing database answers exactly as it did
        // before until a row is rewritten by an append. That is what makes the
        // column safe to add without a schema-version bump: it carries no default
        // and carries no index, so no row is rewritten and no migration backup is
        // needed — the same idempotent-addition pattern as the indexes above.
        let has_streaming: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('messages') WHERE name = 'streaming')",
            [],
            |row| row.get(0),
        )?;
        if !has_streaming {
            let _ = self
                .conn
                .execute_batch("ALTER TABLE messages ADD COLUMN streaming INTEGER");
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE turns
         SET status = 'aborted', error_code = COALESCE(error_code, 'TURN_ABORTED'),
             ended_at = ?1
         WHERE status = 'running'",
            params![now],
        )?;
        tx.execute(
            "UPDATE task_runs SET status = 'aborted', ended_at = ?1 WHERE status = 'running'",
            params![now],
        )?;

        // No durable Plan work is safe to replay after a host restart. Keep
        // terminal approved session configuration intact, but interrupt every
        // pending approval and execution descriptor that could otherwise be
        // returned as queued to the desktop runner.
        let plan_work: Vec<PlanWorkRow> = {
            let mut stmt = tx.prepare_cached(
                "SELECT request_id, session_id, turn_id, tool_call_id, execution_id,
                    status, execution_state
             FROM plan_approvals
             WHERE status = 'pending' OR execution_state IN ('queued', 'running')",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(PlanWorkRow {
                    proposal_id: row.get(0)?,
                    session_id: row.get(1)?,
                    turn_id: row.get(2)?,
                    tool_call_id: row.get(3)?,
                    execution_id: row.get(4)?,
                    status: row.get(5)?,
                    execution_state: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute(
            "UPDATE plan_approvals
         SET status = CASE WHEN status = 'pending' THEN 'interrupted' ELSE status END,
             resolved_at = CASE WHEN status = 'pending' THEN ?1 ELSE resolved_at END,
             execution_state = CASE
               WHEN execution_state IN ('queued', 'running') THEN 'interrupted'
               ELSE execution_state
             END,
             updated_at = ?1,
             version = version + 1,
             error_code = CASE
               WHEN status = 'pending' THEN 'PLAN_APPROVAL_INTERRUPTED'
               WHEN execution_state IN ('queued', 'running')
                 THEN 'PLAN_EXECUTION_INTERRUPTED'
               ELSE error_code
             END
         WHERE status = 'pending' OR execution_state IN ('queued', 'running')",
            params![now],
        )?;
        for PlanWorkRow {
            proposal_id,
            session_id,
            turn_id,
            tool_call_id,
            execution_id,
            status,
            execution_state,
        } in plan_work
        {
            if status == "pending" {
                crate::audit::append_tx(
                    &tx,
                    "plan_approval_interrupted",
                    Some(&session_id),
                    serde_json::json!({
                        "proposalId": proposal_id,
                        "sessionId": session_id,
                        "turnId": turn_id,
                        "toolCallId": tool_call_id,
                        "status": "interrupted",
                        "errorCode": "PLAN_APPROVAL_INTERRUPTED",
                        "reason": "host_restart"
                    }),
                )?;
            }
            if matches!(execution_state.as_deref(), Some("queued") | Some("running")) {
                crate::audit::append_tx(
                    &tx,
                    "plan_execution_interrupted",
                    Some(&session_id),
                    serde_json::json!({
                        "proposalId": proposal_id,
                        "sessionId": session_id,
                        "executionId": execution_id,
                        "errorCode": "PLAN_EXECUTION_INTERRUPTED",
                        "reason": "host_restart"
                    }),
                )?;
            }
        }
        tx.commit()?;
        self.conn.execute(
            "DELETE FROM audit_log WHERE ts < ?1",
            params![now - AUDIT_RETENTION_MS],
        )?;
        self.conn.execute(
            "DELETE FROM task_runs WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY task_id ORDER BY started_at DESC
             ) AS rn FROM task_runs
           ) WHERE rn > ?1
         )",
            params![TASK_RUNS_KEEP],
        )?;
        self.conn.execute(
            "DELETE FROM notifications
         WHERE id IN (
           SELECT id FROM notifications
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?1
         )",
            params![NOTIFICATION_KEEP],
        )?;
        let _ = self.conn.execute_batch("PRAGMA incremental_vacuum;");
        // One-time repair: strip the Windows extended-length path prefix
        // (`//?/X:/...` → `X:/...`) from project paths stored by older versions.
        self.fix_extended_length_project_paths()?;
        self.daily_memory_tidy(now);
        Ok(())
    }

    /// Repair project paths that were stored with the Windows extended-length
    /// prefix (`//?/X:/...`). Idempotent: rows already in normal form are
    /// skipped, and duplicates are merged by keeping the most-recently-opened.
    fn fix_extended_length_project_paths(&self) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, path FROM projects WHERE path LIKE '//?/%'")?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, old_path) in rows {
            let Some(fixed) = normalize_project_path(&old_path) else {
                continue;
            };
            if fixed == old_path {
                continue;
            }
            // Check if a row with the fixed path already exists.
            let existing: Option<i64> = self
                .conn
                .query_row(
                    "SELECT id FROM projects WHERE path = ?1",
                    params![fixed],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(keep_id) = existing {
                // Merge: reassign FKs pointing to old id, then delete the old row.
                self.conn.execute(
                    "UPDATE sessions SET project_id = ?1 WHERE project_id = ?2",
                    params![keep_id, id],
                )?;
                self.conn.execute(
                    "UPDATE scheduled_tasks SET project_id = ?1 WHERE project_id = ?2",
                    params![keep_id, id],
                )?;
                self.conn
                    .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
            } else {
                self.conn.execute(
                    "UPDATE projects SET path = ?1 WHERE id = ?2",
                    params![fixed, id],
                )?;
            }
        }
        Ok(())
    }

    /// Durable-memory retention (ADR 0371), at most once a day. Best effort:
    /// housekeeping must never keep the host from starting.
    fn daily_memory_tidy(&self, now: i64) {
        const NAMESPACE: &str = "memoryTidy";
        let last = self
            .kv_get(NAMESPACE, "lastRunAt")
            .ok()
            .flatten()
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        if now - last < 24 * 3600 * 1000 {
            return;
        }
        match self.tidy_memories(&crate::memory::TidyPolicy::default()) {
            Ok(outcome) => {
                if outcome.total() > 0 {
                    tracing::info!(
                        expired = outcome.expired,
                        overflow = outcome.overflow,
                        "memory retention removed rows"
                    );
                }
                let _ = self.kv_set(NAMESPACE, "lastRunAt", &serde_json::json!(now));
            }
            Err(error) => tracing::warn!(error = %error, "memory retention failed"),
        }
    }
}
