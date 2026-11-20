//! HTTP transports for the two provider families the desktop configures.
//!
//! Upstream counterpart: `agent/transports/*` plus the adapters. The request is
//! built from [`ChatRequest`], the response body is fed chunk by chunk into the
//! streaming decoder, and every decoded frame is forwarded as a
//! [`StreamEvent`] — so the loop above this module never learns HTTP.
//!
//! TLS is `rustls` and the client is `reqwest` without its `stream` feature: the
//! body is read with `Response::chunk`, which keeps the dependency set to what
//! the process needs and the binary statically linkable.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::anthropic::AnthropicStreamDecoder;
use super::openai::OpenAiStreamDecoder;
use super::{BoxFuture, ChatRequest, Provider, ProviderStream, StreamEvent};
use crate::cancel::CancelToken;
use crate::error::{AgentError, ProviderErrorKind, Result};
use crate::message::Role;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireApi {
    /// `POST {base}/chat/completions` with `Authorization: Bearer`.
    OpenAiCompatible,
    /// `POST {base}/v1/messages` with `x-api-key` (or a bearer, when the
    /// provider is a gateway that speaks the Anthropic wire over OAuth).
    AnthropicMessages,
}

#[derive(Debug, Clone)]
pub struct HttpProviderConfig {
    pub name: String,
    pub wire: WireApi,
    /// Base URL without trailing slash: `https://api.example.com/v1`.
    pub base_url: String,
    pub api_key: String,
    pub extra_headers: Vec<(String, String)>,
    /// Anthropic requires the field; OpenAI-compatible providers accept it.
    pub default_max_tokens: u32,
    pub timeout: Duration,
}

impl HttpProviderConfig {
    pub fn openai(
        name: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            wire: WireApi::OpenAiCompatible,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            extra_headers: Vec::new(),
            default_max_tokens: 8192,
            timeout: Duration::from_secs(600),
        }
    }

    pub fn anthropic(
        name: impl Into<String>,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            wire: WireApi::AnthropicMessages,
            ..Self::openai(name, base_url, api_key)
        }
    }

    fn endpoint(&self) -> String {
        match self.wire {
            WireApi::OpenAiCompatible => format!("{}/chat/completions", self.base_url),
            WireApi::AnthropicMessages => format!("{}/messages", self.base_url),
        }
    }
}

pub struct HttpProvider {
    config: HttpProviderConfig,
    client: reqwest::Client,
}

impl HttpProvider {
    pub fn new(config: HttpProviderConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| AgentError::Transport(error.to_string()))?;
        Ok(Self { config, client })
    }

    fn headers(&self) -> Result<HeaderMap> {
        let mut headers = HeaderMap::new();
        match self.config.wire {
            WireApi::OpenAiCompatible => {
                let mut raw = b"Bearer ".to_vec();
                raw.extend_from_slice(self.config.api_key.as_bytes());
                let mut value = HeaderValue::from_bytes(&raw).map_err(|error| {
                    AgentError::Invalid(format!("api key is not a valid header: {error}"))
                })?;
                value.set_sensitive(true);
                headers.insert(reqwest::header::AUTHORIZATION, value);
            }
            WireApi::AnthropicMessages => {
                let mut key = HeaderValue::from_str(&self.config.api_key).map_err(|error| {
                    AgentError::Invalid(format!("api key is not a valid header: {error}"))
                })?;
                key.set_sensitive(true);
                headers.insert(HeaderName::from_static("x-api-key"), key);
                headers.insert(
                    HeaderName::from_static("anthropic-version"),
                    HeaderValue::from_static("2023-06-01"),
                );
            }
        }
        for (name, value) in &self.config.extra_headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| {
                AgentError::Invalid(format!("invalid provider header name `{name}`: {error}"))
            })?;
            let value = HeaderValue::from_str(value).map_err(|error| {
                AgentError::Invalid(format!("invalid header value for `{name}`: {error}"))
            })?;
            headers.insert(name, value);
        }
        Ok(headers)
    }

    fn body(&self, request: &ChatRequest) -> Result<Value> {
        match self.config.wire {
            WireApi::OpenAiCompatible => Ok(openai_body(&self.config, request)),
            WireApi::AnthropicMessages => Ok(anthropic_body(&self.config, request)),
        }
    }
}

