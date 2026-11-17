//! HTTP transports for the two provider families the desktop configures.
//!
//! Hermes counterpart: `agent/transports/*` plus the adapters. The request is
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
                ));
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
            Role::User => messages.push(json!({"role": "user", "content": message.text()})),
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
                    messages.push(json!({"role": "user", "content": message.text()}));
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

    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": request.max_output_tokens.unwrap_or(config.default_max_tokens),
        "stream": true,
    });
    if let Some(system) = system {
        body["system"] = json!(system);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body
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
        assert_eq!(body["system"], "sys");
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
}
