//! Provider boundary: one trait, one streaming event vocabulary, one
//! assembler.
//!
//! Upstream counterpart: `agent/auxiliary_client.py` plus the per-provider
//! adapters (`anthropic_adapter.py`, `gemini_native_adapter.py`,
//! `codex_responses_adapter.py`). The Node runtime splits the same job across
//! `pi-ai`'s adapters and `stream-rules.ts`.
//!
//! Transports are deliberately *not* part of this module yet: a decoder turns
//! bytes into [`StreamEvent`]s, and the HTTP layer that feeds it arrives with
//! the sidecar in phase 2. That keeps the whole kernel testable from fixtures.

pub mod anthropic;
pub mod google;
pub mod http;
pub mod openai;
pub mod responses;
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

/// How much reasoning a provider is asked to do for one request.
///
/// The vocabulary is the host's (`SESSION_THINKING_LEVELS` in
/// `packages/shared`): the renderer picks a value, main stamps it on the prompt,
/// and this enum decides what — if anything — goes on the wire. Keeping the two
/// halves aligned matters more than the enum's own shape, because a level the
/// host can select but the kernel cannot name is a switch that does nothing.
///
/// `Off` and `Omit` are not the same thing to the wire but they are to this
/// kernel: neither asks for reasoning. `Off` means "the user turned thinking
/// off"; `Omit` means "leave the provider's own default alone", which is what a
/// model whose reasoning cannot be described by `reasoning_effort` needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThinkingLevel {
    #[default]
    Off,
    /// The smallest reasoning budget a provider accepts.
    Minimal,
    Low,
    Medium,
    High,
    /// Above `High`, for models that publish an extra tier.
    XHigh,
    Max,
    /// No reasoning field at all: the provider's default applies.
    Omit,
}

impl ThinkingLevel {
    /// The whole host vocabulary, in selection order. A host that offers a level
    /// not in this list is offering a switch the kernel would ignore.
    pub const HOST_LEVELS: [&'static str; 8] = [
        "off", "minimal", "low", "medium", "high", "xhigh", "max", "omit",
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
            Self::Omit => "omit",
        }
    }

    /// Read a level the host sent. An unknown or empty value is `None` so a
    /// caller can keep what it already had instead of silently turning
    /// reasoning off.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value.trim().to_ascii_lowercase().as_str() {
            "off" => Self::Off,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::XHigh,
            "max" => Self::Max,
            "omit" => Self::Omit,
            _ => return None,
        })
    }

    /// The Chat Completions `reasoning_effort` this level asks for.
    ///
    /// `high`, `xhigh` and `max` collapse onto `high`: the field's documented
    /// values stop there, and a provider handed `xhigh` rejects the request
    /// rather than clamping it. `off`/`omit` send nothing at all.
    pub fn reasoning_effort(self) -> Option<&'static str> {
        match self {
            Self::Minimal => Some("minimal"),
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High | Self::XHigh | Self::Max => Some("high"),
            Self::Off | Self::Omit => None,
        }
    }

    /// The Anthropic `thinking.budget_tokens` this level asks for.
    ///
    /// Anthropic's floor is 1024, so `minimal` is the floor rather than a
    /// smaller number the API would refuse. `off`/`omit` send nothing.
    pub fn budget_tokens(self) -> Option<u32> {
        match self {
            Self::Minimal => Some(1024),
            Self::Low => Some(2048),
            Self::Medium => Some(4096),
            Self::High | Self::XHigh | Self::Max => Some(8192),
            Self::Off | Self::Omit => None,
        }
    }
}

/// How long a provider is asked to keep this request's prefix cached.
///
/// The prefix of a turn — the system prompt, the tool declarations, and the
/// conversation so far — is re-sent on every request. A provider that can cache it
/// charges a fraction for the part it has already seen, which is the single
/// largest lever on a long session; `None` is for a one-shot request (a compaction
/// summary, a background review) where writing a cache entry costs more than the
/// request and nobody will read it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheRetention {
    /// The provider's default window (minutes).
    #[default]
    Short,
    /// An extended window, where the provider supports one.
    Long,
    /// No cache breakpoints at all.
    None,
}

impl CacheRetention {
    /// Read the value a caller sends, falling back to `PI_CACHE_RETENTION`.
    pub fn resolve(explicit: Option<&str>, env_value: Option<&str>) -> Self {
        match explicit
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| env_value.map(str::trim).filter(|value| !value.is_empty()))
        {
            Some("none") => Self::None,
            Some("long") => Self::Long,
            _ => Self::Short,
        }
    }

    /// The `cache_control` object a provider expects, if any.
    ///
    /// `None` retention produces no breakpoint rather than `"none"`: a provider
    /// that does not know the field would reject the request outright.
    pub fn breakpoint(self) -> Option<serde_json::Value> {
        match self {
            Self::Short => Some(serde_json::json!({"type": "ephemeral"})),
            Self::Long => Some(serde_json::json!({"type": "ephemeral", "ttl": "1h"})),
            Self::None => None,
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
    pub cache: CacheRetention,
    /// A stable name for this conversation, for providers that route requests by it.
    ///
    /// OpenAI's cache is a prefix cache, but *where* the prefix is cached depends on
    /// which machine the request lands on: two identical requests can miss each
    /// other's cache if they are routed differently. `prompt_cache_key` is the field
    /// that pins them together. It is not content — a session id, not a digest of the
    /// prompt — because the provider only uses it as a routing hint.
    pub cache_key: Option<String>,
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
            cache: CacheRetention::default(),
            cache_key: None,
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

/// A listener on the wire: what one request carries, and what came back.
///
/// The transport builds the payload and sends it; it does not decide what goes
/// in it. Trusted extensions do, through `before_provider_request`, and they
/// see the same payload object the provider would have sent
/// (`withExtensionProviderHooks` in `packages/agent-runtime/src/runtime.ts`
/// rides pi-ai's `onPayload` / `onResponse` the same way).
///
/// Every method has a safe default so a provider without extensions pays
/// nothing and a transport cannot forge an answer.
pub trait WireHooks: Send + Sync {
    /// The payload to send: the hook's replacement, or the original.
    fn before_request<'a>(&'a self, payload: serde_json::Value) -> BoxFuture<'a, serde_json::Value>;

    /// The response arrived, whatever its status.
    fn after_response<'a>(&'a self, status: u16) -> BoxFuture<'a, ()>;
}

