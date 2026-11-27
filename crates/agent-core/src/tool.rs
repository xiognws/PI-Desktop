//! Tool boundary: declarations, execution and the approval gate.
//!
//! Upstream counterpart: `tools/registry.py` (declarations),
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
use crate::exec_policy::{ExecPolicy, ExecPolicyCell, ExecVerdict};
use crate::hooks::{HookChain, HookOutcome};
use crate::message::{ToolCall, ToolResult};
use crate::provider::BoxFuture;

/// Declaration sent to the provider. `parameters` is a JSON Schema object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    /// Action names this `plugin_*` tool may run in a contract mode (Plan/Goal).
    ///
    /// Upstream counterpart: `PluginToolDef.planSafeActions`
    /// (`packages/agent-runtime/src/runtime.ts`), the same list the Node runtime
    /// forwards to host-core (ADR 0211). It never reaches the provider — the
    /// request bodies in `provider::http` build their declarations field by field
    /// — so it is a kernel-to-host detail carried on `tools.execute`.
    ///
    /// `None` is the fail-closed default: host-core denies a plugin tool in a
    /// contract mode unless it declares a non-empty list. An empty list means the
    /// same there, so the two spellings are collapsed into `None` on the way in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_safe_actions: Option<Vec<String>>,
}

impl ToolSpec {
    pub fn new(name: impl Into<String>, description: impl Into<String>, parameters: Value) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
            plan_safe_actions: None,
        }
    }

    /// The same declaration, carrying host-core's Plan/Goal carve-out list.
    ///
    /// An empty list is stored as `None`: host-core treats "declared but empty"
    /// and "not declared" identically, and one spelling keeps every downstream
    /// `is_some` check honest.
    pub fn with_plan_safe_actions<I, S>(mut self, actions: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let actions: Vec<String> = actions.into_iter().map(Into::into).collect();
        self.plan_safe_actions = if actions.is_empty() {
            None
        } else {
            Some(actions)
        };
        self
    }
}

/// Everything a tool may know about the call it is serving. Deliberately
/// small: a tool that needs host state asks the host bridge, not this struct.
#[derive(Clone)]
pub struct ToolContext {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub cancel: CancelToken,
    /// Where a mid-turn message lands, when this turn accepts steering.
    ///
    /// A tool that waits on the host watches this: a steer that arrives while it
    /// runs means the work has been redirected, and the host is asked to stop.
    pub steering: Option<std::sync::Arc<dyn crate::steering::SteeringSource>>,
}

impl std::fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("session_id", &self.session_id)
            .field("turn_id", &self.turn_id)
            .field("tool_call_id", &self.tool_call_id)
            .field("steering", &self.steering.is_some())
            .finish()
    }
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>>;

    /// The same call, keeping the structured details a client renders.
    ///
    /// Upstream's tools answer `{ content, details }`: the model reads the text,
    /// and the renderer (subagent topology, background jobs), Electron's
    /// persistence layer and host-core read `result.details`. A tool that owns
    /// structured state overrides this; every other tool keeps the string-only
    /// contract and reports no details, which is what the default does.
    fn call_with_details<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<ToolOutcome>> {
        Box::pin(async move { self.call(call, ctx).await.map(ToolOutcome::text) })
    }
}

/// One tool result: the text the model reads, plus what a client may want.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolOutcome {
    pub content: String,
    /// Rendered verbatim as `result.details`; `None` leaves the row text-only.
    pub details: Option<Value>,
}

impl ToolOutcome {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            details: None,
        }
    }

    pub fn with_details(content: impl Into<String>, details: Value) -> Self {
        Self {
            content: content.into(),
            details: Some(details),
        }
    }
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
    /// Policy hooks that run before the gate's answer is acted on: they can refuse
    /// a call or rewrite its arguments.
    hooks: Option<Arc<HookChain>>,
    /// The execution boundary: which command shapes never leave the kernel. Distinct
    /// from the gate (may this tool run) and from the hooks (this session's rules):
    /// this is the shape a behaviour engine scores, and it applies to every session.
    exec: Option<Arc<ExecPolicyCell>>,
}

impl ToolRegistry {
    pub fn new(gate: Arc<dyn PermissionGate>) -> Self {
        Self {
            tools: BTreeMap::new(),
            gate,
            result_limit_chars: None,
            hooks: None,
            exec: None,
        }
    }

    pub fn with_result_limit(mut self, limit: usize) -> Self {
        self.result_limit_chars = Some(limit);
        self
    }

