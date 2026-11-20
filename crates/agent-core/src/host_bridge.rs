//! Host bridge: the kernel's outbound calls to Electron main.
//!
//! Upstream counterpart: none — this is the desktop's own shape, taken from the
//! Node runtime's `ParentHostProxy` (`packages/agent-runtime/src/parent-host-proxy.ts`).
//! The kernel does not implement filesystem, shell or search tools itself: it
//! asks main, main applies permissions against host-core, and the answer comes
//! back on the same stdio channel.
//!
//! Wire shape (unchanged from the Node sidecar):
//!
//! ```text
//! kernel -> main   {"jsonrpc":"2.0","id":"<uuid>","method":"host.proxy",
//!                   "params":{"method":"tools.execute","params":{...}}}
//! main -> kernel   {"jsonrpc":"2.0","id":"<uuid>","result":{...}}   (or "error")
//! ```
//!
//! Because main calls back with the same id, these frames are *responses*, not
//! requests: the serve loop routes them here instead of dispatching them, and a
//! line that carries both an id and a `result`/`error` but no `method` is
//! treated as one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{AgentError, Result};
use crate::message::{ToolCall, ToolResult};
use crate::provider::BoxFuture;
use crate::rpc::{self, RpcError};
use crate::sidecar::LineSink;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Failure classes a bridge call can end in. `Timeout` and `Closed` are
/// distinct from an RPC error because the caller must not treat them as a
/// refusal from the host.
#[derive(Debug, Clone)]
pub enum HostError {
    Rpc(RpcError),
    Timeout { method: String, millis: u64 },
    Closed,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rpc(error) => write!(f, "host refused: {error}"),
            Self::Timeout { method, millis } => {
                write!(f, "host call `{method}` timed out after {millis} ms")
            }
            Self::Closed => f.write_str("the host channel is closed"),
        }
    }
}

impl std::error::Error for HostError {}

pub struct HostBridge {
    out: Arc<dyn LineSink>,
    pending: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, RpcError>>>>,
    closed: Mutex<Option<String>>,
    timeout: Duration,
}

impl HostBridge {
    /// Default ceiling for one host call. Tool calls can legitimately take
    /// minutes (a build, a shell command), so this is generous; the host's own
    /// per-tool timeouts are the real limit.
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

    pub fn new(out: Arc<dyn LineSink>) -> Self {
        Self {
            out,
            pending: Mutex::new(HashMap::new()),
            closed: Mutex::new(None),
            timeout: Self::DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|p| p.len()).unwrap_or(0)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.lock().map(|c| c.is_some()).unwrap_or(true)
    }

    /// Issue one host call and await its answer.
    pub async fn call(&self, method: &str, params: Value) -> std::result::Result<Value, HostError> {
        if self.is_closed() {
            return Err(HostError::Closed);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| HostError::Closed)?;
            pending.insert(id.clone(), tx);
        }
        let line = rpc::encode_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "host.proxy",
            "params": { "method": method, "params": params },
        }));
        self.out.send_line(line);

        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(outcome)) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                outcome.map_err(HostError::Rpc)
            }
            // The sender was dropped: `fail_all` ran while we waited.
            Ok(Err(_)) => Err(HostError::Closed),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(HostError::Timeout {
                    method: method.to_string(),
                    millis: self.timeout.as_millis() as u64,
                })
            }
        }
    }

    /// Complete a pending call with the peer's answer. Unknown ids (a reply
    /// that arrived after its timeout) are dropped.
    pub fn complete(&self, id: &str, outcome: std::result::Result<Value, RpcError>) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        if let Some(sender) = sender {
            let _ = sender.send(outcome);
        } else {
            tracing::debug!(target: "agent_core::host_bridge", %id, "response for an unknown call id");
        }
    }

    /// The peer went away: every waiter fails instead of hanging until timeout.
    pub fn fail_all(&self, reason: &str) {
        if let Ok(mut closed) = self.closed.lock() {
            if closed.is_none() {
                *closed = Some(reason.to_string());
            }
        }
        let drained: Vec<_> = self
            .pending
            .lock()
            .map(|mut pending| pending.drain().collect())
            .unwrap_or_default();
        for (_, sender) in drained {
            // Dropping the sender is what wakes the waiter with `Closed`.
            drop(sender);
        }
    }
}

