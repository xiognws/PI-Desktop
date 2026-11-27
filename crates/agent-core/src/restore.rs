//! Rebuilding the kernel's transcript from host-owned history.
//!
//! Host-core owns persistence: a session's messages live in SQLite, and the
//! kernel keeps only what it needs for the turn in flight. When a session is
//! reopened — after a restart, or when a runtime is rebuilt — the kernel has to
//! ask for that history back, or the model sees a conversation that starts with
//! the user's newest message and remembers nothing.
//!
//! The rows are `UiMessage`s: what the renderer draws and what host-core stores.
//! They are richer than the model needs and shaped for a UI, so this module is
//! the one place that decides what crosses back into model context. Everything
//! it drops is dropped on purpose, and the reasons matter more than the code.
//!
//! # The stored checkpoint
//!
//! A compaction replaces the conversation with a summary plus a short tail, in
//! memory, and the conversation keeps growing from there. If that summary is not
//! durable, a restart rebuilds the *raw* rows the summary had already replaced:
//! the model resumes on a different history than the one it compacted, and every
//! restart picks a different slice. `session.appendCompaction` stores the record,
//! `session.get` hands it back, and [`restore_history`] starts from it — summary
//! first, then the tail the record kept, then the rows written after the cut.
//! The record names its retained messages by id instead of carrying copies, so a
//! restored session always re-reads the real rows.

use serde_json::Value;

use crate::compaction::checkpoint_message;
use crate::message::{ContentPart, Message};
use crate::message::{ToolCall, ToolResult};

/// What one restore did with the rows it was given.
///
/// "The model forgot" is either a checkpoint that summarized the wrong range, a
/// restore that returned a fraction of the rows, or a later ageing pass — and
/// without these counts none of the three can be told apart from a log.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RestoreReport {
    pub rows: usize,
    pub messages: usize,
    /// Prompt journal rows: the kernel's own record of what it sent.
    pub dropped_system: usize,
    /// Subagent rows: they belong to the delegate's context, not the parent's.
    pub dropped_delegated: usize,
    /// Aborted or failed assistant rows with nothing to reply to.
    pub dropped_empty_assistant: usize,
    /// Tool rows whose call id never landed, so the pair cannot be rebuilt.
    pub dropped_tool_without_call: usize,
    /// Rows the stored checkpoint already summarized.
    pub dropped_summarized: usize,
    /// Whether a checkpoint governed this restore.
    pub checkpoint: bool,
}

impl RestoreReport {
    /// One line's worth of shape, ready for a log field.
    pub fn summary(&self) -> String {
        format!(
            "rows={} messages={} checkpoint={} summarized={} delegated={} system={} empty_assistant={} orphan_tool={}",
            self.rows,
            self.messages,
            self.checkpoint,
            self.dropped_summarized,
            self.dropped_delegated,
            self.dropped_system,
            self.dropped_empty_assistant,
            self.dropped_tool_without_call
        )
    }
}

/// A stored compaction record, reduced to what a restore needs.
struct Checkpoint {
    summary: String,
    /// Last message the summary replaced.
    through: String,
    /// Messages the checkpoint kept verbatim, by id.
    retained: Vec<String>,
}

