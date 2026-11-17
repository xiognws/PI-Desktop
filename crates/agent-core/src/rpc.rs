//! NDJSON JSON-RPC 2.0 over stdio.
//!
//! This is the wire the Electron main process already speaks to the Node
//! sidecar (`packages/agent-runtime/src/sidecar.ts`, and the framing helper
//! `readNdjsonLines` in `@pi-workspace/shared`). It is reproduced here rather
//! than redesigned: the protocol is the migration contract, so the renderer and
//! main stay untouched when the process behind it changes.
//!
//! One JSON value per line, both directions. A line that is not valid JSON is
//! answered with `-32700`; a message without `method` with `-32600`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const JSONRPC_VERSION: &str = "2.0";

/// JSON-RPC id: a number or a string, echoed back unchanged.
pub type Id = Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Request {
    #[serde(default = "default_version")]
    pub jsonrpc: String,
    /// Absent for a notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    /// `#[serde(default)]` so a syntactically valid frame that merely lacks
    /// `method` is answered with `-32600` (invalid request), not `-32700`.
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn default_version() -> String {
    JSONRPC_VERSION.to_string()
}

impl Request {
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    pub fn str_param(&self, key: &str) -> Option<&str> {
        self.params.get(key).and_then(Value::as_str)
    }

    pub fn require_str(&self, key: &str) -> Result<&str, RpcError> {
        self.str_param(key)
            .ok_or_else(|| RpcError::invalid_params(format!("`{key}` must be a string")))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Id,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub jsonrpc: &'static str,
    pub id: Id,
    pub error: RpcError,
}

#[derive(Debug, Clone, Serialize)]
pub struct Notification {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(-32700, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(-32600, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("method `{method}` is not implemented"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(-32602, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(-32603, message)
    }

    /// Application-level failure with the sidecar's `-32000` code and a stable
    /// machine-readable `errorCode`, matching what main already maps.
    pub fn app(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
            data: Some(json!({ "errorCode": code.into() })),
        }
    }

    /// Carry a kernel error across the boundary without losing its class.
    pub fn from_agent_error(error: &crate::error::AgentError) -> Self {
        Self::app(error.code(), error.to_string())
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Result of reading one line from the peer.
#[derive(Debug)]
pub enum Incoming {
    Request(Request),
    /// An answer to a call this process issued (the host bridge). The serve
    /// loop routes these to [`crate::host_bridge::HostBridge::complete`] instead
    /// of dispatching them as methods.
    Response {
        id: Id,
        outcome: std::result::Result<Value, RpcError>,
    },
    /// Parsed but unusable: the caller answers with the error, using the id
    /// when one could be recovered (`null` otherwise, per JSON-RPC).
    Invalid {
        error: RpcError,
        id: Option<Id>,
    },
    /// Blank line — keep reading.
    Empty,
}

/// Parse one NDJSON line.
pub fn parse_line(line: &str) -> Incoming {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Incoming::Empty;
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(error) => {
            return Incoming::Invalid {
                error: RpcError::parse_error(format!("invalid JSON: {error}")),
                id: None,
            }
        }
    };

    // A line that answers a call this process issued: an id plus a result or an
    // error, and no method. `host.proxy` replies arrive this way.
    if value.get("method").is_none()
        && value.get("id").is_some()
        && (value.get("result").is_some() || value.get("error").is_some())
    {
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let outcome = match value.get("error") {
            Some(error) if !error.is_null() => {
                match serde_json::from_value::<RpcError>(error.clone()) {
                    Ok(error) => Err(error),
                    Err(parse) => Err(RpcError::parse_error(format!(
                        "malformed error object: {parse}"
                    ))),
                }
            }
            _ => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Incoming::Response { id, outcome };
    }

    match serde_json::from_value::<Request>(value.clone()) {
        Ok(request) => {
            if request.method.trim().is_empty() {
                return Incoming::Invalid {
                    error: RpcError::invalid_request("`method` must be a non-empty string"),
                    id: request.id,
                };
            }
            Incoming::Request(request)
        }
        Err(error) => {
            // Recover the id when the envelope is otherwise unusable, so the
            // caller can still correlate the failure.
            let id = value.get("id").cloned();
            Incoming::Invalid {
                error: RpcError::parse_error(format!("invalid JSON-RPC frame: {error}")),
                id,
            }
        }
    }
}

/// Encode one message as a line, including the trailing newline.
pub fn encode_line<T: Serialize>(message: &T) -> String {
    let mut line = serde_json::to_string(message).unwrap_or_else(|error| {
        // Serializing our own envelopes cannot fail on data; if it somehow
        // does, emit a well-formed internal error rather than a broken frame.
        format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{{\"code\":-32603,\"message\":\"encode failed: {error}\"}}}}"
        )
    });
    line.push('\n');
    line
}

pub fn response(id: Id, result: Value) -> String {
    encode_line(&Response {
        jsonrpc: JSONRPC_VERSION,
        id,
        result,
    })
}

pub fn error_response(id: Id, error: RpcError) -> String {
    encode_line(&ErrorResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        error,
    })
}

pub fn notification(method: impl Into<String>, params: Value) -> String {
    encode_line(&Notification {
        jsonrpc: JSONRPC_VERSION,
        method: method.into(),
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_request_with_an_id() {
        let Incoming::Request(request) =
            parse_line(r#"{"jsonrpc":"2.0","id":7,"method":"sidecar.health","params":{}}"#)
        else {
            panic!("expected a request");
        };
        assert_eq!(request.method, "sidecar.health");
        assert_eq!(request.id, Some(json!(7)));
        assert!(!request.is_notification());
    }

    #[test]
    fn parses_a_notification() {
        let Incoming::Request(request) =
            parse_line(r#"{"jsonrpc":"2.0","method":"agent.event","params":{}}"#)
        else {
            panic!("expected a request");
        };
        assert!(request.is_notification());
    }

    #[test]
    fn recovers_the_id_from_an_invalid_frame() {
        let Incoming::Invalid { error, id } = parse_line(r#"{"id":"abc","method":42}"#) else {
            panic!("expected an invalid frame");
        };
        assert_eq!(error.code, -32700);
        assert_eq!(id, Some(json!("abc")));
    }

    #[test]
    fn blank_lines_are_skipped() {
        assert!(matches!(parse_line("   \n"), Incoming::Empty));
    }

    #[test]
    fn a_missing_method_is_an_invalid_request() {
        let Incoming::Invalid { error, .. } = parse_line(r#"{"jsonrpc":"2.0","id":1}"#) else {
            panic!("expected an invalid frame");
        };
        assert_eq!(error.code, -32600);
    }

    #[test]
    fn responses_and_notifications_are_single_lines() {
        let line = response(json!(1), json!({"ok": true}));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
        let value: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["result"]["ok"], true);

        let line = notification("agent.event", json!({"type": "turn_start"}));
        let value: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["method"], "agent.event");
        assert!(value.get("id").is_none(), "a notification carries no id");
    }

    #[test]
    fn app_errors_keep_their_stable_code() {
        let error = RpcError::app("RUNTIME_NOT_FOUND", "no runtime for session");
        let value = serde_json::to_value(&error).unwrap();
        assert_eq!(value["code"], -32000);
        assert_eq!(value["data"]["errorCode"], "RUNTIME_NOT_FOUND");
    }

    #[test]
    fn required_string_params_report_their_name() {
        let Incoming::Request(request) = parse_line(r#"{"id":1,"method":"m","params":{}}"#) else {
            panic!("expected a request");
        };
        let error = request.require_str("sessionId").unwrap_err();
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("sessionId"));
    }
}
