//! Provider boundary: one trait, one streaming event vocabulary, one
//! assembler.
//!
//! Hermes counterpart: `agent/auxiliary_client.py` plus the per-provider
//! adapters (`anthropic_adapter.py`, `gemini_native_adapter.py`,
//! `codex_responses_adapter.py`). The Node runtime splits the same job across
//! `pi-ai`'s adapters and `stream-rules.ts`.
//!
//! Transports are deliberately *not* part of this module yet: a decoder turns
//! bytes into [`StreamEvent`]s, and the HTTP layer that feeds it arrives with
//! the sidecar in phase 2. That keeps the whole kernel testable from fixtures.

pub mod anthropic;
pub mod openai;
pub mod scripted;
pub mod sse;

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc;

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};
use crate::message::{ContentPart, Message, Role, StopReason, ToolCall, Usage};
use crate::tool::ToolSpec;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingLevel {
    #[default]
    Off,
    Low,
    Medium,
    High,
}

impl ThinkingLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub thinking: ThinkingLevel,
}

impl ChatRequest {
    pub fn new(model: impl Into<String>, messages: Vec<Message>) -> Self {
        Self {
            model: model.into(),
            system: None,
            messages,
            tools: Vec::new(),
            max_output_tokens: None,
            temperature: None,
            thinking: ThinkingLevel::Off,
        }
    }
}

/// One decoded provider frame. Every adapter normalizes into this set so the
/// loop never learns a provider's wire format.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    ThinkingDelta(String),
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallDelta {
        index: usize,
        arguments_delta: String,
    },
    Usage(Usage),
    Finish(StopReason),
}

/// A provider produces a channel of [`StreamEvent`]s. The channel ends when
/// the response is complete or the task fails; cancellation closes it early.
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;

    fn stream<'a>(
        &'a self,
        request: ChatRequest,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<ProviderStream>>;
}

pub struct ProviderStream {
    rx: mpsc::Receiver<StreamEvent>,
}

impl ProviderStream {
    pub fn new(rx: mpsc::Receiver<StreamEvent>) -> Self {
        Self { rx }
    }

    /// Build a stream from an already-decoded sequence. Used by scripted
    /// providers in tests and by the self-check.
    pub fn from_events(events: Vec<StreamEvent>) -> Self {
        let (tx, rx) = mpsc::channel(events.len().max(1));
        tokio::spawn(async move {
            for event in events {
                if tx.send(event).await.is_err() {
                    return;
                }
            }
        });
        Self { rx }
    }

    pub async fn next(&mut self) -> Option<StreamEvent> {
        self.rx.recv().await
    }

    /// Drain the stream, folding every frame into one assistant message.
    /// Convenience for callers that do not need incremental output.
    pub async fn collect(mut self) -> Result<AssembledResponse> {
        let mut assembler = ResponseAssembler::new();
        while let Some(event) = self.next().await {
            assembler.push(event)?;
        }
        assembler.finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssembledResponse {
    pub message: Message,
    pub usage: Usage,
    pub stop_reason: StopReason,
}

#[derive(Debug, Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Folds streaming frames into the assistant message the transcript stores.
///
/// Rules carried over from the Hermes loop and `pi-agent-core`:
/// * text and thinking accumulate into separate parts, in arrival order;
/// * tool calls are keyed by stream index, because the id and name arrive on
///   the first frame and the argument JSON arrives in fragments;
/// * a response that carries tool calls is a `ToolUse` turn even when the
///   provider claims `stop`, because the calls must still be executed;
/// * a stream that closes without a finish reason is an error, not an empty
///   successful turn.
#[derive(Debug, Default)]
pub struct ResponseAssembler {
    text: String,
    thinking: String,
    tool_calls: Vec<PartialToolCall>,
    usage: Usage,
    finish: Option<StopReason>,
}

impl ResponseAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: StreamEvent) -> Result<()> {
        match event {
            StreamEvent::TextDelta(delta) => {
                self.text.push_str(&delta);
            }
            StreamEvent::ThinkingDelta(delta) => {
                self.thinking.push_str(&delta);
            }
            StreamEvent::ToolCallStart { index, id, name } => {
                let slot = self.slot(index);
                if !id.is_empty() {
                    slot.id = id;
                }
                if !name.is_empty() {
                    slot.name = name;
                }
            }
            StreamEvent::ToolCallDelta {
                index,
                arguments_delta,
            } => {
                let slot = self.slot(index);
                slot.arguments.push_str(&arguments_delta);
            }
            StreamEvent::Usage(usage) => {
                self.usage.merge(&usage);
            }
            StreamEvent::Finish(reason) => {
                self.finish = Some(reason);
            }
        }
        Ok(())
    }

    fn slot(&mut self, index: usize) -> &mut PartialToolCall {
        while self.tool_calls.len() <= index {
            self.tool_calls.push(PartialToolCall::default());
        }
        &mut self.tool_calls[index]
    }