/// Rebuild conversation messages from `session.get` rows, honouring the store's
/// checkpoint when there is one.
///
/// Skipped, deliberately:
///
/// - `system` rows: these are the kernel's own journal of the system prompt it
///   sent (with tool declarations), not conversation. Re-sending one would
///   duplicate the prompt, and the prompt for *this* turn is composed fresh.
/// - rows carrying `parentToolCallId`: a subagent's turns never enter the parent
///   model's context (ADR 0062). Only the `Task` report does, and it is a
///   tool result the parent already has.
/// - aborted or failed assistant rows with no text: they would add an empty
///   assistant message the model must not reply to.
/// - rows the stored checkpoint already summarized: sending them again is a
///   second copy of a conversation the model has already been told about.
pub fn restore_history(
    rows: &[Value],
    compaction: Option<&Value>,
) -> (Vec<Message>, RestoreReport) {
    let mut report = RestoreReport {
        rows: rows.len(),
        ..RestoreReport::default()
    };
    let resolved = checkpoint_from(compaction).and_then(|checkpoint| {
        rows.iter()
            .position(|row| row_id(row) == Some(checkpoint.through.as_str()))
            .map(|index| (checkpoint, index))
    });
    let Some((checkpoint, cut)) = resolved else {
        // No usable checkpoint — a session that never compacted, an older store,
        // or a record naming a row that has since been rewritten. The whole
        // transcript is the context, as it was before compaction existed.
        let mut messages = Vec::new();
        for row in rows {
            append_row(row, &mut messages, &mut report);
        }
        report.messages = messages.len();
        return (messages, report);
    };

    report.checkpoint = true;
    // The summary is authoritative for everything up to the cut. What survives
    // is only what the checkpoint explicitly kept, and it survives *ahead* of the
    // live tail because that is the order the model saw it in.
    let mut messages = vec![checkpoint_message(&checkpoint.summary)];
    let retained: std::collections::HashSet<&str> =
        checkpoint.retained.iter().map(String::as_str).collect();
    for row in &rows[..=cut] {
        match row_id(row) {
            Some(id) if retained.contains(id) => append_row(row, &mut messages, &mut report),
            _ => report.dropped_summarized += 1,
        }
    }
    for row in &rows[cut + 1..] {
        append_row(row, &mut messages, &mut report);
    }
    report.messages = messages.len();
    (messages, report)
}

/// Rebuild conversation messages from `session.get` rows, ignoring any stored
/// checkpoint.
///
/// Kept for callers that hold rows and nothing else; a resumed session goes
/// through [`restore_history`] so its checkpoint is honoured.
pub fn messages_from_history(rows: &[Value]) -> Vec<Message> {
    restore_history(rows, None).0
}

fn checkpoint_from(compaction: Option<&Value>) -> Option<Checkpoint> {
    let record = compaction?.as_object()?;
    // A blank summary and a cut that names nothing are both a record a restore
    // cannot act on; falling back to the rows beats installing an empty
    // checkpoint over the conversation.
    let summary = record.get("summary")?.as_str()?.trim().to_string();
    if summary.is_empty() {
        return None;
    }
    let through = record.get("throughMessageId")?.as_str()?.to_string();
    if through.is_empty() {
        return None;
    }
    let retained = record
        .get("details")
        .and_then(|details| details.get("retainedMessageIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(Checkpoint {
        summary,
        through,
        retained,
    })
}

fn row_id(row: &Value) -> Option<&str> {
    row.as_object()?.get("id")?.as_str()
}

/// Append the messages one row contributes, counting it when it contributes none.
fn append_row(row: &Value, out: &mut Vec<Message>, report: &mut RestoreReport) {
    let Some(object) = row.as_object() else {
        return;
    };
    if object.contains_key("parentToolCallId") || object.contains_key("agentName") {
        report.dropped_delegated += 1;
        return;
    }
    let role = object.get("role").and_then(Value::as_str).unwrap_or("");
    match role {
        "user" => {
            let text = object.get("content").and_then(Value::as_str).unwrap_or("");
            // A steering row is user input accepted mid-turn: it is part of
            // the conversation the model saw, so it is restored like any
            // other user message.
            let mut message = Message::user_text(text);
            restore_id(&mut message, object);
            out.push(message);
        }
        "assistant" => {
            let text = object.get("content").and_then(Value::as_str).unwrap_or("");
            let thinking = object.get("thinking").and_then(Value::as_str);
            if text.trim().is_empty() && thinking.is_none() {
                report.dropped_empty_assistant += 1;
                return;
            }
            let mut message = Message::new(crate::message::Role::Assistant);
            if let Some(thinking) = thinking.filter(|text| !text.trim().is_empty()) {
                message.parts.push(ContentPart::Thinking {
                    text: thinking.to_string(),
                });
            }
            if !text.is_empty() {
                message.parts.push(ContentPart::Text {
                    text: text.to_string(),
                });
            }
            message.stop_reason = Some(crate::message::StopReason::EndTurn);
            restore_id(&mut message, object);
            out.push(message);
        }
        "tool" => {
            // A persisted tool row is the *result*; the model also needs the
            // call that asked for it, or the pair is dangling. The call is
            // reconstructed from the row's own fields, which is why the
            // assistant message is synthesized here rather than looked for.
            let Some(call_id) = object.get("toolCallId").and_then(Value::as_str) else {
                report.dropped_tool_without_call += 1;
                return;
            };
            let name = object
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let arguments = object
                .get("toolArgs")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default()));
            let mut caller = Message::new(crate::message::Role::Assistant);
            caller.push_tool_call(ToolCall {
                id: call_id.to_string(),
                name: name.to_string(),
                arguments,
                raw_arguments: None,
            });
            caller.stop_reason = Some(crate::message::StopReason::ToolUse);
            out.push(caller);

            let content = match object.get("toolResult") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => object
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            };
            let is_error = object
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || object.get("toolStatus").and_then(Value::as_str) == Some("error");
            out.push(Message::tool_result(ToolResult {
                call_id: call_id.to_string(),
                name: name.to_string(),
                content,
                is_error,
                truncated: false,
            }));
        }
        // `system` and anything this kernel does not know about: not
        // conversation, so never model context.
        "system" => report.dropped_system += 1,
        _ => {}
    }
}

