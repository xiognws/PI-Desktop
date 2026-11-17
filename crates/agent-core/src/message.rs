//! Message and transcript row model.
//!
//! Hermes counterpart: `agent/agent_messages.py` plus the transcript rows the
//! desktop persists. The wire shape the renderer consumes (`UiMessage`) is a
//! projection of this model: `content` is the concatenated text parts,
//! `thinking` the concatenated thinking parts, and tool traffic stays in
//! `parts` because the loop needs the exact call/result pairing.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub type MessageId = String;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_message_id() -> MessageId {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

/// One model-visible content part. Provider adapters re-encode these into
/// their own wire format; nothing downstream should have to look at raw
/// provider JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    /// Model reasoning. Never merged into `Text`: the transcript keeps the two
    /// apart so a resume replays the same ordering the UI showed.
    Thinking {
        text: String,
    },
    /// Attachment admitted with a user turn (`image-admission.ts` in the Node
    /// runtime). Base64 payload, provider adapters decide whether to inline it.
    Image {
        mime_type: String,
        data: String,
    },
    ToolCall(ToolCall),
    ToolResult(ToolResult),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-assigned id. Every tool result must quote it back.
    pub id: String,
    pub name: String,
    /// Parsed arguments. Kept as JSON because tool schemas are dynamic.
    pub arguments: Value,
    /// Raw argument text when the provider streamed a partial/invalid object;
    /// kept so a repair path can report what the model actually said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
    /// Set when the result was cut to the configured limit (spec 16).
    #[serde(default)]
    pub truncated: bool,
}

/// Token accounting. Mirrors `MessageUsage` in `packages/shared`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    #[serde(default)]
    pub reasoning_tokens: u64,
}

impl Usage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    pub fn merge(&mut self, other: &Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }
}

/// Why the provider stopped. `ToolUse` is what keeps the loop going.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxOutputTokens,
    StopSequence,
    ContentFilter,
    /// Provider-specific terminator kept verbatim for diagnostics.
    Other(String),
}

impl StopReason {
    pub fn wants_tools(&self) -> bool {
        matches!(self, Self::ToolUse)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub role: Role,
    pub parts: Vec<ContentPart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    pub created_at_ms: i64,
}

impl Message {
    pub fn new(role: Role) -> Self {
        Self {
            id: new_message_id(),
            role,
            parts: Vec::new(),
            usage: None,
            stop_reason: None,
            created_at_ms: now_ms(),
        }
    }

    pub fn user_text(text: impl Into<String>) -> Self {
        let mut message = Self::new(Role::User);
        message.parts.push(ContentPart::Text { text: text.into() });
        message
    }

    pub fn system_text(text: impl Into<String>) -> Self {
        let mut message = Self::new(Role::System);
        message.parts.push(ContentPart::Text { text: text.into() });
        message
    }

    pub fn tool_result(result: ToolResult) -> Self {
        let mut message = Self::new(Role::Tool);
        message.parts.push(ContentPart::ToolResult(result));
        message
    }

    /// Concatenated text parts — what `UiMessage.content` shows.
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// Concatenated thinking parts — what `UiMessage.thinking` shows.
    pub fn thinking(&self) -> Option<String> {
        let joined: String = self
            .parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Thinking { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    }

    pub fn tool_calls(&self) -> Vec<&ToolCall> {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolCall(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    pub fn tool_results(&self) -> Vec<&ToolResult> {
        self.parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::ToolResult(result) => Some(result),
                _ => None,
            })
            .collect()
    }

    pub fn has_tool_traffic(&self) -> bool {
        self.parts
            .iter()
            .any(|part| matches!(part, ContentPart::ToolCall(_) | ContentPart::ToolResult(_)))
    }

    /// Append streamed text, creating the part on first use so consecutive
    /// deltas cannot produce two adjacent `Text` parts.
    pub fn push_text(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        match self.parts.last_mut() {
            Some(ContentPart::Text { text }) => text.push_str(delta),
            _ => self.parts.push(ContentPart::Text {
                text: delta.to_string(),
            }),
        }
    }

    pub fn push_thinking(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        match self.parts.last_mut() {
            Some(ContentPart::Thinking { text }) => text.push_str(delta),
            _ => self.parts.push(ContentPart::Thinking {
                text: delta.to_string(),
            }),
        }
    }

    pub fn push_tool_call(&mut self, call: ToolCall) {
        self.parts.push(ContentPart::ToolCall(call));
    }

    /// True when the message carries nothing a model or a reader needs.
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
            || self.text().is_empty()
                && self.thinking().is_none()
                && self.tool_calls().is_empty()
                && self.tool_results().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_text_and_thinking_stay_separate_parts() {
        let mut message = Message::new(Role::Assistant);
        message.push_thinking("plan ");
        message.push_thinking("first");
        message.push_text("answer");
        message.push_text(" body");

        assert_eq!(message.thinking().as_deref(), Some("plan first"));
        assert_eq!(message.text(), "answer body");
        assert_eq!(message.parts.len(), 2);
    }

    #[test]
    fn usage_merge_is_additive() {
        let mut total = Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        };
        total.merge(&Usage {
            input_tokens: 3,
            cache_read_tokens: 7,
            ..Usage::default()
        });
        assert_eq!(total.input_tokens, 13);
        assert_eq!(total.output_tokens, 5);
        assert_eq!(total.cache_read_tokens, 7);
        assert_eq!(total.total_tokens(), 18);
    }

    #[test]
    fn empty_assistant_turn_is_detectable() {
        let mut message = Message::new(Role::Assistant);
        assert!(message.is_empty());
        message.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "a.txt"}),
            raw_arguments: None,
        });
        assert!(!message.is_empty());
        assert_eq!(message.tool_calls().len(), 1);
    }
}
