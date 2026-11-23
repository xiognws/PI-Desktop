//! OpenAI **Responses** API (`POST {base}/responses`) adapter.
//!
//! The third wire the desktop can configure (`packages/shared/src/model-catalog.ts`
//! `API_STYLES`: `responses`), and the one OpenAI's own new models answer on. It is
//! the same vendor as [`super::openai`] but a different envelope, so it gets its own
//! body builder and decoder while reusing every shared piece: [`super::sse`] framing,
//! the retry/backoff in `crate::retry`, the timeout and cancel handling in
//! [`super::http`], and the [`StreamEvent`] vocabulary above.
//!
//! # Wire <-> kernel mapping
//!
//! Request (`POST {base}/responses`, bearer `Authorization` header):
//!
//! | Responses field | Kernel source |
//! | --- | --- |
//! | `instructions` (string) | `ChatRequest::system`, with any extra `Role::System` transcript rows folded in — same fold the Anthropic body does |
//! | `input: [{role:"user", content:[{type:"input_text", text}]}]` | `Role::User` text parts |
//! | `input: [{role:"user", content:[{type:"input_image", image_url}]}]` | `ContentPart::Image` (data URL, like the Chat Completions body) |
//! | `input: [{role:"assistant", content:[{type:"output_text", text}]}]` | `Role::Assistant` text |
//! | `input: [{type:"function_call", call_id, name, arguments}]` | `ContentPart::ToolCall` (arguments is a JSON **string**) |
//! | `input: [{type:"function_call_output", call_id, output}]` | `Role::Tool` `ToolResult` |
//! | `tools: [{type:"function", name, description, parameters}]` — flat, *not* `function:{...}` | `ToolSpec` |
//! | `max_output_tokens` | `ChatRequest::max_output_tokens` / `default_max_tokens` |
//! | `temperature` | `ChatRequest::temperature` |
//! | `reasoning: {effort}` (`minimal\|low\|medium\|high`) | `ThinkingLevel::reasoning_effort()` — the same table the Chat Completions body uses, so the two OpenAI wires cannot drift |
//! | `store: false` | not a kernel field: the transcript is replayed in full every turn, so the provider must not keep server-side state |
//!
//! Response (SSE; every frame carries `type`, mirrored in the `event:` name):
//!
//! | Responses event | `StreamEvent` |
//! | --- | --- |
//! | `response.output_text.delta` `{delta}` | `TextDelta` |
//! | `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` | `ThinkingDelta` |
//! | `response.refusal.delta` | `TextDelta` (the refusal is what the user must read) |
//! | `response.output_item.added` / `.done` with `item.type == "function_call"` | `ToolCallStart { id: item.call_id, name }` |
//! | `response.function_call_arguments.delta` `{delta, output_index}` | `ToolCallDelta` |
//! | `response.function_call_arguments.done` `{arguments}` | `ToolCallDelta` only when no delta arrived (gateways that buffer) |
//! | `response.completed` / `response.incomplete` | `Usage` + `Finish` |
//! | `response.failed`, `error` | `AgentError::provider`, message made readable |
//!
//! Usage (`response.completed.response.usage`):
//!
//! | Responses | `Usage` |
//! | --- | --- |
//! | `input_tokens` | `input_tokens` (cached tokens are counted **inside** it, as on Chat Completions) |
//! | `input_tokens_details.cached_tokens` | `cache_read_tokens` |
//! | `output_tokens` | `output_tokens` |
//! | `output_tokens_details.reasoning_tokens` | `reasoning_tokens` |
//! | — | `cache_write_tokens` stays 0: this wire reports no cache writes |
//!
//! # `openai_codex_responses`
//!
//! Same wire, different endpoint and credentials: the ChatGPT subscription backend
//! (`https://chatgpt.com/backend-api/codex/responses`) speaks these events too, but
//! authenticates with an OAuth token plus `chatgpt-account-id`, and rejects request
//! fields this body always sends (`max_output_tokens` and the cache fields among
//! them). So it is *not* reachable by pointing this adapter at a different
//! `base_url`: it needs a documented source for the account id header and a
//! verified omit-list, and there is no subscription credential on this host to
//! verify either against. It stays unimplemented and loudly rejected by the wire
//! selector — see `API_STYLES_NOT_MIGRATED` in `sidecar.rs`.
//!
//! # What this wire does not carry
//!
//! * `prompt_cache_key` / `prompt_cache_retention` on anything but OpenAI's own API.
//!   Responses caches on its own, and these two knobs are the only way to steer it —
//!   but they are provider-specific and a compatible gateway may reject an unknown
//!   field, so they are sent to `*.openai.com` only (see `caches_by_key`). Extended
//!   retention (`CacheRetention::Long`) becomes `24h`; the default window is left
//!   unstated so the provider's own default stands.
//! * Reasoning items on replay. The kernel keeps thinking text, not the encrypted
//!   `reasoning` item the API wants back, so prior thinking is not re-sent.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::http::HttpProviderConfig;
use super::CacheRetention;
use super::sse::SseFramer;
use super::StreamEvent;
use crate::error::{AgentError, ProviderErrorKind, Result};
use crate::message::{ContentPart, Role, StopReason, Usage};
use super::ChatRequest;