    pub fn finish(self) -> Result<AssembledResponse> {
        let stop_reason = self.finish.ok_or(AgentError::IncompleteStream)?;

        let mut message = Message::new(Role::Assistant);
        if !self.thinking.is_empty() {
            message.parts.push(ContentPart::Thinking {
                text: self.thinking,
            });
        }
        if !self.text.is_empty() {
            message.parts.push(ContentPart::Text { text: self.text });
        }
        let mut calls = Vec::new();
        for partial in self.tool_calls {
            if partial.name.is_empty() {
                continue;
            }
            let (arguments, raw_arguments) = parse_arguments(&partial.arguments);
            let call = ToolCall {
                id: if partial.id.is_empty() {
                    // Providers that omit ids still need a stable handle so a
                    // result can be paired with its call.
                    format!("call_{}", crate::message::new_message_id())
                } else {
                    partial.id
                },
                name: partial.name,
                arguments,
                raw_arguments,
            };
            calls.push(call);
        }
        let has_calls = !calls.is_empty();
        for call in calls {
            message.parts.push(ContentPart::ToolCall(call));
        }
        if has_calls {
            message.stop_reason = Some(StopReason::ToolUse);
        } else {
            message.stop_reason = Some(stop_reason.clone());
        }
        message.usage = Some(self.usage);

        Ok(AssembledResponse {
            message,
            usage: self.usage,
            stop_reason: if has_calls {
                StopReason::ToolUse
            } else {
                stop_reason
            },
        })
    }
}

/// Argument JSON that arrives truncated or malformed is kept verbatim rather
/// than dropped: the tool layer reports the parse failure back to the model,
/// which is recoverable, while a silently missing call is not.
fn parse_arguments(raw: &str) -> (serde_json::Value, Option<String>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // A tool with no arguments is legal; `{}` is the honest reading.
        return (serde_json::json!({}), None);
    }
    match serde_json::from_str(trimmed) {
        Ok(value) => (value, None),
        Err(_) => (serde_json::Value::Null, Some(raw.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assembled(events: Vec<StreamEvent>) -> AssembledResponse {
        let mut assembler = ResponseAssembler::new();
        for event in events {
            assembler.push(event).unwrap();
        }
        assembler.finish().unwrap()
    }

    #[test]
    fn text_and_thinking_land_in_separate_parts() {
        let response = assembled(vec![
            StreamEvent::ThinkingDelta("weigh ".into()),
            StreamEvent::ThinkingDelta("options".into()),
            StreamEvent::TextDelta("Done.".into()),
            StreamEvent::Finish(StopReason::EndTurn),
        ]);
        assert_eq!(response.stop_reason, StopReason::EndTurn);
        assert_eq!(
            response.message.thinking().as_deref(),
            Some("weigh options")
        );
        assert_eq!(response.message.text(), "Done.");
        assert!(response
            .message
            .parts
            .first()
            .unwrap()
            .eq(&ContentPart::Thinking {
                text: "weigh options".into()
            }));
    }

    #[test]
    fn fragmented_tool_arguments_are_reassembled() {
        let response = assembled(vec![
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_a".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "{\"path\":".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "\"a.txt\"}".into(),
            },
            StreamEvent::Finish(StopReason::StopSequence),
        ]);
        // Presence of a call outranks the provider's `stop_sequence`.
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        let calls = response.message.tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_a");
        assert_eq!(calls[0].arguments, serde_json::json!({"path": "a.txt"}));
        assert!(calls[0].raw_arguments.is_none());
    }

    #[test]
    fn parallel_tool_calls_keep_their_stream_order() {
        let response = assembled(vec![
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_a".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolCallStart {
                index: 1,
                id: "call_b".into(),
                name: "grep".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 1,
                arguments_delta: "{\"pattern\":\"x\"}".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "{\"path\":\"a\"}".into(),
            },
            StreamEvent::Finish(StopReason::ToolUse),
        ]);
        let names: Vec<_> = response
            .message
            .tool_calls()
            .iter()
            .map(|call| call.name.clone())
            .collect();
        assert_eq!(names, vec!["read_file", "grep"]);
    }

    #[test]
    fn malformed_arguments_are_preserved_for_the_tool_layer() {
        let response = assembled(vec![
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_a".into(),
                name: "read_file".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "{\"path\": \"a.tx".into(),
            },
            StreamEvent::Finish(StopReason::ToolUse),
        ]);
        let call = &response.message.tool_calls()[0];
        assert_eq!(call.arguments, serde_json::Value::Null);
        assert_eq!(call.raw_arguments.as_deref(), Some("{\"path\": \"a.tx"));
    }

    #[test]
    fn missing_tool_arguments_default_to_empty_object() {
        let response = assembled(vec![
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_a".into(),
                name: "list_sessions".into(),
            },
            StreamEvent::Finish(StopReason::ToolUse),
        ]);
        assert_eq!(
            response.message.tool_calls()[0].arguments,
            serde_json::json!({})
        );
    }

    #[test]
    fn a_stream_without_a_finish_reason_is_an_error() {
        let mut assembler = ResponseAssembler::new();
        assembler
            .push(StreamEvent::TextDelta("half".into()))
            .unwrap();
        assert!(matches!(
            assembler.finish(),
            Err(AgentError::IncompleteStream)
        ));
    }

    #[test]
    fn usage_frames_accumulate() {
        let response = assembled(vec![
            StreamEvent::Usage(Usage {
                input_tokens: 12,
                output_tokens: 1,
                ..Usage::default()
            }),
            StreamEvent::Usage(Usage {
                output_tokens: 4,
                ..Usage::default()
            }),
            StreamEvent::Finish(StopReason::EndTurn),
        ]);
        assert_eq!(response.usage.input_tokens, 12);
        assert_eq!(response.usage.output_tokens, 5);
    }
}
