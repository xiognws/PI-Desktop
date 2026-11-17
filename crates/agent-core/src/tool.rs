//! Tool boundary: declarations, execution and the approval gate.
//!
//! Hermes counterpart: `tools/registry.py` (declarations),
//! `agent/tool_executor.py` (execution, result shaping, pairing) and
//! `tools/approval.py` (the gate). Phase 1 keeps the mechanism and leaves the
//! individual tools to later phases: a tool is anything that can announce a
//! JSON-Schema parameter object and answer one call.
//!
//! Tool failures are *results*, not turn failures: the model has to see what
//! went wrong to recover, so [`ToolRegistry::call`] converts an error into an
//! `is_error` result instead of aborting the turn.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};
use crate::message::{ToolCall, ToolResult};
use crate::provider::BoxFuture;

/// Declaration sent to the provider. `parameters` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

impl ToolSpec {
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// Everything a tool may know about the call it is serving. Deliberately
/// small: a tool that needs host state asks the host bridge, not this struct.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub cancel: CancelToken,
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>>;
}

/// Outcome of asking the gate. `Ask` is answered by the renderer through the
/// `permissions.request` RPC in the sidecar phase; until then a registry
/// configured with `Ask` treats it as a denial rather than running silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Permission {
    Allow,
    Deny(String),
    Ask,
}

impl Permission {
    pub fn deny_outcome(&self) -> Option<String> {
        match self {
            Self::Deny(reason) => Some(reason.clone()),
            Self::Ask => Some("waiting for user approval is not available in this runtime".into()),
            Self::Allow => None,
        }
    }
}

pub trait PermissionGate: Send + Sync {
    fn decide(&self, tool_name: &str, arguments: &Value) -> Permission;
}

/// Gate used by the self-check and by tests: every tool is allowed.
#[derive(Debug, Default, Clone, Copy)]
pub struct AllowAll;

impl PermissionGate for AllowAll {
    fn decide(&self, _tool_name: &str, _arguments: &Value) -> Permission {
        Permission::Allow
    }
}

/// Gate that denies a fixed set of tool names. The desktop's persisted
/// per-tool policy becomes a `PermissionGate` implementation later.
#[derive(Debug, Clone)]
pub struct DenyList {
    denied: Vec<String>,
}

impl DenyList {
    pub fn new<I, S>(denied: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            denied: denied.into_iter().map(Into::into).collect(),
        }
    }
}

impl PermissionGate for DenyList {
    fn decide(&self, tool_name: &str, _arguments: &Value) -> Permission {
        if self.denied.iter().any(|denied| denied == tool_name) {
            Permission::Deny(format!("`{tool_name}` is denied by policy"))
        } else {
            Permission::Allow
        }
    }
}

pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
    gate: Arc<dyn PermissionGate>,
    /// Result ceiling from spec 16. `None` keeps results uncut.
    result_limit_chars: Option<usize>,
}

impl ToolRegistry {
    pub fn new(gate: Arc<dyn PermissionGate>) -> Self {
        Self {
            tools: BTreeMap::new(),
            gate,
            result_limit_chars: None,
        }
    }

    pub fn with_result_limit(mut self, limit: usize) -> Self {
        self.result_limit_chars = Some(limit);
        self
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.insert(tool.spec().name, tool);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(|tool| tool.spec()).collect()
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Execute one call. Never returns `Err` for a tool-level failure: the
    /// failure becomes a result the model can read.
    pub async fn call(&self, call: &ToolCall, ctx: &ToolContext) -> ToolResult {
        let mut result = self.dispatch(call, ctx).await;
        if let Some(limit) = self.result_limit_chars {
            let (content, truncated) = truncate_result(&result.content, limit);
            result.content = content;
            result.truncated |= truncated;
        }
        result
    }

    async fn dispatch(&self, call: &ToolCall, ctx: &ToolContext) -> ToolResult {
        let error = |message: String| ToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: message,
            is_error: true,
            truncated: false,
        };

        if ctx.cancel.is_cancelled() {
            return error("cancelled before the tool ran".into());
        }
        if let Some(raw) = &call.raw_arguments {
            return error(format!(
                "arguments were not valid JSON, so `{}` did not run: {raw}",
                call.name
            ));
        }
        if let Some(reason) = self.gate.decide(&call.name, &call.arguments).deny_outcome() {
            return error(reason);
        }
        let Some(tool) = self.tools.get(&call.name) else {
            return error(format!("no tool named `{}` is registered", call.name));
        };

        let outcome = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => Err(AgentError::Cancelled),
            outcome = tool.call(call, ctx) => outcome,
        };

