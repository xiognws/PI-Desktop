//! `Remember` tool body (ADR 0371).
//!
//! Trusted transport fields decide the scope: the tool never takes a project
//! path or session id from `args`. A call inside a session defaults to project
//! scope (the session's own project) and can ask for session or global scope;
//! a session with no project falls back to session scope, because a project
//! memory without a project has nowhere to live.

use std::sync::Arc;
use std::time::Instant;

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::memory::{MemoryKind, MemoryScope, MemorySource, NewMemory};
use crate::state::AppState;
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};

const MAX_TAGS: usize = 6;

pub async fn execute(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
) -> Result<ToolsExecuteResult, JsonRpcError> {
    let started = Instant::now();
    let outcome = run(state, p).await;
    let (ok, content, error_code) = match outcome {
        Ok((descriptor, deduped)) => (
            true,
            json!({ "text": descriptor, "deduped": deduped }),
            None,
        ),
        Err(error) => {
            let code = error
                .data
                .as_ref()
                .and_then(|data| data["errorCode"].as_str())
                .unwrap_or("INTERNAL")
                .to_string();
            (
                false,
                json!({ "error": error.message, "code": code }),
                Some(code),
            )
        }
    };
    Ok(ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    })
}

async fn run(
    state: &Arc<Mutex<AppState>>,
    p: &ToolsExecuteParams,
) -> Result<(String, bool), JsonRpcError> {
    let title = arg_str(&p.args, "title")?;
    let body = arg_str(&p.args, "body")?;
    let kind = match arg_opt_str(&p.args, "kind")? {
        Some(value) => {
            MemoryKind::parse(&value).map_err(|_| invalid(format!("unknown kind: {value}")))?
        }
        None => MemoryKind::Fact,
    };
    let requested_scope = arg_opt_str(&p.args, "scope")?;
    let tags = arg_tags(&p.args)?;

    let st = state.lock().await;
    if st.shutting_down {
        return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
    }

    let project_path = project_path_for_session(&st, &p.session_id)?;
    let scope = match requested_scope.as_deref() {
        Some("global") => MemoryScope::Global,
        Some("session") => MemoryScope::Session,
        Some("project") | None => {
            if project_path.is_some() {
                MemoryScope::Project
            } else {
                MemoryScope::Session
            }
        }
        Some(other) => {
            return Err(invalid(format!(
                "unknown scope: {other}; use project, session or global"
            )))
        }
    };

    let mut input = NewMemory::new(scope, kind, title.clone(), body);
    input.source = MemorySource::Agent;
    input.tags = tags;
    match scope {
        MemoryScope::Project => {
            input.project_path = project_path;
        }
        MemoryScope::Session => {
            input.session_id = Some(p.session_id.clone());
        }
        MemoryScope::Global => {}
    }

    let outcome = st.db.remember(input).map_err(|error| {
        let message = error.to_string();
        if message.contains("exceeds") || message.contains("empty") || message.contains("needs ") {
            invalid(message)
        } else {
            rpc_err(1000, message, "INTERNAL")
        }
    })?;

    let label = format!(
        "{}/{}",
        outcome.memory.scope.as_str(),
        outcome.memory.kind.as_str()
    );
    let text = if outcome.deduped {
        format!("Remembered (existing): {title} [{label}]")
    } else {
        format!("Remembered: {title} [{label}]")
    };
    Ok((text, outcome.deduped))
}

fn invalid(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1002, message, "INVALID_ARGUMENT")
}

fn arg_str(args: &Value, name: &str) -> Result<String, JsonRpcError> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| invalid(format!("{name} required")))
}

fn arg_opt_str(args: &Value, name: &str) -> Result<Option<String>, JsonRpcError> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
        }
        Some(_) => Err(invalid(format!("{name} must be a string"))),
    }
}

fn arg_tags(args: &Value) -> Result<Vec<String>, JsonRpcError> {
    match args.get("tags") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                let tag = item
                    .as_str()
                    .ok_or_else(|| invalid("tags must be an array of strings"))?
                    .trim();
                if !tag.is_empty() {
                    out.push(tag.to_string());
                    if out.len() >= MAX_TAGS {
                        break;
                    }
                }
            }
            Ok(out)
        }
        Some(_) => Err(invalid("tags must be an array of strings")),
    }
}

fn project_path_for_session(
    st: &AppState,
    session_id: &str,
) -> Result<Option<String>, JsonRpcError> {
    st.db
        .conn
        .query_row(
            "SELECT p.path FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?1",
            rusqlite::params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
}