/// A tool whose implementation lives in the host.
///
/// Declarations arrive from main (`sidecar.configure` → `tools`), because the
/// host is the side that knows which tools exist and what their schemas are;
/// the kernel only relays the call and interprets the answer.
pub struct HostTool {
    spec: ToolSpec,
    bridge: Arc<HostBridge>,
    /// The shell this session runs commands in, for `Bash` only.
    ///
    /// The host refuses a `Bash` call whose stated shell does not match the one it
    /// resolved, because the same command means different things in different
    /// shells. Passing the prompt's own identity is what keeps them in step.
    shell: Option<crate::builtin_tools::ShellIdentity>,
    /// The session mode this call runs under.
    ///
    /// host-core requires it on `tools.execute` and evaluates the call against
    /// that mode's permission ceiling, so it travels with the tool rather than
    /// being guessed at call time.
    mode: String,
}

impl HostTool {
    pub fn new(spec: ToolSpec, bridge: Arc<HostBridge>) -> Self {
        Self {
            spec,
            bridge,
            shell: None,
            mode: "agent".to_string(),
        }
    }

    /// The same tool, told which session mode its calls belong to.
    pub fn with_mode(mut self, mode: impl Into<String>) -> Self {
        self.mode = mode.into();
        self
    }

    /// The same tool, told which shell a `Bash` call runs in.
    pub fn with_shell(mut self, shell: Option<crate::builtin_tools::ShellIdentity>) -> Self {
        self.shell = shell;
        self
    }

    /// Map the host's `{ok, content, isError?, errorCode?}` answer onto the
    /// kernel's tool-result vocabulary.
    fn interpret(&self, call: &ToolCall, value: &Value) -> Result<String> {
        let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
        let is_error = value
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
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
            .unwrap_or("TOOL_FAILED");
        let message = if content.is_empty() {
            format!("`{}` failed ({error_code})", self.spec.name)
        } else {
            content
        };
        let denied = value
            .get("denied")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || error_code == "PERMISSION_DENIED";
        Err(if denied {
            AgentError::ToolDenied {
                tool: call.name.clone(),
                reason: message,
            }
        } else {
            AgentError::Tool {
                tool: call.name.clone(),
                message,
            }
        })
    }
}

/// How often a running tool asks whether a steer has arrived.
///
/// The queue is a plain mutex, so there is nothing to await: 50ms is far below a
/// person's sense of "immediately" and costs one uncontended lock per tick.
const STEER_WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

impl HostTool {
    /// Ask the host to stop the work this call started, and say which call it was.
    ///
    /// Fire and forget on purpose: this runs on the path that is already trying to stop
    /// waiting for a tool, so awaiting the courtesy call's answer is the one thing it
    /// must not do. A host with no `tools.abort` handler — or one that is mid-restart —
    /// would otherwise hold the tool until the RPC timeout, which is exactly the
    /// five-minute build the steer was meant to cut short, and a Stop would wait the
    /// same way before the turn could end. Failure is logged, not propagated.
    fn abort_call(&self, ctx: &ToolContext) {
        let bridge = self.bridge.clone();
        let params = json!({
            "sessionId": ctx.session_id,
            "toolCallId": ctx.tool_call_id,
            "toolName": self.spec.name,
        });
        let name = self.spec.name.clone();
        let call_id = ctx.tool_call_id.clone();
        tokio::spawn(async move {
            if let Err(error) = bridge.call("tools.abort", params).await {
                tracing::debug!(
                    target: "agent_core::host_bridge",
                    tool = %name,
                    call = %call_id,
                    %error,
                    "tools.abort was not answered"
                );
            }
        });
    }
}