    /// Attach the execution policy. A registry without one runs whatever the model
    /// writes, which is the default only because the sidecar always sets it.
    pub fn with_exec_policy(mut self, policy: Arc<ExecPolicyCell>) -> Self {
        self.exec = Some(policy);
        self
    }

    /// The active execution policy, for a health report.
    pub fn exec_policy(&self) -> Option<ExecPolicy> {
        self.exec.as_ref().map(|cell| cell.snapshot())
    }

    /// What every declared tool is, by risk class. A panel can show this; a policy
    /// decision can be made from it.
    pub fn classes(&self) -> Vec<(String, crate::exec_policy::ToolClass)> {
        let cell = self
            .exec
            .clone()
            .unwrap_or_else(|| ExecPolicyCell::new(ExecPolicy::default()));
        self.tools
            .values()
            .map(|tool| {
                let spec = tool.spec();
                (
                    spec.name.clone(),
                    cell.classify(&spec.name, &serde_json::json!({})),
                )
            })
            .collect()
    }

    /// Attach the session's hook chain. It is consulted for every call, before the
    /// tool is looked up, because a rewrite changes which arguments the tool sees.
    pub fn with_hooks(mut self, hooks: Arc<HookChain>) -> Self {
        self.hooks = Some(hooks);
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

    /// The tool registered under `name`, so a kernel tool can forward a call to
    /// the host-declared handler it wraps.
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// A copy of this registry with extra tools added.
    ///
    /// A per-session tool has to be built per prompt (its catalog belongs to one
    /// session), while the host's declarations are shared — so the registry is
    /// copied rather than mutated in place, and two sessions cannot see each
    /// other's tools.
    /// A copy holding only `names`, keeping the same gate.
    ///
    /// A subagent gets exactly the tools its definition declares: delegation must
    /// not become a way to reach a capability the parent's definition withheld.
    pub fn restricted(&self, names: &[String]) -> ToolRegistry {
        let tools = self
            .tools
            .iter()
            .filter(|(name, _)| names.iter().any(|wanted| wanted == *name))
            .map(|(name, tool)| (name.clone(), tool.clone()))
            .collect();
        ToolRegistry {
            tools,
            gate: self.gate.clone(),
            result_limit_chars: self.result_limit_chars,
            hooks: self.hooks.clone(),
            exec: self.exec.clone(),
        }
    }

    pub fn extended(&self, extra: Vec<Arc<dyn Tool>>) -> ToolRegistry {
        let mut tools = self.tools.clone();
        for tool in extra {
            tools.insert(tool.spec().name, tool);
        }
        ToolRegistry {
            tools,
            gate: self.gate.clone(),
            result_limit_chars: self.result_limit_chars,
            hooks: self.hooks.clone(),
            exec: self.exec.clone(),
        }
    }

    /// Execute one call. Never returns `Err` for a tool-level failure: the
    /// failure becomes a result the model can read.
    pub async fn call(&self, call: &ToolCall, ctx: &ToolContext) -> ToolResult {
        self.call_with_details(call, ctx).await.0
    }

    /// Execute one call, keeping the structured details its client renders.
    ///
    /// A transcript reader (the model) needs only the text; a renderer reading
    /// the same row through `result.details` needs the structure a tool chose to
    /// publish. Callers that persist or draw a row use this one.
    pub async fn call_with_details(
        &self,
        call: &ToolCall,
        ctx: &ToolContext,
    ) -> (ToolResult, Option<Value>) {
        let mut outcome = self.dispatch(call, ctx).await;
        if let Some(limit) = self.result_limit_chars {
            let (content, truncated) = truncate_result(&outcome.0.content, limit);
            outcome.0.content = content;
            outcome.0.truncated |= truncated;
        }
        outcome
    }

    async fn dispatch(&self, call: &ToolCall, ctx: &ToolContext) -> (ToolResult, Option<Value>) {
        let error = |message: String| {
            (
                ToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: message,
                    is_error: true,
                    truncated: false,
                },
                None,
            )
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
        // The execution boundary runs before anything is dispatched: a command shape
        // that gets a legitimate binary terminated must not reach the host at all.
        if let Some(policy) = &self.exec {
            if let ExecVerdict::Deny(reason) = policy.check(&call.name, &call.arguments) {
                tracing::debug!(
                    target: "agent_core::tool",
                    tool = %call.name,
                    "execution policy refused a call"
                );
                return error(reason);
            }
        }
        // Hooks run after the gate: a denial is a policy the session may not
        // override, while a rewrite is a correction to a call that was allowed.
        let mut effective = call.clone();
        if let Some(hooks) = &self.hooks {
            match hooks.decide(&call.name, &call.arguments) {
                HookOutcome::Allow => {}
                HookOutcome::Deny(reason) => return error(reason),
                HookOutcome::Rewrite(arguments) => {
                    effective.arguments = arguments;
                    effective.raw_arguments = None;
                }
            }
        }
        let Some(tool) = self.tools.get(&effective.name) else {
            return error(format!("no tool named `{}` is registered", effective.name));
        };

        let outcome = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => Err(AgentError::Cancelled),
            outcome = tool.call_with_details(&effective, ctx) => outcome,
        };

        match outcome {
            Ok(outcome) => (
                ToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: outcome.content,
                    is_error: false,
                    truncated: false,
                },
                outcome.details,
            ),
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
            steering: None,
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

    /// A tool that mutates: what an approval floor actually governs.
    struct Mutating;

    impl Tool for Mutating {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "Write",
                "Write a file",
                serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}}),
            )
        }

        fn call<'a>(
            &'a self,
            _call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move { Ok("written".to_string()) })
        }
    }

    /// The worker's tool set is the parent's gate, not a second policy.
    ///
    /// A subagent runs on a registry derived with `restricted()`, which keeps the same
    /// `ApprovalCell`. So a read-only session refuses the worker's write for exactly the
    /// reason it refuses the orchestrator's, and lifting the floor mid-flight lets the
    /// already-built worker through — a snapshot of the decision would not.
    #[tokio::test]
    async fn a_subagent_inherits_the_session_permission_floor_live() {
        use crate::approval::{ApprovalCell, ApprovalGate, ApprovalPolicy};

        // A session owns a workspace: a write inside it is an edit, and an edit is what
        // the floor governs. Without one the call classifies as dangerous instead.
        let cell = ApprovalCell::new(ApprovalPolicy::reviewer().with_workspace("E:/proj"));
        let gate: Arc<dyn PermissionGate> = ApprovalGate::new(Arc::new(AllowAll), cell.clone());
        let mut session = ToolRegistry::new(gate);
        session.register(Arc::new(Mutating));

        let worker_names = vec!["Write".to_string()];
        let worker = session.restricted(&worker_names);
        let call = call("Write", serde_json::json!({"path": "E:/proj/a.txt"}));

        let refused = worker.call(&call, &ctx()).await;
        assert!(
            refused.is_error,
            "a read-only session must refuse the worker's write: {}",
            refused.content
        );
        assert!(
            refused.content.to_lowercase().contains("read-only")
                || refused.content.to_lowercase().contains("editable")
                || refused.content.to_lowercase().contains("approval"),
            "the refusal must name the permission, not just fail: {}",
            refused.content
        );

        // The user switches the session window to a mode that allows edits.
        cell.set_floor(crate::approval::DangerLevel::Editable);

        let allowed = worker.call(&call, &ctx()).await;
        assert!(
            !allowed.is_error,
            "the same worker must follow the session's new floor: {}",
            allowed.content
        );
        assert_eq!(allowed.content, "written");
    }

    /// Publishes structured details next to its text.
    struct Detailed;

    impl Tool for Detailed {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(
                "detailed",
                "Answers with details",
                serde_json::json!({"type": "object"}),
            )
        }

        fn call<'a>(
            &'a self,
            _call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move { Ok("the text".to_string()) })
        }

        fn call_with_details<'a>(
            &'a self,
            _call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, Result<ToolOutcome>> {
            Box::pin(async move {
                Ok(ToolOutcome::with_details(
                    "the text",
                    serde_json::json!({"delegationId": "d1", "status": "running"}),
                ))
            })
        }
    }

    #[tokio::test]
    async fn details_reach_the_caller_that_draws_the_row() {
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(Detailed));
        let (result, details) = registry
            .call_with_details(&call("detailed", Value::Null), &ctx())
            .await;
        assert_eq!(result.content, "the text");
        assert_eq!(
            details,
            Some(serde_json::json!({"delegationId": "d1", "status": "running"}))
        );
        // The model-facing path stays string-only, and a tool that publishes
        // nothing reports no details at all.
        let text_only = registry.call(&call("detailed", Value::Null), &ctx()).await;
        assert_eq!(text_only.content, "the text");
        let (_, no_details) = registry
            .call_with_details(&call("echo", serde_json::json!({"text": "hi"})), &ctx())
            .await;
        assert_eq!(no_details, None);
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