/// Keep the host's row id, so a persisted row and the restored message are the
/// same message to anything that compares them.
fn restore_id(message: &mut Message, row: &serde_json::Map<String, Value>) {
    if let Some(id) = row.get("id").and_then(Value::as_str) {
        message.id = id.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_plain_conversation_round_trips() {
        let rows = vec![
            json!({"id": "u1", "role": "user", "content": "first question"}),
            json!({"id": "a1", "role": "assistant", "content": "first answer"}),
            json!({"id": "u2", "role": "user", "content": "second question"}),
        ];
        let messages = messages_from_history(&rows);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].id, "u1");
        assert_eq!(messages[0].text(), "first question");
        assert_eq!(messages[1].role, crate::message::Role::Assistant);
        assert_eq!(messages[2].text(), "second question");
    }

    #[test]
    fn the_system_journal_row_is_not_conversation() {
        let rows = vec![
            json!({"id": "s1", "role": "system", "content": "", "modelSystem": {"version": 1, "messageJson": "{}"}}),
            json!({"id": "u1", "role": "user", "content": "hi"}),
        ];
        let messages = messages_from_history(&rows);
        assert_eq!(messages.len(), 1, "the prompt snapshot is not replayed");
        assert_eq!(messages[0].role, crate::message::Role::User);
    }

    #[test]
    fn a_subagent_row_never_enters_the_parent_context() {
        let rows = vec![
            json!({"id": "u1", "role": "user", "content": "do it"}),
            json!({"id": "d1", "role": "assistant", "content": "child work", "parentToolCallId": "call_1"}),
            json!({"id": "a1", "role": "assistant", "content": "parent answer"}),
        ];
        let messages = messages_from_history(&rows);
        assert_eq!(messages.len(), 2, "the delegate's turn stays out");
        assert_eq!(messages[1].text(), "parent answer");
    }

    #[test]
    fn a_tool_row_restores_both_the_call_and_its_result() {
        let rows = vec![json!({
            "id": "t1",
            "role": "tool",
            "content": "",
            "toolName": "read_file",
            "toolCallId": "call_9",
            "toolArgs": {"path": "a.txt"},
            "toolResult": "file contents",
            "toolStatus": "success"
        })];
        let messages = messages_from_history(&rows);
        assert_eq!(messages.len(), 2, "a call and its result");
        let calls = messages[0].tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_9");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments["path"], "a.txt");
        let results = messages[1].tool_results();
        assert_eq!(results[0].call_id, "call_9");
        assert_eq!(results[0].content, "file contents");
        assert!(!results[0].is_error);
    }

    #[test]
    fn a_failed_tool_row_keeps_its_error_state() {
        let rows = vec![json!({
            "id": "t1",
            "role": "tool",
            "toolName": "Bash",
            "toolCallId": "call_3",
            "toolResult": {"ok": false, "error": "boom"},
            "toolStatus": "error"
        })];
        let messages = messages_from_history(&rows);
        assert!(messages[1].tool_results()[0].is_error);
        assert!(messages[1].tool_results()[0].content.contains("boom"));
    }

    #[test]
    fn an_empty_failed_assistant_row_is_dropped() {
        let rows = vec![
            json!({"id": "u1", "role": "user", "content": "go"}),
            json!({"id": "a1", "role": "assistant", "content": "", "status": "aborted"}),
            json!({"id": "a2", "role": "assistant", "content": "", "thinking": "I considered it"}),
        ];
        let messages = messages_from_history(&rows);
        assert_eq!(messages.len(), 2, "nothing to reply to is not a message");
        assert!(matches!(messages[1].parts[0], ContentPart::Thinking { .. }));
    }

    #[test]
    fn a_tool_row_without_an_id_is_skipped_rather_than_guessed() {
        let rows = vec![json!({"role": "tool", "toolName": "Bash", "content": "x"})];
        assert!(messages_from_history(&rows).is_empty());
    }

    /// The whole point of storing the record: a restart resumes on the history
    /// the model compacted, not on the raw rows the summary replaced.
    #[test]
    fn a_stored_checkpoint_replaces_the_rows_it_summarized() {
        let rows = vec![
            json!({"id": "u1", "role": "user", "content": "read the repo"}),
            json!({"id": "a1", "role": "assistant", "content": "read it"}),
            json!({"id": "u2", "role": "user", "content": "now the tests"}),
            json!({"id": "a2", "role": "assistant", "content": "ran them"}),
            json!({"id": "u3", "role": "user", "content": "continue"}),
        ];
        let compaction = json!({
            "id": "c1",
            "summary": "Explored the repo and ran the tests; three failures remain.",
            "throughMessageId": "a2",
            "tokensBefore": 61000,
            "details": {"retainedMessageIds": ["u2"]},
        });
        let (messages, report) = restore_history(&rows, Some(&compaction));
        assert!(report.checkpoint);
        assert!(messages[0].text().contains("context checkpoint"));
        assert!(
            messages[0].text().contains("three failures remain"),
            "the summary is the record of what happened: {}",
            messages[0].text()
        );
        let ids: Vec<&str> = messages.iter().map(|message| message.id.as_str()).collect();
        assert_eq!(
            ids[1..],
            ["u2", "u3"],
            "the retained tail survives, in order, ahead of the live tail: {ids:?}"
        );
        assert_eq!(report.dropped_summarized, 3, "u1, a1 and a2");
        assert_eq!(report.messages, messages.len());
    }

    /// A record naming a row that is no longer in the store cannot be trusted to
    /// mark a boundary; dropping everything before it would be worse than
    /// restoring the whole transcript.
    #[test]
    fn a_checkpoint_naming_a_missing_row_falls_back_to_every_row() {
        let rows = vec![
            json!({"id": "u1", "role": "user", "content": "one"}),
            json!({"id": "u2", "role": "user", "content": "two"}),
        ];
        let compaction = json!({
            "id": "c1",
            "summary": "summary",
            "throughMessageId": "gone",
            "tokensBefore": 10,
        });
        let (messages, report) = restore_history(&rows, Some(&compaction));
        assert!(!report.checkpoint);
        assert_eq!(messages.len(), 2);
        assert_eq!(report.dropped_summarized, 0);
    }

    /// The counts are the diagnosis: a resume that silently halved the
    /// conversation must be readable from the log line.
    #[test]
    fn the_report_counts_every_kind_of_drop() {
        let rows = vec![
            json!({"id": "s1", "role": "system", "content": ""}),
            json!({"id": "d1", "role": "assistant", "content": "child", "parentToolCallId": "c"}),
            json!({"id": "a1", "role": "assistant", "content": ""}),
            json!({"id": "t1", "role": "tool", "toolName": "Bash", "content": ""}),
            json!({"id": "u1", "role": "user", "content": "hi"}),
        ];
        let (messages, report) = restore_history(&rows, None);
        assert_eq!(messages.len(), 1);
        assert_eq!(report.dropped_system, 1);
        assert_eq!(report.dropped_delegated, 1);
        assert_eq!(report.dropped_empty_assistant, 1);
        assert_eq!(report.dropped_tool_without_call, 1);
        assert!(report.summary().contains("rows=5 messages=1"));
    }
}
