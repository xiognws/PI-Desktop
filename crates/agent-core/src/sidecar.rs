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
use crate::context::{ContextLimits, ModelLimits};
use crate::error::Result;
use crate::event::{AgentEventEnvelope, CompactionReason, EventSink};
use crate::host_bridge::{tool_spec_from_value, HostBridge, HostTool};
use crate::message::Message;
use crate::provider::http::{HttpProvider, HttpProviderConfig};
use crate::provider::scripted::ScriptedProvider;
use crate::provider::{BoxFuture, Provider, StreamEvent};
use crate::rpc::{self, Request, RpcError};
use crate::session::Transcript;
use crate::tool::{AllowAll, PermissionGate, ToolRegistry};
use crate::turn::{TurnConfig, TurnEngine};
use crate::ThinkingLevel;

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

    /// Every `host.proxy` frame, whole — id included, so a test can answer it.
    ///
    /// `notifications` returns a notification's params; a reverse RPC's params
    /// are the proxied method, and the id that completes it is on the frame.
    pub fn host_calls(&self) -> Vec<Value> {
        self.lines()
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|value| value.get("method").and_then(Value::as_str) == Some("host.proxy"))
            .collect()
    }

    /// Wait for a `host.proxy` call carrying `method`, and return its frame.
    ///
    /// A proxy notification's own method is always `host.proxy`; the method the
    /// host is asked to run is inside the params. Tests that care about one call
    /// need this, because several now share the channel (history restore runs
    /// before the turn asks for a tool).
    pub async fn wait_for_host_call(
        &self,
        method: &str,
        timeout: std::time::Duration,
    ) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let found = self
                .lines()
                .iter()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| {
                    value.get("method").and_then(Value::as_str) == Some("host.proxy")
                        && value.pointer("/params/method").and_then(Value::as_str) == Some(method)
                });
            if found.is_some() {
                return found;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let _ = tokio::time::timeout(remaining, self.notify.notified()).await;
        }
    }

    /// Wait until a message with `method` has arrived and return the whole
    /// frame (id included), for tests that must answer a host call.
    pub async fn wait_for_message(
        &self,
        method: &str,
        timeout: std::time::Duration,
    ) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let found = self
                .lines()
                .iter()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| value.get("method").and_then(Value::as_str) == Some(method));
            if let Some(value) = found {
                return Some(value);
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

    /// Wait until an `agent.event` notification of `event_type` has arrived.
    /// Tests assert on the turn's own terminator instead of polling, so a turn
    /// that never ends fails as a timeout rather than a spin.
    pub async fn wait_for_event(
        &self,
        event_type: &str,
        timeout: std::time::Duration,
    ) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(found) = self
                .notifications("agent.event")
                .into_iter()
                .find(|params| params["event"]["type"] == event_type)
            {
                return Some(found);
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

#[derive(Debug, Clone, Default)]
struct RuntimeConfig {
    /// Host metadata from `sidecar.configure`. Main sends host identity, the
    /// data directory and proxy settings — not model credentials, which arrive
    /// per prompt (`params.provider`), exactly as the Node sidecar expects.
    host_binary: Option<String>,
    data_dir: Option<String>,
    network_proxy: Option<Value>,
    model: String,
    system: Option<String>,
    max_steps: usize,
    temperature: Option<f32>,
    max_output_tokens: Option<u32>,
}

impl RuntimeConfig {
    fn new() -> Self {
        Self {
            max_steps: 24,
            ..Self::default()
        }
    }
}

/// How long a prompt waits for a pre-turn host call (history, journal write).
///
/// Main answers in milliseconds; this bound exists so a host that never answers
/// degrades instead of holding the prompt open forever. A host that *answers*
/// with a refusal is a different case and is never ignored.
const HOST_PREPARE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

struct Session {
    transcript: Arc<tokio::sync::Mutex<Transcript>>,
    cancel: Mutex<CancelToken>,
    running: AtomicBool,
    current_turn: Mutex<Option<String>>,
    /// Messages a user sent while the turn was running. Drained by the loop
    /// between steps, so a steer reaches the model on the next request instead
    /// of waiting for the turn to finish.
    steering: Mutex<std::collections::VecDeque<Message>>,
    /// The catalog this session was launched with, kept live so a `Skill` call
    /// mid-turn lists what exists now rather than what existed at session start.
    skills: Arc<crate::skills::SkillCatalog>,
    /// Delegations this session started. Kept per session so a report that
    /// settled after the parent stopped calling tools is still readable.
    delegations: Arc<crate::delegate::DelegationRegistry>,
    /// The background skill review's gate: tool calls since the last pass, and
    /// the floor between passes.
    review_gate: Mutex<crate::skill_review::ReviewGate>,
    /// One review at a time: a second fork would read a library the first is
    /// still writing to.
    review_running: AtomicBool,
    /// The system prompts this session has already journaled.
    journal: Mutex<crate::journal::SystemJournal>,
    /// Whether history has already been pulled from the host for this session.
    /// Once is enough: after that the kernel's transcript is the newer copy, and
    /// asking again would resurrect rows the user has since deleted.
    restored: AtomicBool,
}

impl Session {
    fn new(session_id: &str) -> Self {
        Self {
            transcript: Arc::new(tokio::sync::Mutex::new(Transcript::new())),
            cancel: Mutex::new(CancelToken::new()),
            running: AtomicBool::new(false),
            current_turn: Mutex::new(None),
            steering: Mutex::new(std::collections::VecDeque::new()),
            skills: Arc::new(crate::skills::SkillCatalog::new()),
            restored: AtomicBool::new(false),
            journal: Mutex::new(crate::journal::SystemJournal::new()),
            review_gate: Mutex::new(crate::skill_review::ReviewGate::new()),
            review_running: AtomicBool::new(false),
            delegations: Arc::new(crate::delegate::DelegationRegistry::new(session_id)),
        }
    }
}

impl crate::turn::SteeringSource for Session {
    fn drain(&self) -> Vec<Message> {
        self.steering
            .lock()
            .map(|mut queue| queue.drain(..).collect())
            .unwrap_or_default()
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
    tools: Mutex<Arc<ToolRegistry>>,
    gate: Arc<dyn PermissionGate>,
    bridge: Arc<HostBridge>,
    config: Mutex<RuntimeConfig>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// The ask cards waiting for an answer. One broker per sidecar: a card is
    /// resolved by session id, not by whichever turn happened to create it.
    asks: Arc<crate::ask::AskBroker>,
}

impl Sidecar {
    pub fn new(out: Arc<dyn LineSink>, gate: Arc<dyn PermissionGate>) -> Self {
        let sink: Arc<dyn crate::EventSink> = Arc::new(NotificationSink { out: out.clone() });
        Self {
            bridge: Arc::new(HostBridge::new(out.clone())),
            asks: Arc::new(crate::ask::AskBroker::new(sink)),
            out,
            provider: Mutex::new(None),
            tools: Mutex::new(Arc::new(ToolRegistry::new(gate.clone()))),
            gate,
            config: Mutex::new(RuntimeConfig::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Convenience constructor for callers with no policy of their own.
    pub fn with_default_gate(out: Arc<dyn LineSink>) -> Self {
        Self::new(out, Arc::new(AllowAll))
    }

    /// The outbound half of the host channel. The serve loop feeds answers back
    /// through `HostBridge::complete`.
    pub fn bridge(&self) -> Arc<HostBridge> {
        self.bridge.clone()
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
            // `ok`/`runtimes` are the Node sidecar's shape, and a caller that
            // learned the protocol from it must keep working here. The rest is
            // additive diagnostics this kernel can answer honestly.
            "sidecar.health" => Ok(json!({
                "ok": true,
                "runtimes": self.sessions.lock().map(|s| s.len()).unwrap_or(0),
                "runtime": "rust",
                "version": crate::VERSION,
                "providerConfigured": self.provider.lock().map(|p| p.is_some()).unwrap_or(false),
            })),
            "sidecar.configure" => self.configure(request),
            "agent.prompt" | "agent.turn" => self.prompt(request).await,
            "agent.compact" => self.compact(request).await,
            "asktool.resolve" => self.resolve_ask(request),
            "agent.steer" => self.steer(request),
            "agent.steeringContext" => self.steering_context(request),
            "agent.abort" => self.abort(request),
            "agent.getStatus" => self.get_status(request),
            "agent.disposeSession" => self.dispose_session(request),
            "native.session.get" => self.session_get(request).await,
            "native.session.list" => self.session_list(request),
            "native.session.fork" => self.session_fork(request).await,
            "native.session.search" => self.session_search(request).await,
            other => Err(RpcError::method_not_found(other)),
        }
    }

    fn configure(&self, request: &Request) -> Result<Value, RpcError> {
        // Main's payload is host metadata, not credentials: keep it opaque and
        // answer with what was accepted. A provider here is a harness shortcut
        // for tests and the self-check; a real prompt carries its own.
        let mut config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?;
        config.host_binary = request.str_param("hostBinary").map(str::to_string);
        config.data_dir = request.str_param("dataDir").map(str::to_string);
        if let Some(proxy) = request.params.get("networkProxy") {
            config.network_proxy = Some(proxy.clone());
        }
        if let Some(system) = request.str_param("system") {
            config.system = Some(system.to_string());
        }
        if let Some(model) = request.str_param("model") {
            config.model = model.to_string();
        }
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
        drop(config);

        let mut provider_declared = false;
        if let Some(spec) = request.params.get("provider") {
            let provider = build_provider(spec)?;
            *self
                .provider
                .lock()
                .map_err(|_| RpcError::internal("provider lock poisoned"))? = Some(provider);
            provider_declared = true;
        }

        let tools = match request.params.get("tools").and_then(Value::as_array) {
            Some(declarations) => self.install_tools(declarations)?,
            None => {
                let count = self
                    .tools
                    .lock()
                    .map_err(|_| RpcError::internal("tool lock poisoned"))?
                    .specs()
                    .len();
                json!(count)
            }
        };

        Ok(json!({
            "ok": true,
            "mode": "host-proxy",
            "providerDeclared": provider_declared,
            "tools": tools,
        }))
    }

    /// Replace the tool set with host declarations: every call is served by
    /// `tools.execute` rather than by kernel code.
    fn install_tools(&self, declarations: &[Value]) -> Result<Value, RpcError> {
        let mut registry = ToolRegistry::new(self.gate.clone());
        for declaration in declarations {
            let spec = tool_spec_from_value(declaration).map_err(RpcError::invalid_params)?;
            registry.register(Arc::new(HostTool::new(spec, self.bridge.clone())));
        }
        let count = declarations.len();
        *self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))? = Arc::new(registry);
        Ok(json!(count))
    }

    /// Build the system prompt for one turn from the request's session inputs.
    ///
    /// The real product prompt, the instruction chain and the mode rules are
    /// all resolved here so the loop only ever sees one string.
    fn compose_prompt(
        &self,
        request: &Request,
        config: &RuntimeConfig,
        mode: crate::prompt::SessionMode,
        skills: &[crate::skills::SkillDef],
    ) -> crate::prompt::ComposedPrompt {
        let fs: Arc<dyn crate::prompt::PromptFs> = Arc::new(crate::prompt::StdFs);
        let workspace_root = request
            .str_param("workspaceRoot")
            .or_else(|| request.str_param("projectPath"))
            .or_else(|| request.str_param("cwd"));
        let mut inputs = crate::prompt::PromptInputs::new(workspace_root);
        inputs.workspace_path = request
            .str_param("workspacePath")
            .or_else(|| request.str_param("activeFile"));
        inputs.global_agent_dir = request
            .str_param("agentDataHome")
            .or(config.data_dir.as_deref());
        inputs.mode = mode;
        inputs.tool_instructions = request.str_param("toolInstructions");
        inputs.product_prompt = request
            .str_param("systemPrompt")
            .or(config.system.as_deref());
        inputs.skills = skills;
        crate::prompt::build_system_prompt(&fs, &inputs)
    }

    fn session(&self, session_id: &str) -> Result<Arc<Session>, RpcError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        Ok(sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Session::new(session_id)))
            .clone())
    }

    async fn prompt(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?.to_string();
        // Main sends `content`; `prompt`/`text` stay accepted so a harness does
        // not have to mimic the renderer.
        let text = request
            .str_param("content")
            .or_else(|| request.str_param("prompt"))
            .or_else(|| request.str_param("text"))
            .ok_or_else(|| RpcError::invalid_params("`content` must be a string"))?
            .to_string();
        // A prompt carries its own provider: main stamps the session's model and
        // credentials on every turn. The configured provider is only a fallback
        // for harnesses and the self-check.
        let provider = match request
            .params
            .get("provider")
            .filter(|value| !value.is_null())
        {
            Some(spec) => build_provider(spec)?,
            None => self
                .provider
                .lock()
                .map_err(|_| RpcError::internal("provider lock poisoned"))?
                .clone()
                .ok_or_else(|| {
                    RpcError::app(
                        "PROVIDER_NOT_CONFIGURED",
                        "the prompt carries no provider and none is configured",
                    )
                })?,
        };
        if let Some(declarations) = request.params.get("tools").and_then(Value::as_array) {
            self.install_tools(declarations)?;
        }
        // A composer can name MCP servers or exact tools. The answer is the set
        // those names authorize — resolved by exact identity, never by the shape
        // of a tool name — and a selection that cannot be honoured refuses the
        // prompt instead of quietly running without the tool.
        if request.params.get("mcpServerIds").is_some()
            || request.params.get("mcpToolNames").is_some()
        {
            let identities: Vec<crate::mcp::McpToolIdentity> = request
                .params
                .get("tools")
                .and_then(Value::as_array)
                .map(|declarations| {
                    declarations
                        .iter()
                        .filter_map(crate::mcp::McpToolIdentity::from_value)
                        .collect()
                })
                .unwrap_or_default();
            let declared = self
                .tools
                .lock()
                .map_err(|_| RpcError::internal("tool lock poisoned"))?
                .clone();
            let available = |name: &str| declared.contains(name);
            match crate::mcp::resolve_mcp_tool_selection(
                request.params.get("mcpServerIds"),
                &identities,
                &available,
                request.params.get("mcpToolNames"),
            ) {
                Ok(names) => tracing::debug!(
                    target: "agent_core::sidecar",
                    count = names.len(),
                    "mcp tools selected for this prompt"
                ),
                Err(error) => return Err(RpcError::app(error.code(), error.message())),
            }
        }

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

        // A reopened session starts with the history host-core kept for it.
        self.restore_history(&session, session_id.as_str()).await?;

        {
            let mut transcript = session.transcript.lock().await;
            // The transcript keeps the user's own text; the recall query below
            // reads the same string, so the row and the query cannot drift.
            let mut message = Message::user_text(text.clone());
            // The renderer already drew this row optimistically; keeping its id
            // is what lets main reconcile instead of duplicating it.
            if let Some(id) = request.str_param("userMessageId") {
                message.id = id.to_string();
            }
            transcript.push(message);
        }

        let mut config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?
            .clone();
        // The catalog main launched this session with. Only ids, names and
        // descriptions arrive; the documents stay on the host.
        let catalog = crate::skills::parse_catalog(request.params.get("pluginSkills"));
        session.skills.replace(catalog.clone());
        let mode = crate::prompt::SessionMode::parse(request.str_param("mode"));
        // Compose the system prompt for this turn: persona, custom append, tool
        // guidance, the project instruction chain, the skill catalog and the
        // mode's rules.
        let composed = self.compose_prompt(request, &config, mode.clone(), &catalog);
        if !composed.system.trim().is_empty() {
            config.system = Some(composed.system.clone());
        }
        // The prompt the model receives is journaled before dispatch: nothing in
        // the transcript shows it, so without this row a restored session cannot
        // reproduce what it ran with, and a support bundle cannot show it.
        self.journal_system_prompt(request, &session, &composed, session_id.as_str(), &turn_id)
            .await?;
        if let Some(model) = request.str_param("modelId").or_else(|| {
            request
                .params
                .get("provider")
                .and_then(|provider| provider.get("modelId"))
                .and_then(Value::as_str)
        }) {
            config.model = model.to_string();
        }
        // Durable memory: only when this prompt says the host offers it. A host
        // without memory gets no recall round trip, which is what keeps the
        // request sequence of an older host unchanged.
        // Every Agent turn recalls, which is what the Node sidecar does; a host
        // that wants to skip it says `memoryRecall: false`. Gating recall behind
        // an opt-in flag meant memory silently stopped working the moment this
        // kernel started serving prompts, because main never sends the flag.
        let memory_prefix = if matches!(mode, crate::prompt::SessionMode::Agent)
            && request.params.get("memoryRecall").and_then(Value::as_bool) != Some(false)
        {
            let project_path = request
                .str_param("projectPath")
                .or_else(|| request.str_param("workspaceRoot"));
            crate::memory_context::recall_prefix(
                &*self.bridge,
                &text,
                project_path,
                Some(session_id.as_str()),
                crate::memory_context::RECALL_LIMIT,
            )
            .await
        } else {
            None
        };

        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        // `Skill` exists only when a library exists, and only in the mode that may
        // write one — the same gate the desktop runtime uses. A tool whose only
        // honest answer is "there is nothing here" is noise in every request.
        // Read the retry policy here: the spawned task cannot borrow `request`.
        let infinite_provider_retry = request
            .params
            .get("infiniteProviderRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let subagents = parse_subagents(request);
        let mut extra: Vec<Arc<dyn crate::Tool>> = Vec::new();
        if !subagents.is_empty() && matches!(mode, crate::prompt::SessionMode::Agent) {
            // A delegate runs its own turn with the session's provider and only
            // the tools its definition declares.
            let hub = Arc::new(crate::delegate::DelegationHub::new(
                session.delegations.clone(),
                subagents,
                Arc::new(SidecarDelegateRunner {
                    provider: provider.clone(),
                    tools: tools.clone(),
                    sink: Arc::new(NotificationSink {
                        out: self.out.clone(),
                    }),
                    model: config.model.clone(),
                    model_limits: model_limits_from(request),
                    guidance: Vec::new(),
                    infinite_provider_retry,
                }),
            ));
            extra.push(Arc::new(crate::delegate::TaskTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskWaitTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskListTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskStopTool::new(hub)));
        }
        if !catalog.is_empty() && matches!(mode, crate::prompt::SessionMode::Agent) {
            // An id lookup is forwarded to the host's own `Skill` handler when
            // main declared one; the listing is answered here.
            let load = tools.get(crate::skills::SKILL_TOOL_NAME);
            extra.push(Arc::new(crate::skills::SkillTool::new(
                session.skills.clone(),
                load,
            )));
        }
        // `asktool` is available in Agent, Plan and Goal mode: asking is not an
        // authorization, so a plan turn may ask what the user wants.
        if matches!(
            mode,
            crate::prompt::SessionMode::Agent
                | crate::prompt::SessionMode::Plan
                | crate::prompt::SessionMode::Goal
        ) {
            extra.push(Arc::new(crate::ask::AskTool::new(self.asks.clone())));
        }
        if matches!(mode, crate::prompt::SessionMode::Agent) {
            // The skill library's writer: every action is a `skills.*` RPC, so
            // the runtime, the UI and a background review share one path rule.
            extra.push(Arc::new(crate::skill_manage::SkillManageTool::new(
                self.bridge.clone(),
                request
                    .str_param("projectPath")
                    .or_else(|| request.str_param("workspaceRoot"))
                    .map(str::to_string),
            )));
        }
        if matches!(mode, crate::prompt::SessionMode::Agent) {
            // Memory writes and reads are host RPCs; the store, the dedupe and
            // the scope filtering stay in one place.
            extra.push(Arc::new(crate::memory::MemoryTool::new(
                self.bridge.clone(),
                request
                    .str_param("projectPath")
                    .or_else(|| request.str_param("workspaceRoot"))
                    .map(str::to_string),
                session.skills.clone(),
            )));
        }
        let tools = if extra.is_empty() {
            tools
        } else {
            Arc::new(tools.extended(extra))
        };
        // Keep the pieces the background review needs: the engine takes
        // ownership of the provider and the tool set below.
        let review_provider = provider.clone();
        let review_tools = tools.clone();
        let engine = TurnEngine::new(
            provider,
            tools,
            Arc::new(NotificationSink {
                out: self.out.clone(),
            }),
        )
        .with_steering(session.clone());
        // Main stamps the session's model window on the prompt; without it the
        // loop has no budget to enforce and would never compact.
        let engine = match model_limits_from(request) {
            Some(limits) => engine.with_model_limits(limits),
            None => engine,
        }
        .with_memory_prefix(memory_prefix)
        .with_delegations(session.delegations.clone());

        // The turn task announces the state it is about to run in, then the one
        // it settled in. Both carry the same shape `agent.getStatus` answers.
        self.emit_status(&session_id, &turn_id, &session);

        let task_session = session.clone();
        let task_session_id = session_id.clone();
        let task_turn_id = turn_id.clone();
        let status_out = self.out.clone();
        // Read the retry policy here: the spawned task cannot borrow `request`.
        let infinite_provider_retry = request
            .params
            .get("infiniteProviderRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let task_asks = self.asks.clone();
        // A background skill review runs after this turn, in the same task: the
        // client has already been told the turn ended, so nothing is held back.
        let review_policy =
            crate::skill_review::SkillReviewPolicy::from_params(request.params.get("skillReview"));
        let review_model = config.model.clone();
        let review_system = config.system.clone();
        let review_mode = mode.clone();
        let review_out = self.out.clone();
        let review_turn_id = turn_id.clone();
        let review_session_id = session_id.clone();
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
                        infinite_provider_retry,
                    },
                    cancel,
                )
                .await;
            drop(transcript);
            // No card survives the turn that asked it, whatever ended the turn.
            task_asks.cancel_session(&task_session_id);
            task_session.running.store(false, Ordering::SeqCst);
            if let Ok(mut current) = task_session.current_turn.lock() {
                *current = None;
            }
            match outcome {
                Ok(outcome) => {
                    tracing::debug!(
                        target: "agent_core::sidecar",
                        steps = outcome.steps,
                        tool_calls = outcome.tool_calls,
                        input = outcome.usage.input_tokens,
                        output = outcome.usage.output_tokens,
                        "turn finished"
                    );
                    skill_review_pass(SkillReviewInput {
                        provider: review_provider,
                        tools: review_tools,
                        model: review_model,
                        system: review_system,
                        policy: review_policy,
                        mode: review_mode,
                        session: task_session.clone(),
                        out: review_out,
                        session_id: review_session_id,
                        turn_id: review_turn_id,
                        tool_calls: outcome.tool_calls,
                    })
                    .await;
                }
                Err(error) => tracing::debug!(
                    target: "agent_core::sidecar",
                    code = error.code(),
                    %error,
                    "turn failed"
                ),
            }
            // Idle last, after everything the turn caused — the end event, the
            // review's notice. A client that treats this as the authoritative
            // "nothing is happening" must not be told that while the review is
            // still writing to the library.
            let idle = json!({
                "sessionId": task_session_id,
                "isRunning": false,
                "pendingToolConfirmations": 0,
            });
            NotificationSink { out: status_out }.emit(crate::AgentEventEnvelope::new(
                &task_session_id,
                task_turn_id.clone(),
                crate::AgentEvent::Status { status: idle },
            ));
        });

        Ok(json!({ "accepted": true, "sessionId": session_id, "turnId": turn_id }))
    }

    /// Compact a session on request, with the same engine the loop uses so the
    /// manual path cannot drift from the automatic one.
    async fn compact(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?.to_string();
        let provider = match request
            .params
            .get("provider")
            .filter(|value| !value.is_null())
        {
            Some(spec) => build_provider(spec)?,
            None => self
                .provider
                .lock()
                .map_err(|_| RpcError::internal("provider lock poisoned"))?
                .clone()
                .ok_or_else(|| {
                    RpcError::app(
                        "PROVIDER_NOT_CONFIGURED",
                        "manual compaction needs a provider to write the summary",
                    )
                })?,
        };

        let session = self.session(&session_id)?;
        // A summary needs a stable transcript; compacting under a running turn
        // would summarize rows that are still being appended.
        if session.running.load(Ordering::SeqCst) {
            return Err(RpcError::app(
                "TURN_IN_FLIGHT",
                "this session has a running turn; compact after it finishes",
            ));
        }

        let mut config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?
            .clone();
        if let Some(model) = request.str_param("modelId").or_else(|| {
            request
                .params
                .get("provider")
                .and_then(|provider| provider.get("modelId"))
                .and_then(Value::as_str)
        }) {
            config.model = model.to_string();
        }
        let limits = ContextLimits::for_model(model_limits_from(request).unwrap_or_default());
        let turn_id = request
            .str_param("turnId")
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        let engine = TurnEngine::new(
            provider,
            tools,
            Arc::new(NotificationSink {
                out: self.out.clone(),
            }),
        );
        let cancel = CancelToken::new();
        let turn_config = TurnConfig {
            model: config.model.clone(),
            system: config.system.clone(),
            max_steps: config.max_steps,
            temperature: config.temperature,
            max_output_tokens: config.max_output_tokens,
            thinking: ThinkingLevel::Off,
            infinite_provider_retry: false,
        };

        let mut transcript: tokio::sync::MutexGuard<'_, Transcript> =
            session.transcript.lock().await;
        engine
            .compact(
                &session_id,
                &turn_id,
                &mut transcript,
                &limits,
                CompactionReason::Manual,
                crate::turn::TurnRun {
                    config: &turn_config,
                    cancel: &cancel,
                },
            )
            .await
            .map_err(|error| RpcError::app(error.code(), error.to_string()))?;
        Ok(json!({
            "compacted": true,
            "messageCount": transcript.messages().len(),
            "turnId": turn_id,
        }))
    }

    /// Queue a message into the running turn. It reaches the model on the next
    /// step, and the loop emits it as a user row so the transcript keeps the
    /// order the user typed it in.
    fn steer(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let content = request
            .str_param("content")
            .or_else(|| request.str_param("text"))
            .ok_or_else(|| RpcError::invalid_params("`content` must be a string"))?
            .to_string();

        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Err(RpcError::app("TURN_NOT_FOUND", "no active turn to steer"));
        };
        if !session.running.load(Ordering::SeqCst) {
            return Err(RpcError::app("TURN_NOT_FOUND", "no active turn to steer"));
        }
        let current = session
            .current_turn
            .lock()
            .map_err(|_| RpcError::internal("turn lock poisoned"))?
            .clone();
        if let Some(expected) = request
            .str_param("expectedTurnId")
            .filter(|value| !value.is_empty())
        {
            if current.as_deref() != Some(expected) {
                return Err(RpcError::app(
                    "TURN_NOT_FOUND",
                    "the turn changed since the steer was addressed",
                ));
            }
        }

        let mut message = Message::user_text(content);
        if let Some(id) = request
            .str_param("messageId")
            .or_else(|| request.str_param("userMessageId"))
        {
            message.id = id.to_string();
        }
        session
            .steering
            .lock()
            .map_err(|_| RpcError::internal("steering lock poisoned"))?
            .push_back(message);

        Ok(json!({ "accepted": true, "turnId": current }))
    }

    /// What a reconnecting renderer needs: the running turn and anything the
    /// user queued for it that the turn has not consumed yet.
    fn steering_context(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({
                "turnId": Value::Null,
                "pending": [],
                "steering": false,
            }));
        };
        let current = session
            .current_turn
            .lock()
            .map_err(|_| RpcError::internal("turn lock poisoned"))?
            .clone();
        let addressed_to_current = request
            .str_param("expectedTurnId")
            .filter(|value| !value.is_empty())
            .map(|expected| current.as_deref() == Some(expected))
            .unwrap_or(true);
        let pending: Vec<String> = if addressed_to_current {
            session
                .steering
                .lock()
                .map(|queue| queue.iter().map(|message| message.text()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(json!({
            "turnId": current,
            "pending": pending,
            "steering": session.running.load(Ordering::SeqCst),
        }))
    }

    /// Answer one ask card. A malformed answer is rejected and the card stays
    /// pending, so a bad click cannot silently skip a question.
    fn resolve_ask(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let request_id = request.require_str("requestId")?;
        let answers = request
            .params
            .get("answers")
            .ok_or_else(|| RpcError::invalid_params("`answers` is required"))?;
        self.asks
            .resolve(session_id, request_id, answers)
            .map_err(|error| RpcError::app(error.code(), error.message()))?;
        Ok(json!({ "ok": true }))
    }

    fn abort(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({ "ok": false, "aborted": false, "reason": "unknown session" }));
        };
        // An abort addressed at a turn that already ended is a no-op, not an
        // error: the renderer's Stop may race the turn's own finish.
        if let Some(expected) = request
            .str_param("turnId")
            .filter(|value| !value.is_empty())
        {
            let current = session
                .current_turn
                .lock()
                .map_err(|_| RpcError::internal("turn lock poisoned"))?
                .clone();
            if current.as_deref() != Some(expected) {
                return Ok(json!({ "ok": false, "aborted": false }));
            }
        }
        let running = session.running.load(Ordering::SeqCst);
        session
            .cancel
            .lock()
            .map_err(|_| RpcError::internal("cancel lock poisoned"))?
            .cancel();
        // A stopped turn settles every card it left open as skipped.
        self.asks.cancel_session(session_id);
        Ok(json!({ "ok": running, "aborted": running }))
    }

    /// Sessions this process owns. Until the kernel gains persistence these are
    /// live, in-memory sessions — the store arrives with the host-core session
    /// phase, and this method then reads from it instead of from the table.
    fn session_list(&self, _request: &Request) -> Result<Value, RpcError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let mut out: Vec<Value> = Vec::with_capacity(sessions.len());
        for (id, session) in sessions.iter() {
            let (message_count, title) = match session.transcript.try_lock() {
                Ok(transcript) => {
                    let title = transcript
                        .messages()
                        .iter()
                        .find(|message| message.role == crate::message::Role::User)
                        .map(|message| snippet(&message.text(), 80))
                        .unwrap_or_default();
                    (transcript.len(), title)
                }
                // A running turn holds the transcript; report what is known.
                Err(_) => (0, String::new()),
            };
            out.push(json!({
                "id": id,
                "messageCount": message_count,
                "title": title,
                "isRunning": session.running.load(Ordering::SeqCst),
            }));
        }
        out.sort_by(|left, right| {
            left["id"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["id"].as_str().unwrap_or_default())
        });
        Ok(json!({ "sessions": out }))
    }

    async fn session_fork(&self, request: &Request) -> Result<Value, RpcError> {
        let source_id = request
            .str_param("id")
            .or_else(|| request.str_param("sessionId"))
            .ok_or_else(|| RpcError::invalid_params("`id` must be a string"))?;
        let source = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?
            .get(source_id)
            .cloned()
            .ok_or_else(|| {
                RpcError::app("SESSION_NOT_FOUND", format!("no session `{source_id}`"))
            })?;
        let target_id = request
            .str_param("targetId")
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        // Copy the messages, never the running turn: a fork is a new, idle
        // conversation that starts from the same history.
        let messages = source.transcript.lock().await.messages().to_vec();
        let message_count = messages.len();
        let target = self.session(&target_id)?;
        *target.transcript.lock().await = Transcript::from_messages(messages);

        Ok(json!({
            "session": { "id": target_id, "messageCount": message_count },
            "sourceId": source_id,
        }))
    }

    async fn session_search(&self, request: &Request) -> Result<Value, RpcError> {
        let query = request
            .str_param("query")
            .ok_or_else(|| RpcError::invalid_params("`query` must be a string"))?
            .to_lowercase();
        if query.is_empty() {
            return Ok(json!({ "results": [] }));
        }
        let sessions: Vec<(String, Arc<Session>)> = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| RpcError::internal("session lock poisoned"))?;
            sessions
                .iter()
                .map(|(id, session)| (id.clone(), session.clone()))
                .collect()
        };

        let mut results: Vec<Value> = Vec::new();
        for (session_id, session) in sessions {
            let transcript = session.transcript.lock().await;
            for message in transcript.messages() {
                let text = message.text();
                if text.to_lowercase().contains(&query) {
                    results.push(json!({
                        "sessionId": session_id,
                        "messageId": message.id,
                        "role": message.role.as_str(),
                        "snippet": snippet(&text, 160),
                    }));
                }
            }
        }
        Ok(json!({ "results": results }))
    }

    /// `agent.getStatus`, in the shape the renderer reads: the answer is
    /// wrapped in `status`, because `api.ts` destructures `{ status }` and reads
    /// `status.isRunning`. A flat object left the renderer with `undefined` and
    /// an idle session that never looked idle.
    /// Record the system prompt for this turn, once per distinct prompt.
    ///
    /// A write that fails fails the request. The store would otherwise hold a
    /// turn whose prompt it never saw, and retrying the provider cannot repair a
    /// durable write that did not land.
    async fn journal_system_prompt(
        &self,
        request: &Request,
        session: &Arc<Session>,
        composed: &crate::prompt::ComposedPrompt,
        session_id: &str,
        turn_id: &str,
    ) -> Result<(), RpcError> {
        if composed.system.trim().is_empty() {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or_default();
        let key = crate::journal::system_message_key(composed);
        let message_json = crate::journal::system_message_json(composed, now);
        let row = {
            let mut journal = session
                .journal
                .lock()
                .map_err(|_| RpcError::internal("journal lock poisoned"))?;
            journal.row(&key, &message_json, request.str_param("userMessageId"), now)
        };
        let Some(message) = row else {
            return Ok(());
        };
        match tokio::time::timeout(
            HOST_PREPARE_TIMEOUT,
            self.bridge.call(
                "session.appendMessage",
                json!({
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "message": message,
                }),
            ),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            // The host said no. Fail before dispatch: retrying the provider
            // cannot repair a durable write that did not land, and a turn the
            // store never saw cannot be reproduced.
            Ok(Err(crate::host_bridge::HostError::Rpc(_))) => Err(RpcError {
                code: -32000,
                message: "Local request preparation failed.".into(),
                data: Some(json!({
                    "errorCode": "LOCAL_REQUEST_ERROR",
                    "phase": "request-preparation",
                })),
            }),
            // The host is not there. A prompt that hangs on a dead host is worse
            // than a turn without its journal row, and the row is retried the
            // next time the prompt changes.
            Ok(Err(error)) => {
                tracing::warn!(
                    target: "agent_core::sidecar",
                    %error,
                    "system prompt journal write skipped"
                );
                Ok(())
            }
            Err(_) => {
                tracing::warn!(
                    target: "agent_core::sidecar",
                    "system prompt journal write timed out"
                );
                Ok(())
            }
        }
    }

    /// Emit the session's current run state to the client.
    fn emit_status(&self, session_id: &str, turn_id: &str, session: &Arc<Session>) {
        let running = session.running.load(Ordering::SeqCst);
        let mut status = json!({
            "sessionId": session_id,
            "isRunning": running,
            "pendingToolConfirmations": 0,
        });
        if running {
            if let Some(turn) = session
                .current_turn
                .lock()
                .map(|current| current.clone())
                .unwrap_or(None)
            {
                status["currentTurnId"] = json!(turn);
            }
        }
        NotificationSink {
            out: self.out.clone(),
        }
        .emit(crate::AgentEventEnvelope::new(
            session_id,
            turn_id,
            crate::AgentEvent::Status { status },
        ));
    }

    /// Load this session's history from the host, once.
    ///
    /// Host-core owns persistence, so a session the kernel has never seen — a
    /// restart, a rebuilt runtime, a window reopened on an old conversation —
    /// has no transcript here until it asks. A host that does not implement
    /// `session.get` is not an error: the session simply starts empty, which is
    /// what a brand-new conversation looks like anyway. A host that answers "no
    /// such session" *is* an error, because prompting a deleted session is a
    /// state the caller has to see.
    async fn restore_history(
        &self,
        session: &Arc<Session>,
        session_id: &str,
    ) -> Result<(), RpcError> {
        if session.restored.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let response = match tokio::time::timeout(
            HOST_PREPARE_TIMEOUT,
            self.bridge.call("session.get", json!({ "id": session_id })),
        )
        .await
        {
            Ok(Ok(response)) => response,
            // Older host, remote workspace mid-upgrade, or a host that never
            // answers: start empty rather than hold the prompt open forever.
            Ok(Err(_)) | Err(_) => return Ok(()),
        };
        let Some(detail) = response.get("session") else {
            return Ok(());
        };
        if detail.is_null() {
            return Err(RpcError::app(
                "SESSION_NOT_FOUND",
                "session not found while restoring history",
            ));
        }
        let Some(rows) = detail.get("messages").and_then(Value::as_array) else {
            return Ok(());
        };
        let messages = crate::restore::messages_from_history(rows);
        if messages.is_empty() {
            return Ok(());
        }
        let mut transcript = session.transcript.lock().await;
        transcript.extend(messages);
        Ok(())
    }

    fn get_status(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({
                "status": {
                    "sessionId": session_id,
                    "isRunning": false,
                    "pendingToolConfirmations": 0,
                }
            }));
        };
        let running = session.running.load(Ordering::SeqCst);
        let current_turn = session
            .current_turn
            .lock()
            .map(|turn| turn.clone())
            .unwrap_or(None);
        let mut status = json!({
            "sessionId": session_id,
            "isRunning": running,
            // Every kernel tool either runs or fails; none waits for a person,
            // so the count is always zero here. The field exists because the
            // renderer reads it.
            "pendingToolConfirmations": 0,
        });
        if running {
            if let Some(turn_id) = current_turn {
                status["currentTurnId"] = json!(turn_id);
            }
        }
        Ok(json!({ "status": status }))
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

