//! Transcript and tool-pair repair.
//!
//! Providers accept a strict alternation: every `tool_calls` the assistant
//! message announced must be answered by exactly one tool result before the
//! next assistant message. Interrupted turns, a crashed sidecar, an aborted
//! tool or a compaction that cut a pair all violate it, and the provider then
//! rejects the whole request.
//!
//! Upstream counterpart: `agent/turn_recovery.py`; the Node runtime has the same
//! rule in `compaction-restore-tool-pairs.ts`. [`Transcript::repair_tool_pairs`]
//! is the single place that restores the invariant, and it is idempotent, so it
//! is safe to run before every provider request.

use crate::message::{ContentPart, Message, Role, ToolCall, ToolResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RepairReport {
    /// Results whose call id no assistant message ever announced.
    pub dropped_orphan_results: usize,
    /// Calls that had no result (interrupted turn) and got a synthetic one.
    pub synthesized_results: usize,
    /// A second result for a call id that already had one.
    pub dropped_duplicate_results: usize,
}

impl RepairReport {
    pub fn repaired_anything(&self) -> bool {
        self.dropped_orphan_results + self.synthesized_results + self.dropped_duplicate_results > 0
    }
}

#[derive(Debug, Default, Clone)]
pub struct Transcript {
    messages: Vec<Message>,
}

impl Transcript {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_messages(messages: Vec<Message>) -> Self {
        Self { messages }
    }

    pub fn push(&mut self, message: Message) {
        self.messages.push(message);
    }

    pub fn extend<I: IntoIterator<Item = Message>>(&mut self, messages: I) {
        self.messages.extend(messages);
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn into_messages(self) -> Vec<Message> {
        self.messages
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn last(&self) -> Option<&Message> {
        self.messages.last()
    }

    /// Restore assistant-call / tool-result pairing in place.
    ///
    /// Every assistant message that announced calls is followed by exactly one
    /// tool message holding one result per call, in call order. Missing results
    /// are synthesized as errors so the model learns the tool never completed;
    /// orphan and duplicate results are dropped.
    pub fn repair_tool_pairs(&mut self) -> RepairReport {
        let mut report = RepairReport::default();
        let mut repaired: Vec<Message> = Vec::with_capacity(self.messages.len());
        let mut index = 0;

        while index < self.messages.len() {
            let message = &self.messages[index];
            if message.role == Role::Tool {
                // A tool message is only re-emitted under its assistant call.
                report.dropped_orphan_results += message.tool_results().len().max(1);
                index += 1;
                continue;
            }

            let calls: Vec<ToolCall> = message.tool_calls().into_iter().cloned().collect();
            repaired.push(message.clone());
            index += 1;

            if calls.is_empty() {
                continue;
            }

            // Gather the results that belong to these calls, keeping each
            // result's owning message id and timestamp so a repair never
            // renames or re-dates a row the transcript already persisted.
            let assistant_created_at = message.created_at_ms;
            let mut gathered: Vec<Option<(ToolResult, String, i64)>> = vec![None; calls.len()];
            while index < self.messages.len() && self.messages[index].role == Role::Tool {
                let tool_message = &self.messages[index];
                let message_id = tool_message.id.clone();
                let created_at = tool_message.created_at_ms;
                for part in &tool_message.parts {
                    if let ContentPart::ToolResult(result) = part {
                        match calls.iter().position(|call| call.id == result.call_id) {
                            Some(slot) if gathered[slot].is_none() => {
                                gathered[slot] =
                                    Some((result.clone(), message_id.clone(), created_at));
                            }
                            Some(_) => report.dropped_duplicate_results += 1,
                            None => report.dropped_orphan_results += 1,
                        }
                    }
                }
                index += 1;
            }

            // One tool message per assistant call keeps the pairing explicit
            // and survives providers that only accept single-result turns.
            for (call, slot) in calls.iter().zip(gathered) {
                let (result, message_id, created_at) = match slot {
                    Some(pair) => pair,
                    None => {
                        report.synthesized_results += 1;
                        (
                            ToolResult {
                                call_id: call.id.clone(),
                                name: call.name.clone(),
                                content: "the tool call did not complete (turn interrupted before a result was recorded)".to_string(),
                                is_error: true,
                                truncated: false,
                            },
                            // Deterministic, so a second repair pass emits the
                            // same row instead of a fresh one.
                            format!("synthetic-result-{}", call.id),
                            // Dated from the assistant message that announced
                            // the call, so repair never rewrites a timestamp.
                            assistant_created_at,
                        )
                    }
                };
                let mut tool_row = Message::new(Role::Tool);
                tool_row.id = message_id;
                tool_row.created_at_ms = created_at;
                tool_row.parts.push(ContentPart::ToolResult(result));
                repaired.push(tool_row);
            }
        }

        self.messages = repaired;
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::Message;

    fn assistant_call(id: &str, name: &str) -> Message {
        let mut message = Message::new(Role::Assistant);
        message.push_tool_call(ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: serde_json::json!({}),
            raw_arguments: None,
        });
        message
    }

    fn result(id: &str, content: &str) -> ToolResult {
        ToolResult {
            call_id: id.into(),
            name: "read_file".into(),
            content: content.into(),
            is_error: false,
            truncated: false,
        }
    }

    #[test]
    fn paired_transcript_is_untouched() {
        let mut transcript = Transcript::from_messages(vec![
            Message::user_text("go"),
            assistant_call("call_1", "read_file"),
            Message::tool_result(result("call_1", "ok")),
        ]);
        let before = transcript.clone();
        let report = transcript.repair_tool_pairs();
        assert!(!report.repaired_anything());
        // Repair normalizes nothing when the pairing already holds.
        assert_eq!(transcript.messages(), before.messages());
    }

    #[test]
    fn missing_result_is_synthesized_as_an_error() {
        let mut transcript = Transcript::from_messages(vec![
            Message::user_text("go"),
            assistant_call("call_1", "read_file"),
        ]);
        let report = transcript.repair_tool_pairs();
        assert_eq!(report.synthesized_results, 1);
        let tool_message = transcript.messages().last().unwrap();
        assert_eq!(tool_message.role, Role::Tool);
        let results = tool_message.tool_results();
        assert_eq!(results.len(), 1);
        assert!(results[0].is_error);
        assert_eq!(results[0].call_id, "call_1");
    }

    #[test]
    fn orphan_result_is_dropped() {
        let mut transcript = Transcript::from_messages(vec![
            Message::user_text("go"),
            Message::tool_result(result("call_ghost", "stale")),
        ]);
        let report = transcript.repair_tool_pairs();
        assert_eq!(report.dropped_orphan_results, 1);
        assert!(transcript
            .messages()
            .iter()
            .all(|message| message.role != Role::Tool));
    }

    #[test]
    fn duplicate_result_keeps_the_first() {
        let mut transcript = Transcript::from_messages(vec![
            assistant_call("call_1", "read_file"),
            Message::tool_result(result("call_1", "first")),
            Message::tool_result(result("call_1", "second")),
        ]);
        let report = transcript.repair_tool_pairs();
        assert_eq!(report.dropped_duplicate_results, 1);
        let tool_messages: Vec<_> = transcript
            .messages()
            .iter()
            .filter(|message| message.role == Role::Tool)
            .collect();
        assert_eq!(tool_messages.len(), 1);
        assert_eq!(tool_messages[0].tool_results()[0].content, "first");
    }

    #[test]
    fn parallel_calls_keep_call_order_even_when_results_are_reordered() {
        let mut transcript = Transcript::from_messages(vec![
            {
                let mut message = Message::new(Role::Assistant);
                for (id, name) in [("call_a", "read_file"), ("call_b", "grep")] {
                    message.push_tool_call(ToolCall {
                        id: id.into(),
                        name: name.into(),
                        arguments: serde_json::json!({}),
                        raw_arguments: None,
                    });
                }
                message
            },
            Message::tool_result(result("call_b", "b-result")),
            Message::tool_result(result("call_a", "a-result")),
        ]);
        transcript.repair_tool_pairs();
        let contents: Vec<String> = transcript
            .messages()
            .iter()
            .filter(|message| message.role == Role::Tool)
            .map(|message| message.tool_results()[0].content.clone())
            .collect();
        assert_eq!(contents, vec!["a-result", "b-result"]);
    }

    #[test]
    fn repair_is_idempotent() {
        let mut transcript = Transcript::from_messages(vec![
            assistant_call("call_1", "read_file"),
            assistant_call("call_2", "grep"),
        ]);
        transcript.repair_tool_pairs();
        let once = transcript.clone();
        let report = transcript.repair_tool_pairs();
        assert!(!report.repaired_anything());
        assert_eq!(transcript.messages(), once.messages());
    }
}