#[derive(Debug)]
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
/// Rules carried over from the reference loop and the Node runtime:
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

#[cfg(test)]
mod cache_tests {
    use super::CacheRetention;

    #[test]
    fn retention_falls_back_from_the_caller_to_the_environment_to_short() {
        assert_eq!(
            CacheRetention::resolve(Some("none"), None),
            CacheRetention::None
        );
        assert_eq!(
            CacheRetention::resolve(Some("long"), Some("none")),
            CacheRetention::Long
        );
        assert_eq!(
            CacheRetention::resolve(None, Some("long")),
            CacheRetention::Long
        );
        assert_eq!(
            CacheRetention::resolve(None, Some("  ")),
            CacheRetention::Short
        );
        assert_eq!(CacheRetention::resolve(None, None), CacheRetention::Short);
    }

    #[test]
    fn no_retention_sends_no_breakpoint_at_all() {
        assert!(CacheRetention::None.breakpoint().is_none());
        assert_eq!(
            CacheRetention::Short.breakpoint().unwrap()["type"],
            "ephemeral"
        );
        assert_eq!(CacheRetention::Long.breakpoint().unwrap()["ttl"], "1h");
    }
}

#[cfg(test)]
mod thinking_tests {
    use super::ThinkingLevel;

    /// Every level the host can select must survive a round trip through the
    /// wire spelling. A level that does not is a switch the renderer offers and
    /// the kernel quietly ignores.
    #[test]
    fn every_host_level_round_trips() {
        for name in ThinkingLevel::HOST_LEVELS {
            let level = ThinkingLevel::parse(name).unwrap_or_else(|| panic!("{name} is not a level"));
            assert_eq!(level.as_str(), name);
        }
        assert_eq!(ThinkingLevel::HOST_LEVELS.len(), 8);
    }

    #[test]
    fn an_unknown_or_empty_level_is_not_guessed() {
        for value in ["", "  ", "mediumish", "OFF!", "1"] {
            assert!(
                ThinkingLevel::parse(value).is_none(),
                "{value:?} must not resolve"
            );
        }
        // Case and padding are the caller's, not a different level.
        assert_eq!(ThinkingLevel::parse(" XHigh "), Some(ThinkingLevel::XHigh));
    }

    /// The Chat Completions field stops at `high`; anything above it collapses
    /// rather than being sent as a value the provider would reject.
    #[test]
    fn reasoning_effort_collapses_the_top_tiers_and_sends_nothing_for_off() {
        assert_eq!(ThinkingLevel::Minimal.reasoning_effort(), Some("minimal"));
        assert_eq!(ThinkingLevel::Low.reasoning_effort(), Some("low"));
        assert_eq!(ThinkingLevel::Medium.reasoning_effort(), Some("medium"));
        for level in [
            ThinkingLevel::High,
            ThinkingLevel::XHigh,
            ThinkingLevel::Max,
        ] {
            assert_eq!(level.reasoning_effort(), Some("high"), "{level:?}");
        }
        assert_eq!(ThinkingLevel::Off.reasoning_effort(), None);
        assert_eq!(ThinkingLevel::Omit.reasoning_effort(), None);
    }

    /// Anthropic will not accept a budget below 1024, so the smallest level is
    /// the floor; the tiers grow from there and stop at 8192.
    #[test]
    fn thinking_budgets_are_the_api_floor_and_above() {
        assert_eq!(ThinkingLevel::Minimal.budget_tokens(), Some(1024));
        assert_eq!(ThinkingLevel::Low.budget_tokens(), Some(2048));
        assert_eq!(ThinkingLevel::Medium.budget_tokens(), Some(4096));
        assert_eq!(ThinkingLevel::High.budget_tokens(), Some(8192));
        assert_eq!(ThinkingLevel::XHigh.budget_tokens(), Some(8192));
        assert_eq!(ThinkingLevel::Max.budget_tokens(), Some(8192));
        assert_eq!(ThinkingLevel::Off.budget_tokens(), None);
        assert_eq!(ThinkingLevel::Omit.budget_tokens(), None);
    }

    /// The default is unchanged: a request nobody configured asks for no
    /// reasoning, which is what every caller got before the field was read.
    #[test]
    fn the_default_level_asks_for_nothing() {
        assert_eq!(ThinkingLevel::default(), ThinkingLevel::Off);
        assert_eq!(ThinkingLevel::default().reasoning_effort(), None);
        assert_eq!(ThinkingLevel::default().budget_tokens(), None);
    }
}
