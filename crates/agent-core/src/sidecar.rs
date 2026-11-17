//! The sidecar process: JSON-RPC methods over one stdio channel.
//!
//! Hermes counterpart: none — this layer is the desktop's own contract, taken
//! from `packages/agent-runtime/src/sidecar.ts`. The method names, the
//! `agent.event` notification and the `AgentEventEnvelope` payload are the ones
//! main already speaks, so switching the spawn target is enough.
//!
//! Responsibilities:
//! * validate parameters and answer with the protocol's own error codes;
//! * own the session table (transcript, running turn, cancellation token);
//! * run each turn as a task, so `agent.prompt` answers immediately and the
//!   progress arrives as notifications — exactly what the renderer expects.
//!
//! A session runs one turn at a time: a second `agent.prompt` while a turn is
//! in flight is refused with `TURN_IN_FLIGHT` rather than interleaved.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::event::{AgentEventEnvelope, EventSink};
use crate::message::Message;
use crate::provider::http::{HttpProvider, HttpProviderConfig};
use crate::provider::scripted::ScriptedProvider;
use crate::provider::{Provider, StreamEvent};
use crate::rpc::{self, Request, RpcError};
use crate::session::Transcript;
use crate::tool::ToolRegistry;
use crate::turn::{TurnConfig, TurnEngine};

/// Destination for one encoded protocol line.
pub trait LineSink: Send + Sync {
    fn send_line(&self, line: String);
}

impl LineSink for tokio::sync::mpsc::UnboundedSender<String> {
    fn send_line(&self, line: String) {
        let _ = self.send(line);
    }
}

/// Test sink that keeps every line and can be awaited.
#[derive(Debug, Default, Clone)]
pub struct RecordingLines {
    lines: Arc<Mutex<Vec<String>>>,
    notify: Arc<tokio::sync::Notify>,
}

impl RecordingLines {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines.lock().expect("line log poisoned").clone()
    }

    /// Parsed notifications with the given method, in order.
    pub fn notifications(&self, method: &str) -> Vec<Value> {
        self.lines()
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value.get("method").and_then(Value::as_str) == Some(method))
            .filter_map(|value| value.get("params").cloned())
            .collect()
    }

    /// Wait until a notification with `method` has arrived, and return its
    /// params. Wakes on arrival instead of polling, so tests have no sleep.
    pub async fn wait_for(&self, method: &str, timeout: std::time::Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(params) = self.notifications(method).pop() {
                return Some(params);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            tokio::select! {
                _ = tokio::time::sleep(remaining) => return None,
                _ = self.notify.notified() => {}
            }
        }
    }
}

impl LineSink for RecordingLines {
    fn send_line(&self, line: String) {
        self.lines.lock().expect("line log poisoned").push(line);
        self.notify.notify_waiters();
    }
}

#[derive(Debug, Clone)]
struct RuntimeConfig {
    model: String,
    system: Option<String>,
    max_steps: usize,
    temperature: Option<f32>,
    max_output_tokens: Option<u32>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            system: None,
            max_steps: 24,
            temperature: None,
            max_output_tokens: None,
        }
    }
}

struct Session {
    transcript: Arc<tokio::sync::Mutex<Transcript>>,
    cancel: Mutex<CancelToken>,
    running: AtomicBool,
    current_turn: Mutex<Option<String>>,
}

impl Session {
    fn new() -> Self {
        Self {
            transcript: Arc::new(tokio::sync::Mutex::new(Transcript::new())),
            cancel: Mutex::new(CancelToken::new()),
            running: AtomicBool::new(false),
            current_turn: Mutex::new(None),
        }
    }
}

/// Forwards kernel events to the peer as `agent.event` notifications.
struct NotificationSink {
    out: Arc<dyn LineSink>,
}

impl EventSink for NotificationSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        let params = serde_json::to_value(&envelope).unwrap_or(Value::Null);
        self.out.send_line(rpc::notification("agent.event", params));
    }
}