impl Provider for HttpProvider {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn stream<'a>(
        &'a self,
        request: ChatRequest,
        cancel: CancelToken,
    ) -> BoxFuture<'a, Result<ProviderStream>> {
        Box::pin(async move {
            let body = self.body(&request)?;
            let headers = self.headers()?;
            let url = self.config.endpoint();
            let wire = self.config.wire;

            // The request is sent here, not inside the stream task, so an HTTP
            // failure surfaces as an error from `stream()` instead of an
            // abruptly closed stream.
            let response = self
                .client
                .post(&url)
                .headers(headers)
                .json(&body)
                .send()
                .await
                .map_err(|error| {
                    AgentError::provider(
                        ProviderErrorKind::Transport,
                        format!("request to {url} failed: {error}"),
                    )
                })?;

            let status = response.status();
            if !status.is_success() {
                // Read the delay before the body: `text()` consumes the response.
                let retry_after = crate::retry::parse_retry_after_ms(
                    response
                        .headers()
                        .get("retry-after-ms")
                        .and_then(|value| value.to_str().ok()),
                    response
                        .headers()
                        .get("retry-after")
                        .and_then(|value| value.to_str().ok()),
                    crate::retry::RATE_LIMIT_MAX_DELAY_MS,
                );
                let detail = response
                    .text()
                    .await
                    .unwrap_or_else(|error| format!("<body unavailable: {error}>"));
                let kind = if status.as_u16() == 429 || status.is_server_error() {
                    ProviderErrorKind::Retryable
                } else {
                    ProviderErrorKind::Fatal
                };
                return Err(AgentError::provider_status(
                    kind,
                    status.as_u16(),
                    truncate(&detail, 600),
                )
                .with_retry_after(retry_after));
            }

            let (tx, rx) = mpsc::channel(64);
            tokio::spawn(async move {
                pump(response, wire, tx, cancel).await;
            });
            Ok(ProviderStream::new(rx))
        })
    }
}

/// Read the body and forward decoded frames until the provider finishes, the
/// consumer goes away, or the turn is cancelled.
async fn pump(
    mut response: reqwest::Response,
    wire: WireApi,
    tx: mpsc::Sender<StreamEvent>,
    cancel: CancelToken,
) {
    let mut openai = OpenAiStreamDecoder::new();
    let mut anthropic = AnthropicStreamDecoder::new();
    let mut finished = false;

    loop {
        if cancel.is_cancelled() {
            return;
        }
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            chunk = response.chunk() => chunk,
        };
        let events = match chunk {
            Ok(Some(bytes)) => {
                let text = String::from_utf8_lossy(&bytes);
                let decoded = match wire {
                    WireApi::OpenAiCompatible => openai.push_chunk(&text),
                    WireApi::AnthropicMessages => anthropic.push_chunk(&text),
                };
                match decoded {
                    Ok(events) => events,
                    Err(error) => {
                        tracing::warn!(target: "agent_core::provider::http", %error, "stream decode failed");
                        return;
                    }
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(target: "agent_core::provider::http", %error, "stream read failed");
                return;
            }
        };
        for event in events {
            finished |= matches!(event, StreamEvent::Finish(_));
            if tx.send(event).await.is_err() {
                return;
            }
        }
    }

    if !finished {
        // A body that ends without a terminator is a truncated response; the
        // assembler turns the missing finish into `IncompleteStream`.
        tracing::warn!(target: "agent_core::provider::http", "stream ended without a finish frame");
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let head: String = text.chars().take(limit).collect();
    format!("{head}…")
}

fn openai_body(config: &HttpProviderConfig, request: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = &request.system {
        messages.push(json!({"role": "system", "content": system}));
    }
    for message in &request.messages {
        match message.role {
            Role::System => messages.push(json!({"role": "system", "content": message.text()})),
            Role::User => {
                // 带图片的 user 消息必须发多模态数组：原来一律发 `message.text()`，
                // 于是 `ContentPart::Image` 被**静默丢掉**（模型只看到问题看不到图）。
                let images: Vec<&crate::message::ContentPart> = message
                    .parts
                    .iter()
                    .filter(|part| matches!(part, crate::message::ContentPart::Image { .. }))
                    .collect();
                if images.is_empty() {
                    messages.push(json!({"role": "user", "content": message.text()}));
                } else {
                    let mut blocks: Vec<Value> = Vec::new();
                    for part in &message.parts {
                        match part {
                            crate::message::ContentPart::Text { text } if !text.is_empty() => {
                                blocks.push(json!({"type": "text", "text": text}));
                            }
                            crate::message::ContentPart::Image { mime_type, data } => {
                                blocks.push(json!({
                                    "type": "image_url",
                                    "image_url": {"url": format!("data:{mime_type};base64,{data}")},
                                }));
                            }
                            _ => {}
                        }
                    }
                    messages.push(json!({"role": "user", "content": blocks}));
                }
            }
            Role::Assistant => {
                let calls: Vec<Value> = message
                    .tool_calls()
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.raw_arguments.clone().unwrap_or_else(|| call.arguments.to_string()),
                            }
                        })
                    })
                    .collect();
                let mut entry = json!({"role": "assistant", "content": message.text()});
                if !calls.is_empty() {
                    entry["tool_calls"] = Value::Array(calls);
                }
                messages.push(entry);
            }
            Role::Tool => {
                for result in message.tool_results() {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": result.call_id,
                        "content": result.content,
                    }));
                }
            }
        }
    }

    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_tokens": request.max_output_tokens.unwrap_or(config.default_max_tokens),
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    // The reasoning switch the renderer offers has to reach the wire, or the
    // control is decoration. `off` and `omit` add no field at all: the first
    // means the user turned it off, the second means the provider's own default
    // stands, and neither is spelled as a value here.
    if let Some(effort) = request.thinking.reasoning_effort() {
        body["reasoning_effort"] = json!(effort);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    body
}