        match outcome {
            Ok(content) => ToolResult {
                call_id: call.id.clone(),
                name: call.name.clone(),
                content,
                is_error: false,
                truncated: false,
            },
            Err(AgentError::Cancelled) => error("cancelled while running".into()),
            Err(other) => error(other.to_string()),
        }
    }
}

/// Cut a result to the configured ceiling, keeping the head and the tail so a
/// log dump or a stack trace still carries its conclusion.
pub fn truncate_result(content: &str, limit: usize) -> (String, bool) {
    if limit == 0 || content.chars().count() <= limit {
        return (content.to_string(), false);
    }
    let chars: Vec<char> = content.chars().collect();
    let head_len = limit * 2 / 3;
    let tail_len = limit - head_len;
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    let omitted = chars.len() - head_len - tail_len;
    (
        format!("{head}\n[... {omitted} characters omitted by the tool-result limit ...]\n{tail}"),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo;

    impl Tool for Echo {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "echo",
                "Echo the `text` argument back",
                serde_json::json!({
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"]
                }),
            )
        }

        fn call<'a>(
            &'a self,
            call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move {
                Ok(call
                    .arguments
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string())
            })
        }
    }

    struct Failing;

    impl Tool for Failing {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "boom",
                "Always fails",
                serde_json::json!({"type": "object"}),
            )
        }

        fn call<'a>(
            &'a self,
            _call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move {
                Err(AgentError::Tool {
                    tool: "boom".into(),
                    message: "disk is on fire".into(),
                })
            })
        }
    }

    fn ctx() -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            cancel: CancelToken::new(),
        }
    }

    fn call(name: &str, arguments: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: name.into(),
            arguments,
            raw_arguments: None,
        }
    }

    fn registry() -> ToolRegistry {
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(Echo));
        registry.register(Arc::new(Failing));
        registry
    }

    #[tokio::test]
    async fn registered_tool_runs_and_returns_content() {
        let result = registry()
            .call(&call("echo", serde_json::json!({"text": "hi"})), &ctx())
            .await;
        assert!(!result.is_error);
        assert_eq!(result.content, "hi");
        assert_eq!(result.call_id, "call_1");
    }

    #[tokio::test]
    async fn unknown_tool_becomes_an_error_result() {
        let result = registry().call(&call("nope", Value::Null), &ctx()).await;
        assert!(result.is_error);
        assert!(result.content.contains("no tool named"));
    }

    #[tokio::test]
    async fn tool_failure_does_not_abort_the_turn() {
        let result = registry().call(&call("boom", Value::Null), &ctx()).await;
        assert!(result.is_error);
        assert!(result.content.contains("disk is on fire"));
    }

    #[tokio::test]
    async fn denied_tool_never_runs() {
        let mut registry = ToolRegistry::new(Arc::new(DenyList::new(["echo"])));
        registry.register(Arc::new(Echo));
        let result = registry
            .call(&call("echo", serde_json::json!({"text": "hi"})), &ctx())
            .await;
        assert!(result.is_error);
        assert!(result.content.contains("denied by policy"));
    }

    #[tokio::test]
    async fn malformed_arguments_are_reported_instead_of_guessed() {
        let mut malformed = call("echo", Value::Null);
        malformed.raw_arguments = Some("{\"text\": ".into());
        let result = registry().call(&malformed, &ctx()).await;
        assert!(result.is_error);
        assert!(result.content.contains("not valid JSON"));
    }

    #[tokio::test]
    async fn result_limit_keeps_head_and_tail() {
        let registry = {
            let mut registry = ToolRegistry::new(Arc::new(AllowAll));
            registry.register(Arc::new(Echo));
            registry.with_result_limit(20)
        };
        let long = "A".repeat(40) + "TAIL";
        let result = registry
            .call(&call("echo", serde_json::json!({"text": long})), &ctx())
            .await;
        assert!(result.truncated);
        assert!(result.content.contains("characters omitted"));
        assert!(result.content.ends_with("TAIL"));
    }

    #[test]
    fn truncate_is_a_no_op_below_the_limit() {
        let (content, truncated) = truncate_result("short", 100);
        assert_eq!(content, "short");
        assert!(!truncated);
    }

    #[test]
    fn specs_are_stable_and_sorted() {
        let registry = registry();
        let names: Vec<_> = registry.specs().into_iter().map(|spec| spec.name).collect();
        assert_eq!(names, vec!["boom", "echo"]);
    }

    #[tokio::test]
    async fn cancelled_token_short_circuits_execution() {
        let context = ctx();
        context.cancel.cancel();
        let result = registry()
            .call(&call("echo", serde_json::json!({"text": "hi"})), &context)
            .await;
        assert!(result.is_error);
        assert!(result.content.contains("cancelled"));
    }
}
