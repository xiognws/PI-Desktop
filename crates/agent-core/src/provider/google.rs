//! Google **Gemini** native wire adapter (`generateContent` /
//! `streamGenerateContent`).
//!
//! The fourth wire the desktop can configure (`packages/shared`
//! `API_STYLES`: `google_generative_ai`) and the one the Node runtime binds to
//! pi-ai's `google-generative-ai` API (`packages/agent-runtime/src/provider-binding.ts`,
//! default base `https://generativelanguage.googleapis.com/v1beta`). It shares
//! nothing with the OpenAI envelope, so it gets its own body builder and
//! decoder while reusing every shared piece: [`super::sse`] framing, the
//! retry/backoff in `crate::retry`, the timeout and cancel handling in
//! [`super::http`], and the [`StreamEvent`] vocabulary above.
//!
//! # Wire <-> kernel mapping
//!
//! Request: `POST {base}/models/{model}:streamGenerateContent?alt=sse`, with the
//! key in an `x-goog-api-key` header.
//!
//! | Gemini field | Kernel source |
//! | --- | --- |
//! | `contents: [{role:"user"\|"model", parts:[…]}]` | the transcript; **assistant is `"model"`** |
//! | `parts: [{text}]` | `ContentPart::Text` |
//! | `parts: [{inlineData:{mimeType,data}}]` | `ContentPart::Image` |
//! | `parts: [{functionCall:{name,args,id?}}]` | `ContentPart::ToolCall` — `args` is an **object**, not a JSON string |
//! | `parts: [{functionResponse:{name,response:{output\|error},id?}}]` on a `user` turn | `Role::Tool` `ToolResult` |
//! | `systemInstruction: {parts:[{text}]}` | `ChatRequest::system`, with extra `Role::System` rows folded in — the same fold the Anthropic and Responses bodies do |
//! | `generationConfig.maxOutputTokens` | `ChatRequest::max_output_tokens` / `default_max_tokens` |
//! | `generationConfig.temperature` | `ChatRequest::temperature` |
//! | `generationConfig.thinkingConfig.{thinkingLevel\|thinkingBudget}` | `ThinkingLevel` (see below) |
//! | `tools: [{functionDeclarations:[{name,description,parametersJsonSchema}]}]` | `ToolSpec` |
//!
//! Response (SSE; every frame is a whole `GenerateContentResponse`, no `event:`
//! name):
//!
//! | Gemini field | `StreamEvent` |
//! | --- | --- |
//! | `candidates[0].content.parts[].text` | `TextDelta` |
//! | `candidates[0].content.parts[].text` with `thought: true` | `ThinkingDelta` |
//! | `candidates[0].content.parts[].functionCall` | `ToolCallStart` + `ToolCallDelta` |
//! | `candidates[0].finishReason` | `Finish` |
//! | `usageMetadata` | `Usage`, emitted **once** (the counts are cumulative per chunk, so the last frame wins instead of being summed) |
//! | `promptFeedback.blockReason` | `Finish(ContentFilter)` — a blocked prompt has no candidate at all |
//! | `{error:{code,message,status}}` | `AgentError::provider`, message made readable |
//!
//! Usage (`usageMetadata`):
//!
//! | Gemini | `Usage` |
//! | --- | --- |
//! | `promptTokenCount` | `input_tokens` — the cached slice is counted **inside** it, as on both OpenAI wires |
//! | `cachedContentTokenCount` | `cache_read_tokens` |
//! | `candidatesTokenCount` + `thoughtsTokenCount` | `output_tokens` — thinking is spent out of the same answer budget, as on Anthropic |
//! | `thoughtsTokenCount` | `reasoning_tokens` |
//! | — | `cache_write_tokens` stays 0: this wire reports no cache writes |
//!
//! pi-ai subtracts the cached slice from `input` instead. The kernel keeps it
//! whole so `Usage` means the same thing on every wire; only one of the two
//! readings can be right, and consistency is what the transcript compares.
//!
//! # Tool calls have no id
//!
//! `functionCall` carries a name and arguments and, on older models, no id at
//! all — so the pairing with its result is **by name**, which is why
//! `functionResponse.name` must be the name of the call that asked for it and
//! not a guess. This adapter therefore:
//!
//! * generates a stable id (`call_<uuid>`) for every call the API leaves
//!   unnamed, so the transcript can pair a result with its call;
//! * remembers `id -> name` for the calls it replayed and uses it when a
//!   `ToolResult` arrives without a name;
//! * sends `functionCall.id` / `functionResponse.id` **only** for models that
//!   require them (`claude-*`, `gpt-oss-*`, Gemini 3 and later — pi-ai's
//!   `requiresToolCallId`). Protobuf-JSON parsing rejects unknown fields, so an
//!   `id` on a Gemini 2.5 model would fail the request outright.
//!
//! # What this wire does not carry
//!
//! * Prompt-cache breakpoints. Gemini caches implicitly and an explicit
//!   `cachedContents` resource is a separate API call, so `ChatRequest::cache`
//!   is ignored here rather than guessed at.
//! * Thought signatures on replay. The kernel keeps the thinking *text*, not the
//!   encrypted `thoughtSignature` that preserves the reasoning chain, so prior
//!   thinking is not re-sent (a signature-less `thought: true` part is what
//!   breaks Gemini 3 tool turns).
//! * `toolConfig.functionCallingConfig`. The kernel decides at the loop level
//!   which tools exist; it never asks for a forced or forbidden call.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::http::HttpProviderConfig;
use super::sse::SseFramer;
use super::{ChatRequest, StreamEvent, ThinkingLevel};
use crate::error::{AgentError, ProviderErrorKind, Result};
use crate::message::{ContentPart, Role, StopReason, Usage};