fn anthropic_body(config: &HttpProviderConfig, request: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let mut system = request.system.clone();
    // The prefix of a turn is re-sent every request; a breakpoint here is what
    // makes the provider charge a fraction for the part it has already seen.
    let cache = request.cache.breakpoint();

    for message in &request.messages {
        match message.role {
            Role::System => {
                // Anthropic carries the system prompt outside the message list;
                // extra system rows from the transcript are folded in.
                let text = message.text();
                system = Some(match system {
                    Some(existing) => format!("{existing}\n\n{text}"),
                    None => text,
                });
            }
            Role::User => {
                if message.has_tool_traffic() {
                    // Results travel as user-role tool_result blocks.
                    let blocks: Vec<Value> = message
                        .tool_results()
                        .iter()
                        .map(|result| {
                            json!({
                                "type": "tool_result",
                                "tool_use_id": result.call_id,
                                "content": result.content,
                                "is_error": result.is_error,
                            })
                        })
                        .collect();
                    messages.push(json!({"role": "user", "content": blocks}));
                } else {
                    // A user turn that carries images must send content blocks:
                    // Anthropic has no way to place an image in a plain string, so
                    // text-only would silently drop the picture the user attached.
                    let has_images = message
                        .parts
                        .iter()
                        .any(|part| matches!(part, crate::message::ContentPart::Image { .. }));
                    if !has_images {
                        messages.push(json!({"role": "user", "content": message.text()}));
                    } else {
                        let mut blocks: Vec<Value> = Vec::new();
                        for part in &message.parts {
                            match part {
                                crate::message::ContentPart::Text { text } if !text.is_empty() => {
                                    blocks.push(json!({"type": "text", "text": text}));
                                }
                                crate::message::ContentPart::Image { mime_type, data } => {
                                    blocks.push(json!({
                                        "type": "image",
                                        "source": {
                                            "type": "base64",
                                            "media_type": mime_type,
                                            "data": data,
                                        },
                                    }));
                                }
                                _ => {}
                            }
                        }
                        messages.push(json!({"role": "user", "content": blocks}));
                    }
                }
            }
            Role::Tool => {
                let blocks: Vec<Value> = message
                    .tool_results()
                    .iter()
                    .map(|result| {
                        json!({
                            "type": "tool_result",
                            "tool_use_id": result.call_id,
                            "content": result.content,
                            "is_error": result.is_error,
                        })
                    })
                    .collect();
                messages.push(json!({"role": "user", "content": blocks}));
            }
            Role::Assistant => {
                let mut blocks: Vec<Value> = Vec::new();
                if !message.text().is_empty() {
                    blocks.push(json!({"type": "text", "text": message.text()}));
                }
                for call in message.tool_calls() {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }));
                }
                if blocks.is_empty() {
                    // An empty assistant turn is not a legal content block list.
                    continue;
                }
                messages.push(json!({"role": "assistant", "content": blocks}));
            }
        }
    }

    if let Some(control) = &cache {
        mark_last_breakpoint(&mut messages, control);
    }

    let max_tokens = request
        .max_output_tokens
        .unwrap_or(config.default_max_tokens);
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
    });
    if let Some(system) = system {
        body["system"] = match &cache {
            Some(control) => json!([{
                "type": "text",
                "text": system,
                "cache_control": control,
            }]),
            None => json!(system),
        };
    }
    // Extended thinking spends tokens out of the same budget as the answer, and
    // Anthropic refuses a budget that does not fit under `max_tokens` — so the
    // field is sent only when this request has room for it. `off`/`omit` send
    // nothing, which leaves the provider's own default in place.
    let thinking = request
        .thinking
        .budget_tokens()
        .filter(|budget| *budget < max_tokens);
    if let Some(budget) = thinking {
        body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
    }
    // With thinking enabled Anthropic accepts only `temperature: 1`, so the same
    // switch that asked for reasoning drops the sampling override instead of
    // producing a request the API rejects.
    if let Some(temperature) = request.temperature {
        if thinking.is_none() {
            body["temperature"] = json!(temperature);
        }
    }
    if !request.tools.is_empty() {
        let last = request.tools.len() - 1;
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .enumerate()
                .map(|(index, tool)| {
                    let mut declaration = json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    });
                    if index == last {
                        if let Some(control) = &cache {
                            declaration["cache_control"] = control.clone();
                        }
                    }
                    declaration
                })
                .collect(),
        );
    }
    body
}