/// Wire styles this kernel can speak, keyed by the `apiStyle` main sends.
///
/// Main never sends `kind`: a prompt carries a `RuntimeProviderConfig` whose
/// wire is `apiStyle` and whose model is `modelId`. Reading `kind` alone meant
/// the kernel rejected every real prompt — the shape this port was verified
/// against only ever came from its own tests.
const API_STYLE_OPENAI_COMPLETIONS: &str = "openai-completions";
const API_STYLE_ANTHROPIC_MESSAGES: &str = "anthropic_messages";
/// Known wires this kernel does not implement yet. They fail loudly: silently
/// falling back to Chat Completions would send a valid credential to an endpoint
/// of a different shape and surface as an unexplained provider 400.
const API_STYLES_NOT_MIGRATED: &[&str] = &["responses", "openai_codex_responses", "pi_messages"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderWire {
    OpenAiCompletions,
    AnthropicMessages,
}

/// Which wire a provider spec asks for.
///
/// `kind` is this kernel's own spelling, kept for its tests and for a harness
/// that wants to pin a wire explicitly. Production payloads carry `apiStyle`.
/// An absent or unrecognised style falls back to Chat Completions, which is the
/// documented behaviour of `apiBindingForStyle` upstream.
fn provider_wire(spec: &Value) -> Result<ProviderWire, RpcError> {
    if let Some(kind) = spec.get("kind").and_then(Value::as_str) {
        return match kind {
            "openai" => Ok(ProviderWire::OpenAiCompletions),
            "anthropic" => Ok(ProviderWire::AnthropicMessages),
            other => Err(RpcError::invalid_params(format!(
                "unknown provider kind `{other}`"
            ))),
        };
    }
    let Some(style) = spec.get("apiStyle").and_then(Value::as_str) else {
        return Ok(ProviderWire::OpenAiCompletions);
    };
    if API_STYLES_NOT_MIGRATED.contains(&style) {
        return Err(RpcError::invalid_params(format!(
            "provider apiStyle `{style}` is not migrated to this kernel yet; supported: {}, {}",
            API_STYLE_OPENAI_COMPLETIONS, API_STYLE_ANTHROPIC_MESSAGES
        )));
    }
    Ok(match style {
        API_STYLE_ANTHROPIC_MESSAGES => ProviderWire::AnthropicMessages,
        _ => ProviderWire::OpenAiCompletions,
    })
}

fn build_provider(spec: &Value) -> Result<Arc<dyn Provider>, RpcError> {
    if spec.get("kind").and_then(Value::as_str) == Some("scripted") {
        return scripted_provider(spec);
    }
    match provider_wire(spec)? {
        ProviderWire::OpenAiCompletions => http_provider(spec, ProviderWire::OpenAiCompletions),
        ProviderWire::AnthropicMessages => http_provider(spec, ProviderWire::AnthropicMessages),
    }
}

/// A provider that replays a fixed script. Development and tests only.
fn scripted_provider(spec: &Value) -> Result<Arc<dyn Provider>, RpcError> {
    let responses = if let Some(script) = spec.get("script").and_then(Value::as_array) {
        // Each entry is one provider response: either a tool call or text.
        // Enough to drive a multi-step turn from a harness.
        script
            .iter()
            .map(|step| {
                let mut events = Vec::new();
                if let Some(call) = step.get("toolCall") {
                    events.push(StreamEvent::ToolCallStart {
                        index: 0,
                        id: call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("call_1")
                            .to_string(),
                        name: call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string(),
                    });
                    events.push(StreamEvent::ToolCallDelta {
                        index: 0,
                        arguments_delta: call
                            .get("arguments")
                            .cloned()
                            .unwrap_or_else(|| json!({}))
                            .to_string(),
                    });
                    events.push(StreamEvent::Finish(crate::message::StopReason::ToolUse));
                } else {
                    events.push(StreamEvent::TextDelta(
                        step.get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    ));
                    events.push(StreamEvent::Finish(crate::message::StopReason::EndTurn));
                }
                events
            })
            .collect::<Vec<_>>()
    } else {
        let text = spec
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("scripted response");
        (0..spec.get("turns").and_then(Value::as_u64).unwrap_or(1))
            .map(|_| {
                vec![
                    StreamEvent::TextDelta(text.to_string()),
                    StreamEvent::Finish(crate::message::StopReason::EndTurn),
                ]
            })
            .collect::<Vec<_>>()
    };
    Ok(Arc::new(ScriptedProvider::new(responses)))
}

/// An HTTP provider over the requested wire.
fn http_provider(spec: &Value, wire: ProviderWire) -> Result<Arc<dyn Provider>, RpcError> {
    let base_url = spec
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params("`provider.baseUrl` is required"))?;
    // A provider row that authenticates elsewhere (`authKind: "none"`) has no
    // key to send, and requiring one would reject a working configuration.
    let authless = spec.get("authKind").and_then(Value::as_str) == Some("none");
    let api_key = match spec.get("apiKey").and_then(Value::as_str) {
        Some(key) => key.to_string(),
        None if authless => String::new(),
        None => return Err(RpcError::invalid_params("`provider.apiKey` is required")),
    };
    let label = spec
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(match wire {
            ProviderWire::OpenAiCompletions => "openai",
            ProviderWire::AnthropicMessages => "anthropic",
        });
    let mut config = match wire {
        ProviderWire::OpenAiCompletions => HttpProviderConfig::openai(label, base_url, &api_key),
        ProviderWire::AnthropicMessages => HttpProviderConfig::anthropic(label, base_url, &api_key),
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

/// First `limit` characters of `text` with runs of whitespace collapsed, for
/// titles and search snippets.
fn snippet(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= limit {
        return collapsed;
    }
    let head: String = collapsed.chars().take(limit).collect();
    format!("{head}…")
}

/// The model window facts a prompt carries. Main stamps them per turn; without
/// them the loop cannot tell a large context from a small one.
fn model_limits_from(request: &Request) -> Option<ModelLimits> {
    // The window is a property of the model, and main stamps it on the provider
    // (`provider.modelConfig`). Reading only top-level params meant the kernel
    // never learned the window from a real prompt and therefore never compacted.
    let model_config = request
        .params
        .get("provider")
        .and_then(|provider| provider.get("modelConfig"));
    let from_model = |key: &str| {
        model_config
            .and_then(|config| config.get(key))
            .and_then(Value::as_u64)
    };
    let context_window = from_model("contextWindow")
        .or_else(|| request.params.get("contextWindow").and_then(Value::as_u64));
    let max_tokens =
        from_model("maxTokens").or_else(|| request.params.get("maxTokens").and_then(Value::as_u64));
    if context_window.is_none() && max_tokens.is_none() {
        return None;
    }
    Some(ModelLimits {
        context_window,
        max_tokens,
    })
}

/// Attributes everything a delegate emits to the `Task` call that started it, so
/// the renderer can nest the rows under it and the parent's history stays one
/// stream.
struct DelegateSink {
    inner: Arc<dyn crate::EventSink>,
    parent_tool_call_id: String,
    agent_name: String,
}

impl crate::EventSink for DelegateSink {
    fn emit(&self, envelope: crate::AgentEventEnvelope) {
        self.inner
            .emit(envelope.with_delegate(&self.parent_tool_call_id, &self.agent_name));
    }
}

/// Collects a review fork's tool calls without showing them to the client.
///
/// The review's writes are ordinary `skill_manage` calls; the transcript never
/// shows them, so the summary the `skill_review` event carries is the only place
/// a person learns what changed.
struct ReviewSink {
    collector: std::sync::Mutex<crate::skill_review::ReviewActionCollector>,
}

impl ReviewSink {
    fn new() -> Self {
        Self {
            collector: std::sync::Mutex::new(crate::skill_review::ReviewActionCollector::new()),
        }
    }

    fn snapshot(&self) -> (usize, Vec<String>) {
        match self.collector.lock() {
            Ok(collector) => (collector.tool_call_count(), collector.action_lines()),
            Err(_) => (0, Vec::new()),
        }
    }
}

impl crate::EventSink for ReviewSink {
    fn emit(&self, envelope: crate::AgentEventEnvelope) {
        let Ok(mut collector) = self.collector.lock() else {
            return;
        };
        match &envelope.event {
            crate::AgentEvent::ToolStart {
                tool_call_id,
                tool_name,
                arguments,
            } => collector.start(tool_call_id, tool_name, arguments),
            crate::AgentEvent::ToolEnd {
                tool_call_id,
                is_error,
                ..
            } => collector.end(tool_call_id, *is_error),
            _ => {}
        }
    }
}

/// Everything one review pass needs, grouped so the pass itself stays readable.
struct SkillReviewInput {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    model: String,
    system: Option<String>,
    policy: crate::skill_review::SkillReviewPolicy,
    mode: crate::prompt::SessionMode,
    session: Arc<Session>,
    out: Arc<dyn LineSink>,
    session_id: String,
    turn_id: String,
    tool_calls: usize,
}

/// One background skill-review pass, for a turn that just ended.
///
/// The review is a fork with tools, not a model asked for a plan: it reads the
/// library through `Skill`, writes through the same `skill_manage` path the
/// foreground uses, and every write is a validated tool call.
async fn skill_review_pass(input: SkillReviewInput) {
    let SkillReviewInput {
        provider,
        tools,
        model,
        system,
        policy,
        mode,
        session,
        out,
        session_id,
        turn_id,
        tool_calls,
    } = input;

    let emit_notice = |notice: &crate::skill_review::ReviewNotice| {
        if !notice.is_visible(policy) {
            return;
        }
        NotificationSink { out: out.clone() }.emit(crate::AgentEventEnvelope::new(
            &session_id,
            turn_id.clone(),
            crate::AgentEvent::SkillReview {
                outcome: notice.outcome.as_str().to_string(),
                reason: notice.reason.clone(),
                actions: notice.actions.clone(),
            },
        ));
    };

    if mode != crate::prompt::SessionMode::Agent {
        // Plan and Goal negotiate a contract first; there is no work in them to
        // learn from.
        emit_notice(&crate::skill_review::ReviewNotice::skipped(
            crate::skill_review::ReviewSkip::Mode.reason(),
        ));
        return;
    }
    if session.review_running.swap(true, Ordering::SeqCst) {
        emit_notice(&crate::skill_review::ReviewNotice::skipped(
            crate::skill_review::ReviewSkip::AlreadyRunning.reason(),
        ));
        return;
    }
    // The guard must not outlive this statement: the pass awaits network work
    // below, and a `MutexGuard` held across an await makes the future `!Send`.
    let qualified = {
        let gate = session.review_gate.lock();
        match gate {
            Ok(mut gate) => gate.qualify(policy, tool_calls, std::time::Instant::now()),
            Err(_) => {
                session.review_running.store(false, Ordering::SeqCst);
                return;
            }
        }
    };
    match Ok::<_, ()>(qualified) {
        Ok(Ok(())) => {}
        Ok(Err(skip)) => {
            session.review_running.store(false, Ordering::SeqCst);
            emit_notice(&crate::skill_review::ReviewNotice::skipped(skip.reason()));
            return;
        }
        Err(()) => {
            session.review_running.store(false, Ordering::SeqCst);
            return;
        }
    }

    let names: Vec<String> = crate::skill_review::REVIEW_TOOL_ALLOWLIST
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let review_tools = Arc::new(tools.restricted(&names));
    if !review_tools.contains("Skill") || !review_tools.contains("skill_manage") {
        // A fork without these would pay a full completion and could not land a
        // single change; naming what is missing is what makes it actionable.
        session.review_running.store(false, Ordering::SeqCst);
        let present = review_tools
            .specs()
            .into_iter()
            .map(|spec| spec.name)
            .collect::<Vec<_>>()
            .join(",");
        emit_notice(&crate::skill_review::ReviewNotice::skipped(format!(
            "no-skill-tools:{present}"
        )));
        return;
    }

    let history = {
        let transcript = session.transcript.lock().await;
        transcript.messages().to_vec()
    };
    let mut transcript =
        crate::session::Transcript::from_messages(crate::skill_review::review_transcript(&history));
    let sink = Arc::new(ReviewSink::new());
    let engine = TurnEngine::new(
        provider,
        review_tools,
        sink.clone() as Arc<dyn crate::EventSink>,
    );
    let config = TurnConfig {
        model,
        system,
        max_steps: crate::skill_review::REVIEW_MAX_ITERATIONS as usize,
        temperature: None,
        max_output_tokens: None,
        thinking: crate::provider::ThinkingLevel::Off,
        infinite_provider_retry: false,
    };
    let review_session_id = format!("{session_id}#skill-review");
    let review_turn_id = format!("{turn_id}#skill-review");
    let cancel = CancelToken::new();
    let mut outcome = engine
        .run_turn(
            &review_session_id,
            &review_turn_id,
            &mut transcript,
            &config,
            cancel.clone(),
        )
        .await;

    // A pass that answered without reading anything has not seen what the
    // library already covers. Correct it once, then accept the answer.
    if outcome.is_ok() && sink.snapshot().0 == 0 {
        transcript.push(Message::user_text(
            crate::skill_review::SKILL_REVIEW_NO_LOOK_RETRY,
        ));
        outcome = engine
            .run_turn(
                &review_session_id,
                &format!("{review_turn_id}#retry"),
                &mut transcript,
                &config,
                cancel,
            )
            .await;
    }

    session.review_running.store(false, Ordering::SeqCst);
    let notice = match outcome {
        Ok(_) => {
            if let Ok(mut gate) = session.review_gate.lock() {
                gate.record_review(std::time::Instant::now());
            }
            let (tool_calls, actions) = sink.snapshot();
            if tool_calls == 0 {
                crate::skill_review::ReviewNotice {
                    outcome: crate::skill_review::ReviewOutcome::Failed,
                    reason: Some("no-tool-calls".to_string()),
                    actions: Vec::new(),
                }
            } else if actions.is_empty() {
                crate::skill_review::ReviewNotice::skipped("nothing-to-save")
            } else {
                crate::skill_review::ReviewNotice {
                    outcome: crate::skill_review::ReviewOutcome::Applied,
                    reason: None,
                    actions,
                }
            }
        }
        Err(error) => crate::skill_review::ReviewNotice::failed(error.code()),
    };
    emit_notice(&notice);
}

/// Runs one delegate turn: its own transcript, its own prompt, only its own tools.
struct SidecarDelegateRunner {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    sink: Arc<dyn crate::EventSink>,
    model: String,
    model_limits: Option<crate::context::ModelLimits>,
    guidance: Vec<String>,
    infinite_provider_retry: bool,
}

impl crate::delegate::DelegateRunner for SidecarDelegateRunner {
    fn run<'a>(
        &'a self,
        request: crate::delegate::DelegateRunRequest,
    ) -> BoxFuture<'a, crate::delegate::DelegateOutcome> {
        Box::pin(async move {
            use crate::delegate::{DelegateOutcome, DelegationError, DelegationStatus};
            let prompt = crate::delegate::compose_subagent_system_prompt(
                &request.definition,
                &self.guidance,
                &request.definition.tools,
            );
            let scoped = Arc::new(self.tools.restricted(&request.definition.tools));
            let sink: Arc<dyn crate::EventSink> = Arc::new(DelegateSink {
                inner: self.sink.clone(),
                parent_tool_call_id: request.parent_tool_call_id.clone(),
                agent_name: request.definition.name.clone(),
            });
            let mut engine = TurnEngine::new(self.provider.clone(), scoped, sink);
            if let Some(limits) = self.model_limits {
                engine = engine.with_model_limits(limits);
            }
            let mut transcript = Transcript::new();
            transcript.push(Message::user_text(request.task.clone()));
            let config = TurnConfig {
                model: self.model.clone(),
                system: Some(prompt),
                max_steps: crate::delegate::SUBAGENT_MAX_STEPS,
                temperature: None,
                max_output_tokens: None,
                thinking: ThinkingLevel::Off,
                // A delegate inherits the session's policy: the same gateway can
                // fail it, and the same retry that saves the parent saves it.
                infinite_provider_retry: self.infinite_provider_retry,
            };
            let outcome = engine
                .run_turn(
                    &request.session_id,
                    &request.delegation_id,
                    &mut transcript,
                    &config,
                    request.cancel.clone(),
                )
                .await;
            let report = last_assistant_text(&transcript);
            let tool_calls = transcript
                .messages()
                .iter()
                .map(|message| message.tool_results().len())
                .sum();
            match outcome {
                Ok(outcome) => {
                    if report.trim().is_empty() {
                        DelegateOutcome {
                            status: DelegationStatus::Failed,
                            report: String::new(),
                            turns: outcome.steps,
                            tool_calls,
                            usage: outcome.usage,
                            error: Some(DelegationError {
                                code: "SUBAGENT_NO_REPORT".into(),
                                message: "The subagent finished without writing a report.".into(),
                            }),
                        }
                    } else {
                        DelegateOutcome {
                            status: DelegationStatus::Completed,
                            report,
                            turns: outcome.steps,
                            tool_calls,
                            usage: outcome.usage,
                            error: None,
                        }
                    }
                }
                Err(crate::error::AgentError::Cancelled) => DelegateOutcome {
                    status: DelegationStatus::Aborted,
                    report,
                    turns: 0,
                    tool_calls,
                    usage: crate::Usage::default(),
                    error: None,
                },
                Err(error) => DelegateOutcome {
                    status: DelegationStatus::Failed,
                    report,
                    turns: 0,
                    tool_calls,
                    usage: crate::Usage::default(),
                    error: Some(DelegationError {
                        code: error.code().to_string(),
                        message: error.to_string(),
                    }),
                },
            }
        })
    }
}

