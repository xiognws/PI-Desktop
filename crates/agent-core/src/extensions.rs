//! Trusted-extension hooks, asked of the host over the existing host bridge.
//!
//! Upstream counterpart: `packages/agent-runtime/src/extensions/runner.ts` and
//! the emission sites in `packages/agent-runtime/src/runtime.ts`
//! (`extensionToolCall`, `extensionToolResult`, `extensionContext`,
//! `extensionBeforeAgentStart`, `withExtensionProviderHooks`,
//! `forwardAgentEventToExtensions`).
//!
//! An extension is JavaScript. This kernel has no JS runner and must not grow
//! one, so every hook is a round trip over the same `host.proxy` seam the tools
//! already use: the kernel names the event, the host runs the registered
//! handlers through the *same* `TrustedExtensionRunner` the Node path uses, and
//! the folded result comes back. Hook names, payload fields and the fold rules
//! are the Node contract verbatim, so an extension never learns which runtime
//! answers turns.
//!
//! Failure policy (Node: `Runner.dispatch`): a handler that throws or stalls is
//! a diagnostic on the plugin row, not a failed turn. The kernel mirrors that —
//! any host error, timeout or malformed answer means "unchanged value", logged
//! and continued, never propagated into the turn.
//!
//! Deliberately not here: `hooks.rs`, which is the kernel's own tool
//! allow/deny/rewrite policy. That is a different layer with a different owner.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::error::{AgentError, Result};
use crate::host_bridge::{HostBridge, HostError};
use crate::message::{ContentPart, Message, Role, ToolCall, ToolResult};
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// One hook event, folded by the host exactly as the Node runner folds it.
pub const HOOK_METHOD: &str = "extensions.hooks.emit";
/// What this session registered: the hook events with handlers, and the agent
/// tools the extensions declared.
pub const DESCRIBE_METHOD: &str = "extensions.session.describe";
/// Run one extension-registered agent tool in the host.
pub const TOOL_METHOD: &str = "extensions.tools.execute";

/// Outer ceiling for one hook round trip.
///
/// The host enforces its own per-handler ceiling
/// (`TRUSTED_EXTENSION_HANDLER_TIMEOUT_MS`, 30 s) and records the timeout as a
/// diagnostic. This bound exists for the case that has no host answer at all: a
/// stalled host must cost one step, not the bridge's 600 s tool timeout.
pub const HOOK_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Whether `event` has at least one handler in this session.
///
/// Node asks `runner.hasHandlers(event)` before every emission and skips the
/// round trip when nothing is registered. The kernel learns the same set once
/// per prompt from [`DESCRIBE_METHOD`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExtensionEvents {
    events: Vec<String>,
}

impl ExtensionEvents {
    pub fn from_json(value: Option<&Value>) -> Self {
        let events = value
            .and_then(|value| value.get("events"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Self { events }
    }

    pub fn has(&self, event: &str) -> bool {
        self.events.iter().any(|known| known == event)
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

/// One extension's agent tool, as the host declared it.
///
/// The fields are the ones `tool_spec_from_value` already reads for a host
/// declaration, because the host forwards `getAgentTools()` verbatim.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionToolSpec {
    pub spec: ToolSpec,
}

impl ExtensionToolSpec {
    fn from_value(value: &Value) -> Option<Self> {
        let name = value.get("name").and_then(Value::as_str)?.trim();
        if name.is_empty() {
            return None;
        }
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parameters = value
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"}));
        Some(Self {
            spec: ToolSpec::new(name, description, parameters),
        })
    }
}

/// Everything one prompt learned about this session's extensions.
#[derive(Debug, Clone, Default)]
pub struct ExtensionSession {
    pub events: ExtensionEvents,
    pub tools: Vec<ExtensionToolSpec>,
}

impl ExtensionSession {
    /// Parse the host's answer. A payload this kernel cannot read is an empty
    /// session, not an error: no extensions must mean the plain turn.
    pub fn from_value(value: &Value) -> Self {
        let tools = value
            .get("tools")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(ExtensionToolSpec::from_value).collect())
            .unwrap_or_default();
        Self {
            events: ExtensionEvents::from_json(Some(value)),
            tools,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty() && self.tools.is_empty()
    }
}

/// The kernel's handle on this session's extensions.
///
/// Cloneable on purpose: the turn engine, the provider and the tool registry all
/// need it, and they must all speak for the same session.
#[derive(Clone)]
pub struct ExtensionHost {
    bridge: Arc<HostBridge>,
    session_id: String,
    /// Which events this session has handlers for. Empty until
    /// [`ExtensionHost::describe`] has answered, and empty means "fire nothing"
    /// — the same skip Node's `runner.hasHandlers(event)` performs.
    events: ExtensionEvents,
}

impl std::fmt::Debug for ExtensionHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExtensionHost")
            .field("session_id", &self.session_id)
            .finish()
    }
}

impl ExtensionHost {
    pub fn new(bridge: Arc<HostBridge>, session_id: impl Into<String>) -> Self {
        Self {
            bridge,
            session_id: session_id.into(),
            events: ExtensionEvents::default(),
        }
    }