/// The hosted endpoint every row starts from, for callers that build a config
/// without the host's default (`provider-binding.ts` uses the same string).
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Build the request body for one turn.
///
/// The model is **not** in the body: Gemini takes it in the path
/// (`/models/{model}:streamGenerateContent`).
pub fn google_body(config: &HttpProviderConfig, request: &ChatRequest) -> Value {
    let mut contents: Vec<Value> = Vec::new();
    let mut system = super::http::effective_system(request);
    let requires_id = requires_tool_call_id(&request.model);
    // `id -> name` for every call this body replays, so a result that lost its
    // name still gets a `functionResponse` the API can pair.
    let mut call_names: HashMap<String, String> = HashMap::new();

    for message in &request.messages {
        match message.role {
            Role::System => {
                // Gemini has one system instruction; extra transcript rows join it
                // instead of becoming turns in the conversation.
                let text = message.text();
                if !text.is_empty() {
                    system = Some(match system {
                        Some(existing) => format!("{existing}\n\n{text}"),
                        None => text,
                    });
                }
            }
            Role::User => {
                if message.has_tool_traffic() {
                    // Results travel as `functionResponse` parts on a user turn,
                    // merged into a trailing one because Gemini expects all of
                    // them together.
                    for result in message.tool_results() {
                        let name = resolve_result_name(result, &call_names);
                        push_function_response(
                            &mut contents,
                            function_response(&name, result, requires_id),
                        );
                    }
                    continue;
                }
                let parts = user_parts(message);
                if !parts.is_empty() {
                    contents.push(json!({ "role": "user", "parts": parts }));
                }
            }
            Role::Assistant => {
                let mut parts: Vec<Value> = Vec::new();
                let text = message.text();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                for call in message.tool_calls() {
                    call_names.insert(call.id.clone(), call.name.clone());
                    let mut function_call = json!({
                        "name": call.name,
                        "args": call.arguments,
                    });
                    if requires_id {
                        function_call["id"] = json!(call.id);
                    }
                    parts.push(json!({ "functionCall": function_call }));
                }
                // Thinking blocks are deliberately not replayed: without the
                // `thoughtSignature` this kernel does not keep, they cost tokens
                // and can end a Gemini 3 turn early.
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            Role::Tool => {
                for result in message.tool_results() {
                    let name = resolve_result_name(result, &call_names);
                    push_function_response(
                        &mut contents,
                        function_response(&name, result, requires_id),
                    );
                }
            }
        }
    }

    let mut generation = Map::new();
    generation.insert(
        "maxOutputTokens".into(),
        json!(request
            .max_output_tokens
            .unwrap_or(config.default_max_tokens)),
    );
    if let Some(temperature) = request.temperature {
        generation.insert("temperature".into(), json!(temperature));
    }
    if let Some(thinking) = thinking_config(&request.model, request.thinking) {
        generation.insert("thinkingConfig".into(), thinking);
    }

    let mut body = json!({
        "contents": contents,
        "generationConfig": Value::Object(generation),
    });
    if let Some(system) = system {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    if !request.tools.is_empty() {
        let declarations: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    // Full JSON Schema is what pi-ai sends for this API
                    // (`parametersJsonSchema`); the legacy `parameters` field is
                    // the OpenAPI 3.03 subset and drops `anyOf`/`oneOf`.
                    "parametersJsonSchema": tool.parameters,
                })
            })
            .collect();
        body["tools"] = json!([{ "functionDeclarations": declarations }]);
    }
    body
}