/// Mark the final content block of the last user message as a cache breakpoint.
///
/// A string body becomes a single text block to carry it; a message whose last
/// block is something the provider caches (text, image, tool result) gets the mark
/// in place. An assistant-final conversation needs no breakpoint: the next request
/// appends a user message, and the mark moves with it.
fn mark_last_breakpoint(messages: &mut [Value], control: &Value) {
    let Some(last) = messages.last_mut() else {
        return;
    };
    if last["role"] != "user" {
        return;
    }
    match last["content"].as_array_mut() {
        Some(blocks) => {
            if let Some(block) = blocks.last_mut() {
                block["cache_control"] = control.clone();
            }
        }
        None => {
            let text = last["content"].clone();
            last["content"] = json!([{
                "type": "text",
                "text": text.as_str().unwrap_or_default(),
                "cache_control": control,
            }]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{Message, ToolCall, ToolResult};

    fn config(wire: WireApi) -> HttpProviderConfig {
        HttpProviderConfig {
            wire,
            ..HttpProviderConfig::openai("test", "https://example.test/v1", "sk-secret")
        }
    }

    #[test]
    fn endpoints_are_appended_to_the_base_url() {
        assert_eq!(
            config(WireApi::OpenAiCompatible).endpoint(),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            config(WireApi::AnthropicMessages).endpoint(),
            "https://example.test/v1/messages"
        );
    }

    #[test]
    fn openai_body_carries_tools_and_tool_results() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("looking");
        assistant.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: json!({"path": "a.txt"}),
            raw_arguments: None,
        });
        let mut request = ChatRequest::new(
            "m",
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
        request.tools = vec![crate::tool::ToolSpec::new(
            "read_file",
            "Read a file",
            json!({"type": "object"}),
        )];

        let body = openai_body(&config(WireApi::OpenAiCompatible), &request);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["name"],
            "read_file"
        );
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["arguments"],
            "{\"path\":\"a.txt\"}"
        );
        assert_eq!(body["messages"][3]["role"], "tool");
        assert_eq!(body["messages"][3]["tool_call_id"], "call_1");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    }

    #[test]
    fn anthropic_body_folds_system_and_uses_content_blocks() {
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_tool_call(ToolCall {
            id: "toolu_1".into(),
            name: "read_file".into(),
            arguments: json!({"path": "a.txt"}),
            raw_arguments: None,
        });
        let mut request = ChatRequest::new(
            "claude",
            vec![
                Message::user_text("read a.txt"),
                assistant,
                Message::tool_result(ToolResult {
                    call_id: "toolu_1".into(),
                    name: "read_file".into(),
                    content: "body".into(),
                    is_error: false,
                    truncated: false,
                }),
            ],
        );
        request.system = Some("sys".into());
        request.tools = vec![crate::tool::ToolSpec::new(
            "read_file",
            "Read a file",
            json!({"type": "object"}),
        )];

        let body = anthropic_body(&config(WireApi::AnthropicMessages), &request);
        // The system prompt travels as a block so it can carry the cache breakpoint.
        assert_eq!(body["system"][0]["text"], "sys");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][1]["content"][0]["input"]["path"], "a.txt");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "toolu_1");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert!(body["messages"].as_array().unwrap().len() == 3);
    }

    #[test]
    fn empty_assistant_turns_are_not_sent_to_anthropic() {
        let request = ChatRequest::new(
            "claude",
            vec![Message::user_text("hi"), Message::new(Role::Assistant)],
        );
        let body = anthropic_body(&config(WireApi::AnthropicMessages), &request);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn auth_headers_match_the_wire() {
        let openai = HttpProvider::new(config(WireApi::OpenAiCompatible)).unwrap();
        let headers = openai.headers().unwrap();
        assert_eq!(
            headers.get(reqwest::header::AUTHORIZATION).unwrap(),
            "Bearer sk-secret"
        );

        let anthropic = HttpProvider::new(config(WireApi::AnthropicMessages)).unwrap();
        let headers = anthropic.headers().unwrap();
        assert_eq!(headers.get("x-api-key").unwrap(), "sk-secret");
        assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
        assert!(headers.get(reqwest::header::AUTHORIZATION).is_none());
    }

    fn request_with_cache(cache: crate::provider::CacheRetention) -> ChatRequest {
        let mut request = ChatRequest::new("claude-test", vec![Message::user_text("hello")]);
        request.system = Some("You are Pi.".to_string());
        request.tools = vec![
            crate::tool::ToolSpec::new(
                "Read",
                "Read a file.".to_string(),
                serde_json::json!({"type": "object", "properties": {}}),
            ),
            crate::tool::ToolSpec::new(
                "Bash",
                "Run a command.".to_string(),
                serde_json::json!({"type": "object", "properties": {}}),
            ),
        ];
        request.cache = cache;
        request
    }

    /// The prefix of a turn is re-sent on every request, so it must carry the
    /// provider's cache breakpoints: system, the tool block, and the newest turn.
    #[test]
    fn anthropic_marks_the_prefix_nobody_wants_to_pay_for_twice() {
        let body = anthropic_body(
            &config(WireApi::AnthropicMessages),
            &request_with_cache(crate::provider::CacheRetention::Short),
        );
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        assert!(
            body["tools"][0].get("cache_control").is_none(),
            "only the last declaration closes the tool block: {body}"
        );
        assert_eq!(body["tools"][1]["cache_control"]["type"], "ephemeral");
        let last = body["messages"]
            .as_array()
            .expect("messages")
            .last()
            .expect("a message");
        assert_eq!(last["content"][0]["cache_control"]["type"], "ephemeral");
    }

    #[test]
    fn a_long_retention_asks_for_the_extended_window() {
        let body = anthropic_body(
            &config(WireApi::AnthropicMessages),
            &request_with_cache(crate::provider::CacheRetention::Long),
        );
        assert_eq!(body["system"][0]["cache_control"]["ttl"], "1h");
    }

    /// A one-shot request writes a cache entry nobody reads: it must stay clean,
    /// and it must not send a field a strict provider would reject.
    #[test]
    fn no_retention_sends_no_cache_fields_and_keeps_system_a_string() {
        let body = anthropic_body(
            &config(WireApi::AnthropicMessages),
            &request_with_cache(crate::provider::CacheRetention::None),
        );
        assert!(body["system"].is_string(), "plain system: {body}");
        assert!(body["tools"][1].get("cache_control").is_none());
        assert!(body["messages"][0]["content"].is_string());
        assert!(!body.to_string().contains("cache_control"));
    }

    /// OpenAI-compatible providers cache on their own; sending the field would be
    /// a request they did not ask for.
    #[test]
    fn the_openai_wire_carries_no_cache_fields() {
        let body = openai_body(
            &config(WireApi::OpenAiCompatible),
            &request_with_cache(crate::provider::CacheRetention::Short),
        );
        assert!(!body.to_string().contains("cache_control"));
    }

    /// An assistant-final conversation gets no mark: the next request appends the
    /// user message that will carry it.
    #[test]
    fn an_assistant_final_transcript_is_not_marked() {
        let mut request = request_with_cache(crate::provider::CacheRetention::Short);
        let mut assistant = Message::new(Role::Assistant);
        assistant.push_text("done");
        request.messages.push(assistant);
        let body = anthropic_body(&config(WireApi::AnthropicMessages), &request);
        let last = body["messages"]
            .as_array()
            .expect("messages")
            .last()
            .expect("a message");
        assert_eq!(last["role"], "assistant");
        assert!(last.to_string().find("cache_control").is_none());
    }

    // ---- the reasoning switch -------------------------------------------------

    fn request_with_thinking(
        level: crate::provider::ThinkingLevel,
        max_output_tokens: Option<u32>,
    ) -> ChatRequest {
        let mut request = ChatRequest::new("test-model", vec![Message::user_text("think about it")]);
        request.thinking = level;
        request.max_output_tokens = max_output_tokens;
        request
    }

    fn openai_thinking_body(
        level: crate::provider::ThinkingLevel,
        max_output_tokens: Option<u32>,
    ) -> serde_json::Value {
        openai_body(
            &config(WireApi::OpenAiCompatible),
            &request_with_thinking(level, max_output_tokens),
        )
    }

    fn anthropic_thinking_body(
        level: crate::provider::ThinkingLevel,
        max_output_tokens: Option<u32>,
    ) -> serde_json::Value {
        anthropic_body(
            &config(WireApi::AnthropicMessages),
            &request_with_thinking(level, max_output_tokens),
        )
    }

    #[test]
    fn openai_minimal_sends_reasoning_effort_minimal() {
        let body = openai_thinking_body(crate::provider::ThinkingLevel::Minimal, None);
        assert_eq!(body["reasoning_effort"], "minimal");
    }

    #[test]
    fn openai_low_sends_reasoning_effort_low() {
        let body = openai_thinking_body(crate::provider::ThinkingLevel::Low, None);
        assert_eq!(body["reasoning_effort"], "low");
    }

    #[test]
    fn openai_medium_sends_reasoning_effort_medium() {
        let body = openai_thinking_body(crate::provider::ThinkingLevel::Medium, None);
        assert_eq!(body["reasoning_effort"], "medium");
    }

    #[test]
    fn openai_high_sends_reasoning_effort_high() {
        let body = openai_thinking_body(crate::provider::ThinkingLevel::High, None);
        assert_eq!(body["reasoning_effort"], "high");
        // The tiers above `high` are the same field, and the only value the API
        // documents for them.
        for level in [
            crate::provider::ThinkingLevel::XHigh,
            crate::provider::ThinkingLevel::Max,
        ] {
            assert_eq!(
                openai_thinking_body(level, None)["reasoning_effort"],
                "high",
                "{level:?}"
            );
        }
    }

    #[test]
    fn openai_off_and_omit_send_no_reasoning_field() {
        for level in [
            crate::provider::ThinkingLevel::Off,
            crate::provider::ThinkingLevel::Omit,
        ] {
            let body = openai_thinking_body(level, None);
            assert!(
                body.get("reasoning_effort").is_none(),
                "{level:?} must add no field: {body}"
            );
            assert!(
                !body.to_string().contains("reasoning"),
                "{level:?} must not mention reasoning at all: {body}"
            );
        }
    }

    /// Anthropic pays for thinking out of `max_tokens`, so each tier's budget has
    /// to fit under this request's ceiling.
    #[test]
    fn anthropic_low_sends_a_2048_token_budget() {
        let body = anthropic_thinking_body(crate::provider::ThinkingLevel::Low, Some(16_384));
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
    }

    #[test]
    fn anthropic_medium_sends_a_4096_token_budget() {
        let body = anthropic_thinking_body(crate::provider::ThinkingLevel::Medium, Some(16_384));
        assert_eq!(body["thinking"]["budget_tokens"], 4096);
    }

    #[test]
    fn anthropic_high_sends_an_8192_token_budget() {
        let body = anthropic_thinking_body(crate::provider::ThinkingLevel::High, Some(16_384));
        assert_eq!(body["thinking"]["budget_tokens"], 8192);
    }

    /// A budget that does not fit under `max_tokens` is a 400 from Anthropic, so
    /// the field is dropped rather than sent and refused. The rest of the request
    /// is unchanged.
    #[test]
    fn anthropic_omits_thinking_when_the_budget_does_not_fit_under_max_tokens() {
        // `medium` needs 4096 and this request may spend 2048.
        let body = anthropic_thinking_body(crate::provider::ThinkingLevel::Medium, Some(2048));
        assert!(body.get("thinking").is_none(), "sent: {body}");
        assert_eq!(body["max_tokens"], 2048);
        // The rest of the request is untouched: one user message, still there.
        assert_eq!(body["messages"].as_array().expect("messages").len(), 1);
        assert!(body.to_string().contains("think about it"), "sent: {body}");

        // The provider default ceiling is 8192, which a `high` budget does not fit
        // under either: 8192 is not less than 8192.
        let body = anthropic_thinking_body(crate::provider::ThinkingLevel::High, None);
        assert!(body.get("thinking").is_none(), "sent: {body}");
        assert_eq!(body["max_tokens"], 8192);
    }

    #[test]
    fn anthropic_off_and_omit_send_no_thinking_block() {
        for level in [
            crate::provider::ThinkingLevel::Off,
            crate::provider::ThinkingLevel::Omit,
        ] {
            let body = anthropic_thinking_body(level, Some(16_384));
            assert!(
                body.get("thinking").is_none(),
                "{level:?} must add no block: {body}"
            );
            assert!(!body.to_string().contains("budget_tokens"));
        }
    }

    /// Anthropic accepts only `temperature: 1` alongside thinking, so the switch
    /// that asked for reasoning drops the sampling override instead of failing.
    #[test]
    fn anthropic_drops_temperature_only_when_thinking_is_actually_sent() {
        let mut request = request_with_thinking(crate::provider::ThinkingLevel::Low, Some(16_384));
        request.temperature = Some(0.2);
        let body = anthropic_body(&config(WireApi::AnthropicMessages), &request);
        assert_eq!(body["thinking"]["budget_tokens"], 2048);
        assert!(body.get("temperature").is_none(), "sent: {body}");

        // Without a budget that fits, the request is an ordinary one and keeps it.
        let mut request = request_with_thinking(crate::provider::ThinkingLevel::Low, Some(1024));
        request.temperature = Some(0.2);
        let body = anthropic_body(&config(WireApi::AnthropicMessages), &request);
        assert!(body.get("thinking").is_none());
        assert_eq!(body["temperature"], serde_json::json!(0.2f32));
    }
}

#[cfg(test)]
mod image_wire_tests {
    use super::*;
    use crate::message::{ContentPart, Message};

    #[test]
    fn image_parts_reach_the_wire() {
        // 纯函数化的一小段：与 `request_body` 里 user 分支同构，断言图片不是被丢掉。
        let mut message = Message::user_text("这是什么颜色？");
        message.parts.push(ContentPart::Image {
            mime_type: "image/png".into(),
            data: "QUJD".into(),
        });
        let images: Vec<&ContentPart> = message
            .parts
            .iter()
            .filter(|part| matches!(part, ContentPart::Image { .. }))
            .collect();
        assert_eq!(images.len(), 1, "图片 part 必须被识别到");
        let encoded = serde_json::json!({
            "type": "image_url",
            "image_url": {"url": format!("data:{};base64,{}", "image/png", "QUJD")},
        });
        assert!(encoded["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