    /// The same host, told which events this session registered — the answer of
    /// [`ExtensionHost::describe`].
    pub fn scoped(mut self, events: ExtensionEvents) -> Self {
        self.events = events;
        self
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn events(&self) -> &ExtensionEvents {
        &self.events
    }

    /// What this session registered: the events with handlers, and the agent
    /// tools the modules declared.
    ///
    /// Asked once per prompt, and only for a session main said has extensions —
    /// it sends the trusted set with the prompt, and an empty set is the answer.
    pub async fn describe(&self) -> ExtensionSession {
        match self.call(DESCRIBE_METHOD, json!({ "sessionId": self.session_id })).await {
            Some(value) => ExtensionSession::from_value(&value),
            None => ExtensionSession::default(),
        }
    }

    /// One hook event, folded by the host. `None` means no handler answered —
    /// which is also what a failure degrades to.
    pub async fn emit(&self, event: &str, payload: Value) -> Option<Value> {
        if !self.events.has(event) {
            return None;
        }
        let value = self
            .call(
                HOOK_METHOD,
                json!({ "sessionId": self.session_id, "event": event, "payload": payload }),
            )
            .await?;
        value.get("result").filter(|result| !result.is_null()).cloned()
    }

    /// One host call with the kernel's outer ceiling and the degrade-and-log
    /// policy every hook shares.
    async fn call(&self, method: &str, params: Value) -> Option<Value> {
        match tokio::time::timeout(HOOK_CALL_TIMEOUT, self.bridge.call(method, params)).await {
            Ok(Ok(value)) => Some(value),
            Ok(Err(error)) => {
                Self::report(method, &error);
                None
            }
            Err(_) => {
                tracing::warn!(
                    target: "agent_core::extensions",
                    method,
                    timeout_ms = HOOK_CALL_TIMEOUT.as_millis() as u64,
                    "the host did not answer a hook in time; the turn continues with the unchanged value"
                );
                None
            }
        }
    }

    fn report(method: &str, error: &HostError) {
        // `Closed` on shutdown is ordinary: a turn that ends with the host gone
        // must not read as an extension failure.
        if matches!(error, HostError::Closed) {
            tracing::debug!(target: "agent_core::extensions", method, "the host channel closed");
            return;
        }
        tracing::warn!(
            target: "agent_core::extensions",
            method,
            %error,
            "a hook was not answered; the turn continues with the unchanged value"
        );
    }

    /// `before_agent_start`: a chained system-prompt replacement.
    ///
    /// Payload and fold are `Runner.emitBeforeAgentStart`: handler N sees the
    /// payload handler N-1 returned, and only a string `systemPrompt` counts.
    pub async fn before_agent_start(&self, prompt: &str, system_prompt: &str) -> Option<String> {
        let payload = json!({
            "type": "before_agent_start",
            "messageType": "user",
            "prompt": prompt,
            "systemPrompt": system_prompt,
            "systemPromptOptions": {},
        });
        let result = self.emit("before_agent_start", payload).await?;
        result
            .get("systemPrompt")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// `context`: an extension may rewrite one request's message list.
    ///
    /// The replacement shapes that request only; the transcript keeps every
    /// message (Node: "the run's working context and the transcript keep the
    /// original messages"). A replacement this kernel cannot read is dropped
    /// with a log, never half-applied.
    pub async fn context(&self, messages: &[Message]) -> Option<Vec<Message>> {
        let payload = json!({
            "type": "context",
            "messages": messages.iter().map(message_to_wire).collect::<Vec<_>>(),
        });
        let result = self.emit("context", payload).await?;
        let items = result.get("messages")?.as_array()?;
        let mut parsed = Vec::with_capacity(items.len());
        for item in items {
            match message_from_wire(item) {
                Some(message) => parsed.push(message),
                None => {
                    tracing::warn!(
                        target: "agent_core::extensions",
                        "a `context` replacement carried a message this kernel cannot read; keeping the original request"
                    );
                    return None;
                }
            }
        }
        Some(parsed)
    }

    /// `before_provider_request`: the provider payload, replaced or returned.
    pub async fn before_provider_request(&self, payload: Value) -> Option<Value> {
        let event = json!({ "type": "before_provider_request", "payload": payload });
        self.emit("before_provider_request", event).await
    }

    /// `before_provider_headers`: header mutations, merged into the request.
    ///
    /// Node emits this once per run and merges the result into every request of
    /// that run (`extensionBeforeAgentStart` → `extensionProviderHeaders`), so
    /// the kernel asks once per prompt and hands the merged set to the provider.
    pub async fn before_provider_headers(
        &self,
        headers: Vec<(String, String)>,
    ) -> Vec<(String, String)> {
        let mut map = Map::new();
        for (name, value) in &headers {
            map.insert(name.clone(), Value::String(value.clone()));
        }
        let event = json!({ "type": "before_provider_headers", "headers": Value::Object(map) });
        let Some(result) = self.emit("before_provider_headers", event).await else {
            return headers;
        };
        let Some(mut merged) = result.get("headers").and_then(Value::as_object).cloned() else {
            return headers;
        };
        // Node replaces the header set with the handlers' object
        // (`Object.assign` over the same object), so the answer is authoritative
        // — but a value that is not a string cannot go on the wire.
        merged.retain(|_, value| value.is_string());
        merged
            .into_iter()
            .map(|(name, value)| (name, value.as_str().unwrap_or_default().to_string()))
            .collect()
    }

    /// `after_provider_response`: a notification, with the status the fixture
    /// and every real extension read from `response.status`.
    pub async fn after_provider_response(&self, status: u16) {
        let payload = json!({
            "type": "after_provider_response",
            "response": { "status": status },
        });
        let _ = self.emit("after_provider_response", payload).await;
    }

    /// A notification event with no payload beyond its own name.
    pub async fn notify(&self, event: &str) {
        let _ = self.emit(event, json!({ "type": event })).await;
    }

    /// `turn_start` / `turn_end`: pi's per-response turns, numbered the way Node
    /// numbers them (`extensionTurnIndex`, 1-based).
    pub async fn turn_start(&self, turn_index: usize) {
        let payload = json!({
            "type": "turn_start",
            "turnIndex": turn_index,
            "timestamp": crate::message::now_ms(),
        });
        let _ = self.emit("turn_start", payload).await;
    }

    pub async fn turn_end(&self, turn_index: usize, message: Option<&Message>, results: &[ToolResult]) {
        let payload = json!({
            "type": "turn_end",
            "turnIndex": turn_index,
            "message": message.map(message_to_wire),
            "toolResults": results.iter().map(tool_result_to_wire).collect::<Vec<_>>(),
        });
        let _ = self.emit("turn_end", payload).await;
    }

    pub async fn agent_end(&self, messages: &[Message]) {
        let payload = json!({
            "type": "agent_end",
            "messages": messages.iter().map(message_to_wire).collect::<Vec<_>>(),
        });
        let _ = self.emit("agent_end", payload).await;
    }

    /// `tool_call`: `Some(reason)` blocks the call and becomes its result.
    ///
    /// Fold is Node's (`runtime.ts`): the first handler that blocks wins, and a
    /// later `{block: false}` cannot unblock it.
    pub async fn tool_call(&self, call: &ToolCall) -> Option<String> {
        let payload = json!({
            "type": "tool_call",
            "toolName": call.name,
            "toolCallId": call.id,
            "input": call.arguments,
        });
        let result = self.emit("tool_call", payload).await?;
        if result.get("block").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        Some(
            result
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("blocked by a trusted extension")
                .to_string(),
        )
    }

    /// `tool_result`: content, details or the error flag, replaced.
    ///
    /// The kernel's `ToolResult` has no `details` field — the transcript does not
    /// carry one — so a replacement's `details` is reported and dropped rather
    /// than stored somewhere it would be read as content.
    pub async fn tool_result(&self, call: &ToolCall, result: &ToolResult) -> Option<Value> {
        let payload = json!({
            "type": "tool_result",
            "toolName": call.name,
            "toolCallId": call.id,
            "input": call.arguments,
            "content": [{ "type": "text", "text": result.content }],
            "details": Value::Null,
            "isError": result.is_error,
        });
        self.emit("tool_result", payload).await
    }
}

/// Apply a `tool_result` replacement to the kernel's result.
///
/// `content` arrives as content blocks (pi's shape) or as a bare string; both
/// become the one text the transcript stores. `isError` and `truncated` follow
/// the same rule the Node runtime applies — only the fields the extension
/// actually returned change.
pub fn apply_tool_result_patch(result: &mut ToolResult, patch: &Value) {
    if let Some(content) = patch.get("content") {
        match content {
            Value::String(text) => result.content = text.clone(),
            Value::Null => {}
            Value::Array(blocks) => {
                let text = blocks.iter().filter_map(block_text).collect::<Vec<_>>().join("");
                // An array of nothing but non-text blocks is not a replacement:
                // an empty result would silently delete what the tool said.
                if !text.is_empty() || blocks.is_empty() {
                    result.content = text;
                }
            }
            other => result.content = other.to_string(),
        }
    }
    if let Some(is_error) = patch.get("isError").and_then(Value::as_bool) {
        result.is_error = is_error;
    }
    if patch.get("details").is_some_and(|details| !details.is_null()) {
        tracing::debug!(
            target: "agent_core::extensions",
            tool = %result.name,
            "a `tool_result` replacement carried `details`, which this kernel's transcript does not store"
        );
    }
}

fn block_text(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) == Some("text") {
        return block.get("text").and_then(Value::as_str).map(str::to_string);
    }
    None
}

/// One kernel message as pi's `AgentMessage`: `{role, content: [blocks]}`.
///
/// The block vocabulary is pi's, not this kernel's (`toolCall` / `toolResult`
/// against `tool_call` / `tool_result`), because the handler on the other side is
/// extension code written against the Node contract.
pub fn message_to_wire(message: &Message) -> Value {
    json!({
        "role": message.role.as_str(),
        "content": message.parts.iter().map(part_to_wire).collect::<Vec<_>>(),
        "timestamp": message.created_at_ms,
    })
}

fn part_to_wire(part: &ContentPart) -> Value {
    match part {
        ContentPart::Text { text } => json!({ "type": "text", "text": text }),
        ContentPart::Thinking { text } => json!({ "type": "thinking", "thinking": text }),
        ContentPart::Image { mime_type, data } => {
            json!({ "type": "image", "mimeType": mime_type, "data": data })
        }
        ContentPart::ToolCall(call) => json!({
            "type": "toolCall",
            "id": call.id,
            "name": call.name,
            "arguments": call.arguments,
        }),
        ContentPart::ToolResult(result) => tool_result_to_wire(result),
    }
}

fn tool_result_to_wire(result: &ToolResult) -> Value {
    json!({
        "type": "toolResult",
        "toolCallId": result.call_id,
        "toolName": result.name,
        "content": [{ "type": "text", "text": result.content }],
        "isError": result.is_error,
    })
}

/// The inverse of [`message_to_wire`]. `None` means the message is not
/// addressable — a role this kernel has no row for — and the caller keeps the
/// original request rather than sending a half-rewritten one.
pub fn message_from_wire(value: &Value) -> Option<Message> {
    let role = match value.get("role").and_then(Value::as_str)? {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        _ => return None,
    };
    let mut message = Message::new(role);
    if let Some(id) = value.get("id").and_then(Value::as_str) {
        message.id = id.to_string();
    }
    match value.get("content") {
        Some(Value::String(text)) => message.parts.push(ContentPart::Text { text: text.clone() }),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                if let Some(part) = part_from_wire(block) {
                    message.parts.push(part);
                }
            }
        }
        _ => {}
    }
    if let Some(timestamp) = value.get("timestamp").and_then(Value::as_i64) {
        message.created_at_ms = timestamp;
    }
    Some(message)
}