fn user_parts(message: &crate::message::Message) -> Vec<Value> {
    let mut parts = Vec::new();
    for part in &message.parts {
        match part {
            ContentPart::Text { text } if !text.is_empty() => parts.push(json!({ "text": text })),
            ContentPart::Image { mime_type, data } => parts.push(json!({
                "inlineData": { "mimeType": mime_type, "data": data },
            })),
            _ => {}
        }
    }
    parts
}

/// The name a `functionResponse` must quote: the result's own, or the one the
/// call that asked for it carried.
fn resolve_result_name(
    result: &crate::message::ToolResult,
    call_names: &HashMap<String, String>,
) -> String {
    if !result.name.is_empty() {
        return result.name.clone();
    }
    call_names.get(&result.call_id).cloned().unwrap_or_default()
}

fn function_response(name: &str, result: &crate::message::ToolResult, requires_id: bool) -> Value {
    // `output` for a success and `error` for a failure is the shape the SDK
    // documents; anything else and the model reads a bare string as a result.
    let response = if result.is_error {
        json!({ "error": result.content })
    } else {
        json!({ "output": result.content })
    };
    let mut function_response = json!({ "name": name, "response": response });
    if requires_id {
        function_response["id"] = json!(result.call_id);
    }
    json!({ "functionResponse": function_response })
}

/// Append a `functionResponse` part, merging it into a trailing user turn that
/// already holds one.
///
/// The kernel stores one `Role::Tool` row per result, so without this merge a
/// parallel tool turn would become several consecutive user turns — a shape
/// Gemini reads as a malformed conversation.
fn push_function_response(contents: &mut Vec<Value>, part: Value) {
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("user") {
            if let Some(parts) = last.get_mut("parts").and_then(Value::as_array_mut) {
                if parts
                    .iter()
                    .any(|existing| existing.get("functionResponse").is_some())
                {
                    parts.push(part);
                    return;
                }
            }
        }
    }
    contents.push(json!({ "role": "user", "parts": [part] }));
}

/// The `generationConfig.thinkingConfig` this level asks for.
///
/// `off`/`omit` send nothing at all: Gemini 2.5 Pro cannot switch thinking off
/// (`thinkingBudget: 0` is refused) and a model whose reasoning is its own
/// default is better left alone than described wrongly.
fn thinking_config(model: &str, level: ThinkingLevel) -> Option<Value> {
    let api_level = match level {
        ThinkingLevel::Off | ThinkingLevel::Omit => return None,
        ThinkingLevel::Minimal => "MINIMAL",
        ThinkingLevel::Low => "LOW",
        ThinkingLevel::Medium => "MEDIUM",
        // The field stops at HIGH; a larger budget is not a different level.
        ThinkingLevel::High | ThinkingLevel::XHigh | ThinkingLevel::Max => "HIGH",
    };
    if uses_thinking_level(model) {
        return Some(json!({
            "includeThoughts": true,
            "thinkingLevel": api_level,
        }));
    }
    Some(json!({
        "includeThoughts": true,
        "thinkingBudget": thinking_budget(model, level),
    }))
}

/// Token budgets by model family, from pi-ai's `getGoogleBudget`; `-1` means
/// "let the model decide", which is what Google documents for dynamic thinking.
fn thinking_budget(model: &str, level: ThinkingLevel) -> i64 {
    let id = model.to_ascii_lowercase();
    let table: Option<[i64; 4]> = if id.contains("2.5-flash-lite") {
        Some([512, 2048, 8192, 24576])
    } else if id.contains("2.5-pro") {
        Some([128, 2048, 8192, 32768])
    } else if id.contains("2.5-flash") {
        Some([128, 2048, 8192, 24576])
    } else {
        None
    };
    let Some([minimal, low, medium, high]) = table else {
        return -1;
    };
    match level {
        ThinkingLevel::Minimal => minimal,
        ThinkingLevel::Low => low,
        ThinkingLevel::Medium => medium,
        ThinkingLevel::High | ThinkingLevel::XHigh | ThinkingLevel::Max => high,
        ThinkingLevel::Off | ThinkingLevel::Omit => -1,
    }
}