/// The delegate's final assistant text: the only thing the parent model reads.
fn last_assistant_text(transcript: &Transcript) -> String {
    transcript
        .messages()
        .iter()
        .rev()
        .find(|message| message.role == crate::Role::Assistant)
        .map(|message| message.text())
        .unwrap_or_default()
}

/// Tools that can change files or run commands, for the delegate's mutability note.
const MUTATING_TOOLS: [&str; 6] = [
    "Write",
    "Edit",
    "Bash",
    "OfficeWrite",
    "AstEdit",
    "AstEditApply",
];

/// Read the subagent definitions a prompt declares.
///
/// An entry without a name is dropped: the model picks a delegate by name, so an
/// entry it cannot name is not one it can start.
fn parse_subagents(request: &Request) -> Vec<crate::delegate::SubagentDefinition> {
    let Some(entries) = request.params.get("subagents").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut definitions = Vec::new();
    for entry in entries {
        let Some(name) = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        let description = entry
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let prompt = entry
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let tools: Vec<String> = entry
            .get("tools")
            .and_then(Value::as_array)
            .map(|tools| {
                tools
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|tool| !tool.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let can_mutate = tools
            .iter()
            .any(|tool| MUTATING_TOOLS.iter().any(|known| known == tool));
        definitions.push(crate::delegate::SubagentDefinition {
            name: name.to_string(),
            description,
            prompt,
            tools,
            can_mutate,
        });
    }
    definitions
}

#[cfg(test)]
mod provider_wire_tests {
    use super::*;

    /// The payload Electron main actually sends: a `RuntimeProviderConfig` with
    /// `apiStyle` and `modelId`, and no `kind` field at all.
    fn production_spec(api_style: Option<&str>) -> Value {
        let mut spec = json!({
            "id": "row-1",
            "name": "Gateway",
            "baseUrl": "https://gateway.example/v1",
            "modelId": "gw-large",
            "apiKey": "test-key",
            "authKind": "api-key",
            "supportsReasoning": true,
            "supportedThinkingLevels": ["off", "low"],
        });
        if let Some(style) = api_style {
            spec["apiStyle"] = json!(style);
        }
        spec
    }

    #[test]
    fn a_production_payload_without_kind_builds_a_provider() {
        // Regression: the kernel used to require `provider.kind`, which no real
        // prompt carries, so every production prompt was rejected as invalid.
        for style in [None, Some("openai-completions"), Some("opencode_go")] {
            let provider = build_provider(&production_spec(style))
                .unwrap_or_else(|error| panic!("style {style:?} rejected: {error}"));
            assert!(!provider.name().is_empty());
        }
    }

    #[test]
    fn an_anthropic_style_selects_the_anthropic_wire() {
        assert_eq!(
            provider_wire(&production_spec(Some("anthropic_messages"))).unwrap(),
            ProviderWire::AnthropicMessages
        );
        assert_eq!(
            provider_wire(&production_spec(Some("openai-completions"))).unwrap(),
            ProviderWire::OpenAiCompletions
        );
    }

    #[test]
    fn an_unmigrated_wire_fails_loudly_instead_of_using_the_wrong_endpoint() {
        for style in ["responses", "openai_codex_responses", "pi_messages"] {
            let error = provider_wire(&production_spec(Some(style)))
                .expect_err("an unimplemented wire must not silently become Chat Completions");
            let message = error.to_string();
            assert!(message.contains(style), "{message}");
            assert!(message.contains("not migrated"), "{message}");
        }
    }

    #[test]
    fn an_unrecognised_style_falls_back_to_chat_completions() {
        // Matches `apiBindingForStyle` upstream: unknown styles are the
        // pre-apiStyle behaviour, not an error.
        assert_eq!(
            provider_wire(&production_spec(Some("something_new"))).unwrap(),
            ProviderWire::OpenAiCompletions
        );
    }

    #[test]
    fn an_explicit_kind_still_pins_the_wire() {
        let mut spec = production_spec(None);
        spec["kind"] = json!("anthropic");
        assert_eq!(
            provider_wire(&spec).unwrap(),
            ProviderWire::AnthropicMessages
        );
        spec["kind"] = json!("openai");
        assert_eq!(
            provider_wire(&spec).unwrap(),
            ProviderWire::OpenAiCompletions
        );
        spec["kind"] = json!("nonsense");
        assert!(provider_wire(&spec).is_err());
    }

    #[test]
    fn a_provider_that_authenticates_elsewhere_needs_no_key() {
        let mut spec = production_spec(None);
        spec["authKind"] = json!("none");
        spec.as_object_mut().expect("object").remove("apiKey");
        assert!(build_provider(&spec).is_ok());

        spec["authKind"] = json!("api-key");
        assert!(
            build_provider(&spec).is_err(),
            "a key-using provider without a key is a configuration error"
        );
    }
}