fn part_from_wire(block: &Value) -> Option<ContentPart> {
    match block.get("type").and_then(Value::as_str)? {
        "text" => Some(ContentPart::Text {
            text: block.get("text").and_then(Value::as_str)?.to_string(),
        }),
        "thinking" => Some(ContentPart::Thinking {
            text: block
                .get("thinking")
                .and_then(Value::as_str)
                .or_else(|| block.get("text").and_then(Value::as_str))?
                .to_string(),
        }),
        "image" => Some(ContentPart::Image {
            mime_type: block.get("mimeType").and_then(Value::as_str)?.to_string(),
            data: block.get("data").and_then(Value::as_str)?.to_string(),
        }),
        "toolCall" => Some(ContentPart::ToolCall(ToolCall {
            id: block.get("id").and_then(Value::as_str)?.to_string(),
            name: block.get("name").and_then(Value::as_str)?.to_string(),
            arguments: block
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({})),
            raw_arguments: None,
        })),
        "toolResult" => Some(ContentPart::ToolResult(ToolResult {
            call_id: block.get("toolCallId").and_then(Value::as_str)?.to_string(),
            name: block.get("toolName").and_then(Value::as_str)?.to_string(),
            content: blocks_as_text(block.get("content")),
            is_error: block.get("isError").and_then(Value::as_bool).unwrap_or(false),
            truncated: false,
        })),
        _ => None,
    }
}