/// Gemini's major version in a model id (`gemini-2.5-flash` -> 2,
/// `gemini-live-3-pro` -> 3).
fn gemini_major(model: &str) -> Option<u32> {
    let id = model.to_ascii_lowercase();
    let rest = id.strip_prefix("gemini-")?;
    let rest = rest.strip_prefix("live-").unwrap_or(rest);
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Whether this model is steered by `thinkingLevel` rather than
/// `thinkingBudget` — pi-ai's `usesGoogleThinkingLevel`.
fn uses_thinking_level(model: &str) -> bool {
    let id = model.to_ascii_lowercase();
    match gemini_major(&id) {
        Some(major) => major >= 3,
        None => {
            id == "gemini-flash-latest"
                || id == "gemini-flash-lite-latest"
                || id.contains("gemma-4")
                || id.contains("gemma4")
        }
    }
}

/// Models that require an explicit id on `functionCall` / `functionResponse` —
/// pi-ai's `requiresToolCallId`.
fn requires_tool_call_id(model: &str) -> bool {
    let id = model.to_ascii_lowercase();
    id.starts_with("claude-")
        || id.starts_with("gpt-oss-")
        || gemini_major(&id).is_some_and(|major| major >= 3)
}

/// `finishReason` -> [`StopReason`].
///
/// The content-policy terminators get their own variant so the transcript can
/// say *why* the answer stopped; everything else is kept verbatim rather than
/// flattened into one "error", because "the model emitted a malformed function
/// call" and "the model ran out of images" are different things to a person.
fn map_finish_reason(reason: &str) -> StopReason {
    match reason {
        "STOP" => StopReason::EndTurn,
        "MAX_TOKENS" => StopReason::MaxOutputTokens,
        "SAFETY"
        | "RECITATION"
        | "BLOCKLIST"
        | "PROHIBITED_CONTENT"
        | "SPII"
        | "IMAGE_SAFETY"
        | "IMAGE_PROHIBITED_CONTENT"
        | "IMAGE_RECITATION"
        | "IMAGE_OTHER"
        | "LANGUAGE" => StopReason::ContentFilter,
        "" => StopReason::EndTurn,
        other => StopReason::Other(other.to_string()),
    }
}

fn parse_usage(value: &Value) -> Option<Usage> {
    let count = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    let prompt = count("promptTokenCount");
    let candidates = count("candidatesTokenCount");
    let thoughts = count("thoughtsTokenCount");
    if prompt == 0 && candidates == 0 && thoughts == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: prompt,
        output_tokens: candidates + thoughts,
        cache_read_tokens: count("cachedContentTokenCount"),
        cache_write_tokens: 0,
        reasoning_tokens: thoughts,
    })
}

/// Turn Google's error object into a sentence a person can act on.
///
/// The shape is `{"error":{"code":429,"message":"…","status":"RESOURCE_EXHAUSTED"}}`,
/// where `code` is the HTTP status and `status` the canonical gRPC name. Both
/// are kept: the number decides whether a retry can help, the name tells the
/// reader what went wrong.
pub fn error_from_body(error: &Value) -> AgentError {
    let inner = error.get("error").unwrap_or(error);
    let code = inner.get("code").and_then(|code| match code {
        Value::Number(code) => code.as_u64(),
        Value::String(code) => code.parse().ok(),
        _ => None,
    });
    let status = inner.get("status").and_then(Value::as_str);
    let message = inner
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty());

    let text = match (message, status, code) {
        (Some(message), Some(status), _) => format!("{message} ({status})"),
        (Some(message), None, Some(code)) => format!("{message} (code {code})"),
        (Some(message), None, None) => message.to_string(),
        (None, Some(status), _) => format!("provider reported {status}"),
        (None, None, Some(code)) => format!("provider reported an error (code {code})"),
        (None, None, None) => "provider reported an error".to_string(),
    };
    let kind = match (code, status) {
        (Some(429 | 500 | 502 | 503 | 504), _) => ProviderErrorKind::Retryable,
        (_, Some("RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "INTERNAL" | "DEADLINE_EXCEEDED")) => {
            ProviderErrorKind::Retryable
        }
        _ => ProviderErrorKind::Fatal,
    };
    AgentError::provider(kind, text)
}

/// The readable message of a non-2xx body, for the HTTP layer: Google answers a
/// failed request with the same `{error:{…}}` object it streams, so a person
/// should not have to read the envelope.
pub fn readable_error_body(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    // Only a body that really carries Google's error object is worth unwrapping;
    // an HTML gateway page stays as it is for the caller to truncate.
    let error = value.get("error")?;
    Some(match error_from_body(error) {
        AgentError::Provider { message, .. } => message,
        other => other.to_string(),
    })
}

/// Incremental Gemini decoder: SSE bytes in, [`StreamEvent`]s out.
#[derive(Debug, Default)]
pub struct GoogleStreamDecoder {
    framer: SseFramer,
    /// Gemini names no index for a call, so slots are handed out in arrival order.
    next_slot: usize,
    /// The last usage frame seen. Every chunk repeats the counts, so this is
    /// held rather than emitted — the assembler *adds* what it is given.
    usage: Option<Usage>,
    usage_emitted: bool,
    finished: bool,
}

