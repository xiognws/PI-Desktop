//! Host bridge: the kernel's outbound calls to Electron main.
//!
//! Hermes counterpart: none — this is the desktop's own shape, taken from the
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
}

impl HostTool {
    pub fn new(spec: ToolSpec, bridge: Arc<HostBridge>) -> Self {
        Self { spec, bridge }
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
            let params = json!({
                "sessionId": ctx.session_id,
                "turnId": ctx.turn_id,
                "toolCallId": ctx.tool_call_id,
                "toolName": self.spec.name,
                "args": call.arguments,
            });
            match self.bridge.call("tools.execute", params).await {
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