fn blocks_as_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks.iter().filter_map(block_text).collect(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// A tool whose implementation is an extension handler in the host.
///
/// The call travels to `extensions.tools.execute`, not `tools.execute`: the
/// extension's module runs in main, and host-core knows nothing about it. That
/// is the same split the Node runtime has, where the runner calls
/// `definition.execute` in-process.
pub struct ExtensionTool {
    spec: ToolSpec,
    host: ExtensionHost,
}

impl ExtensionTool {
    pub fn new(spec: ToolSpec, host: ExtensionHost) -> Self {
        Self { spec, host }
    }
}

impl Tool for ExtensionTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn call<'a>(&'a self, call: &'a ToolCall, ctx: &'a ToolContext) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let params = json!({
                "sessionId": ctx.session_id,
                "turnId": ctx.turn_id,
                "toolCallId": ctx.tool_call_id,
                "toolName": self.spec.name,
                "args": call.arguments,
            });
            let value = self
                .host
                .call(TOOL_METHOD, params)
                .await
                .ok_or_else(|| AgentError::Tool {
                    tool: self.spec.name.clone(),
                    message: "the host did not answer the extension tool call".into(),
                })?;
            let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let is_error = value.get("isError").and_then(Value::as_bool).unwrap_or(false);
            let content = match value.get("content") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            };
            if ok && !is_error {
                return Ok(content);
            }
            let error_code = value
                .get("errorCode")
                .and_then(Value::as_str)
                .unwrap_or("EXTENSION_TOOL_FAILED");
            Err(AgentError::Tool {
                tool: self.spec.name.clone(),
                message: if content.is_empty() {
                    format!("`{}` failed ({error_code})", self.spec.name)
                } else {
                    content
                },
            })
        })
    }
}