impl GoogleStreamDecoder {
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
                // Gemini ends at `finishReason`; a proxy in front of it may still
                // send the OpenAI-style sentinel.
                self.emit_usage_once(&mut events);
                self.finish_once(StopReason::EndTurn, &mut events);
                continue;
            }
            let value: Value = serde_json::from_str(data).map_err(|error| {
                AgentError::provider(
                    ProviderErrorKind::Protocol,
                    format!("google frame is not JSON: {error}"),
                )
            })?;
            if let Some(error) = value.get("error") {
                return Err(error_from_body(error));
            }
            self.decode_chunk(&value, &mut events);
        }
        Ok(events)
    }

    fn decode_chunk(&mut self, value: &Value, events: &mut Vec<StreamEvent>) {
        if let Some(usage) = value.get("usageMetadata").and_then(parse_usage) {
            self.usage = Some(usage);
            if self.finished {
                // The last chunk carries the final counts; a decoder that already
                // finished still owes the turn its usage frame.
                self.emit_usage_once(events);
            }
        }
        // A blocked prompt has no candidate at all, only the reason.
        if let Some(reason) = value
            .get("promptFeedback")
            .and_then(|feedback| feedback.get("blockReason"))
            .and_then(Value::as_str)
        {
            if !reason.is_empty() {
                self.emit_usage_once(events);
                self.finish_once(StopReason::ContentFilter, events);
                return;
            }
        }
        let Some(candidate) = value
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
        else {
            return;
        };
        if let Some(parts) = candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
        {
            for part in parts {
                self.decode_part(part, events);
            }
        }
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            self.emit_usage_once(events);
            self.finish_once(map_finish_reason(reason), events);
        }
    }

    fn decode_part(&mut self, part: &Value, events: &mut Vec<StreamEvent>) {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                // `thought: true` is the definitive marker for reasoning; a
                // `thoughtSignature` on a plain text part is not thinking.
                let thought = part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                events.push(if thought {
                    StreamEvent::ThinkingDelta(text.to_string())
                } else {
                    StreamEvent::TextDelta(text.to_string())
                });
            }
        }
        let Some(call) = part.get("functionCall") else {
            return;
        };
        let index = self.next_slot;
        self.next_slot += 1;
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // Gemini names no id on older models, and a duplicate id would pair two
        // results with one call, so an absent or blank one is replaced.
        let id = match call.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => format!("call_{}", crate::message::new_message_id()),
        };
        events.push(StreamEvent::ToolCallStart { index, id, name });
        // `args` arrives whole and as an object; the assembler takes text.
        if let Some(args) = call.get("args") {
            events.push(StreamEvent::ToolCallDelta {
                index,
                arguments_delta: args.to_string(),
            });
        }
    }

    fn emit_usage_once(&mut self, events: &mut Vec<StreamEvent>) {
        if self.usage_emitted {
            return;
        }
        if let Some(usage) = self.usage.take() {
            self.usage_emitted = true;
            events.push(StreamEvent::Usage(usage));
        }
    }

    fn finish_once(&mut self, reason: StopReason, events: &mut Vec<StreamEvent>) {
        if !self.finished {
            self.finished = true;
            events.push(StreamEvent::Finish(reason));
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Message, ToolCall, ToolResult};
    use crate::provider::ResponseAssembler;
    use crate::tool::ToolSpec;

    fn config() -> HttpProviderConfig {
        HttpProviderConfig {
            default_max_tokens: 4096,
            ..HttpProviderConfig::google("gem", DEFAULT_BASE_URL, "AIza-secret")
        }
    }

    fn decode(raw: &str) -> Vec<StreamEvent> {
        let mut decoder = GoogleStreamDecoder::new();
        decoder.push_chunk(raw).expect("fixture must decode")
    }

    fn frame(data: &str) -> String {
        format!("data: {data}\n\n")
    }

    fn assemble(events: Vec<StreamEvent>) -> crate::provider::AssembledResponse {
        let mut assembler = ResponseAssembler::new();
        for event in events {
            assembler.push(event).unwrap();
        }
        assembler.finish().expect("a finished turn")
    }

    fn text_call_request(model: &str) -> ChatRequest {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("looking");
        assistant.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: json!({ "path": "a.txt" }),
            raw_arguments: None,
        });
        let mut request = ChatRequest::new(
            model,
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
            json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        )];
        request
    }

    #[test]
    fn the_body_sends_contents_and_generation_config_not_a_message_list() {
        let mut request = text_call_request("gemini-2.5-flash");
        request.temperature = Some(0.2);
        let body = google_body(&config(), &request);

        assert!(body.get("messages").is_none(), "sent: {body}");
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 4096);
        // `f32` to JSON is not exactly `0.2`, which says nothing about the mapping.
        let temperature = body["generationConfig"]["temperature"]
            .as_f64()
            .expect("a temperature");
        assert!((temperature - 0.2).abs() < 1e-6, "sent: {body}");
        // The model travels in the path, never in the body.
        assert!(body.get("model").is_none(), "sent: {body}");
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "read a.txt");
    }

    #[test]
    fn a_system_prompt_becomes_system_instruction_and_extra_system_rows_join_it() {
        let mut extra = Message::new(Role::System);
        extra.push_text("second rule");
        let mut request = text_call_request("gemini-2.5-flash");
        request.messages.push(extra);

        let body = google_body(&config(), &request);
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            "you are terse\n\nsecond rule"
        );
        assert_eq!(
            body["contents"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|turn| turn["role"] == json!("system"))
                .count(),
            0,
            "a system row must never become a turn: {body}"
        );
    }

    #[test]
    fn tool_calls_replay_as_function_call_parts_on_the_model_role() {
        let request = text_call_request("gemini-2.5-flash");
        let body = google_body(&config(), &request);
        let model_turn = body["contents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|turn| turn["role"] == json!("model"))
            .expect("an assistant turn");

        assert_eq!(model_turn["parts"][0]["text"], "looking");
        assert_eq!(model_turn["parts"][1]["functionCall"]["name"], "read_file");
        // `args` is an object here; a JSON *string* is the OpenAI shape.
        assert_eq!(
            model_turn["parts"][1]["functionCall"]["args"]["path"],
            "a.txt"
        );
        // Gemini 2.5 refuses an unknown `id` field, so it is not sent.
        assert!(
            model_turn["parts"][1]["functionCall"].get("id").is_none(),
            "sent: {model_turn}"
        );
    }

    #[test]
    fn a_model_that_requires_tool_call_ids_gets_them_on_call_and_response() {
        let request = text_call_request("gemini-3-pro-preview");
        let body = google_body(&config(), &request);
        let turns = body["contents"].as_array().unwrap();
        let model_turn = turns
            .iter()
            .find(|turn| turn["role"] == json!("model"))
            .expect("an assistant turn");
        assert_eq!(model_turn["parts"][1]["functionCall"]["id"], "call_1");

        let result_turn = turns.last().expect("a result turn");
        assert_eq!(result_turn["role"], "user");
        assert_eq!(result_turn["parts"][0]["functionResponse"]["id"], "call_1");
    }

    #[test]
    fn tool_results_replay_as_function_responses_merged_into_one_user_turn() {
        // Two results in a row: the kernel stores one row each, Gemini wants one
        // turn holding both.
        let request = ChatRequest::new(
            "gemini-2.5-flash",
            vec![
                Message::user_text("check both"),
                Message::tool_result(ToolResult {
                    call_id: "call_a".into(),
                    name: "read_file".into(),
                    content: "a".into(),
                    is_error: false,
                    truncated: false,
                }),
                Message::tool_result(ToolResult {
                    call_id: "call_b".into(),
                    name: "grep".into(),
                    content: "boom".into(),
                    is_error: true,
                    truncated: false,
                }),
            ],
        );
        let body = google_body(&config(), &request);
        let turns = body["contents"].as_array().unwrap();
        assert_eq!(turns.len(), 2, "one user turn, one result turn: {body}");
        let result_parts = turns[1]["parts"].as_array().unwrap();
        assert_eq!(result_parts.len(), 2);
        assert_eq!(result_parts[0]["functionResponse"]["name"], "read_file");
        assert_eq!(
            result_parts[0]["functionResponse"]["response"]["output"],
            "a"
        );
        // A failure is `error`, not a bare string the model would read as output.
        assert_eq!(
            result_parts[1]["functionResponse"]["response"]["error"],
            "boom"
        );
    }

    #[test]
    fn a_result_that_lost_its_name_is_paired_through_the_call_it_answers() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_tool_call(ToolCall {
            id: "call_7".into(),
            name: "read_file".into(),
            arguments: json!({ "path": "a.txt" }),
            raw_arguments: None,
        });
        let mut nameless = ToolResult {
            call_id: "call_7".into(),
            name: String::new(),
            content: "body".into(),
            is_error: false,
            truncated: false,
        };
        nameless.name.clear();
        let request = ChatRequest::new(
            "gemini-2.5-flash",
            vec![
                Message::user_text("read a.txt"),
                assistant,
                Message::tool_result(nameless),
            ],
        );
        let body = google_body(&config(), &request);
        let turns = body["contents"].as_array().unwrap();
        // Gemini pairs a result with its call by name, so an empty one is a
        // request the model cannot answer.
        assert_eq!(
            turns[2]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
    }

    #[test]
    fn an_image_travels_as_inline_data() {
        let mut message = Message::user_text("what colour is this");
        message.parts.push(ContentPart::Image {
            mime_type: "image/png".into(),
            data: "QUJD".into(),
        });
        let request = ChatRequest::new("gemini-2.5-flash", vec![message]);
        let body = google_body(&config(), &request);
        let parts = &body["contents"][0]["parts"];
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/png");
        assert_eq!(parts[1]["inlineData"]["data"], "QUJD");
    }

    #[test]
    fn tool_declarations_use_the_full_json_schema_field() {
        let request = text_call_request("gemini-2.5-flash");
        let body = google_body(&config(), &request);
        let declaration = &body["tools"][0]["functionDeclarations"][0];
        assert_eq!(declaration["name"], "read_file");
        assert_eq!(
            declaration["parametersJsonSchema"]["properties"]["path"]["type"],
            "string"
        );
        // `function: {...}` is the Chat Completions shape; `parameters` is the
        // OpenAPI subset that drops `anyOf`.
        assert!(declaration.get("function").is_none(), "sent: {body}");
        assert!(body["tools"][0].get("function").is_none(), "sent: {body}");
    }

    #[test]
    fn the_thinking_switch_becomes_a_thinking_config_and_nothing_when_off() {
        for (level, expected) in [
            (ThinkingLevel::Minimal, Some("MINIMAL")),
            (ThinkingLevel::Low, Some("LOW")),
            (ThinkingLevel::Medium, Some("MEDIUM")),
            (ThinkingLevel::High, Some("HIGH")),
            (ThinkingLevel::XHigh, Some("HIGH")),
            (ThinkingLevel::Off, None),
            (ThinkingLevel::Omit, None),
        ] {
            let mut request =
                ChatRequest::new("gemini-3-pro-preview", vec![Message::user_text("hi")]);
            request.thinking = level;
            let body = google_body(&config(), &request);
            assert_eq!(
                body["generationConfig"]
                    .get("thinkingConfig")
                    .and_then(|config| config.get("thinkingLevel"))
                    .and_then(Value::as_str),
                expected,
                "{level:?}: {body}"
            );
        }

        // A 2.5 model takes a token budget instead of a level.
        let mut request = ChatRequest::new("gemini-2.5-pro", vec![Message::user_text("hi")]);
        request.thinking = ThinkingLevel::Medium;
        let body = google_body(&config(), &request);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            8192
        );
        assert!(
            body["generationConfig"]["thinkingConfig"]
                .get("thinkingLevel")
                .is_none(),
            "sent: {body}"
        );
    }

    #[test]
    fn text_streams_from_parts_and_finishes_with_stop() {
        let raw = [
            frame(r#"{"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"},"index":0}]}"#),
            frame(r#"{"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP","index":0}]}"#),
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
        assert_eq!(text, "Hello");
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Finish(StopReason::EndTurn))
        );
    }

    #[test]
    fn thought_parts_become_thinking_deltas() {
        let raw = frame(
            r#"{"candidates":[{"content":{"parts":[{"text":"weigh ","thought":true},{"text":"done"}],"role":"model"},"finishReason":"STOP"}]}"#,
        );
        let events = decode(&raw);
        assert!(events.contains(&StreamEvent::ThinkingDelta("weigh ".into())));
        assert!(events.contains(&StreamEvent::TextDelta("done".into())));
    }

    #[test]
    fn a_function_call_becomes_a_tool_call_with_a_generated_id() {
        let raw = frame(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a.txt"}}}],"role":"model"},"finishReason":"STOP"}]}"#,
        );
        let response = assemble(decode(&raw));
        // A call outranks the provider's `STOP`: the call must still run.
        assert_eq!(response.stop_reason, StopReason::ToolUse);
        let calls = response.message.tool_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert!(
            !calls[0].id.is_empty(),
            "an unnamed call still needs a handle a result can quote"
        );
        assert_eq!(calls[0].arguments, json!({ "path": "a.txt" }));
        assert!(calls[0].raw_arguments.is_none());
    }

    #[test]
    fn two_calls_in_one_chunk_get_two_distinct_slots_and_ids() {
        let raw = frame(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}},{"functionCall":{"name":"grep","args":{"pattern":"x"}}}],"role":"model"},"finishReason":"STOP"}]}"#,
        );
        let response = assemble(decode(&raw));
        let calls = response.message.tool_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[1].name, "grep");
        assert_ne!(calls[0].id, calls[1].id);
    }

    #[test]
    fn a_function_call_that_carries_an_id_keeps_it() {
        let raw = frame(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc_9","name":"list_files","args":{}}}],"role":"model"},"finishReason":"STOP"}]}"#,
        );
        let response = assemble(decode(&raw));
        assert_eq!(response.message.tool_calls()[0].id, "fc_9");
    }

    #[test]
    fn usage_is_reported_once_even_though_every_chunk_carries_it() {
        let raw = [
            frame(r#"{"candidates":[{"content":{"parts":[{"text":"a"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}"#),
            frame(r#"{"candidates":[{"content":{"parts":[{"text":"b"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":4,"totalTokenCount":15}}"#),
        ]
        .concat();
        let events = decode(&raw);
        // The assembler *adds* usage, so a per-chunk emission would report 10+10.
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, StreamEvent::Usage(_)))
                .count(),
            1
        );
        let response = assemble(events);
        assert_eq!(
            response.usage,
            Usage {
                input_tokens: 10,
                // candidates + thoughts: thinking is spent out of the answer budget
                output_tokens: 5,
                cache_read_tokens: 4,
                cache_write_tokens: 0,
                reasoning_tokens: 2,
            }
        );
    }

    #[test]
    fn each_finish_reason_maps_to_a_stop_reason_a_person_can_read() {
        assert_eq!(map_finish_reason("STOP"), StopReason::EndTurn);
        assert_eq!(map_finish_reason("MAX_TOKENS"), StopReason::MaxOutputTokens);
        assert_eq!(map_finish_reason("SAFETY"), StopReason::ContentFilter);
        assert_eq!(map_finish_reason("RECITATION"), StopReason::ContentFilter);
        assert_eq!(map_finish_reason("BLOCKLIST"), StopReason::ContentFilter);
        assert_eq!(
            map_finish_reason("PROHIBITED_CONTENT"),
            StopReason::ContentFilter
        );
        // Tool-protocol failures keep their own name instead of flattening into
        // one generic error.
        assert_eq!(
            map_finish_reason("MALFORMED_FUNCTION_CALL"),
            StopReason::Other("MALFORMED_FUNCTION_CALL".into())
        );
        assert_eq!(
            map_finish_reason("OTHER"),
            StopReason::Other("OTHER".into())
        );
    }

    #[test]
    fn a_blocked_prompt_finishes_as_content_filter_without_a_candidate() {
        let raw = frame(
            r#"{"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":7}}"#,
        );
        let events = decode(&raw);
        assert!(events.contains(&StreamEvent::Finish(StopReason::ContentFilter)));
        assert!(events
            .iter()
            .any(|event| matches!(event, StreamEvent::Usage(_))));
    }

    #[test]
    fn an_error_body_is_unwrapped_and_retryable_when_google_says_so() {
        let raw = frame(
            r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#,
        );
        let mut decoder = GoogleStreamDecoder::new();
        let error = decoder.push_chunk(&raw).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("Resource has been exhausted"), "{text}");
        assert!(text.contains("RESOURCE_EXHAUSTED"), "{text}");
        assert!(
            !text.contains("\\\""),
            "the envelope must be unwrapped: {text}"
        );
        assert!(error.is_retryable(), "429 is worth another attempt: {text}");

        let fatal = error_from_body(&json!({
            "error": { "code": 400, "message": "API key not valid.", "status": "INVALID_ARGUMENT" }
        }));
        assert!(!fatal.is_retryable());
        assert!(fatal.to_string().contains("API key not valid."));
        assert!(fatal.to_string().contains("INVALID_ARGUMENT"));
    }

    #[test]
    fn a_non_google_body_is_left_for_the_caller_to_truncate() {
        // A gateway that answers an HTML error page must not be reported as a
        // provider sentence it never sent.
        assert!(readable_error_body("<html>502 Bad Gateway</html>").is_none());
        assert_eq!(
            readable_error_body(
                r#"{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}"#
            )
            .as_deref(),
            Some("API key not valid. (INVALID_ARGUMENT)")
        );
    }

    #[test]
    fn invalid_json_is_a_protocol_error_not_a_panic() {
        let mut decoder = GoogleStreamDecoder::new();
        let error = decoder.push_chunk("data: {not json}\n\n").unwrap_err();
        assert_eq!(error.code(), "PROVIDER_ERROR");
        // A half frame must not corrupt the frames that follow it.
        let mut decoder = GoogleStreamDecoder::new();
        assert!(decoder
            .push_chunk("data: {\"candidates\":")
            .unwrap()
            .is_empty());
        let events = decoder
            .push_chunk(
                "[{\"content\":{\"parts\":[{\"text\":\"ok\"}]},\"finishReason\":\"STOP\"}]}\n\n",
            )
            .unwrap();
        assert!(events.contains(&StreamEvent::TextDelta("ok".into())));
    }
}