pub struct Sidecar {
    out: Arc<dyn LineSink>,
    provider: Mutex<Option<Arc<dyn Provider>>>,
    tools: Arc<ToolRegistry>,
    config: Mutex<RuntimeConfig>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Sidecar {
    pub fn new(out: Arc<dyn LineSink>, tools: Arc<ToolRegistry>) -> Self {
        Self {
            out,
            provider: Mutex::new(None),
            tools,
            config: Mutex::new(RuntimeConfig::default()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Answer one request. Notifications get no answer.
    pub async fn handle(&self, request: Request) -> Option<String> {
        let id = request.id.clone();
        let result = self.dispatch(&request).await;
        match (id, result) {
            (Some(id), Ok(value)) => Some(rpc::response(id, value)),
            (Some(id), Err(error)) => {
                tracing::debug!(target: "agent_core::sidecar", method = %request.method, %error, "request failed");
                Some(rpc::error_response(id, error))
            }
            (None, _) => None,
        }
    }

    async fn dispatch(&self, request: &Request) -> Result<Value, RpcError> {
        match request.method.as_str() {
            "sidecar.health" => Ok(json!({
                "status": "ok",
                "runtime": "rust",
                "version": crate::VERSION,
                "sessions": self.sessions.lock().map(|s| s.len()).unwrap_or(0),
                "providerConfigured": self.provider.lock().map(|p| p.is_some()).unwrap_or(false),
            })),
            "sidecar.configure" => self.configure(request),
            "agent.prompt" | "agent.turn" => self.prompt(request).await,
            "agent.abort" => self.abort(request),
            "agent.getStatus" => self.get_status(request),
            "agent.disposeSession" => self.dispose_session(request),
            "native.session.get" => self.session_get(request).await,
            other => Err(RpcError::method_not_found(other)),
        }
    }

    fn configure(&self, request: &Request) -> Result<Value, RpcError> {
        let provider_spec = request
            .params
            .get("provider")
            .ok_or_else(|| RpcError::invalid_params("`provider` is required"))?;
        let provider: Arc<dyn Provider> = build_provider(provider_spec)?;

        let mut config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?;
        config.model = request
            .str_param("model")
            .map(str::to_string)
            .unwrap_or_else(|| provider.name().to_string());
        config.system = request.str_param("system").map(str::to_string);
        if let Some(steps) = request.params.get("maxSteps").and_then(Value::as_u64) {
            config.max_steps = steps.max(1) as usize;
        }
        config.temperature = request
            .params
            .get("temperature")
            .and_then(Value::as_f64)
            .map(|value| value as f32);
        config.max_output_tokens = request
            .params
            .get("maxOutputTokens")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let model = config.model.clone();
        drop(config);

        *self
            .provider
            .lock()
            .map_err(|_| RpcError::internal("provider lock poisoned"))? = Some(provider);

        Ok(json!({ "model": model }))
    }

    fn session(&self, session_id: &str) -> Result<Arc<Session>, RpcError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        Ok(sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Session::new()))
            .clone())
    }

    async fn prompt(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?.to_string();
        let text = request
            .str_param("prompt")
            .or_else(|| request.str_param("text"))
            .ok_or_else(|| RpcError::invalid_params("`prompt` must be a string"))?
            .to_string();
        let provider = self
            .provider
            .lock()
            .map_err(|_| RpcError::internal("provider lock poisoned"))?
            .clone()
            .ok_or_else(|| {
                RpcError::app(
                    "PROVIDER_NOT_CONFIGURED",
                    "sidecar.configure must run before agent.prompt",
                )
            })?;

        let session = self.session(&session_id)?;
        // One turn at a time, per session: the flag is the admission gate.
        if session.running.swap(true, Ordering::SeqCst) {
            return Err(RpcError::app(
                "TURN_IN_FLIGHT",
                "this session already has a running turn",
            ));
        }

        let turn_id = request
            .str_param("turnId")
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cancel = CancelToken::new();
        *session
            .cancel
            .lock()
            .map_err(|_| RpcError::internal("cancel lock poisoned"))? = cancel.clone();
        *session
            .current_turn
            .lock()
            .map_err(|_| RpcError::internal("turn lock poisoned"))? = Some(turn_id.clone());

        {
            let mut transcript = session.transcript.lock().await;
            transcript.push(Message::user_text(text));
        }

        let config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?
            .clone();
        let engine = TurnEngine::new(
            provider,
            self.tools.clone(),
            Arc::new(NotificationSink {
                out: self.out.clone(),
            }),
        );

        let task_session = session.clone();
        let task_session_id = session_id.clone();
        let task_turn_id = turn_id.clone();
        tokio::spawn(async move {
            let mut transcript = task_session.transcript.lock().await;
            let outcome = engine
                .run_turn(
                    &task_session_id,
                    &task_turn_id,
                    &mut transcript,
                    &TurnConfig {
                        model: config.model.clone(),
                        system: config.system.clone(),
                        max_steps: config.max_steps,
                        temperature: config.temperature,
                        max_output_tokens: config.max_output_tokens,
                        thinking: crate::provider::ThinkingLevel::Off,
                    },
                    cancel,
                )
                .await;
            drop(transcript);
            task_session.running.store(false, Ordering::SeqCst);
            if let Ok(mut current) = task_session.current_turn.lock() {
                *current = None;
            }
            match outcome {
                Ok(outcome) => tracing::debug!(
                    target: "agent_core::sidecar",
                    steps = outcome.steps,
                    input = outcome.usage.input_tokens,
                    output = outcome.usage.output_tokens,
                    "turn finished"
                ),
                Err(error) => tracing::debug!(
                    target: "agent_core::sidecar",
                    code = error.code(),
                    %error,
                    "turn failed"
                ),
            }
        });

        Ok(json!({ "sessionId": session_id, "turnId": turn_id }))
    }

    fn abort(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({ "aborted": false, "reason": "unknown session" }));
        };
        let running = session.running.load(Ordering::SeqCst);
        session
            .cancel
            .lock()
            .map_err(|_| RpcError::internal("cancel lock poisoned"))?
            .cancel();
        Ok(json!({ "aborted": running }))
    }

    fn get_status(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({
                "exists": false,
                "isRunning": false,
                "currentTurnId": Value::Null,
                "messageCount": 0,
            }));
        };
        Ok(json!({
            "exists": true,
            "isRunning": session.running.load(Ordering::SeqCst),
            "currentTurnId": session
                .current_turn
                .lock()
                .map(|turn| turn.clone())
                .unwrap_or(None),
            "messageCount": session
                .transcript
                .try_lock()
                .map(|transcript| transcript.len())
                .unwrap_or(0),
        }))
    }

    fn dispose_session(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let removed = sessions.remove(session_id).is_some();
        Ok(json!({ "disposed": removed }))
    }

    async fn session_get(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request
            .str_param("sessionId")
            .or_else(|| request.str_param("id"))
            .ok_or_else(|| RpcError::invalid_params("`sessionId` must be a string"))?;
        let session = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| RpcError::internal("session lock poisoned"))?;
            sessions.get(session_id).cloned()
        };
        let Some(session) = session else {
            return Ok(json!({ "id": session_id, "messages": [] }));
        };
        let transcript = session.transcript.lock().await;
        Ok(json!({
            "id": session_id,
            "messages": transcript.messages(),
            "isRunning": session.running.load(Ordering::SeqCst),
        }))
    }
}