/// Build the request body for one turn.
pub fn responses_body(config: &HttpProviderConfig, request: &ChatRequest) -> Value {
    let mut input: Vec<Value> = Vec::new();
    let mut instructions = super::http::effective_system(request);

    for message in &request.messages {
        match message.role {
            Role::System => {
                // The Responses envelope has one instruction string, so extra
                // system rows join it instead of becoming input items.
                let text = message.text();
                if !text.is_empty() {
                    instructions = Some(match instructions {
                        Some(existing) => format!("{existing}\n\n{text}"),
                        None => text,
                    });
                }
            }
            Role::User => {
                if message.has_tool_traffic() {
                    // Tool results travel as their own top-level items, never
                    // inside a user message.
                    for result in message.tool_results() {
                        input.push(json!({
                            "type": "function_call_output",
                            "call_id": result.call_id,
                            "output": result.content,
                        }));
                    }
                    continue;
                }
                let content: Vec<Value> = message
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text { text } if !text.is_empty() => {
                            Some(json!({"type": "input_text", "text": text}))
                        }
                        ContentPart::Image { mime_type, data } => Some(json!({
                            "type": "input_image",
                            "detail": "auto",
                            "image_url": format!("data:{mime_type};base64,{data}"),
                        })),
                        _ => None,
                    })
                    .collect();
                if !content.is_empty() {
                    input.push(json!({"role": "user", "content": content}));
                }
            }
            Role::Assistant => {
                if !message.text().is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": message.text()}],
                    }));
                }
                for call in message.tool_calls() {
                    // The API pairs a call with its output by `call_id`; the item
                    // `id` (`fc_…`) is optional on replay and this kernel does not
                    // keep it, so it is left out rather than invented.
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call
                            .raw_arguments
                            .clone()
                            .unwrap_or_else(|| call.arguments.to_string()),
                    }));
                }
            }
            Role::Tool => {
                for result in message.tool_results() {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": result.call_id,
                        "output": result.content,
                    }));
                }
            }
        }
    }

    let mut body = json!({
        "model": request.model,
        "input": input,
        "stream": true,
        "store": false,
        "max_output_tokens": request.max_output_tokens.unwrap_or(config.default_max_tokens),
    });
    if let Some(instructions) = instructions {
        body["instructions"] = json!(instructions);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    // Same switch, same table as the Chat Completions body: `off`/`omit` add no
    // field, so the provider's own default stands.
    if let Some(effort) = request.thinking.reasoning_effort() {
        body["reasoning"] = json!({"effort": effort});
    }
    // Cache routing and window. Same gate as the Chat Completions body: documented
    // on OpenAI's own API, omitted everywhere else, and omitted entirely when the
    // caller asked for no cache at all.
    if config.caches_by_key() && request.cache != CacheRetention::None {
        if let Some(key) = request.cache_key.as_deref().filter(|key| !key.is_empty()) {
            body["prompt_cache_key"] = json!(key);
        }
        if request.cache == CacheRetention::Long {
            body["prompt_cache_retention"] = json!("24h");
        }
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
}

/// Incremental Responses decoder: SSE bytes in, [`StreamEvent`]s out.
#[derive(Debug, Default)]
pub struct ResponsesStreamDecoder {
    framer: SseFramer,
    /// `output_index` -> tool-call slot. The API indexes output items (messages,
    /// reasoning, calls) in one list, while the assembler numbers calls alone.
    tool_slots: HashMap<usize, usize>,
    next_slot: usize,
    /// Slots that already received argument text, so a later
    /// `function_call_arguments.done` or item replay cannot append it twice.
    args_seen: HashSet<usize>,
    /// Call ids already announced, for the same reason.
    calls_seen: HashSet<String>,
    text_seen: bool,
    finished: bool,
}

impl ResponsesStreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Result<Vec<StreamEvent>> {
        let mut events = Vec::new();
        for frame in self.framer.push_chunk(chunk) {
            let data = frame.data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                // The public API ends at `response.completed`; a compatible
                // gateway may still send the Chat Completions sentinel.
                self.finish_once(StopReason::EndTurn, &mut events);
                continue;
            }
            let value: Value = serde_json::from_str(data).map_err(|error| {
                AgentError::provider(
                    ProviderErrorKind::Protocol,
                    format!("responses frame is not JSON: {error}"),
                )
            })?;
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(frame.event.clone())
                .unwrap_or_default();
            self.decode(&kind, &value, &mut events)?;
        }
        Ok(events)
    }

    fn decode(&mut self, kind: &str, value: &Value, events: &mut Vec<StreamEvent>) -> Result<()> {
        match kind {
            "response.output_text.delta" | "response.refusal.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        self.text_seen = true;
                        events.push(StreamEvent::TextDelta(delta.to_string()));
                    }
                }
            }
            "response.output_text.done" => {
                // Some gateways buffer the text and only report it here.
                if !self.text_seen {
                    if let Some(text) = value.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            self.text_seen = true;
                            events.push(StreamEvent::TextDelta(text.to_string()));
                        }
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        events.push(StreamEvent::ThinkingDelta(delta.to_string()));
                    }
                }
            }
            "response.output_item.added" | "response.output_item.done" => {
                let done = kind.ends_with(".done");
                self.output_item(value, done, events);
            }
            "response.function_call_arguments.delta" => {
                let output_index = output_index(value);
                let slot = self.slot_for(output_index);
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        self.args_seen.insert(slot);
                        events.push(StreamEvent::ToolCallDelta {
                            index: slot,
                            arguments_delta: delta.to_string(),
                        });
                    }
                }
            }
            "response.function_call_arguments.done" => {
                let output_index = output_index(value);
                let slot = self.slot_for(output_index);
                if !self.args_seen.contains(&slot) {
                    if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
                        if !arguments.is_empty() {
                            self.args_seen.insert(slot);
                            events.push(StreamEvent::ToolCallDelta {
                                index: slot,
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = value.get("response").cloned().unwrap_or(Value::Null);
                if let Some(usage) = response.get("usage").and_then(parse_usage) {
                    events.push(StreamEvent::Usage(usage));
                }
                // A gateway that streams no deltas at all still describes the
                // finished turn here; replay it so the turn is not empty.
                self.replay_output(&response, events);
                let reason = map_status(&response);
                self.finish_once(reason, events);
            }
            "response.failed" => {
                let error = value
                    .get("response")
                    .and_then(|response| response.get("error"))
                    .cloned()
                    .unwrap_or(Value::Null);
                return Err(stream_error(&error));
            }
            "error" => {
                let error = value.get("error").cloned().unwrap_or_else(|| value.clone());
                return Err(stream_error(&error));
            }
            // `response.created`, `response.in_progress`, keep-alives and
            // forward-compatible events carry nothing the loop needs.
            _ => {}
        }
        Ok(())
    }

    fn output_item(&mut self, value: &Value, done: bool, events: &mut Vec<StreamEvent>) {
        let item = value.get("item").cloned().unwrap_or(Value::Null);
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let slot = self.slot_for(output_index(value));
        // The id the result must quote back is `call_id`; `item.id` is the
        // provider's own handle for the item, which this kernel does not replay.
        let id = item
            .get("call_id")
            .and_then(Value::as_str)
            .or_else(|| item.get("id").and_then(Value::as_str))
            .unwrap_or("");
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if !id.is_empty() {
            self.calls_seen.insert(id.to_string());
        }
        if done || !id.is_empty() || !name.is_empty() {
            events.push(StreamEvent::ToolCallStart {
                index: slot,
                id: id.to_string(),
                name: name.to_string(),
            });
        }
        if done && !self.args_seen.contains(&slot) {
            if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                if !arguments.is_empty() {
                    self.args_seen.insert(slot);
                    events.push(StreamEvent::ToolCallDelta {
                        index: slot,
                        arguments_delta: arguments.to_string(),
                    });
                }
            }
        }
    }

    /// Emit whatever the terminal `response` object says the turn produced but the
    /// stream never delivered as a delta.
    fn replay_output(&mut self, response: &Value, events: &mut Vec<StreamEvent>) {
        let Some(output) = response.get("output").and_then(Value::as_array) else {
            return;
        };
        for (position, item) in output.iter().enumerate() {
            match item.get("type").and_then(Value::as_str) {
                Some("function_call") => {
                    let id = item
                        .get("call_id")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("id").and_then(Value::as_str))
                        .unwrap_or("");
                    if !id.is_empty() && self.calls_seen.contains(id) {
                        continue;
                    }
                    let slot = self.slot_for(position);
                    if !id.is_empty() {
                        self.calls_seen.insert(id.to_string());
                    }
                    events.push(StreamEvent::ToolCallStart {
                        index: slot,
                        id: id.to_string(),
                        name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    });
                    if !self.args_seen.contains(&slot) {
                        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                            if !arguments.is_empty() {
                                self.args_seen.insert(slot);
                                events.push(StreamEvent::ToolCallDelta {
                                    index: slot,
                                    arguments_delta: arguments.to_string(),
                                });
                            }
                        }
                    }
                }
                Some("message") if !self.text_seen => {
                    let text: String = item
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|parts| {
                            parts
                                .iter()
                                .filter(|part| {
                                    part.get("type").and_then(Value::as_str)
                                        == Some("output_text")
                                })
                                .filter_map(|part| part.get("text").and_then(Value::as_str))
                                .collect::<String>()
                        })
                        .unwrap_or_default();
                    if !text.is_empty() {
                        self.text_seen = true;
                        events.push(StreamEvent::TextDelta(text));
                    }
                }
                _ => {}
            }
        }
    }

    fn finish_once(&mut self, reason: StopReason, events: &mut Vec<StreamEvent>) {
        if !self.finished {
            self.finished = true;
            events.push(StreamEvent::Finish(reason));
        }
    }

    fn slot_for(&mut self, output_index: usize) -> usize {
        if let Some(slot) = self.tool_slots.get(&output_index) {
            return *slot;
        }
        let slot = self.next_slot;
        self.next_slot += 1;
        self.tool_slots.insert(output_index, slot);
        slot
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }
}

