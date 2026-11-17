//! Kernel error type. Mirrors the `AppError`/`agent-errors.ts` split used by
//! the Node runtime: transport problems, provider problems, tool failures and
//! cancellation stay distinguishable so the renderer can classify them.

use thiserror::Error;

pub type Result<T, E = AgentError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("provider error ({kind}): {message}")]
    Provider {
        kind: ProviderErrorKind,
        message: String,
        /// HTTP status when the failure came from a response, not the transport.
        status: Option<u16>,
    },
    #[error("tool `{tool}` failed: {message}")]
    Tool { tool: String, message: String },
    #[error("tool `{tool}` is not registered")]
    UnknownTool { tool: String },
    #[error("tool `{tool}` was denied: {reason}")]
    ToolDenied { tool: String, reason: String },
    #[error("turn cancelled")]
    Cancelled,
    #[error("turn exceeded its {limit}-step budget")]
    StepLimit { limit: usize },
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("stream ended before the provider finished the response")]
    IncompleteStream,
    #[error("transport: {0}")]
    Transport(String),
    #[error("host error ({code}): {message}")]
    Host { code: String, message: String },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl AgentError {
    /// Stable machine code for logs and RPC error payloads.
    pub fn code(&self) -> &str {
        match self {
            Self::Provider { .. } => "PROVIDER_ERROR",
            Self::Tool { .. } => "TOOL_ERROR",
            Self::UnknownTool { .. } => "TOOL_NOT_FOUND",
            Self::ToolDenied { .. } => "TOOL_DENIED",
            Self::Cancelled => "TURN_CANCELLED",
            Self::StepLimit { .. } => "STEP_LIMIT",
            Self::Invalid(_) => "INVALID_REQUEST",
            Self::IncompleteStream => "INCOMPLETE_STREAM",
            Self::Transport(_) => "TRANSPORT_ERROR",
            Self::Host { code, .. } => code,
            Self::Json(_) => "INVALID_JSON",
        }
    }
}

/// Failure classes the recovery policy cares about. `Retryable` may be retried
/// after backoff; `Fatal` must surface to the user unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderErrorKind {
    /// DNS, connect, TLS, socket reset, timeout.
    Transport,
    /// 429 / 5xx.
    Retryable,
    /// 401 / 403 / 404 / 400 — the request or credentials are wrong.
    Fatal,
    /// The stream decoded into something the provider contract forbids.
    Protocol,
}

impl std::fmt::Display for ProviderErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Transport => "transport",
            Self::Retryable => "retryable",
            Self::Fatal => "fatal",
            Self::Protocol => "protocol",
        };
        f.write_str(name)
    }
}

impl AgentError {
    pub fn provider(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self::Provider {
            kind,
            message: message.into(),
            status: None,
        }
    }

    pub fn provider_status(
        kind: ProviderErrorKind,
        status: u16,
        message: impl Into<String>,
    ) -> Self {
        Self::Provider {
            kind,
            message: message.into(),
            status: Some(status),
        }
    }

    /// Whether the recovery policy may re-issue the same request.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Provider {
                kind: ProviderErrorKind::Transport | ProviderErrorKind::Retryable,
                ..
            }
        )
    }
}