/// `before_provider_request` and `after_provider_response`, on the wire.
///
/// Implemented here rather than in the HTTP layer so the transport stays a
/// transport: it asks this object what to send and tells it what came back, and
/// knows nothing about extensions.
pub struct ProviderHook {
    host: ExtensionHost,
}

impl ProviderHook {
    pub fn new(host: ExtensionHost) -> Self {
        Self { host }
    }

    /// The payload the host hands back, or the original one.
    pub async fn before_request(&self, payload: Value) -> Value {
        // `unwrap_or_else` rather than `unwrap_or`: the original payload is the
        // fallback, so it has to survive the call that consumes it.
        let original = payload.clone();
        self.host
            .before_provider_request(payload)
            .await
            .unwrap_or(original)
    }

    pub async fn after_response(&self, status: u16) {
        self.host.after_provider_response(status).await;
    }
}

impl crate::provider::WireHooks for ProviderHook {
    fn before_request<'a>(&'a self, payload: Value) -> BoxFuture<'a, Value> {
        Box::pin(ProviderHook::before_request(self, payload))
    }

    fn after_response<'a>(&'a self, status: u16) -> BoxFuture<'a, ()> {
        Box::pin(ProviderHook::after_response(self, status))
    }
}

/// Ask the host for one extension tool's declaration, used by the tests.
pub fn tool_specs_from_describe(value: &Value) -> Vec<ToolSpec> {
    ExtensionSession::from_value(value)
        .tools
        .into_iter()
        .map(|tool| tool.spec)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_reads_events_and_tools() {
        let session = ExtensionSession::from_value(&json!({
            "events": ["before_agent_start", "tool_call"],
            "tools": [
                {"name": "fx_add", "description": "Adds two numbers",
                 "parameters": {"type": "object", "properties": {"a": {"type": "number"}}}},
                {"description": "no name"}
            ],
        }));
        assert!(session.events.has("tool_call"));
        assert!(!session.events.has("turn_end"));
        assert_eq!(session.tools.len(), 1, "a declaration without a name is not a tool");
        assert_eq!(session.tools[0].spec.name, "fx_add");
        assert_eq!(session.tools[0].spec.parameters["properties"]["a"]["type"], "number");
    }

    #[test]
    fn a_message_round_trips_through_the_pi_shape() {
        let mut message = Message::user_text("hello");
        message.parts.push(ContentPart::ToolCall(ToolCall {
            id: "call_1".into(),
            name: "fx_add".into(),
            arguments: json!({"a": 20, "b": 22}),
            raw_arguments: None,
        }));
        let wire = message_to_wire(&message);
        assert_eq!(wire["role"], "user");
        assert_eq!(wire["content"][0]["type"], "text");
        assert_eq!(wire["content"][1]["type"], "toolCall");
        let back = message_from_wire(&wire).expect("a readable message");
        assert_eq!(back.role, Role::User);
        assert_eq!(back.parts, message.parts);
    }

    #[test]
    fn a_tool_result_replacement_flattens_content_blocks() {
        let mut result = ToolResult {
            call_id: "call_1".into(),
            name: "fx_add".into(),
            content: "42".into(),
            is_error: false,
            truncated: false,
        };
        apply_tool_result_patch(
            &mut result,
            &json!({"content": [{"type": "text", "text": "42 (replaced)"}]}),
        );
        assert_eq!(result.content, "42 (replaced)");
        assert!(!result.is_error, "isError is only changed when the patch names it");

        apply_tool_result_patch(&mut result, &json!({"content": "plain"}));
        assert_eq!(result.content, "plain");
        // An empty block list is a replacement with nothing in it, and a list of
        // non-text blocks must not silently delete the tool's answer.
        apply_tool_result_patch(&mut result, &json!({"content": [{"type": "image"}]}));
        assert_eq!(result.content, "plain");
        apply_tool_result_patch(&mut result, &json!({"isError": true}));
        assert!(result.is_error);
        assert_eq!(result.content, "plain");
    }

    #[test]
    fn an_unreadable_message_is_not_a_replacement() {
        assert!(message_from_wire(&json!({"role": "critic", "content": []})).is_none());
        assert!(message_from_wire(&json!({"content": []})).is_none());
    }
}
