//! Turn and stream events.
//!
//! The vocabulary is the one the renderer already consumes (`AgentEvent` in
//! `packages/shared/src/types/agent.ts`). Phase 1 emits the subset the kernel
//! can produce on its own; permission, asktool, planning, compaction and
//! skill-review variants join when their subsystems migrate.
//!
//! Field names are `camelCase` so the sidecar RPC layer can forward an event
//! unchanged instead of translating a second time.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::message::{now_ms, Message, Usage};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        #[serde(rename = "messageIds")]
        message_ids: Vec<String>,
    },
    TurnStart,
    Usage {
        usage: Usage,
    },
    TurnEnd,
    MessageStart {
        message: Message,
    },
    /// Append-only streaming frame: `deltaText`/`deltaThinking` are applied on
    /// top of the live row, and a snapshot replacement omits them.
    MessageUpdate {
        message: Message,
        #[serde(rename = "deltaText", skip_serializing_if = "Option::is_none")]
        delta_text: Option<String>,
        #[serde(rename = "deltaThinking", skip_serializing_if = "Option::is_none")]
        delta_thinking: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<String>,
    },
    MessageEnd {
        message: Message,
    },
    ToolStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "args")]
        arguments: serde_json::Value,
    },
    ToolEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        result: serde_json::Value,
        #[serde(rename = "isError", skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
    CompactionStart {
        reason: CompactionReason,
    },
    CompactionEnd {
        reason: CompactionReason,
        ok: bool,
        #[serde(rename = "tokensBefore", skip_serializing_if = "Option::is_none")]
        tokens_before: Option<u64>,
        #[serde(rename = "firstKeptMessageId", skip_serializing_if = "Option::is_none")]
        first_kept_message_id: Option<String>,
        #[serde(rename = "willRetry")]
        will_retry: bool,
        /// Present when the summary failed and a retained tail was installed.
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<CompactionFallback>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<CompactionFailure>,
    },
    /// A question the model asked; the renderer draws a card and answers it
    /// through `asktool.resolve`. The wire name is one word: the renderer's event
    /// union spells it `asktool_request`, not `ask_tool_request`.
    #[serde(rename = "asktool_request")]
    AskToolRequest {
        request: crate::ask::AskRequest,
    },
    Error {
        code: String,
        message: String,
    },
}

/// Why compaction ran. Wire names match `ContextCompactionReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    Manual,
    Threshold,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionFallback {
    RetainedTail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub ts: i64,
    pub event: AgentEvent,
}

impl AgentEventEnvelope {
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        event: AgentEvent,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: Some(turn_id.into()),
            ts: now_ms(),
            event,
        }
    }
}

/// Where the kernel publishes events. The sidecar implements this over its
/// JSON-RPC notification channel; tests implement it over a vector.
pub trait EventSink: Send + Sync {
    fn emit(&self, envelope: AgentEventEnvelope);
}

impl EventSink for tokio::sync::mpsc::UnboundedSender<AgentEventEnvelope> {
    fn emit(&self, envelope: AgentEventEnvelope) {
        // A closed receiver means the consumer went away; the turn will notice
        // through cancellation, so dropping the event here is correct.
        let _ = self.send(envelope);
    }
}

/// Test/self-check sink that keeps every event in order.
#[derive(Debug, Default, Clone)]
pub struct RecordingSink {
    events: Arc<Mutex<Vec<AgentEventEnvelope>>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> Vec<AgentEventEnvelope> {
        self.events.lock().expect("event log poisoned").clone()
    }

    pub fn events(&self) -> Vec<AgentEvent> {
        self.snapshot()
            .into_iter()
            .map(|envelope| envelope.event)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.events.lock().expect("event log poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        self.events
            .lock()
            .expect("event log poisoned")
            .push(envelope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_serializes_with_camel_case_contract() {
        let envelope = AgentEventEnvelope::new(
            "s1",
            "t1",
            AgentEvent::ToolStart {
                tool_call_id: "call_1".into(),
                tool_name: "read_file".into(),
                arguments: serde_json::json!({"path": "a.txt"}),
            },
        );
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["turnId"], "t1");
        assert_eq!(value["event"]["type"], "tool_start");
        assert_eq!(value["event"]["toolCallId"], "call_1");
        assert_eq!(value["event"]["toolName"], "read_file");
    }

    #[test]
    fn recording_sink_keeps_order() {
        let sink = RecordingSink::new();
        sink.emit(AgentEventEnvelope::new("s", "t", AgentEvent::TurnStart));
        sink.emit(AgentEventEnvelope::new("s", "t", AgentEvent::TurnEnd));
        let events = sink.events();
        assert_eq!(events, vec![AgentEvent::TurnStart, AgentEvent::TurnEnd]);
    }
}
