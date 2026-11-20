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

use serde_json::Value;

use crate::message::{ContentPart, Message};
use crate::message::{ToolCall, ToolResult};

/// Rebuild conversation messages from `session.get` rows.
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
pub fn messages_from_history(rows: &[Value]) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();
    for row in rows {
        let Some(object) = row.as_object() else {
            continue;
        };
        if object.contains_key("parentToolCallId") || object.contains_key("agentName") {
            continue;
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
                    continue;
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
                    continue;
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
            _ => {}
        }
    }
    out
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
}