fn output_index(value: &Value) -> usize {
    value
        .get("output_index")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

/// `status` plus `incomplete_details.reason`. A completed response that carried
/// tool calls is reported as `EndTurn` here; the assembler raises it to `ToolUse`
/// because the calls must still run.
fn map_status(response: &Value) -> StopReason {
    let status = response.get("status").and_then(Value::as_str).unwrap_or("");
    let reason = response
        .get("incomplete_details")
        .and_then(|details| details.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match reason {
        "max_output_tokens" => StopReason::MaxOutputTokens,
        "content_filter" => StopReason::ContentFilter,
        "" if status == "completed" => StopReason::EndTurn,
        "" => StopReason::EndTurn,
        other => StopReason::Other(other.to_string()),
    }
}

/// OpenAI counts cached tokens inside `input_tokens`, so the cached slice is
/// subtracted here and reported separately: every reader of `Usage` adds the three
/// input numbers together, which is only correct when they are disjoint. Chat
/// Completions gets the same treatment.
fn parse_usage(value: &Value) -> Option<Usage> {
    let input = value
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = value
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    let cached = value
        .get("input_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(Usage {
        input_tokens: input.saturating_sub(cached),
        output_tokens: output,
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        reasoning_tokens: value
            .get("output_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

/// Turn an upstream error object into a sentence a person can act on.
///
/// Gateways nest the provider's own body inside `error.message` as a JSON string
/// (measured against the local gateway, whose `/v1/responses` answers
/// `response.failed` with `{"message":"{\"error\":{\"code\":11102,…}}"}`), so the
/// message is unwrapped when it is JSON, and the code is kept when there is one.
fn stream_error(error: &Value) -> AgentError {
    let (message, code) = readable_error(error, 0);
    let text = match (message, code.as_deref()) {
        (Some(message), Some(code)) => format!("{message} (code {code})"),
        (Some(message), None) => message,
        (None, Some(code)) => format!("provider reported an error (code {code})"),
        (None, None) => "provider reported an error".to_string(),
    };
    let kind = match code.as_deref() {
        Some("rate_limit_exceeded" | "server_error" | "overloaded_error" | "api_error") => {
            ProviderErrorKind::Retryable
        }
        _ => ProviderErrorKind::Fatal,
    };
    AgentError::provider(kind, text)
}

/// Depth-limited unwrap: `error.message` may itself be a whole error body.
fn readable_error(value: &Value, depth: usize) -> (Option<String>, Option<String>) {
    let Some(object) = value.as_object() else {
        if let Some(text) = value.as_str() {
            return (Some(text.to_string()), None);
        }
        return (None, None);
    };
    let code = object.get("code").or_else(|| object.get("type")).and_then(|code| match code {
        Value::String(code) => Some(code.clone()),
        Value::Number(code) => Some(code.to_string()),
        _ => None,
    });
    let message = object
        .get("message")
        .or_else(|| object.get("msg"))
        .and_then(Value::as_str);
    if let Some(message) = message {
        let trimmed = message.trim();
        if depth < 3 && trimmed.starts_with('{') {
            if let Ok(nested) = serde_json::from_str::<Value>(trimmed) {
                let (nested_message, nested_code) = readable_error(&nested, depth + 1);
                return (nested_message, code.or(nested_code));
            }
        }
        return (Some(trimmed.to_string()), code);
    }
    // An envelope that only nests the real error one level down.
    for key in ["error", "detail"] {
        if let Some(inner) = object.get(key) {
            let (message, inner_code) = readable_error(inner, depth + 1);
            if message.is_some() {
                return (message, code.or(inner_code));
            }
        }
    }
    (None, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Message, ToolCall, ToolResult};
    use crate::provider::ThinkingLevel;
    use crate::tool::ToolSpec;

    fn config() -> HttpProviderConfig {
        HttpProviderConfig {
            default_max_tokens: 4096,
            ..HttpProviderConfig::openai_responses("oai", "https://api.example.test/v1", "sk-secret")
        }
    }

    /// Extended retention becomes `24h`, the default window is left unstated, and a
    /// gateway hears neither field.
    #[test]
    fn cache_steering_is_sent_only_where_it_is_documented() {
        let mut request = ChatRequest::new("gpt-5", vec![Message::user_text("hi")]);
        request.cache_key = Some("session-1".into());

        let openai = HttpProviderConfig {
            default_max_tokens: 4096,
            ..HttpProviderConfig::openai_responses("oai", "https://api.openai.com/v1", "sk")
        };
        let body = responses_body(&openai, &request);
        assert_eq!(body["prompt_cache_key"], "session-1");
        // Short retention states nothing: the provider's default window stands.
        assert!(body.get("prompt_cache_retention").is_none());

        request.cache = CacheRetention::Long;
        assert_eq!(
            responses_body(&openai, &request)["prompt_cache_retention"],
            "24h"
        );

        let gateway = config();
        let body = responses_body(&gateway, &request);
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none());

        request.cache = CacheRetention::None;
        assert!(responses_body(&openai, &request)
            .get("prompt_cache_key")
            .is_none());
    }

    fn decode(raw: &str) -> Vec<StreamEvent> {
        let mut decoder = ResponsesStreamDecoder::new();
        decoder.push_chunk(raw).expect("fixture must decode")
    }

    fn event(name: &str, data: &str) -> String {
        format!("event: {name}\ndata: {data}\n\n")
    }

    #[test]
    fn text_streams_from_deltas_and_completes_with_usage() {
        let raw = [
            event(
                "response.created",
                r#"{"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}"#,
            ),
            event(
                "response.output_item.added",
                r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant"}}"#,
            ),
            event(
                "response.output_text.delta",
                r#"{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hel"}"#,
            ),
            event(
                "response.output_text.delta",
                r#"{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"lo"}"#,
            ),
            event(
                "response.output_text.done",
                r#"{"type":"response.output_text.done","output_index":0,"text":"Hello"}"#,
            ),
            event(
                "response.completed",
                r#"{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":3},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":18}}}"#,
            ),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat();

        let events = decode(&raw);
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::TextDelta(text) => Some(text.clone()),
                _ => None,
            })
            .collect();
        // The `done` frame must not append the text a second time.
        assert_eq!(text, "Hello");
        assert!(events.contains(&StreamEvent::Usage(Usage {
            input_tokens: 8,
            // Disjoint parts of one 11-token prompt.
            output_tokens: 7,
            cache_read_tokens: 3,
            cache_write_tokens: 0,
            reasoning_tokens: 2,
        })));
        assert!(events.contains(&StreamEvent::Finish(StopReason::EndTurn)));
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::Finish(_)))
                .count(),
            1,
            "[DONE] after response.completed must not add a second finish"
        );
    }

    #[test]
    fn a_tool_call_is_announced_once_and_its_arguments_reassemble() {
        let raw = [
            event(
                "response.output_item.added",
                r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":""}}"#,
            ),
            event(
                "response.function_call_arguments.delta",
                r#"{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"path\":"}"#,
            ),
            event(
                "response.function_call_arguments.delta",
                r#"{"type":"response.function_call_arguments.delta","output_index":0,"delta":"\"a.txt\"}"}"#,
            ),
            event(
                "response.function_call_arguments.done",
                r#"{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"path\":\"a.txt\"}"}"#,
            ),
            event(
                "response.output_item.done",
                r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}"#,
            ),
            event(
                "response.completed",
                r#"{"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}],"usage":{"input_tokens":9,"output_tokens":4}}}"#,
            ),
        ]
        .concat();

        let mut assembler = crate::provider::ResponseAssembler::new();
        for event in decode(&raw) {
            assembler.push(event).unwrap();
        }
        let response = assembler.finish().expect("a finished turn");
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        let calls = response.message.tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, json!({"path": "a.txt"}));
        assert!(calls[0].raw_arguments.is_none());
    }

    #[test]
    fn argument_done_only_gateways_still_yield_parsable_arguments() {
        // No `.delta` frames: the arguments exist only on `.done`.
        let raw = [
            event(
                "response.output_item.added",
                r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_9","name":"list_files"}}"#,
            ),
            event(
                "response.function_call_arguments.done",
                r#"{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"dir\":\"src\"}"}"#,
            ),
            event(
                "response.completed",
                r#"{"type":"response.completed","response":{"status":"completed","output":[]}}"#,
            ),
        ]
        .concat();
        let mut assembler = crate::provider::ResponseAssembler::new();
        for event in decode(&raw) {
            assembler.push(event).unwrap();
        }
        let response = assembler.finish().unwrap();
        assert_eq!(
            response.message.tool_calls()[0].arguments,
            json!({"dir": "src"})
        );
    }

    #[test]
    fn a_gateway_that_only_sends_completed_still_produces_the_turn() {
        let raw = event(
            "response.completed",
            r#"{"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]},{"type":"function_call","call_id":"call_2","name":"read_file","arguments":"{\"path\":\"b.txt\"}"}],"usage":{"input_tokens":4,"output_tokens":2}}}"#,
        );
        let mut assembler = crate::provider::ResponseAssembler::new();
        for event in decode(&raw) {
            assembler.push(event).unwrap();
        }
        let response = assembler.finish().unwrap();
        assert_eq!(response.message.text(), "done");
        assert_eq!(response.message.tool_calls()[0].id, "call_2");
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        assert_eq!(response.usage.input_tokens, 4);
    }

    #[test]
    fn reasoning_deltas_become_thinking() {
        let raw = [
            event(
                "response.reasoning_summary_text.delta",
                r#"{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"weigh "}"#,
            ),
            event(
                "response.reasoning_text.delta",
                r#"{"type":"response.reasoning_text.delta","output_index":0,"delta":"options"}"#,
            ),
            event(
                "response.completed",
                r#"{"type":"response.completed","response":{"status":"completed","output":[]}}"#,
            ),
        ]
        .concat();
        let events = decode(&raw);
        assert!(events.contains(&StreamEvent::ThinkingDelta("weigh ".into())));
        assert!(events.contains(&StreamEvent::ThinkingDelta("options".into())));
    }

    #[test]
    fn incomplete_max_output_tokens_is_its_own_stop_reason() {
        let raw = event(
            "response.incomplete",
            r#"{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}"#,
        );
        assert_eq!(
            decode(&raw),
            vec![StreamEvent::Finish(StopReason::MaxOutputTokens)]
        );
        assert_eq!(map_status(&json!({"status": "completed"})), StopReason::EndTurn);
        assert_eq!(
            map_status(&json!({"status":"incomplete","incomplete_details":{"reason":"content_filter"}})),
            StopReason::ContentFilter
        );
    }

    #[test]
    fn a_failed_response_surfaces_the_providers_own_sentence() {
        // Measured shape: the gateway nests the upstream body as a JSON string.
        let raw = event(
            "response.failed",
            r#"{"type":"response.failed","response":{"status":"failed","error":{"message":"{\"error\":{\"message\":\"model [nope] service info not found\",\"code\":11102}}"}}}"#,
        );
        let mut decoder = ResponsesStreamDecoder::new();
        let error = decoder.push_chunk(&raw).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("model [nope] service info not found"), "{text}");
        assert!(text.contains("11102"), "{text}");
        assert!(!text.contains("\\\""), "the envelope must be unwrapped: {text}");
        assert_eq!(error.code(), "PROVIDER_ERROR");
    }

    #[test]
    fn a_top_level_error_frame_is_retryable_when_it_says_so() {
        let raw = event(
            "error",
            r#"{"type":"error","error":{"type":"rate_limit_exceeded","message":"slow down"}}"#,
        );
        let mut decoder = ResponsesStreamDecoder::new();
        let error = decoder.push_chunk(&raw).unwrap_err();
        assert!(error.is_retryable());
        assert!(error.to_string().contains("slow down"));
    }

    #[test]
    fn invalid_json_is_a_protocol_error_not_a_panic() {
        let mut decoder = ResponsesStreamDecoder::new();
        let error = decoder.push_chunk("data: {not json}\n\n").unwrap_err();
        assert_eq!(error.code(), "PROVIDER_ERROR");
    }

    #[test]
    fn the_body_uses_input_items_and_flat_tool_declarations() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("looking");
        assistant.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: json!({"path": "a.txt"}),
            raw_arguments: None,
        });
        let mut request = ChatRequest::new(
            "gpt-5",
            vec![
                Message::user_text("read a.txt"),
                assistant,
                Message::tool_result(ToolResult {
                    call_id: "call_1".into(),
                    name: "read_file".into(),
                    content: "file body".into(),
                    is_error: false,
                    truncated: false,
                }),
            ],
        );
        request.system = Some("you are terse".into());
        request.tools = vec![ToolSpec::new(
            "read_file",
            "Read a file",
            json!({"type": "object"}),
        )];

        let body = responses_body(&config(), &request);
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert_eq!(body["instructions"], "you are terse");
        assert_eq!(body["max_output_tokens"], 4096);
        // `messages` must not appear: this wire has no such field.
        assert!(body.get("messages").is_none(), "sent: {body}");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][1]["content"][0]["type"], "output_text");
        assert_eq!(body["input"][2]["type"], "function_call");
        assert_eq!(body["input"][2]["call_id"], "call_1");
        assert_eq!(body["input"][2]["arguments"], "{\"path\":\"a.txt\"}");
        assert_eq!(body["input"][3]["type"], "function_call_output");
        assert_eq!(body["input"][3]["call_id"], "call_1");
        assert_eq!(body["input"][3]["output"], "file body");
        // Flat declaration: `function: {...}` is the Chat Completions shape.
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "read_file");
        assert_eq!(body["tools"][0]["parameters"]["type"], "object");
        assert!(body["tools"][0].get("function").is_none(), "sent: {body}");
    }

    #[test]
    fn extra_system_rows_join_the_instructions_string() {
        let mut extra = Message::new(Role::System);
        extra.push_text("second rule");
        let request = ChatRequest::new(
            "gpt-5",
            vec![Message::user_text("hi"), extra],
        );
        let body = responses_body(&config(), &request);
        // A system row in the transcript is still a system prompt: it becomes the
        // instruction string even when the caller set none.
        assert_eq!(body["instructions"], "second rule");
        assert_eq!(
            body["input"]
                .as_array()
                .expect("input")
                .iter()
                .filter(|item| item["role"] == json!("system"))
                .count(),
            0,
            "system rows must never become input items: {body}"
        );

        let mut request = request;
        request.system = Some("first rule".into());
        let body = responses_body(&config(), &request);
        assert_eq!(body["instructions"], "first rule\n\nsecond rule");
    }

    #[test]
    fn an_image_travels_as_an_input_image_data_url() {
        let mut message = Message::user_text("what colour is this");
        message.parts.push(ContentPart::Image {
            mime_type: "image/png".into(),
            data: "QUJD".into(),
        });
        let request = ChatRequest::new("gpt-5", vec![message]);
        let body = responses_body(&config(), &request);
        let content = &body["input"][0]["content"];
        assert_eq!(content[0]["type"], "input_text");
        assert_eq!(content[1]["type"], "input_image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,QUJD");
    }

    #[test]
    fn the_reasoning_switch_reuses_the_chat_completions_effort_table() {
        for (level, expected) in [
            (ThinkingLevel::Minimal, Some("minimal")),
            (ThinkingLevel::Low, Some("low")),
            (ThinkingLevel::Medium, Some("medium")),
            (ThinkingLevel::High, Some("high")),
            (ThinkingLevel::XHigh, Some("high")),
            (ThinkingLevel::Max, Some("high")),
            (ThinkingLevel::Off, None),
            (ThinkingLevel::Omit, None),
        ] {
            let mut request = ChatRequest::new("gpt-5", vec![Message::user_text("hi")]);
            request.thinking = level;
            let body = responses_body(&config(), &request);
            assert_eq!(
                body.get("reasoning").and_then(|reasoning| reasoning.get("effort")).and_then(Value::as_str),
                expected,
                "{level:?}: {body}"
            );
        }
    }

    #[test]
    fn an_empty_assistant_turn_sends_no_item() {
        let request = ChatRequest::new(
            "gpt-5",
            vec![Message::user_text("hi"), Message::new(Role::Assistant)],
        );
        let body = responses_body(&config(), &request);
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
    }
}