fn build_provider(spec: &Value) -> Result<Arc<dyn Provider>, RpcError> {
    let kind = spec
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params("`provider.kind` is required"))?;
    match kind {
        // Development and test only: replays a fixed response without a socket.
        "scripted" => {
            let text = spec
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("scripted response");
            let responses = (0..spec.get("turns").and_then(Value::as_u64).unwrap_or(1))
                .map(|_| {
                    vec![
                        StreamEvent::TextDelta(text.to_string()),
                        StreamEvent::Finish(crate::message::StopReason::EndTurn),
                    ]
                })
                .collect::<Vec<_>>();
            Ok(Arc::new(ScriptedProvider::new(responses)))
        }
        "openai" | "anthropic" => {
            let base_url = spec
                .get("baseUrl")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("`provider.baseUrl` is required"))?;
            let api_key = spec
                .get("apiKey")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::invalid_params("`provider.apiKey` is required"))?;
            let name = spec.get("name").and_then(Value::as_str).unwrap_or(kind);
            let mut config = if kind == "openai" {
                HttpProviderConfig::openai(name, base_url, api_key)
            } else {
                HttpProviderConfig::anthropic(name, base_url, api_key)
            };
            if let Some(max_tokens) = spec.get("defaultMaxTokens").and_then(Value::as_u64) {
                config.default_max_tokens = max_tokens as u32;
            }
            if let Some(headers) = spec.get("headers").and_then(Value::as_object) {
                for (key, value) in headers {
                    if let Some(value) = value.as_str() {
                        config.extra_headers.push((key.clone(), value.to_string()));
                    }
                }
            }
            let provider = HttpProvider::new(config)
                .map_err(|error| RpcError::app(error.code(), error.to_string()))?;
            Ok(Arc::new(provider))
        }
        other => Err(RpcError::invalid_params(format!(
            "unknown provider kind `{other}`"
        ))),
    }
}