impl Tool for HostTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            // Both halves of the turn identity are stamped on every call: the
            // host uses them to attribute the call to a dispatchable turn and to
            // record the approval trail.
            let mut params = json!({
                "sessionId": ctx.session_id,
                "turnId": ctx.turn_id,
                "toolCallId": ctx.tool_call_id,
                "toolName": self.spec.name,
                "args": call.arguments,
                // Mandatory on the host side and part of how the call is
                // evaluated, so it is sent on every call rather than defaulted
                // there.
                "mode": self.mode,
            });
            if self.spec.name == "Bash" {
                if let Some(shell) = &self.shell {
                    // The identity is what the host compares against the shell it
                    // resolved. The id always travels; the dialect only when it is
                    // known, because a wrong dialect fails the call as surely as a
                    // wrong id.
                    params["expectedCommandShellId"] = json!(shell.id);
                    if let Some(dialect) = &shell.dialect {
                        params["expectedCommandShellDialect"] = json!(dialect);
                    }
                }
            }
            // A stopped turn must stop the work the host is doing, not just this
            // kernel's wait. The host runs the tool in its own process; without
            // `tools.abort` a long command keeps running after the user pressed
            // Stop, and its output has nowhere to go.
            let execute = self.bridge.call("tools.execute", params);
            tokio::pin!(execute);

            // A steer is not a Stop, but it does mean the work in flight has been
            // redirected: a five-minute build the user has just written past should
            // not be waited out. The host is asked to stop it with the same call
            // Stop makes, and its aborted result becomes this call's answer — the
            // steer itself lands on the transcript at the next step boundary.
            //
            // A background command is deliberately left alone: it outlives the call
            // by design, and killing it would lose work the user asked to keep
            // running.
            let watch_steering = call.arguments.get("runInBackground") != Some(&json!(true));
            let mut steer_abort_sent = false;
            if watch_steering && ctx.steering.as_ref().is_some_and(|queue| queue.pending()) {
                steer_abort_sent = true;
                self.abort_call(ctx);
            }

            let outcome = loop {
                tokio::select! {
                    biased;
                    _ = ctx.cancel.cancelled() => {
                        self.abort_call(ctx);
                        return Err(AgentError::Cancelled);
                    }
                    outcome = &mut execute => break outcome,
                    _ = tokio::time::sleep(STEER_WATCH_INTERVAL) => {
                        if !steer_abort_sent
                            && watch_steering
                            && ctx.steering.as_ref().is_some_and(|queue| queue.pending())
                        {
                            steer_abort_sent = true;
                            self.abort_call(ctx);
                        }
                    }
                }
            };
            match outcome {
                Ok(value) => self.interpret(call, &value),
                Err(HostError::Rpc(error)) => Err(map_host_rpc_error(error)),
                Err(other) => Err(AgentError::Transport(other.to_string())),
            }
        })
    }
}

/// The host answered with a JSON-RPC error. Its `errorCode` is the machine code
/// the renderer classifies on, so it is carried through instead of collapsed
/// into a generic failure.
fn map_host_rpc_error(error: RpcError) -> AgentError {
    let code = error
        .data
        .as_ref()
        .and_then(|data| data.get("errorCode"))
        .and_then(Value::as_str)
        .unwrap_or("HOST_ERROR")
        .to_string();
    AgentError::Host {
        code,
        message: error.message,
    }
}

/// Parse a tool declaration sent by main.
pub fn tool_spec_from_value(value: &Value) -> std::result::Result<ToolSpec, String> {
    // Two spellings mean the same thing: a host may forward a declaration as it
    // stores it (`{name, description, parameters}`) or as a provider expects it
    // (`{type: "function", function: {...}}`). Reading only one of them turns a
    // perfectly good declaration into an invalid-params error at the prompt.
    let value = match value.get("function").filter(|inner| inner.is_object()) {
        Some(inner) => inner,
        None => value,
    };
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "a tool declaration needs `name`".to_string())?;
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let parameters = value
        .get("parameters")
        .cloned()
        .unwrap_or_else(|| json!({"type": "object"}));
    Ok(ToolSpec::new(name, description, parameters))
}

/// Helper for tests and the self-check: a tool result built from a host answer.
pub fn tool_result_from_host(call: &ToolCall, value: &Value) -> ToolResult {
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let content = match value.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    ToolResult {
        call_id: call.id.clone(),
        name: call.name.clone(),
        content,
        is_error: !ok,
        truncated: false,
    }
}

#[cfg(test)]
mod declaration_shape_tests {
    use super::*;

    #[test]
    fn a_flat_declaration_reads_as_itself() {
        let spec = tool_spec_from_value(&json!({
            "name": "Bash",
            "description": "Run a command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
        }))
        .expect("a flat declaration");
        assert_eq!(spec.name, "Bash");
        assert_eq!(spec.description, "Run a command");
        assert_eq!(spec.parameters["properties"]["command"]["type"], "string");
    }

    #[test]
    fn a_provider_wrapped_declaration_reads_the_same() {
        // A host that forwards `{type: "function", function: {...}}` is not
        // making a mistake, and refusing it would look like a broken prompt.
        let spec = tool_spec_from_value(&json!({
            "type": "function",
            "function": {
                "name": "Read",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
            }
        }))
        .expect("a wrapped declaration");
        assert_eq!(spec.name, "Read");
        assert_eq!(spec.description, "Read a file");
        assert_eq!(spec.parameters["properties"]["path"]["type"], "string");
    }

    #[test]
    fn a_declaration_without_a_name_is_refused() {
        assert!(tool_spec_from_value(&json!({"description": "nothing"})).is_err());
        assert!(tool_spec_from_value(&json!({"type": "function", "function": {}})).is_err());
    }
}
