//! The sidecar process: JSON-RPC methods over one stdio channel.
//!
//! Upstream counterpart: none — this layer is the desktop's own contract, taken
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
use crate::tool::{AllowAll, PermissionGate, ToolRegistry, ToolSpec};
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
    /// The step ceiling a launch inherits when it names none. `None` — the
    /// default — leaves the turn uncapped; `sidecar.configure` can still set one.
    max_steps: Option<usize>,
    temperature: Option<f32>,
    max_output_tokens: Option<u32>,
    /// The reasoning budget a prompt inherits when it names none. Set once by
    /// `sidecar.configure`; a prompt may still override it for one turn.
    thinking: ThinkingLevel,
}

impl RuntimeConfig {
    fn new() -> Self {
        Self::default()
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
    /// The last turn this session ran, kept after it settles.
    ///
    /// `agent.getStatus` is polled for progress by external MCP clients and the
    /// renderer, and the terminal answer they look for is "this turn, no longer
    /// running". Clearing every trace of the turn on completion left those pollers
    /// waiting forever for a turn that had already finished.
    last_turn: Mutex<Option<String>>,
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
    /// The plan lane's state: the approval awaiting an answer, and the receipt of
    /// the host's last accepted checklist write. The checklist itself lives in
    /// host-core, beside the transcript it belongs to.
    plan: Arc<crate::plan::PlanState>,
    /// Turn-boundary snapshots, so a wrong turn can be rewound.
    checkpoints: Mutex<crate::checkpoint::CheckpointStore>,
    /// The staged mode run this session's last prompt claimed, and what Electron
    /// main has since said about it. Written by `agent.prompt` (`modeTurn`) and by
    /// `agent.modeTurnNotice`; the run itself belongs to host-core.
    mode_run: Mutex<ModeRun>,
    /// The on-demand tools this session has switched on with `ToolSearch`.
    ///
    /// Sticky for the session, as in the Node runtime (`resetDeferredToolsForPrompt`,
    /// #1225): activation that resets on every prompt leaves the model calling
    /// tools the next request no longer declares. Names are intersected with the
    /// live catalog when they are read, so a mode switch cannot resurrect a tool
    /// that mode withholds.
    active_tools: Arc<Mutex<std::collections::BTreeSet<String>>>,
    /// What the last turn composed, for the extension surface
    /// (`agent.surface`): the prompt, the budget and the declaration set.
    ///
    /// Main answers a trusted extension's `ctx.getContextUsage()` and friends
    /// under the Node runtime from its live agent state; under this kernel that
    /// state is here, so the turn records it once and a read reports it.
    surface: crate::session_surface::SessionSurface,
}

/// The run turn one prompt claimed: which run, and which stage of it.
///
/// Mirrors `ModeTurnContext` from `@pi-workspace/shared`, narrowed to what this
/// process decides anything from. The kernel does not compose the stage brief or
/// the `CompleteStage` gate (the Node runtime does that from the run's
/// `modeDefinition`, which never reaches this side), so the claim is kept for
/// identity: a notice for this turn and this run is applied, anything else is not.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ModeRunTurn {
    turn_id: String,
    run_id: String,
    stage_id: String,
}

/// What this session knows about its mode run.
#[derive(Debug, Clone, Default)]
struct ModeRun {
    /// The run turn the session's last prompt claimed.
    turn: Option<ModeRunTurn>,
    /// Main paused the run while that turn was working on it.
    closing_out: bool,
}

impl Session {
    fn new(session_id: &str) -> Self {
        Self {
            transcript: Arc::new(tokio::sync::Mutex::new(Transcript::new())),
            cancel: Mutex::new(CancelToken::new()),
            running: AtomicBool::new(false),
            current_turn: Mutex::new(None),
            last_turn: Mutex::new(None),
            steering: Mutex::new(std::collections::VecDeque::new()),
            skills: Arc::new(crate::skills::SkillCatalog::new()),
            restored: AtomicBool::new(false),
            journal: Mutex::new(crate::journal::SystemJournal::new()),
            review_gate: Mutex::new(crate::skill_review::ReviewGate::new()),
            review_running: AtomicBool::new(false),
            delegations: Arc::new(crate::delegate::DelegationRegistry::new(session_id)),
            plan: Arc::new(crate::plan::PlanState::new()),
            checkpoints: Mutex::new(crate::checkpoint::CheckpointStore::default()),
            mode_run: Mutex::new(ModeRun::default()),
            active_tools: crate::tool_activation::ToolActivation::empty_active(),
            surface: crate::session_surface::SessionSurface::new(),
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

    fn pending(&self) -> bool {
        self.steering
            .lock()
            .map(|queue| !queue.is_empty())
            .unwrap_or(false)
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

/// What a session's own tools are built from.
///
/// Named rather than passed as seven positional arguments: `agent.prompt` and
/// `agent.tokenReport` build the same set, and a caller that swapped two
/// `&Arc<…>` parameters would still compile.
struct SessionToolInputs<'a> {
    request: &'a Request,
    mode: &'a crate::prompt::SessionMode,
    catalog: &'a [crate::skills::SkillDef],
    session: &'a Arc<Session>,
    provider: Arc<dyn Provider>,
    config: &'a RuntimeConfig,
    tools: &'a Arc<ToolRegistry>,
}

pub struct Sidecar {
    out: Arc<dyn LineSink>,
    provider: Mutex<Option<Arc<dyn Provider>>>,
    tools: Mutex<Arc<ToolRegistry>>,
    /// What the host declared, apart from what this kernel installed.
    ///
    /// `agent.tokenReport` answers "what would a prompt in this mode declare",
    /// and a built-in this kernel added for some *other* mode must not be counted
    /// there — which is exactly what reading the live registry did.
    host_specs: Mutex<Vec<ToolSpec>>,
    gate: Arc<dyn PermissionGate>,
    bridge: Arc<HostBridge>,
    /// The mode the most recent prompt ran under.
    ///
    /// Install time is the only place the mode is known, and the delegate runner needs
    /// it later to describe the same permission to its workers. Agent until a prompt
    /// says otherwise: a worker inheriting the permissive reading is the safe default
    /// only because the gate, not this field, is what refuses a call.
    mode: Arc<std::sync::RwLock<crate::prompt::SessionMode>>,
    config: Mutex<RuntimeConfig>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// The ask cards waiting for an answer. One broker per sidecar: a card is
    /// resolved by session id, not by whichever turn happened to create it.
    asks: Arc<crate::ask::AskBroker>,
    /// The supervisors, one per router session. Created on first use, because most
    /// sessions never receive an environment event.
    super_agents: Mutex<HashMap<String, Arc<crate::super_agent::SuperAgent>>>,
    /// The execution boundary. One policy for the process, shared by every registry
    /// derived from it: a session may restrict it further, never relax it silently.
    exec_policy: Arc<crate::exec_policy::ExecPolicyCell>,
    /// The registry before the kernel's own `Bash` was added, so turning the local
    /// shell back off restores exactly what the host had declared.
    base_tools: Mutex<Option<Arc<ToolRegistry>>>,
    /// The program the kernel's own shell runs, when it is on. `None` means this
    /// process spawns nothing at all.
    local_shell: Mutex<Option<String>>,
    /// The shell identity a prompt inherits when it names none: `configure`'s
    /// `commandShell`, or the local shell the process runs itself. One turn's
    /// label, not a permission — the host still applies its own policy.
    configured_shell: Mutex<Option<crate::builtin_tools::ShellIdentity>>,
    /// When work is due. Shared, because a tick and an add can arrive together.
    schedule: crate::schedule::SharedSchedule,
    /// What a session may do without a person saying yes.
    approval: Arc<crate::approval::ApprovalCell>,
    /// Outbound delivery intents: at-least-once, with backoff and a dead letter. The
    /// kernel keeps the bookkeeping; the host does the sending.
    deliveries: Mutex<crate::delivery::DeliveryQueue>,
}

impl Sidecar {
    pub fn new(out: Arc<dyn LineSink>, gate: Arc<dyn PermissionGate>) -> Self {
        let sink: Arc<dyn crate::EventSink> = Arc::new(NotificationSink { out: out.clone() });
        let exec_policy =
            crate::exec_policy::ExecPolicyCell::new(crate::exec_policy::ExecPolicy::default());
        // Approval is layered over whatever gate the host supplied: the host's refusal
        // stands, and this decides what a session may do without a person saying yes.
        let approval = crate::approval::ApprovalCell::new(
            crate::approval::ApprovalPolicy::default()
                .with_workspace(std::env::current_dir().unwrap_or_default()),
        );
        let gate: Arc<dyn PermissionGate> =
            crate::approval::ApprovalGate::new(gate, approval.clone());
        Self {
            bridge: Arc::new(HostBridge::new(out.clone())),
            mode: Arc::new(std::sync::RwLock::new(crate::prompt::SessionMode::Agent)),
            asks: Arc::new(crate::ask::AskBroker::new(sink)),
            out,
            provider: Mutex::new(None),
            // Every tool call in this process passes this registry, so the execution
            // boundary is installed once, here, and cannot be forgotten per call site.
            tools: Mutex::new(Arc::new(
                ToolRegistry::new(gate.clone()).with_exec_policy(exec_policy.clone()),
            )),
            host_specs: Mutex::new(Vec::new()),
            gate,
            config: Mutex::new(RuntimeConfig::new()),
            sessions: Mutex::new(HashMap::new()),
            super_agents: Mutex::new(HashMap::new()),
            exec_policy,
            approval,
            deliveries: Mutex::new(crate::delivery::DeliveryQueue::new(
                crate::delivery::DeliveryPolicy::default(),
            )),
            base_tools: Mutex::new(None),
            local_shell: Mutex::new(None),
            configured_shell: Mutex::new(None),
            schedule: crate::schedule::shared(),
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
        // Method and id only: params carry user content and tool arguments, which
        // a support log must not hold.
        tracing::debug!(
            target: "agent_core::sidecar",
            method = %request.method,
            request_id = ?id,
            "request received"
        );
        let started = std::time::Instant::now();
        let result = self.dispatch(&request).await;
        match (id, result) {
            (Some(id), Ok(value)) => Some(rpc::response(id, value)),
            (Some(id), Err(error)) => {
                tracing::warn!(
                    target: "agent_core::sidecar",
                    method = %request.method,
                    %error,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "request failed"
                );
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
                // The process shape, stated as a property rather than a promise: an
                // enterprise behaviour engine scores this binary on what it starts and
                // how. Off by default, nothing is started at all.
                "processShape": {
                    "spawnsProcesses": self.local_shell.lock().map(|shell| shell.is_some()).unwrap_or(false),
                    "localShell": self.local_shell.lock().ok().and_then(|shell| shell.clone()),
                    // `CREATE_NO_WINDOW` on a child that was asked for, never a script
                    // asking to be hidden: the flag is the ordinary way to not show a
                    // console, and it is what the reference implementation's own executor uses.
                    "consoleWindow": "none",
                    "selfCopy": false,
                },
                "execPolicy": json!(self.exec_policy.snapshot()),
                // What this session may do without a person saying yes, and the soonest
                // fire time so a host can set one timer instead of polling.
                "approval": {
                    "floor": self.approval.snapshot().floor,
                    "modes": self.approval.snapshot().modes,
                },
                "delivery": self
                    .deliveries
                    .lock()
                    .map(|queue| json!(queue.stats(crate::schedule::now_ms())))
                    .unwrap_or_else(|_| json!(null)),
                // The soonest fire time, so a host can set one timer instead of
                // polling: `None` means nothing is scheduled.
                "nextWakeupAtMs": self
                    .schedule
                    .lock()
                    .ok()
                    .and_then(|book| book.next_wakeup()),
            })),
            "sidecar.configure" => self.configure(request),
            "agent.prompt" | "agent.turn" => self.prompt(request).await,
            // An approved plan runs as one ordinary Agent turn: main has already
            // claimed the execution and begun the durable turn, and all that is
            // missing is the instruction that says what is being executed.
            "agent.executeApprovedPlan" => self.execute_approved_plan(request).await,
            "agent.compact" => self.compact(request).await,
            "agent.tokenReport" => self.token_report(request),
            "asktool.resolve" => self.resolve_ask(request),
            "agent.steer" => self.steer(request),
            "agent.steeringContext" => self.steering_context(request),
            // A staged mode run's turn changed under it: the user paused the run,
            // or removed it. Main sends the notice; this kernel answers whether it
            // was applied to the turn and run it names.
            "agent.modeTurnNotice" => self.mode_turn_notice(request),
            "agent.abort" => self.abort(request),
            // `agent.stop`: the same turn-addressed path as `agent.abort`, with
            // the opposite effect on the work in flight — see `stop`.
            "agent.stop" => self.stop(request),
            "agent.getStatus" => self.get_status(request),
            // What a kernel-run extension command reads off `ctx`. Under the
            // Node runtime the runtime answers these from its live agent state;
            // here the kernel composes the prompt and holds the activation set,
            // so main asks rather than re-deriving either.
            "agent.surface" => self.surface(request),
            "agent.setActiveTools" => self.set_active_tools(request),
            "agent.stopSubagents" => self.stop_subagents(request),
            "agent.disposeSession" => self.dispose_session(request),
            "native.session.get" => self.session_get(request).await,
            "native.session.list" => self.session_list(request),
            "native.session.fork" => self.session_fork(request).await,
            "native.session.search" => self.session_search(request).await,
            // The plan and the rewind points are the kernel's own state: no host
            // round trip, and no second store to keep in step with the transcript.
            "agent.plan" => self.plan_status(request),
            "agent.checkpoints" => self.checkpoints(request),
            "agent.rewind" => self.rewind(request).await,
            "agent.execPolicy" => self.exec_policy_rpc(request),
            "agent.approvalPolicy" => self.approval_policy_rpc(request),
            // When work is due: the kernel answers *when*, the host answers *what*.
            // A tick returns the jobs that are due and nothing else, so a host that
            // crashes between the tick and the run loses no schedule: the next tick
            // reports the job again, late, once.
            "schedule.add" => self.schedule_add(request),
            "schedule.list" => self.schedule_list(request),
            "schedule.remove" => self.schedule_remove(request),
            "schedule.enable" => self.schedule_enable(request),
            "schedule.tick" => self.schedule_tick(request),
            // Outbound delivery: the kernel keeps "what was meant to go out, how many
            // times, and which ones are beyond saving"; the host does the sending.
            "delivery.enqueue" => self.delivery_enqueue(request),
            "delivery.claim" => self.delivery_claim(request),
            "delivery.complete" => self.delivery_complete(request),
            "delivery.fail" => self.delivery_fail(request),
            "delivery.requeue" => self.delivery_requeue(request),
            "delivery.list" => self.delivery_list(request),
            "delivery.stats" => self.delivery_stats(request),
            "delivery.purge" => self.delivery_purge(request),
            // The Super-agent surface: events in, decisions out, reports back. The
            // worker turns themselves are ordinary prompts on the worker's own
            // session id, so the host keeps its approval and UI paths.
            "superagent.configure" => self.superagent_configure(request),
            "superagent.trigger" => self.superagent_trigger(request),
            "superagent.pump" => self.superagent_pump(request).await,
            "superagent.report" => self.superagent_report(request),
            "superagent.status" => self.superagent_status(request),
            "superagent.threads" => self.superagent_threads(request),
            "superagent.recall" => self.superagent_recall(request),
            "superagent.workerStop" => self.superagent_worker_stop(request),
            "superagent.watchdog" => self.superagent_watchdog(request),
            "superagent.asyncStart" => self.superagent_async_start(request),
            "superagent.asyncList" => self.superagent_async_list(request),
            "superagent.asyncStop" => self.superagent_async_stop(request),
            other => Err(RpcError::method_not_found(other)),
        }
    }

    fn configure(&self, request: &Request) -> Result<Value, RpcError> {
        // The execution boundary is configuration, not a per-call opinion: a host
        // that wants a looser shape says so once, here, and health reports it.
        self.apply_exec_policy(request)?;
        // Same for approval: the floor and the allow rules are session configuration.
        self.apply_approval_policy(request)?;
        // The kernel's own `Bash` is opt-in. Off, this process spawns nothing; on, the
        // command runs through the reference-shaped executor (`crate::exec`).
        self.apply_local_shell(request)?;
        // Which shell a `Bash` call is labelled with. `localShell` above names the
        // program this process runs itself; `commandShell` names the host's shell,
        // and it wins when both are present because it is the more specific answer.
        self.apply_command_shell(request)?;
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
            config.max_steps = Some(steps.max(1) as usize);
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
        // The reasoning budget this process defaults to. A prompt may name its own
        // for one turn; an unreadable value keeps what is already configured
        // instead of silently turning reasoning off.
        if let Some(level) = request
            .str_param("thinkingLevel")
            .and_then(ThinkingLevel::parse)
        {
            config.thinking = level;
        }
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
            Some(declarations) => {
                let shell = self.shell_identity();
                // `configure` has no turn mode; its declarations belong to the
                // default agent mode.
                self.install_tools(declarations, shell.as_ref(), "agent")?
            }
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
    ///
    /// The shell identity travels with them because a host that declares `Bash`
    /// itself is still talking to a host that refuses the call without one.
    fn install_tools(
        &self,
        declarations: &[Value],
        shell: Option<&crate::builtin_tools::ShellIdentity>,
        mode: &str,
    ) -> Result<Value, RpcError> {
        let mut registry = ToolRegistry::new(self.gate.clone());
        for declaration in declarations {
            let spec = tool_spec_from_value(declaration).map_err(RpcError::invalid_params)?;
            registry.register(Arc::new(
                HostTool::new(spec, self.bridge.clone())
                    .with_shell(shell.cloned())
                    .with_mode(mode.to_string()),
            ));
        }
        let count = declarations.len();
        // This registry holds the host's declarations and nothing else, so it is
        // also the record of what the host declared.
        if let Ok(mut host) = self.host_specs.lock() {
            *host = registry.specs();
        }
        *self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))? = Arc::new(registry);
        Ok(json!(count))
    }

    /// The shell a prompt's `Bash` call is labelled with when the prompt names
    /// none: what `sidecar.configure` declared, or the local shell this process
    /// runs itself. `None` means the call carries no identity at all.
    fn shell_identity(&self) -> Option<crate::builtin_tools::ShellIdentity> {
        self.configured_shell
            .lock()
            .ok()
            .and_then(|shell| shell.clone())
    }

    /// Where a request's tokens go, itemised.
    ///
    /// Read-only and side-effect free: it composes the prompt this session would
    /// send and prices it. Nothing here trims or reorders — the report is what
    /// makes the next change defensible.
    ///
    /// Both halves are priced as they *would* be if the caller sent a prompt in
    /// `mode` now. `mode` used to change only the prompt text while the tools came
    /// from the live registry, which holds whatever the previous prompt installed:
    /// a Plan report after an Agent turn counted `Write` and `Edit`, tools Plan
    /// never declares. The declarations are rebuilt here from the same three
    /// sources `prompt` installs, and split the same way the turn splits them.
    fn token_report(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?.to_string();
        let config = self
            .config
            .lock()
            .map_err(|_| RpcError::internal("config lock poisoned"))?
            .clone();
        let catalog = crate::skills::parse_catalog(request.params.get("pluginSkills"));
        let mode = crate::prompt::SessionMode::parse(request.str_param("mode"));
        // What the host declared...
        let mut specs = self
            .host_specs
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        // ...plus this mode's built-ins...
        let shell = crate::builtin_tools::ShellIdentity::from_params(&request.params)
            .or_else(|| self.shell_identity());
        for declaration in crate::builtin_tools::declarations(mode.clone(), shell.as_ref()) {
            push_unique_spec(
                &mut specs,
                tool_spec_from_value(&declaration).map_err(RpcError::invalid_params)?,
            );
        }
        // ...plus this session's own tools.
        let registry = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        let session = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?
            .get(&session_id)
            .cloned();
        // The previous prompt's provider is the fallback: a report priced without
        // one would miss the delegation tools the same prompt declares.
        let provider = match request
            .params
            .get("provider")
            .filter(|value| !value.is_null())
        {
            Some(spec) => Some(build_provider(spec)?),
            None => self
                .provider
                .lock()
                .ok()
                .and_then(|provider| provider.clone()),
        };
        if let (Some(session), Some(provider)) = (&session, provider) {
            for tool in self.session_tools(SessionToolInputs {
                request,
                mode: &mode,
                catalog: &catalog,
                session,
                provider,
                config: &config,
                tools: &registry,
            }) {
                push_unique_spec(&mut specs, tool.spec());
            }
        }
        let activation = crate::tool_activation::ToolActivation::new(
            &mode,
            specs,
            session
                .as_ref()
                .map(|session| session.active_tools.clone())
                .unwrap_or_else(crate::tool_activation::ToolActivation::empty_active),
        );
        let section = activation.activation_section();
        let composed = self.compose_prompt(request, &config, mode, &catalog, section.as_deref());
        // What one request in this mode carries: core, the activated tools, and
        // `ToolSearch` when anything is deferred.
        let declared = activation.declared();
        // A turn in flight holds the transcript; the report then says what it can
        // rather than blocking the question behind the work being measured.
        let history = match &session {
            Some(session) => session
                .transcript
                .try_lock()
                .map(|transcript| transcript.messages().to_vec())
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let cost = crate::token_report::RequestCost {
            system: crate::token_report::system_cost(&composed),
            tools: crate::token_report::tools_cost(&declared),
            history: crate::token_report::history_cost(&history),
            memory: None,
        };
        // What the session stores is not what is charged: old tool output is aged
        // for the request only. Both numbers belong in the answer, because the gap
        // between them is the saving.
        let limits = model_limits_from(request).map(crate::context::ContextLimits::for_model);
        let aged = crate::aging::age_tool_results(
            &history,
            limits.as_ref(),
            crate::aging::ToolResultAging::default(),
        );
        let aged_history_tokens = crate::context::estimate_context_tokens(&aged.messages).tokens;
        let (system, tools, _, memory) = cost.group_tokens();
        let mut report = cost.to_json();
        report["request"] = serde_json::json!({
            "tokens": system + tools + aged_history_tokens + memory,
            "historyTokens": aged_history_tokens,
            "aging": {
                "agedResults": aged.aged,
                "charsElided": aged.chars_elided,
            },
        });
        // The tools an activation would add, priced but not charged: this is the
        // headroom the split buys, and it has to be visible or the saving is a
        // claim rather than a measurement.
        let deferred = activation.deferred_specs().to_vec();
        let deferred_cost = crate::token_report::RequestCost {
            system: Vec::new(),
            tools: crate::token_report::tools_cost(&deferred),
            history: Vec::new(),
            memory: None,
        };
        report["onDemand"] = deferred_cost.to_json()["tools"].clone();
        report["declarations"] = serde_json::json!({
            "declared": declared.len(),
            "core": activation.core_specs().len(),
            "onDemand": deferred.len(),
            "active": activation.active_names().len(),
        });
        Ok(report)
    }

    /// Add the built-in declarations this mode may use.
    ///
    /// They are host-executed like any other declaration: the kernel owns the
    /// declaration and the host owns the run, which is the same split the Node
    /// runtime has. `shell` is the identity this turn's `Bash` call carries.
    fn install_builtin_tools(
        &self,
        shell: Option<&crate::builtin_tools::ShellIdentity>,
        mode: crate::prompt::SessionMode,
    ) -> Result<(), RpcError> {
        let declarations = crate::builtin_tools::declarations(mode, shell);
        // `extended` with nothing is how the registry is copied: it is not
        // `Clone` on purpose, so a caller states that it is building a new set.
        let mut registry = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .extended(Vec::new());
        for declaration in declarations {
            let spec = tool_spec_from_value(&declaration).map_err(RpcError::invalid_params)?;
            if registry.contains(&spec.name) {
                continue;
            }
            registry.register(Arc::new(
                HostTool::new(spec, self.bridge.clone()).with_shell(shell.cloned()),
            ));
        }
        *self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))? = Arc::new(registry);
        Ok(())
    }

    /// The tools a session exists for: delegation, the skill library, the
    /// checklist, the plan hand-off, asking, and memory.
    ///
    /// One builder for two callers — [`Self::prompt`], which registers them, and
    /// [`Self::token_report`], which prices them. Two builders would drift, and a
    /// report that priced a set the prompt never installs is the bug this path
    /// exists to fix.
    fn session_tools(&self, inputs: SessionToolInputs<'_>) -> Vec<Arc<dyn crate::Tool>> {
        let SessionToolInputs {
            request,
            mode,
            catalog,
            session,
            provider,
            config,
            tools,
        } = inputs;
        // A delegate reruns this session's model, so it needs the retry policy
        // the prompt was launched with.
        let infinite_provider_retry = request
            .params
            .get("infiniteProviderRetry")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut extra: Vec<Arc<dyn crate::Tool>> = Vec::new();
        let subagents = parse_subagents(request);
        if !subagents.is_empty() && matches!(mode, crate::prompt::SessionMode::Agent) {
            // A delegate runs its own turn with the session's provider and only
            // the tools its definition declares. `Task.model` may name one of the
            // delegation models main authorized for this turn; without one the
            // delegate runs exactly as before, on the session's own model.
            let models = parse_subagent_models(request);
            let model_keys: Vec<String> = models.keys().cloned().collect();
            // Smart mode names the cheap half as the delegation default; a key
            // outside the catalog is dropped here rather than refused later, so a
            // stale launch cannot fail every `Task` call it makes.
            let delegation_default = request
                .str_param("delegationDefaultModel")
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string);
            let hub = Arc::new(
                crate::delegate::DelegationHub::new(
                    session.delegations.clone(),
                    subagents,
                    Arc::new(SidecarDelegateRunner {
                        provider,
                        tools: tools.clone(),
                        sink: Arc::new(NotificationSink {
                            out: self.out.clone(),
                        }),
                        model: config.model.clone(),
                        model_limits: model_limits_from(request),
                        models: Arc::new(models),
                        guidance: Vec::new(),
                        mode: self.mode.clone(),
                        infinite_provider_retry,
                        cache: crate::provider::CacheRetention::resolve(
                            request.str_param("cacheRetention"),
                            std::env::var("PI_CACHE_RETENTION").ok().as_deref(),
                        ),
                    }),
                )
                .with_models(model_keys)
                .with_default_model(delegation_default)
                // A delegate settles after the step that started it, so the hub
                // — not the turn loop — owns the refreshed `Task` row. Same sink
                // the delegate's own rows go to.
                .with_sink(Arc::new(NotificationSink {
                    out: self.out.clone(),
                })),
            );
            extra.push(Arc::new(crate::delegate::TaskTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskWaitTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskListTool::new(hub.clone())));
            extra.push(Arc::new(crate::delegate::TaskStopTool::new(hub)));
        }
        // `Skill` exists only when a library exists, and only in the mode that may
        // write one — the same gate the desktop runtime uses. A tool whose only
        // honest answer is "there is nothing here" is noise in every request.
        if !catalog.is_empty() && matches!(mode, crate::prompt::SessionMode::Agent) {
            // An id lookup is forwarded to the host's own `Skill` handler when
            // main declared one; the listing is answered here.
            let load = tools.get(crate::skills::SKILL_TOOL_NAME);
            extra.push(Arc::new(crate::skills::SkillTool::new(
                session.skills.clone(),
                load,
            )));
        }
        // The session checklist is the host's tool, not the kernel's: `TodoWrite`
        // is the Node runtime's name and argument shape, host-core normalizes the
        // list and writes it, and the kernel only relays the call — the same path
        // `Read` and `Bash` take. Agent mode only: host-core refuses a write from
        // a Plan or Goal session, and the Node runtime withholds the tool there
        // too (`mode-tool-access.ts`, `RETAINED_MODE_TOOLS`).
        if matches!(mode, crate::prompt::SessionMode::Agent) {
            extra.push(Arc::new(crate::plan::TodoWriteTool::new(
                self.bridge.clone(),
                session.plan.clone(),
            )));
        }
        // A Plan turn's whole purpose is to hand its plan over. The host owns the
        // `.pi/plan` artifact and the review, so `SubmitPlan` — forwarding
        // `plans.submit` — is the only path that opens the approval gate. It is
        // registered in Plan mode alone, the same gate the Node runtime applies:
        // an Agent turn that could submit would reopen an approval the user
        // already gave.
        if matches!(mode, crate::prompt::SessionMode::Plan) {
            let host: Arc<dyn crate::plan::PlanHost> = self.bridge.clone();
            extra.push(Arc::new(crate::plan::SubmitPlanTool::new(
                host,
                session.plan.clone(),
                Arc::new(NotificationSink {
                    out: self.out.clone(),
                }),
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
        extra
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
        tool_activation: Option<&str>,
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
        inputs.tool_activation = tool_activation;
        // `smartTurn.tier` is the host's own routing decision. Only the strong
        // half is told to orchestrate: the cheap half is the one executing.
        inputs.smart_orchestrator = request
            .params
            .get("smartTurn")
            .and_then(|turn| turn.get("tier"))
            .and_then(serde_json::Value::as_str)
            .filter(|tier| *tier == "main")
            .map(|_| crate::prompt::smart::SMART_ORCHESTRATOR);
        // The host resolves both of these — it reads the files, applies its byte caps
        // and knows the workspace — so the kernel must not re-read them; it only has to
        // stop dropping what it was handed.
        let (custom, project) = host_prompt_inputs(&request.params);
        inputs.custom = custom.as_ref();
        inputs.project = project.as_ref();
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

    /// A session this process already knows, without creating one.
    ///
    /// A read uses this, not [`Self::session`]: inserting on a read would make a
    /// session the kernel has never run a turn for answer as an empty
    /// conversation, and its history only arrives from host-core at the first
    /// prompt. "Not known here" is the honest answer, and the caller says so.
    fn known_session(&self, session_id: &str) -> Result<Option<Arc<Session>>, RpcError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        Ok(sessions.get(session_id).cloned())
    }

    /// `agent.executeApprovedPlan`: run a plan the user approved.
    ///
    /// Upstream counterparts: `executeApprovedPlan` / `executeApprovedPlanTurn`
    /// in `packages/agent-runtime/src/runtime.ts`, and the handler in
    /// `packages/agent-runtime/src/sidecar.ts`. Main has already claimed the
    /// execution, begun the durable turn and launched this session in Agent mode
    /// (`apps/desktop/electron/main/runtime/plans.ts`), so the only thing missing
    /// is the instruction that names the approved snapshot. That instruction
    /// becomes this turn's user message and the turn runs through the normal
    /// prompt path: an approved plan is an ordinary Agent turn, and a second
    /// execution path beside the first is a second set of bugs.
    async fn execute_approved_plan(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.str_param("sessionId").unwrap_or("").to_string();
        let turn_id = request.str_param("turnId").unwrap_or("").trim().to_string();
        let execution = request
            .params
            .get("execution")
            .filter(|value| value.is_object())
            .cloned();
        let (Some(execution), false) = (execution, session_id.is_empty() || turn_id.is_empty())
        else {
            return Err(RpcError::app(
                "PLAN_EXECUTION_NOT_FOUND",
                "approved plan execution parameters required",
            ));
        };
        // The descriptor names its own session, and an approval granted in one
        // conversation must never run in another.
        if let Some(owner) = execution.get("sessionId").and_then(Value::as_str) {
            if owner != session_id {
                return Err(RpcError::app(
                    "PLAN_EXECUTION_NOT_FOUND",
                    "approved plan belongs to another session",
                ));
            }
        }
        let instruction = crate::plan::approved_execution_instruction(&execution)
            .map_err(|reason| RpcError::app("PLAN_EXECUTION_NOT_FOUND", reason))?;
        let mut params = request.params.clone();
        if let Some(map) = params.as_object_mut() {
            map.insert("content".into(), json!(instruction));
            // Approved plans always execute as the builtin Agent, whatever mode
            // the launch parameters carried.
            map.insert("mode".into(), json!("agent"));
            map.insert("turnId".into(), json!(turn_id));
            // The descriptor is not a prompt input and its Markdown is already
            // inside the instruction; forwarding it would send the plan twice.
            map.remove("execution");
            // No optimistic row was drawn for this turn, so there is no renderer
            // id to reconcile with.
            map.remove("userMessageId");
            // The Node runtime's approved-execution turn appends the instruction
            // and continues: it runs no recall round trip, and the instruction is
            // not a query. Recalling on it would spend a host call to inject
            // memories that have nothing to do with the approved plan.
            map.insert("memoryRecall".into(), json!(false));
        }
        let prompt = Request {
            jsonrpc: request.jsonrpc.clone(),
            id: request.id.clone(),
            method: "agent.prompt".into(),
            params,
        };
        self.prompt(&prompt).await
    }

    /// Publish one planning-state transition, at most once per distinct state.
    ///
    /// A prompt declares its mode on every turn; the renderer needs the
    /// transitions, not a heartbeat.
    fn announce_planning(
        &self,
        session: &Session,
        session_id: &str,
        turn_id: &str,
        update: crate::AgentEvent,
        status: crate::plan::PlanningStatus,
    ) {
        if !session.plan.notice_planning(status) {
            return;
        }
        NotificationSink {
            out: self.out.clone(),
        }
        .emit(crate::AgentEventEnvelope::new(session_id, turn_id, update));
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
        // The staged mode run this turn works on, when main claimed one
        // (ADR mode-definitions). Parsed first: a claim this kernel cannot read
        // refuses the prompt before a session is reserved or a provider is
        // built, so a malformed run never becomes a turn of the bare mode.
        let mode_turn = parse_mode_turn(request.params.get("modeTurn"))?;
        // Trusted extensions are described before anything is built: one round trip
        // per prompt that names the events with handlers (so no other hook costs one)
        // and the agent tools the modules registered. The same handle reaches the
        // provider, the tool registry and the turn, because all three speak for this
        // one session.
        let extensions =
            crate::extensions::ExtensionHost::new(self.bridge.clone(), session_id.clone());
        // Main decided which plugins are enabled for this session's project and
        // sent their ids; an empty list is the answer, and the kernel then asks the
        // host nothing at all. That is the Node sidecar's own rule — it builds a
        // Runner only for a non-empty trusted set — and it keeps an
        // extension-free turn from paying a round trip it has no use for.
        let extension_session = match request
            .params
            .get("trustedExtensions")
            .and_then(Value::as_array)
            .map(|specs| specs.len())
        {
            Some(count) if count > 0 => extensions.describe().await,
            _ => crate::extensions::ExtensionSession::default(),
        };
        let extensions = extensions.scoped(extension_session.events.clone());
        if !extension_session.is_empty() {
            tracing::debug!(
                target: "agent_core::sidecar",
                events = extension_session.events.len(),
                tools = extension_session.tools.len(),
                "trusted extensions registered for this session"
            );
        }
        // A prompt carries its own provider: main stamps the session's model and
        // credentials on every turn. The configured provider is only a fallback
        // for harnesses and the self-check.
        let provider = match request
            .params
            .get("provider")
            .filter(|value| !value.is_null())
        {
            Some(spec) => {
                // `before_provider_headers` is a per-turn hook in the reference
                // (`extensionBeforeAgentStart`): handlers edit the row's own headers
                // in place, and the merged set is what every request of this turn
                // sends. Asked before the provider is built, because a provider owns
                // its header map.
                let spec = extension_provider_spec(&extensions, spec).await;
                build_provider_hooked(&spec, extension_wire_hooks(&extensions))?
            }
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
        // The shell this turn's `Bash` calls are labelled with: the prompt's own
        // `commandShell` when it names one, otherwise whatever `sidecar.configure`
        // declared. A label, not a permission: exec and approval policy are
        // untouched by it, and a missing identity stays missing rather than being
        // invented.
        let shell = crate::builtin_tools::ShellIdentity::from_params(&request.params)
            .or_else(|| self.shell_identity());
        // `tools.execute` carries the mode it runs under; host-core requires it
        // and evaluates the call's permission ceiling from it.
        let tool_mode = crate::prompt::SessionMode::parse(request.str_param("mode"));
        if let Ok(mut applied) = self.mode.write() {
            *applied = tool_mode.clone();
        }
        if let Some(declarations) = request.params.get("tools").and_then(Value::as_array) {
            self.install_tools(declarations, shell.as_ref(), tool_mode.wire_name())?;
        }
        // The runtime declares its own built-in tools; main sends none, and a
        // model with no tools cannot do anything. Host-declared names win, so a
        // host that describes `Bash` itself keeps its own description.
        self.install_builtin_tools(shell.as_ref(), tool_mode)?;
        // A composer can name MCP servers or exact tools. The answer is the set
        // those names authorize — resolved by exact identity, never by the shape
        // of a tool name — and a selection that cannot be honoured refuses the
        // prompt instead of quietly running without the tool.
        let mut selected_tools: Vec<String> = Vec::new();
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
                Ok(names) => {
                    // The composer asked for these by name, so they stay callable
                    // without a `ToolSearch`: a deferral must never hide a tool the
                    // user selected, and the model has no way to know it was meant
                    // to look for it.
                    selected_tools = names.clone();
                    tracing::debug!(
                        target: "agent_core::sidecar",
                        count = names.len(),
                        "mcp tools selected for this prompt"
                    );
                }
                Err(error) => return Err(RpcError::app(error.code(), error.message())),
            }
        }

        let session = self.session(&session_id)?;
        if !selected_tools.is_empty() {
            if let Ok(mut active) = session.active_tools.lock() {
                active.extend(selected_tools.iter().cloned());
            }
        }
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
        // Kept past the settle so a poller can read "this turn, no longer running".
        *session
            .last_turn
            .lock()
            .map_err(|_| RpcError::internal("turn lock poisoned"))? = Some(turn_id.clone());
        // The run turn this prompt claimed, recorded before the turn task starts:
        // a notice that arrives while the turn runs must find it already there.
        // A prompt with no claim clears it, which is what `beginTurn` does to the
        // Node runtime's mode state on every non-run turn.
        {
            let mut run = session
                .mode_run
                .lock()
                .map_err(|_| RpcError::internal("mode run lock poisoned"))?;
            run.turn = mode_turn.map(|claim| ModeRunTurn {
                turn_id: turn_id.clone(),
                run_id: claim.run_id,
                stage_id: claim.stage_id,
            });
            run.closing_out = false;
        }

        // A reopened session starts with the history host-core kept for it.
        self.restore_history(&session, session_id.as_str()).await?;
        // A turn is a boundary a person may want to come back to, so the snapshot is
        // taken before this turn's own user row: a rewind restores the conversation
        // *before* the turn, which is the state a person means by "undo that".
        let snapshot = session.transcript.lock().await.clone();
        if let Ok(mut checkpoints) = session.checkpoints.lock() {
            checkpoints.capture("turn start", &snapshot);
        }

        {
            let mut transcript = session.transcript.lock().await;
            // The transcript keeps the user's own text; the recall query below
            // reads the same string, so the row and the query cannot drift.
            let mut message = Message::user_text(text.clone());
            // Attachments travel with the turn: Electron main resolved the picker
            // and sent base64 payloads, a conversation excerpt, or a bare
            // reference. An image is the only kind the provider can actually see;
            // the rest become text references so the model is never silently told
            // less than the user attached.
            message
                .parts
                .extend(attachment_parts(&request.params).await);
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
        // The reasoning budget this turn asks for: the prompt's own level, else the
        // configured default. A prompt that names a level this kernel cannot read
        // keeps the default rather than turning reasoning off behind the user's back.
        let thinking = request
            .str_param("thinkingLevel")
            .and_then(ThinkingLevel::parse)
            .unwrap_or(config.thinking);
        // The catalog main launched this session with. Only ids, names and
        // descriptions arrive; the documents stay on the host.
        let catalog = crate::skills::parse_catalog(request.params.get("pluginSkills"));
        session.skills.replace(catalog.clone());
        let mode = crate::prompt::SessionMode::parse(request.str_param("mode"));
        // The system prompt is composed further down: the on-demand tool
        // catalogue is a section of it, and that catalogue is only known once
        // this session's own tools have been registered.
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
        // The session checklist is not rendered here. It belongs to host-core —
        // `TodoWrite` writes `session_todo`, announces `todos.changed`, and the
        // panel draws that — so the kernel has no copy to paste into the request.
        // The model's own `TodoWrite` call and its result are already in the
        // transcript it re-reads, which is how the Node runtime keeps it too.
        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        // This session's own tools: delegation, the skill library, the checklist,
        // the plan hand-off, asking, and memory. Registered before the prompt is
        // composed, because the declaration policy below has to see the whole
        // catalog to say which of it is core.
        let extras = self.session_tools(SessionToolInputs {
            request,
            mode: &mode,
            catalog: &catalog,
            session: &session,
            provider: provider.clone(),
            config: &config,
            tools: &tools,
        });
        let tools = if extras.is_empty() {
            tools
        } else {
            Arc::new(tools.extended(extras))
        };
        // Agent tools the trusted extensions registered. They are ordinary
        // declarations — deferred like a plugin tool, activated with `ToolSearch`
        // (the stub in the E2E suite relies on exactly that) — but a call to one
        // travels to `extensions.tools.execute`, because the module that implements
        // it runs in main and host-core has never heard of the name.
        let tools = if extension_session.tools.is_empty() {
            tools
        } else {
            Arc::new(
                tools.extended(
                    extension_session
                        .tools
                        .iter()
                        .map(|tool| {
                            Arc::new(crate::extensions::ExtensionTool::new(
                                tool.spec.clone(),
                                extensions.clone(),
                            )) as Arc<dyn crate::tool::Tool>
                        })
                        .collect(),
                ),
            )
        };
        // An orchestrating turn may not run the worker's tools — the gate refuses
        // them — so it is not shown them either. Declaring a tool the turn cannot
        // call costs its schema on every step and, measured on a real pairing, one
        // wasted step: the model tried `Bash`, read the refusal, and only then
        // dispatched. Half the paid tokens of that turn went to a call the split had
        // already forbidden.
        let specs = if delegate_mechanical_from(request) {
            orchestrator_specs(tools.specs())
        } else {
            tools.specs()
        };
        // Core declarations on every request, the rest on demand. The object is
        // also what refuses a call to a tool the model never activated, so the
        // turn below gets it too.
        let activation = Arc::new(crate::tool_activation::ToolActivation::new(
            &mode,
            specs,
            session.active_tools.clone(),
        ));
        // `ToolSearch` is the only way a deferred tool becomes declared, and the
        // kernel answers it itself: it changes this session's set, not a file.
        let tools =
            if activation.deferred_specs().is_empty() {
                tools
            } else {
                Arc::new(tools.extended(vec![Arc::new(
                    crate::tool_activation::ToolSearchTool::new(activation.clone()),
                )]))
            };
        let activation_section = activation.activation_section();
        // Compose the system prompt for this turn: persona, custom append, tool
        // guidance, the project instruction chain, the skill catalog, the mode's
        // rules and the on-demand tool catalogue.
        let mut composed = self.compose_prompt(
            request,
            &config,
            mode.clone(),
            &catalog,
            activation_section.as_deref(),
        );
        // `before_agent_start`: extensions chain a replacement of the composed
        // prompt, each handler seeing what the previous one returned
        // (`emitBeforeAgentStart`). Applied to the composed value itself, so the
        // journal row below records the prompt the model was actually sent.
        if let Some(replaced) = extensions.before_agent_start(&text, &composed.system).await {
            composed.system = replaced;
        }
        if !composed.system.trim().is_empty() {
            config.system = Some(composed.system.clone());
        }
        // The prompt the model receives is journaled before dispatch: nothing in
        // the transcript shows it, so without this row a restored session cannot
        // reproduce what it ran with, and a support bundle cannot show it.
        self.journal_system_prompt(request, &session, &composed, session_id.as_str(), &turn_id)
            .await?;
        // What this turn composed, kept for the extension surface
        // (`agent.surface`): under this kernel main is the JavaScript host for
        // trusted extensions and cannot compose the prompt or the declaration
        // set itself. Recorded before dispatch, so a prompt that fails to run is
        // still the prompt the session last composed.
        session.surface.record_turn(
            &composed.system,
            activation.clone(),
            model_limits_from(request).map(ContextLimits::for_model),
        );
        // Keep the pieces the background review needs: the engine takes
        // ownership of the provider and the tool set below.
        let review_provider = provider.clone();
        let review_tools = tools.clone();
        // Resolved before the engine takes the registry: the policy is a function of
        // the names the host actually declared.
        let repeat_policy = repeat_policy_for(&tools);
        let engine = TurnEngine::new(
            provider,
            tools,
            Arc::new(NotificationSink {
                out: self.out.clone(),
            }),
        )
        .with_steering(session.clone())
        .with_tool_activation(activation)
        .with_extensions(extensions.clone());
        // Main stamps the session's model window on the prompt; without it the
        // loop has no budget to enforce and would never compact.
        let engine = match model_limits_from(request) {
            Some(limits) => engine.with_model_limits(limits),
            None => engine,
        };
        // Smart mode: the strong half this turn may hand over to. A launch that
        // named none keeps the turn on one provider, exactly as before.
        let engine = match escalation_target_from(request, compaction_enabled_from(request)) {
            Some(target) => engine.with_escalation(target),
            None => engine,
        }
        .with_memory_prefix(memory_prefix)
        .with_delegations(session.delegations.clone())
        // Definition of done: a turn that edits files and never runs a check is sent
        // back once. `verifyBeforeDone: false` is the escape hatch, and a session
        // whose "done" is a person's call is exactly who needs it.
        .with_completion(
            if request
                .params
                .get("verifyBeforeDone")
                .and_then(Value::as_bool)
                == Some(false)
            {
                crate::verify::CompletionPolicy::off()
            } else {
                crate::verify::CompletionPolicy::default()
            },
        )
        // An identical read inside one turn is answered from that turn's cache. The
        // names are the host's, not this crate's: a runtime that ships `read_file`
        // and `grep` must not silently get no suppression at all.
        .with_repeat_suppression(repeat_policy)
        // Concurrent tool calls are opt-in: a host that approves calls one by one
        // wants them one at a time, and a log in call order is easier to follow.
        .with_parallel_tool_calls(
            request
                .params
                .get("parallelToolCalls")
                .and_then(Value::as_bool)
                == Some(true),
        );
        let engine = {
            // One ceiling, not two: merging them here is what keeps a prompt that
            // names both from silently losing the token limit to the step limit.
            let mut run_budget = crate::budget::RunBudget::default();
            if let Some(max_tokens) = request.params.get("tokenBudget").and_then(Value::as_u64) {
                run_budget.max_tokens = Some(max_tokens);
            }
            if let Some(max_steps) = request.params.get("stepBudget").and_then(Value::as_u64) {
                run_budget.max_steps = Some(max_steps.min(usize::MAX as u64) as usize);
            }
            if run_budget.is_unbounded() {
                engine
            } else {
                engine.with_budget(run_budget)
            }
        };

        // The mode this turn runs in *is* the planning state the renderer draws:
        // only Plan mode negotiates a contract (`proposalKindForMode` upstream),
        // and every other mode — including the Agent turn an approved plan runs as
        // — is `inactive`. Announced on change, never per turn.
        let planning = if matches!(mode, crate::prompt::SessionMode::Plan) {
            (crate::plan::PlanningStatus::Planning, Some("plan"))
        } else {
            (crate::plan::PlanningStatus::Inactive, None)
        };
        self.announce_planning(
            &session,
            &session_id,
            &turn_id,
            crate::AgentEvent::planning(planning.0, planning.1),
            planning.0,
        );

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
        // Smart mode's split, decided here for the same reason: the spawned task
        // cannot borrow `request`.
        let delegate_mechanical = delegate_mechanical_from(request);
        let task_asks = self.asks.clone();
        // A background skill review runs after this turn, in the same task: the
        // client has already been told the turn ended, so nothing is held back.
        let review_policy =
            crate::skill_review::SkillReviewPolicy::from_params(request.params.get("skillReview"));
        // A review pinned to its own model is the point of the setting: it is a
        // second completion after every qualifying turn, and the cheapest model that
        // can judge a session is rarely the one the session itself needs.
        let review_model = review_policy
            .model
            .clone()
            .unwrap_or_else(|| config.model.clone());
        // A provider overlay the kernel cannot build falls back to the session's own
        // rather than skipping the pass: a bad overlay must not silently turn the
        // review off.
        let review_provider = match review_policy.provider.as_ref() {
            Some(spec) => match build_provider(spec) {
                Ok(provider) => provider,
                Err(error) => {
                    tracing::warn!(
                        %error,
                        "skill review provider could not be built; using the session's own"
                    );
                    review_provider.clone()
                }
            },
            None => review_provider.clone(),
        };
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
                        // The background review is a second, tool-using
                        // conversation that re-reads its own prefix step by step.
                        cache: crate::provider::CacheRetention::resolve(
                            None,
                            std::env::var("PI_CACHE_RETENTION").ok().as_deref(),
                        ),
                        // The user's reasoning choice, for the turn itself. The
                        // background review keeps `Off`: it reads a transcript and
                        // writes one skill, and paying for a bigger budget there is
                        // not what the switch was for.
                        thinking,
                        infinite_provider_retry,
                        delegate_mechanical,
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
                        // A turn the user stopped ends like any other; this flag
                        // is what tells the log which boundary ended it.
                        graceful_stop = outcome.graceful_stop,
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
            // Compaction is a summary of the transcript, not agent work.
            delegate_mechanical: false,
            // Prefix caching is the largest token lever on a long session; a
            // caller can turn it off per request, and `PI_CACHE_RETENTION` sets the
            // machine default.
            cache: crate::provider::CacheRetention::resolve(
                request.str_param("cacheRetention"),
                std::env::var("PI_CACHE_RETENTION").ok().as_deref(),
            ),
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

    /// `agent.modeTurnNotice`: main reports that the run this turn works on
    /// changed (ADR mode-definitions) — `closeout` after the user paused it,
    /// `release` after the user removed it or the run settled elsewhere.
    ///
    /// Upstream counterpart: `DesktopAgentRuntime.modeTurnNotice` in
    /// `packages/agent-runtime/src/runtime.ts` (with `RuntimeModeState` in
    /// `src/modes/mode-state.ts`), reached from
    /// `apps/desktop/electron/main/runtime/mode-services.ts`. Two things are
    /// carried over exactly, because main acts on them: a notice for another
    /// turn or another run is not applied, and the answer is the same
    /// `{ applied: boolean }` — never an error for a notice that simply arrived
    /// too late.
    ///
    /// What is deliberately narrower: the Node runtime answers a closeout by
    /// recomposing the system prompt mid-turn (`setAgentSystemPrompt`), which
    /// this kernel cannot do — a turn's system prompt is fixed when its task is
    /// spawned. So the notice updates the session's run state and nothing else;
    /// the stage brief and the `CompleteStage` gate are not ported either, since
    /// they need the run's `modeDefinition`, which never crosses this wire.
    fn mode_turn_notice(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let notice = parse_mode_turn_notice(&request.params)?;
        // A session this process has never run has no turn to apply a notice to.
        // The Node sidecar answers `{ applied: false }` for the same reason.
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({ "applied": false }));
        };
        // The turn the notice names must be the turn this session is running:
        // Node compares against `this.turnId`, and the kernel's equivalent is
        // the turn it reserved (cleared when the turn task settles).
        let current = session
            .current_turn
            .lock()
            .map_err(|_| RpcError::internal("turn lock poisoned"))?
            .clone();
        let (turn_id, run_id, action) = notice.into_parts();
        if current.as_deref() != Some(turn_id.as_str()) {
            return Ok(json!({ "applied": false }));
        }
        let mut run = session
            .mode_run
            .lock()
            .map_err(|_| RpcError::internal("mode run lock poisoned"))?;
        // The run the notice names must be the run this turn claimed.
        match run.turn.as_ref() {
            Some(turn) if turn.run_id == run_id => {}
            _ => return Ok(json!({ "applied": false })),
        }
        let applied = match action {
            // `beginCloseout` refuses a second closeout of the same turn, so a
            // repeated pause notice is answered `false` rather than restating it.
            ModeTurnAction::Closeout => {
                if run.closing_out {
                    false
                } else {
                    run.closing_out = true;
                    true
                }
            }
            // The turn finishes as an ordinary turn of the mode the session
            // returned to: the run context, and with it every stage-scoped
            // behaviour, leaves now.
            ModeTurnAction::Release => {
                run.turn = None;
                run.closing_out = false;
                true
            }
        };
        Ok(json!({ "applied": applied }))
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

    /// `agent.stop`: end the turn at the next completed assistant boundary.
    ///
    /// The Node sidecar's `requestGracefulStop` is the reference: the answer is
    /// `{ requested: boolean }`, never an error — a stop that arrives for a turn
    /// that already ended (the common race: the user's Stop and the turn's own
    /// finish) is `requested: false`, exactly as an unknown session is. Identity
    /// is checked the same way `agent.abort` checks it, on the session and the
    /// turn id, because both are addressed at a turn and both must not act on the
    /// wrong one.
    ///
    /// What it deliberately does *not* do, unlike `agent.abort`: it never calls
    /// `cancel`, so the tool the model already asked for keeps its token and runs
    /// to completion, and it leaves the ask cards alone — a pending question is
    /// not an abandoned turn. The loop reads the flag between steps and ends the
    /// turn there, once.
    fn stop(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({ "requested": false }));
        };
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
                return Ok(json!({ "requested": false }));
            }
        }
        // Nothing is streaming, so there is no boundary to stop at. The Node
        // runtime answers the same way for an idle runtime.
        if !session.running.load(Ordering::SeqCst) {
            return Ok(json!({ "requested": false }));
        }
        session
            .cancel
            .lock()
            .map_err(|_| RpcError::internal("cancel lock poisoned"))?
            .request_stop();
        Ok(json!({ "requested": true }))
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
        // One line, deliberately: "the model forgot" is either a restore that returned
        // nothing, a restore that returned a fraction of the rows, or a later ageing
        // pass — and without these two numbers none of the three can be told apart.
        tracing::info!(
            target: "agent_core::restore",
            session = %session_id,
            rows = rows.len(),
            messages = messages.len(),
            "restored conversation history"
        );
        if messages.is_empty() {
            if !rows.is_empty() {
                tracing::warn!(
                    target: "agent_core::restore",
                    session = %session_id,
                    rows = rows.len(),
                    "stored rows produced no conversation: the resumed turn starts empty"
                );
            }
            return Ok(());
        }
        let mut transcript = session.transcript.lock().await;
        transcript.extend(messages);
        Ok(())
    }

    /// `agent.stopSubagents`: cancel this session's running delegates.
    ///
    /// The renderer's subagent stop button is the caller: one id from a transcript
    /// row, or no ids from the activity group's header to stop all of them. The
    /// reply is the list of what the stop actually reached, so a button that was
    /// pressed against a delegation that had already finished reports nothing
    /// instead of pretending to have stopped it.
    fn stop_subagents(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let ids = match request.params.get("delegationIds") {
            None => None,
            Some(Value::Array(values)) => {
                if values.is_empty() || values.len() > 100 {
                    return Err(RpcError::invalid_params("Invalid delegation IDs"));
                }
                let mut ids = Vec::with_capacity(values.len());
                for value in values {
                    match value.as_str().map(str::trim).filter(|id| !id.is_empty()) {
                        Some(id) => ids.push(id.to_string()),
                        None => return Err(RpcError::invalid_params("Invalid delegation IDs")),
                    }
                }
                Some(ids)
            }
            Some(_) => return Err(RpcError::invalid_params("Invalid delegation IDs")),
        };
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| RpcError::internal("session lock poisoned"))?;
        let Some(session) = sessions.get(session_id) else {
            return Ok(json!({ "pending": Vec::<String>::new() }));
        };
        let pending: Vec<String> = session
            .delegations
            .stop(ids.as_deref())
            .into_iter()
            .filter_map(|outcome| match outcome {
                crate::delegate::StopOutcome::Requested { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        Ok(json!({ "pending": pending }))
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
        // The turn the session is on, or the one it last finished. A poller asks
        // "did *this* turn finish", and that answer needs both halves: the id and
        // `isRunning: false`. Reporting the id only while running left every such
        // poller waiting for a turn that had already completed.
        let reported_turn =
            current_turn.or_else(|| session.last_turn.lock().ok().and_then(|turn| turn.clone()));
        if let Some(turn_id) = reported_turn {
            status["currentTurnId"] = json!(turn_id);
        }
        // The staged mode run this session's last prompt claimed, when there is
        // one. Additive diagnostics: `adaptStatus` in
        // `apps/desktop/electron/main/kernel/kernel-adapter.ts` reads the fields
        // it knows and ignores the rest, and a support bundle that shows which
        // run turn the kernel is serving — and whether main has paused it — is
        // what makes a mode-run report answerable at all.
        if let Ok(run) = session.mode_run.lock() {
            if let Some(turn) = run.turn.as_ref() {
                status["modeRun"] = json!({
                    "turnId": turn.turn_id,
                    "runId": turn.run_id,
                    "stageId": turn.stage_id,
                    "closingOut": run.closing_out,
                });
            }
        }
        Ok(json!({ "status": status }))
    }

    /// `agent.surface`: what a kernel-run extension command reads about one
    /// session — the answer to `ctx.getContextUsage()`, `ctx.getSystemPrompt()`
    /// and `ctx.getActiveTools()` / `ctx.getAllTools()`.
    ///
    /// Upstream counterpart: those four members of `createExtensionBridge`
    /// (`packages/agent-runtime/src/runtime.ts:3555-3610`), answered there from
    /// the Node runtime's live agent state. Here that state is the kernel's: the
    /// prompt is composed by `compose_prompt`, the budget is the model window
    /// the launch declared, and the declaration set is
    /// [`crate::tool_activation::ToolActivation`]. They are reported together
    /// because they describe one session's one turn — three reads would be three
    /// round trips and could disagree if a turn finished between them.
    ///
    /// An unknown session answers `null` rather than zeros: this process has not
    /// composed that session's prompt, and history is restored from host-core at
    /// its first prompt, so a count of nothing would be a guess about a
    /// transcript the kernel has never read.
    fn surface(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let Some(session) = self.known_session(session_id)? else {
            return Ok(json!({
                "usage": null,
                "systemPrompt": null,
                "tools": crate::session_surface::tools_report(None),
                "reason": "unknown session",
            }));
        };
        // The budget: the caller's when it supplies one (a session whose model
        // changed needs the new numbers), else the one the last turn planned
        // against. Neither is a default — a default window would report a
        // percentage for a model the session is not running.
        let budget = model_limits_from(request)
            .map(ContextLimits::for_model)
            .or_else(|| session.surface.limits());
        // A turn in flight holds the transcript. Waiting would block a command
        // behind a whole turn, so the answer says the count is not available
        // instead of presenting a stale one as current.
        let usage = budget.and_then(|budget| match session.transcript.try_lock() {
            Ok(transcript) => Some(crate::session_surface::context_usage(
                transcript.messages(),
                &budget,
            )),
            Err(_) => None,
        });
        let activation = session.surface.activation();
        Ok(json!({
            "usage": usage,
            "systemPrompt": session.surface.system_prompt(),
            "tools": crate::session_surface::tools_report(activation.as_deref()),
        }))
    }

    /// `agent.setActiveTools`: the on-demand set the session's next request
    /// declares.
    ///
    /// Upstream counterpart: `setActiveTools` in `createExtensionBridge`
    /// (`runtime.ts:3598`): every on-demand name the wanted set does not list is
    /// switched off, and every one it does list is switched on. Core tools are
    /// not in that set, so naming one — or leaving it out — changes nothing,
    /// exactly as there. The answer is the state the write left behind, so a
    /// caller never has to read back to know what it did.
    fn set_active_tools(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let names = request
            .params
            .get("names")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::invalid_params("`names` must be an array of tool names"))?;
        let mut wanted = std::collections::BTreeSet::new();
        for name in names {
            let name = name.as_str().ok_or_else(|| {
                RpcError::invalid_params("`names` must be an array of tool names")
            })?;
            wanted.insert(name.to_string());
        }
        let session = self.session(session_id)?;
        let activation = session.surface.activation();
        {
            let mut active = session
                .active_tools
                .lock()
                .map_err(|_| RpcError::internal("tool activation lock poisoned"))?;
            match activation.as_deref() {
                Some(activation) => {
                    for name in activation.deferred_names() {
                        if wanted.contains(&name) {
                            active.insert(name);
                        } else {
                            active.remove(&name);
                        }
                    }
                }
                // No turn yet, so no catalog to filter against: the wanted names
                // are the set. The next prompt intersects it with the catalog it
                // builds, which is the rule activation follows everywhere else —
                // a name that mode withholds cannot be resurrected by this write.
                None => {
                    active.clear();
                    active.extend(wanted);
                }
            }
        }
        Ok(json!({
            "tools": crate::session_surface::tools_report(activation.as_deref())
        }))
    }

    /// The plan lane's state: what is awaiting approval, and where the host's
    /// checklist stood at its last accepted write.
    ///
    /// The checklist itself is host-core's (`todos.get`, `todos.changed`); this
    /// reports the receipt of the last `TodoWrite`, never a second copy of the
    /// list, so the two can never disagree.
    fn plan_status(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let session = self.session(session_id)?;
        Ok(json!({
            "plan": {
                "summary": session.plan.checklist_summary(),
                "todos": session.plan.todos(),
                // What the session is negotiating, and the contract it last
                // submitted, so a client can tell "an approval is open" from
                // "the model is still planning" without reading the transcript.
                "planning": session.plan.planning().as_str(),
                "submitted": session.plan.submitted(),
            }
        }))
    }

    /// The rewind points this session has, newest last.
    fn checkpoints(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let session = self.session(session_id)?;
        let list = session
            .checkpoints
            .lock()
            .map_err(|_| RpcError::internal("checkpoint lock poisoned"))?
            .list();
        Ok(json!({ "checkpoints": list }))
    }

    /// Install a checkpoint's transcript.
    ///
    /// Refused while a turn is running: a rewind mid-turn would pull the ground out
    /// from under the loop, which still holds the transcript it is appending to.
    async fn rewind(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let checkpoint_id = request.require_str("checkpointId")?;
        let session = self.session(session_id)?;
        if session.running.load(Ordering::SeqCst) {
            return Err(RpcError::app(
                "TURN_IN_FLIGHT",
                "a running turn cannot be rewound: stop it first",
            ));
        }
        let restored = session
            .checkpoints
            .lock()
            .map_err(|_| RpcError::internal("checkpoint lock poisoned"))?
            .rewind(checkpoint_id);
        let Some(restored) = restored else {
            return Err(RpcError::app(
                "CHECKPOINT_NOT_FOUND",
                "no such checkpoint in this session: it may have been evicted",
            ));
        };
        let messages = restored.len();
        *session.transcript.lock().await = restored;
        tracing::debug!(
            target: "agent_core::sidecar",
            %session_id,
            %checkpoint_id,
            messages,
            "session rewound to a checkpoint"
        );
        Ok(json!({
            "rewound": true,
            "checkpointId": checkpoint_id,
            "messages": messages,
        }))
    }

    /// The supervisor of one router session, created on first use.
    fn super_agent(
        &self,
        session_id: &str,
    ) -> Result<Arc<crate::super_agent::SuperAgent>, RpcError> {
        let mut agents = self
            .super_agents
            .lock()
            .map_err(|_| RpcError::internal("super agent lock poisoned"))?;
        Ok(agents
            .entry(session_id.to_string())
            .or_insert_with(|| {
                Arc::new(crate::super_agent::SuperAgent::with_router_session(
                    session_id,
                ))
            })
            .clone())
    }

    /// Build the supervisor for a session from the prompt's policy.
    ///
    /// Configuration replaces the supervisor, so it has to arrive before the first
    /// event: a policy applied after work started would be a policy the running
    /// workers never agreed to.
    fn superagent_configure(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let mut config = crate::super_agent::SuperAgentConfig::new(session_id);
        if let Some(policy) = request.params.get("policy") {
            let mut route = crate::super_agent::RoutePolicy::permissive();
            if let Some(autonomy) = policy.get("autonomy").and_then(Value::as_str) {
                route.autonomy = match autonomy {
                    "rule_allowlist" | "allowlist" | "allowList" => {
                        crate::super_agent::Autonomy::RuleAllowlist
                    }
                    "record_only" | "recordOnly" => crate::super_agent::Autonomy::RecordOnly,
                    _ => crate::super_agent::Autonomy::AddressedOnly,
                };
            }
            if let Some(sources) = policy.get("sources").and_then(Value::as_array) {
                route.allowed_sources = sources
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(crate::super_agent::SourceKind::parse)
                    .collect();
            }
            if let Some(channels) = policy.get("channels").and_then(Value::as_array) {
                route.allowed_channels = channels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
            }
            if let Some(actors) = policy.get("actors").and_then(Value::as_array) {
                route.allowed_actors = actors
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
            }
            if let Some(rules) = policy.get("rules").and_then(Value::as_array) {
                route.rules = rules
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
            }
            config.policy = route;
        }
        if let Some(max_workers) = request.params.get("maxWorkers").and_then(Value::as_u64) {
            config.max_workers = max_workers.clamp(1, 64) as usize;
        }
        let agent = Arc::new(crate::super_agent::SuperAgent::new(config));
        self.super_agents
            .lock()
            .map_err(|_| RpcError::internal("super agent lock poisoned"))?
            .insert(session_id.to_string(), agent.clone());
        Ok(json!({ "superagent": agent.status() }))
    }

    fn superagent_trigger(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        let value = request
            .params
            .get("trigger")
            .ok_or_else(|| RpcError::invalid_params("`trigger` is required"))?;
        let trigger =
            crate::super_agent::Trigger::from_value(value).map_err(RpcError::invalid_params)?;
        let outcome = agent.submit(trigger);
        Ok(json!({ "outcome": outcome }))
    }

    /// One router decision over whatever is queued.
    ///
    /// The decision is a real provider request (no tools, JSON answer). Applying it
    /// starts workers and hands events to the workers that already own a thread; the
    /// turns themselves are the host's to run, on the session ids this returns.
    async fn superagent_pump(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        let Some(batch) = agent.take_batch() else {
            return Ok(json!({
                "batch": 0,
                "dispatched": [],
                "delivered": 0,
                "ignored": 0,
                "requeued": 0,
                "undecided": 0,
            }));
        };
        let provider = self.superagent_provider(request)?;
        let model = self
            .config
            .lock()
            .map(|config| config.model.clone())
            .unwrap_or_default();
        let router = crate::super_agent::TurnRouter::new(provider.clone(), model);
        let outcome = match router.decide(&batch, &CancelToken::new()).await {
            Ok(outcome) => outcome,
            Err(error) => return Err(RpcError::app(error.code(), error.to_string())),
        };
        // Whatever the answer did not decide goes back to the queue: an answer that
        // cannot be applied is refused rather than guessed at.
        let applied = agent.apply_decisions(&batch.triggers, &outcome.decisions);

        // The kernel runs the worker turns itself, so a host only has to deliver
        // events and read reports. A host that wants to drive them (its own approval
        // path, its own UI) says `driveWorkers: false` and calls `superagent.report`.
        let drive = request
            .params
            .get("driveWorkers")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut drivers = Vec::new();
        if drive {
            drivers = self.start_worker_drivers(&agent, provider, request)?;
        }
        let driving = drivers.len();
        // A harness may wait for the reports in the same call; a person-facing client
        // never does, because waiting is what the whole design removes.
        if request
            .params
            .get("awaitWorkers")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            for driver in drivers {
                let _ = driver.await;
            }
        }

        Ok(json!({
            "batch": batch.triggers.len(),
            "dispatched": applied.dispatched,
            "delivered": applied.delivered,
            "ignored": applied.ignored,
            "requeued": applied.requeued,
            "undecided": applied.undecided,
            "reports": agent.pending_reports(),
            "driving": driving,
            // The session ids of the workers this dispatch started: the host runs
            // their turns, so it needs them in the same answer.
            "workers": agent.status().workers,
            // What the decision itself cost, so a supervisor run is priceable.
            "usage": {
                "inputTokens": outcome.usage.input_tokens,
                "outputTokens": outcome.usage.output_tokens,
            },
        }))
    }

    /// Start one driver task per live worker: claim its turns, run them, report back,
    /// and keep going while the worker still has events queued.
    fn start_worker_drivers(
        &self,
        agent: &Arc<crate::super_agent::SuperAgent>,
        provider: Arc<dyn Provider>,
        request: &Request,
    ) -> Result<Vec<tokio::task::JoinHandle<()>>, RpcError> {
        // The same provider instance the decision used: a rebuilt one would lose its
        // state (a scripted harness would replay its first answer) and pay the client
        // setup again.
        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        let model = self
            .config
            .lock()
            .map(|config| config.model.clone())
            .unwrap_or_default();
        let sink: Arc<dyn crate::event::EventSink> = Arc::new(NotificationSink {
            out: self.out.clone(),
        });
        let limits = model_limits_from(request);
        let mut worker = crate::super_agent::TurnWorker::new(
            provider,
            tools.clone(),
            sink,
            crate::turn::TurnConfig::new(model),
        )
        .with_repeat_policy(repeat_policy_for(&tools));
        if let Some(limits) = limits {
            worker = worker.with_model_limits(limits);
        }
        let worker = Arc::new(worker);

        let mut drivers = Vec::new();
        for view in agent.status().workers {
            if !matches!(
                view.status,
                crate::super_agent::WorkerStatus::Running
                    | crate::super_agent::WorkerStatus::Waiting
            ) {
                continue;
            }
            let agent = agent.clone();
            let worker = worker.clone();
            let worker_id = view.id.clone();
            drivers.push(tokio::spawn(async move {
                while let Some(task) = agent.claim_worker_turn(Some(&worker_id)) {
                    let outcome = worker.run(task.request).await;
                    let status = outcome.status;
                    tracing::debug!(
                        target: "agent_core::sidecar",
                        %worker_id,
                        events = task.events,
                        ?status,
                        turns = outcome.turns,
                        tool_calls = outcome.tool_calls,
                        "worker turn finished"
                    );
                    agent.finish_worker_turn(&worker_id, status, outcome.report);
                    // A stopped or failed worker is done: the supervisor freed its
                    // thread, and a fresh dispatch is the router's decision.
                    if status != crate::super_agent::WorkerStatus::Settled {
                        break;
                    }
                }
            }));
        }
        Ok(drivers)
    }

    /// A worker's turn finished. The report goes to the router's inbox; the host
    /// never sends it to the person directly, which is what keeps one voice.
    fn superagent_report(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let worker_id = request.require_str("workerId")?;
        let agent = self.super_agent(session_id)?;
        let status = match request.str_param("status").unwrap_or("settled") {
            "failed" | "error" => crate::super_agent::WorkerStatus::Failed,
            "stopped" | "cancelled" => crate::super_agent::WorkerStatus::Stopped,
            _ => crate::super_agent::WorkerStatus::Settled,
        };
        let text = request.str_param("text").unwrap_or("(no report text)");
        let report = agent.complete_worker(worker_id, status, text);
        Ok(json!({
            "accepted": report.is_some(),
            "report": report,
            "reportsPending": agent.pending_reports(),
        }))
    }

    fn superagent_status(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        Ok(json!({ "superagent": agent.status() }))
    }

    fn superagent_threads(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        Ok(json!({ "threads": agent.threads() }))
    }

    fn superagent_recall(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let id = request.require_str("id")?;
        let agent = self.super_agent(session_id)?;
        match agent.recall(id) {
            Ok(text) => Ok(json!({ "recalled": text })),
            Err(miss) => Err(RpcError::app("RECALL_MISS", miss.to_string())),
        }
    }

    fn superagent_worker_stop(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let worker_id = request.require_str("workerId")?;
        let agent = self.super_agent(session_id)?;
        Ok(json!({ "stopped": agent.stop_worker(worker_id) }))
    }

    /// Run the program side of the watchdog and apply what it found.
    fn superagent_watchdog(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        let interventions = agent.watchdog_scan();
        let applied: Vec<Value> = interventions
            .iter()
            .map(|intervention| {
                let outcome = agent.apply_intervention(intervention);
                json!({
                    "workerId": intervention.worker_id,
                    "kind": intervention.kind.as_str(),
                    "reason": intervention.reason,
                    "applied": outcome.as_str(),
                })
            })
            .collect();
        Ok(json!({
            "interventions": applied,
            "status": agent.status(),
        }))
    }

    /// Start a background run and return at once: the caller gets a task id, not an
    /// answer. The result re-enters the event path as a trigger on the thread, so it
    /// is handled exactly like a new environment event.
    fn superagent_async_start(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        let prompt = request.require_str("prompt")?.to_string();
        let thread_key = request
            .str_param("threadKey")
            .unwrap_or(session_id)
            .to_string();
        let label = request.str_param("label").unwrap_or("background run");
        let provider = self.superagent_provider(request)?;
        let model = self
            .config
            .lock()
            .map(|config| config.model.clone())
            .unwrap_or_default();
        let runner = Arc::new(crate::super_agent::PromptRunner::new(provider, model));
        let task = agent.start_async(
            runner,
            crate::super_agent::AsyncRequest {
                id: request.str_param("taskId").unwrap_or_default().to_string(),
                label: label.to_string(),
                thread_key: crate::super_agent::ThreadKey::new(thread_key),
                prompt,
            },
        );
        Ok(json!({ "task": task, "tasks": agent.async_tasks() }))
    }

    fn superagent_async_list(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let agent = self.super_agent(session_id)?;
        Ok(json!({
            "tasks": agent.async_tasks(),
            "running": agent.status().async_running,
        }))
    }

    fn superagent_async_stop(&self, request: &Request) -> Result<Value, RpcError> {
        let session_id = request.require_str("sessionId")?;
        let task_id = request.require_str("taskId")?;
        let agent = self.super_agent(session_id)?;
        Ok(json!({ "stopped": agent.stop_async(task_id) }))
    }

    /// The provider a supervisor request runs on: its own, or the configured one.
    fn superagent_provider(&self, request: &Request) -> Result<Arc<dyn Provider>, RpcError> {
        match request
            .params
            .get("provider")
            .filter(|value| !value.is_null())
        {
            Some(spec) => build_provider(spec),
            None => self
                .provider
                .lock()
                .map_err(|_| RpcError::internal("provider lock poisoned"))?
                .clone()
                .ok_or_else(|| {
                    RpcError::app(
                        "PROVIDER_NOT_CONFIGURED",
                        "no provider on the request and none configured",
                    )
                }),
        }
    }

    /// Read or replace the execution policy.
    ///
    /// `agent.execPolicy` with no `policy` answers with the active one; with one, it
    /// replaces it and answers with what took effect. The registry is rebuilt rather
    /// than mutated so a call already in flight keeps the policy it started under.
    fn exec_policy_rpc(&self, request: &Request) -> Result<Value, RpcError> {
        if request.params.get("execPolicy").is_some() || request.params.get("policy").is_some() {
            self.apply_exec_policy(request)?;
        }
        let policy = self.exec_policy.snapshot();
        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        Ok(json!({
            "execPolicy": policy,
            "tools": tools
                .classes()
                .into_iter()
                .map(|(name, class)| json!({"name": name, "class": class}))
                .collect::<Vec<_>>(),
            "processShape": {
                "spawnsProcesses": false,
                "spawnsInterpreters": false,
            },
        }))
    }

    fn apply_exec_policy(&self, request: &Request) -> Result<(), RpcError> {
        let Some(value) = request
            .params
            .get("execPolicy")
            .or_else(|| request.params.get("policy"))
        else {
            return Ok(());
        };
        let policy: crate::exec_policy::ExecPolicy = serde_json::from_value(value.clone())
            .map_err(|error| RpcError::invalid_params(format!("execPolicy: {error}")))?;
        // The cell is shared with every registry derived from this process's base one,
        // so a replacement takes effect for the next call in every session.
        self.exec_policy.set(policy);
        Ok(())
    }

    /// Turn the kernel's own `Bash` on or off.
    ///
    /// Off (the default) means this process starts no child at all: tool calls go to the
    /// host, where the approvals already live. On, a command runs through
    /// [`crate::exec::LocalExecutor`] — the reference-shaped child described in that
    /// module. The registry from before is kept, so switching it off restores exactly
    /// what the host had declared.
    fn apply_local_shell(&self, request: &Request) -> Result<(), RpcError> {
        let Some(value) = request.params.get("localShell") else {
            return Ok(());
        };
        let enabled = match value {
            Value::Bool(flag) => *flag,
            Value::Object(_) => value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            _ => false,
        };
        if !enabled {
            let mut tools = self
                .tools
                .lock()
                .map_err(|_| RpcError::internal("tool lock poisoned"))?;
            if let Some(base) = self
                .base_tools
                .lock()
                .map_err(|_| RpcError::internal("base tool lock poisoned"))?
                .take()
            {
                *tools = base;
            }
            drop(tools);
            *self
                .local_shell
                .lock()
                .map_err(|_| RpcError::internal("local shell lock poisoned"))? = None;
            // Nothing is spawned here any more, so there is no shell of our own to
            // label a `Bash` call with.
            *self
                .configured_shell
                .lock()
                .map_err(|_| RpcError::internal("shell identity lock poisoned"))? = None;
            return Ok(());
        }

        let mut executor = crate::exec::LocalExecutor::new(self.exec_policy.snapshot());
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            executor = executor.with_default_cwd(std::path::PathBuf::from(cwd));
        }
        let program = executor.shell().program.clone();
        let dialect = match executor.shell().dialect {
            crate::exec::Dialect::Posix => "posix",
            crate::exec::Dialect::Cmd => "cmd",
        }
        .to_string();
        let shell: Arc<dyn crate::tool::Tool> = Arc::new(crate::exec::ShellTool::new(executor));

        let mut tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?;
        let mut base_tools = self
            .base_tools
            .lock()
            .map_err(|_| RpcError::internal("base tool lock poisoned"))?;
        let base = base_tools.get_or_insert_with(|| tools.clone());
        *tools = Arc::new(base.extended(vec![shell]));
        drop(tools);
        drop(base_tools);
        *self
            .local_shell
            .lock()
            .map_err(|_| RpcError::internal("local shell lock poisoned"))? = Some(program.clone());
        // A prompt that names no shell inherits this one: it is the shell this
        // process would run a command in, so it is the honest label.
        *self
            .configured_shell
            .lock()
            .map_err(|_| RpcError::internal("shell identity lock poisoned"))? = Some(
            crate::builtin_tools::ShellIdentity::for_local_shell(&program, &dialect),
        );
        Ok(())
    }

    /// Remember which shell `Bash` calls are labelled with, for prompts that name
    /// none.
    ///
    /// Two spellings are accepted, because two callers exist: the catalog row main
    /// resolved (`{id, dialect, …}`) and a bare id from a launcher or a harness.
    /// This decides a label only — the host still applies its exec and approval
    /// policy to every call, so naming a shell here grants nothing.
    fn apply_command_shell(&self, request: &Request) -> Result<(), RpcError> {
        let Some(shell) = request
            .params
            .get("commandShell")
            .and_then(crate::builtin_tools::ShellIdentity::from_value)
        else {
            return Ok(());
        };
        *self
            .configured_shell
            .lock()
            .map_err(|_| RpcError::internal("shell identity lock poisoned"))? = Some(shell);
        Ok(())
    }

    /// Read or replace the approval policy.
    ///
    /// Three spellings, because three callers exist: a whole policy (`approvalPolicy`),
    /// one level for a session (`floor`), and a single rule to stop asking
    /// (`allow` + `tool`/`commandPrefix`/`pathPrefix`). The answer always includes what
    /// took effect and what each declared tool would be called.
    fn approval_policy_rpc(&self, request: &Request) -> Result<Value, RpcError> {
        self.apply_approval_policy(request)?;
        let policy = self.approval.snapshot();
        let tools = self
            .tools
            .lock()
            .map_err(|_| RpcError::internal("tool lock poisoned"))?
            .clone();
        let classes: Vec<Value> = tools
            .classes()
            .into_iter()
            .map(|(name, class)| {
                json!({
                    "name": name,
                    "class": class,
                    "level": crate::approval::DangerLevel::from_class(class),
                })
            })
            .collect();
        Ok(json!({
            "approvalPolicy": policy,
            "floor": policy.floor,
            "tools": classes,
        }))
    }

    fn apply_approval_policy(&self, request: &Request) -> Result<(), RpcError> {
        if let Some(value) = request
            .params
            .get("approvalPolicy")
            .or_else(|| request.params.get("policy"))
        {
            let policy: crate::approval::ApprovalPolicy = serde_json::from_value(value.clone())
                .map_err(|error| RpcError::invalid_params(format!("approvalPolicy: {error}")))?;
            self.approval.set(policy);
            return Ok(());
        }
        if let Some(floor) = request.str_param("floor").map(str::to_string) {
            let level: crate::approval::DangerLevel = serde_json::from_value(json!(floor))
                .map_err(|_| {
                    RpcError::invalid_params(
                        "`floor` must be read_only, editable, dangerous or hardline",
                    )
                })?;
            self.approval.set_floor(level);
        }
        if let Some(tool) = request.str_param("allowTool").map(str::to_string) {
            let mut rule = crate::approval::AllowRule::for_tool(tool);
            if let Some(prefix) = request.str_param("commandPrefix") {
                rule = rule.with_command_prefix(prefix.to_string());
            }
            if let Some(prefix) = request.str_param("pathPrefix") {
                rule = rule.with_path_prefix(prefix.to_string());
            }
            let mut policy = self.approval.snapshot();
            policy.allow.push(rule);
            self.approval.set(policy);
        }
        if let Some(workspace) = request.str_param("workspace") {
            let mut policy = self.approval.snapshot();
            policy.workspace = Some(std::path::PathBuf::from(workspace));
            self.approval.set(policy);
        }
        Ok(())
    }

    /// Add a job: a name, an opaque prompt and when it runs.
    ///
    /// The prompt is not interpreted here. What the host does with it (a turn, a
    /// notification, a file) is the host's business; the kernel keeps the clock exact.
    fn schedule_add(&self, request: &Request) -> Result<Value, RpcError> {
        let name = request.require_str("name")?.to_string();
        let prompt = request.str_param("prompt").unwrap_or_default().to_string();
        let value = request
            .params
            .get("schedule")
            .ok_or_else(|| RpcError::invalid_params("`schedule` is required"))?;
        let schedule: crate::schedule::Schedule = serde_json::from_value(value.clone())
            .map_err(|error| RpcError::invalid_params(format!("schedule: {error}")))?;
        schedule
            .validate()
            .map_err(|reason| RpcError::invalid_params(format!("schedule: {reason}")))?;
        let now = self.now_param(request);
        let mut book = self
            .schedule
            .lock()
            .map_err(|_| RpcError::internal("schedule lock poisoned"))?;
        let job = book.add(name, prompt, schedule, now);
        Ok(json!({
            "job": job,
            "nextWakeupAtMs": book.next_wakeup(),
            "nowMs": now,
        }))
    }

    fn schedule_list(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let book = self
            .schedule
            .lock()
            .map_err(|_| RpcError::internal("schedule lock poisoned"))?;
        Ok(json!({
            "jobs": book.list(),
            "nextWakeupAtMs": book.next_wakeup(),
            "nowMs": now,
        }))
    }

    fn schedule_remove(&self, request: &Request) -> Result<Value, RpcError> {
        let job_id = request.require_str("jobId")?.to_string();
        let mut book = self
            .schedule
            .lock()
            .map_err(|_| RpcError::internal("schedule lock poisoned"))?;
        let removed = book.remove(&job_id);
        Ok(json!({
            "removed": removed,
            "nextWakeupAtMs": book.next_wakeup(),
        }))
    }

    fn schedule_enable(&self, request: &Request) -> Result<Value, RpcError> {
        let job_id = request.require_str("jobId")?.to_string();
        let enabled = request
            .params
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| RpcError::invalid_params("`enabled` must be a boolean"))?;
        let now = self.now_param(request);
        let mut book = self
            .schedule
            .lock()
            .map_err(|_| RpcError::internal("schedule lock poisoned"))?;
        let job = book
            .set_enabled(&job_id, enabled, now)
            .ok_or_else(|| RpcError::invalid_params(format!("no job `{job_id}`")))?;
        Ok(json!({
            "job": job,
            "nextWakeupAtMs": book.next_wakeup(),
            "nowMs": now,
        }))
    }

    /// Which jobs are due now. Reported once each, with how late they are.
    fn schedule_tick(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let mut book = self
            .schedule
            .lock()
            .map_err(|_| RpcError::internal("schedule lock poisoned"))?;
        let due = book.due(now);
        Ok(json!({
            "due": due,
            "nextWakeupAtMs": book.next_wakeup(),
            "nowMs": now,
        }))
    }

    /// The caller's clock, when a host passes one (a test or a replay), else this
    /// process's.
    fn now_param(&self, request: &Request) -> i64 {
        request
            .params
            .get("nowMs")
            .and_then(Value::as_i64)
            .unwrap_or_else(crate::schedule::now_ms)
    }

    /// Queue one outbound delivery.
    ///
    /// `id` is the idempotency key: a host that retries a turn must pass the same one,
    /// and the second enqueue returns the item that already exists instead of sending
    /// the same report twice. Without an `id` one is generated, which makes the call
    /// at-most-once by accident — fine for a notice, wrong for anything a person acts on.
    fn delivery_enqueue(&self, request: &Request) -> Result<Value, RpcError> {
        let target = request.require_str("target")?.to_string();
        let payload = request.require_str("payload")?.to_string();
        let kind = request.str_param("kind").unwrap_or("notice").to_string();
        let id = request
            .str_param("id")
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = self.now_param(request);
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let outcome = queue.enqueue(id, target, kind, payload, now);
        let stats = queue.stats(now);
        Ok(json!({ "outcome": outcome, "stats": stats }))
    }

    /// The items a sender should attempt now, marked in flight with a deadline.
    fn delivery_claim(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let limit = request
            .params
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(10)
            .clamp(1, 100) as usize;
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let claimed = queue.claim(now, limit);
        Ok(json!({ "claimed": claimed, "stats": queue.stats(now), "nowMs": now }))
    }

    fn delivery_complete(&self, request: &Request) -> Result<Value, RpcError> {
        let id = request.require_str("id")?.to_string();
        let now = self.now_param(request);
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let item = queue
            .complete(&id, now)
            .ok_or_else(|| RpcError::invalid_params(format!("no delivery `{id}`")))?;
        Ok(json!({ "delivery": item, "stats": queue.stats(now) }))
    }

    fn delivery_fail(&self, request: &Request) -> Result<Value, RpcError> {
        let id = request.require_str("id")?.to_string();
        let reason = request
            .str_param("reason")
            .unwrap_or("the host reported a failure");
        let now = self.now_param(request);
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let item = queue
            .fail(&id, reason, now)
            .ok_or_else(|| RpcError::invalid_params(format!("no delivery `{id}`")))?;
        Ok(json!({ "delivery": item, "stats": queue.stats(now) }))
    }

    fn delivery_requeue(&self, request: &Request) -> Result<Value, RpcError> {
        let id = request.require_str("id")?.to_string();
        let now = self.now_param(request);
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let item = queue
            .requeue(&id, now)
            .ok_or_else(|| RpcError::invalid_params(format!("no delivery `{id}`")))?;
        Ok(json!({ "delivery": item, "stats": queue.stats(now) }))
    }

    fn delivery_list(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        Ok(json!({ "deliveries": queue.list(), "stats": queue.stats(now) }))
    }

    fn delivery_stats(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        Ok(json!({ "stats": queue.stats(now), "policy": queue.policy() }))
    }

    fn delivery_purge(&self, request: &Request) -> Result<Value, RpcError> {
        let now = self.now_param(request);
        let older_than = request
            .params
            .get("olderThanMs")
            .and_then(Value::as_i64)
            .unwrap_or(24 * 60 * 60 * 1000);
        let mut queue = self
            .deliveries
            .lock()
            .map_err(|_| RpcError::internal("delivery lock poisoned"))?;
        let purged = queue.purge_delivered(now, older_than);
        Ok(json!({ "purged": purged, "stats": queue.stats(now) }))
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
/// OpenAI's own `/responses` envelope. Same credential as Chat Completions, a
/// different body and event vocabulary (`provider::responses`).
const API_STYLE_RESPONSES: &str = "responses";
/// Gemini's native API — `models/{model}:streamGenerateContent?alt=sse`, with
/// `contents`/`systemInstruction`/`generationConfig` instead of `messages`
/// (`provider::google`).
const API_STYLE_GOOGLE_GENERATIVE_AI: &str = "google_generative_ai";
/// Known wires this kernel does not implement yet. They fail loudly: silently
/// falling back to Chat Completions would send a valid credential to an endpoint
/// of a different shape and surface as an unexplained provider 400.
const API_STYLES_NOT_MIGRATED: &[&str] = &["openai_codex_responses", "pi_messages"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderWire {
    OpenAiCompletions,
    AnthropicMessages,
    OpenAiResponses,
    GoogleGenerativeAi,
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
            "provider apiStyle `{style}` is not migrated to this kernel yet; supported: {}, {}, {}, {}",
            API_STYLE_OPENAI_COMPLETIONS,
            API_STYLE_ANTHROPIC_MESSAGES,
            API_STYLE_RESPONSES,
            API_STYLE_GOOGLE_GENERATIVE_AI
        )));
    }
    Ok(match style {
        API_STYLE_ANTHROPIC_MESSAGES => ProviderWire::AnthropicMessages,
        API_STYLE_RESPONSES => ProviderWire::OpenAiResponses,
        API_STYLE_GOOGLE_GENERATIVE_AI => ProviderWire::GoogleGenerativeAi,
        _ => ProviderWire::OpenAiCompletions,
    })
}

/// Add `spec` unless a declaration of that name is already in the set.
///
/// Two sources declare the same name when the host describes a tool this kernel
/// also ships; the host's wins (`prompt` installs it first), so the second copy
/// is dropped rather than billed twice.
fn push_unique_spec(specs: &mut Vec<ToolSpec>, spec: ToolSpec) {
    if !specs.iter().any(|existing| existing.name == spec.name) {
        specs.push(spec);
    }
}

fn build_provider(spec: &Value) -> Result<Arc<dyn Provider>, RpcError> {
    build_provider_hooked(spec, None)
}

/// The same provider, with trusted extensions listening on its wire.
///
/// `before_provider_request` and `after_provider_response` are the two hooks that
/// belong to the transport rather than the loop: they see the payload that is
/// actually sent and the status that actually came back. `None` — a session with
/// no extension at all — leaves the request byte-identical to the one before
/// this surface existed.
fn build_provider_hooked(
    spec: &Value,
    hooks: Option<Arc<dyn crate::provider::WireHooks>>,
) -> Result<Arc<dyn Provider>, RpcError> {
    if spec.get("kind").and_then(Value::as_str) == Some("scripted") {
        return scripted_provider(spec);
    }
    match provider_wire(spec)? {
        ProviderWire::OpenAiCompletions => {
            http_provider(spec, ProviderWire::OpenAiCompletions, hooks)
        }
        ProviderWire::AnthropicMessages => {
            http_provider(spec, ProviderWire::AnthropicMessages, hooks)
        }
        ProviderWire::OpenAiResponses => http_provider(spec, ProviderWire::OpenAiResponses, hooks),
        ProviderWire::GoogleGenerativeAi => {
            http_provider(spec, ProviderWire::GoogleGenerativeAi, hooks)
        }
    }
}

/// The transport hooks for a session with extensions, or `None`.
///
/// A session whose extensions registered neither wire hook still needs the
/// object: `ExtensionHost::emit` skips an event with no handler, so the cost is
/// one local `has` check rather than a round trip.
fn extension_wire_hooks(
    extensions: &crate::extensions::ExtensionHost,
) -> Option<Arc<dyn crate::provider::WireHooks>> {
    if extensions.events().is_empty() {
        return None;
    }
    Some(Arc::new(crate::extensions::ProviderHook::new(
        extensions.clone(),
    )))
}

/// The provider spec this turn sends, after `before_provider_headers`.
///
/// Node seeds the handlers with the provider row's own headers and merges what
/// they edited into every request of the run, so the hook is asked once per
/// prompt with the row's `headers` object. A session with no handler gets the
/// spec back unchanged — the same object, not a rewritten copy.
async fn extension_provider_spec(
    extensions: &crate::extensions::ExtensionHost,
    spec: &Value,
) -> Value {
    if !extensions.events().has("before_provider_headers") {
        return spec.clone();
    }
    let Some(object) = spec.as_object() else {
        return spec.clone();
    };
    let headers: Vec<(String, String)> = object
        .get("headers")
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|value| (name.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let merged = extensions.before_provider_headers(headers).await;
    let mut next = object.clone();
    let mut map = serde_json::Map::new();
    for (name, value) in merged {
        map.insert(name, Value::String(value));
    }
    next.insert("headers".to_string(), Value::Object(map));
    Value::Object(next)
}

/// The two prompt inputs the host resolves for us: the custom `SYSTEM.md` /
/// `APPEND_SYSTEM.md` pair and the workspace instruction chain.
///
/// Both are parsed rather than trusted. A payload the kernel cannot read is dropped
/// instead of failing the turn, because missing instructions must degrade to "no
/// extra rules", never to "no reply". Without this the model answers with the
/// product prompt alone and never sees the project's `AGENTS.md` chain.
pub fn host_prompt_inputs(
    params: &Value,
) -> (
    Option<crate::prompt::CustomSystemPrompt>,
    Option<crate::prompt::ProjectInstructions>,
) {
    let custom = params
        .get("customSystemPrompt")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let project = params
        .get("projectInstructions")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    (custom, project)
}

/// Per-image and per-turn ceilings for inlining an attached image, matching the
/// renderer's limits so a picture the composer accepted is not silently withheld
/// from the model.
const MAX_INLINE_IMAGE_BYTES: u64 = 10_000_000;
const MAX_INLINED_IMAGE_BYTES: u64 = 30_000_000;

/// A turn's attachments as content parts.
///
/// The payload names a path rather than carrying bytes: the renderer records the
/// selection and reading it is this process's job. An image becomes
/// `ContentPart::Image` when the launch says the model can see and the file fits the
/// ceilings; everything else — a file, an oversized image, a model without vision, a
/// path that vanished — becomes a text reference, so the model is told what the user
/// attached and where it is, and nothing is dropped in silence.
pub async fn attachment_parts(params: &Value) -> Vec<crate::message::ContentPart> {
    use crate::message::ContentPart;
    let mut parts = Vec::new();
    let Some(items) = params.get("attachments").and_then(Value::as_array) else {
        return parts;
    };
    let vision = params
        .get("supportsVision")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut budget = MAX_INLINED_IMAGE_BYTES;
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("attachment");
        let path = item.get("path").and_then(Value::as_str).unwrap_or("");
        match kind {
            "image" => {
                let inlined = if vision {
                    read_image_as_base64(path, budget).await
                } else {
                    None
                };
                match inlined {
                    Some((data, size)) => {
                        budget = budget.saturating_sub(size);
                        parts.push(ContentPart::Image {
                            mime_type: image_mime_type(
                                item.get("mimeType").and_then(Value::as_str),
                                path,
                            ),
                            data,
                        });
                    }
                    None => parts.push(ContentPart::Text {
                        text: format!("\n\n[image attached: {name} ({path})]"),
                    }),
                }
            }
            "session" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        parts.push(ContentPart::Text {
                            text: format!("\n\n[{name}]\n{text}"),
                        });
                    }
                }
            }
            _ => {
                let reference = item
                    .get("ref")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("inlinePath").and_then(Value::as_str))
                    .filter(|value| !value.is_empty())
                    .unwrap_or(path);
                if !reference.is_empty() {
                    parts.push(ContentPart::Text {
                        text: format!("\n\n[{name}: {reference}]"),
                    });
                }
            }
        }
    }
    parts
}

/// The mime type to declare for an attached image: the picker's answer when it gave
/// one, otherwise the file extension, so a base64 block is never labelled `octet`.
fn image_mime_type(declared: Option<&str>, path: &str) -> String {
    if let Some(mime) = declared.filter(|mime| !mime.is_empty()) {
        return mime.to_string();
    }
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
    .to_string()
}

/// Read one attached image as base64 for the wire.
///
/// `None` means "keep it as a reference": the file is gone, empty, larger than the
/// remaining budget, or larger than one image may be. A turn must not fail because a
/// picture is big.
async fn read_image_as_base64(path: &str, budget: u64) -> Option<(String, u64)> {
    if path.is_empty() {
        return None;
    }
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    let size = metadata.len();
    if size == 0 || size > budget.min(MAX_INLINE_IMAGE_BYTES) {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some((encoded, size))
}

/// The repeat policy for the tool names a host actually declares.
/// This crate's names (`Read`, `Glob`, `Grep`) are the desktop's, but a host may
/// ship `read_file`/`grep`/`glob`/`list_files` instead. Passing the default policy
/// there would silently mean *no suppression at all*, which looks like a model that
/// keeps re-reading files and costs exactly what the feature exists to save.
pub fn repeat_policy_for(tools: &ToolRegistry) -> crate::tool_use::RepeatPolicy {
    const CANDIDATES: [&str; 7] = [
        "Read",
        "Glob",
        "Grep",
        "read_file",
        "grep",
        "glob",
        "list_files",
    ];
    let present: Vec<String> = CANDIDATES
        .iter()
        .filter(|name| tools.contains(name))
        .map(|name| (*name).to_string())
        .collect();
    if present.is_empty() {
        crate::tool_use::RepeatPolicy::default()
    } else {
        crate::tool_use::RepeatPolicy::for_tools(present)
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
                    // `{"truncated": true}` is a body that ends without a finish
                    // frame. A harness needs that shape to exercise the paths that
                    // recover from an upstream cut, which the review retries.
                    if !step
                        .get("truncated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        events.push(StreamEvent::Finish(crate::message::StopReason::EndTurn));
                    }
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
fn http_provider(
    spec: &Value,
    wire: ProviderWire,
    hooks: Option<Arc<dyn crate::provider::WireHooks>>,
) -> Result<Arc<dyn Provider>, RpcError> {
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
            ProviderWire::OpenAiResponses => "openai-responses",
            ProviderWire::GoogleGenerativeAi => "google",
        });
    let mut config = match wire {
        ProviderWire::OpenAiCompletions => HttpProviderConfig::openai(label, base_url, &api_key),
        ProviderWire::AnthropicMessages => HttpProviderConfig::anthropic(label, base_url, &api_key),
        ProviderWire::OpenAiResponses => {
            HttpProviderConfig::openai_responses(label, base_url, &api_key)
        }
        ProviderWire::GoogleGenerativeAi => HttpProviderConfig::google(label, base_url, &api_key),
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
    let provider = match hooks {
        Some(hooks) => provider.with_hooks(hooks),
        None => provider,
    };
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

/// The window and output budget a provider's `modelConfig` declares.
///
/// A models.dev config carries them under `limit`; a flat config carries
/// `contextWindow` / `maxTokens`. Reading only the flat key meant a real prompt
/// looked like a model with no declared window, so the turn never learned its
/// budget and never compacted.
fn model_limits_from_model_config(model_config: Option<&Value>) -> ModelLimits {
    let from_model = |key: &str| {
        model_config
            .and_then(|config| config.get(key))
            .and_then(Value::as_u64)
    };
    let limit = model_config.and_then(|config| config.get("limit"));
    let from_limit = |key: &str| {
        limit
            .and_then(|limit| limit.get(key))
            .and_then(Value::as_u64)
    };
    ModelLimits {
        context_window: from_model("contextWindow").or_else(|| from_limit("context")),
        max_tokens: from_model("maxTokens").or_else(|| from_limit("output")),
        ..ModelLimits::default()
    }
}

/// The user's compaction switch from the launch payload.
///
/// Only `enabled` is read, and that is deliberate: the Node runtime ignores the
/// token thresholds this shape also carries and derives them from the model
/// window instead (`compactionEnabled` in `packages/agent-runtime/src/runtime.ts`
/// reads `enabled` alone, and `prepareCompaction` is handed
/// `budget.requestHeadroom` / `budget.keepRecentTokens`, never the configured
/// numbers). Reading them here would give the kernel a second, incompatible
/// compaction vocabulary.
///
/// Automatic compaction is on unless the setting says otherwise.
fn compaction_enabled_from(request: &Request) -> bool {
    request
        .params
        .get("compactionSettings")
        .and_then(|settings| settings.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
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
    let mut limits = model_limits_from_model_config(model_config);
    if limits.context_window.is_none() {
        limits.context_window = request.params.get("contextWindow").and_then(Value::as_u64);
    }
    if limits.max_tokens.is_none() {
        limits.max_tokens = request.params.get("maxTokens").and_then(Value::as_u64);
    }
    // A missing window is a deliberate "no automatic protection" (the Node
    // reference behaves the same), so it is not guessed here — but it is the first
    // thing a cost investigation needs, and silence cost a full session once.
    if limits.context_window.is_none() && limits.max_tokens.is_none() {
        tracing::warn!(
            target: "agent_core::sidecar",
            "prompt carries no model window: no ageing, no compaction, no budget"
        );
        return None;
    }
    Some(limits.with_compaction_enabled(compaction_enabled_from(request)))
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

    fn snapshot(&self) -> (usize, Vec<String>, Vec<Value>) {
        match self.collector.lock() {
            Ok(collector) => (
                collector.tool_call_count(),
                collector.action_lines(),
                collector.action_details(),
            ),
            Err(_) => (0, Vec::new(), Vec::new()),
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
        if !notice.is_visible(&policy) {
            return;
        }
        NotificationSink { out: out.clone() }.emit(crate::AgentEventEnvelope::new(
            &session_id,
            turn_id.clone(),
            crate::AgentEvent::SkillReview {
                outcome: notice.outcome.as_str().to_string(),
                reason: notice.reason.clone(),
                actions: notice.actions.clone(),
                action_details: notice.details.clone(),
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
            Ok(mut gate) => gate.qualify(&policy, tool_calls, std::time::Instant::now()),
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
        max_steps: Some(crate::skill_review::REVIEW_MAX_ITERATIONS as usize),
        temperature: None,
        max_output_tokens: None,
        cache: crate::provider::CacheRetention::None,
        thinking: crate::provider::ThinkingLevel::Off,
        infinite_provider_retry: false,
        // A review pass reads a transcript and writes one skill: it is the
        // worker of its own turn, not an orchestrator.
        delegate_mechanical: false,
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

    // One background request can be cut by the upstream while nothing is wrong with
    // the pass itself. A retry costs one request and is worth far more than losing
    // the only review of this session; it is one retry rather than a backoff loop
    // because the review is a convenience, not a turn someone is waiting on.
    if outcome
        .as_ref()
        .err()
        .is_some_and(crate::skill_review::is_upstream_failure)
    {
        outcome = engine
            .run_turn(
                &review_session_id,
                &format!("{review_turn_id}#retry"),
                &mut transcript,
                &config,
                cancel.clone(),
            )
            .await;
    }

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
    let (tool_calls, actions, details) = sink.snapshot();
    let failure = outcome.as_ref().err();
    // The pass spent its budget whenever the fork actually ran, including a run that
    // stopped at the step ceiling or that the upstream cut. Recording only clean runs
    // would let a session whose upstream is flaky buy a fresh fork on every turn.
    let spent = match failure {
        None => true,
        Some(error) => {
            error.code() == "STEP_LIMIT" || crate::skill_review::is_upstream_failure(error)
        }
    };
    if spent {
        if let Ok(mut gate) = session.review_gate.lock() {
            gate.record_review(std::time::Instant::now());
        }
    }
    let notice = crate::skill_review::ReviewNotice::from_run(failure, tool_calls, actions, details);
    emit_notice(&notice);
}

/// Runs one delegate turn: its own transcript, its own prompt, only its own tools.
struct SidecarDelegateRunner {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    sink: Arc<dyn crate::EventSink>,
    model: String,
    model_limits: Option<crate::context::ModelLimits>,
    /// Delegation model overrides this turn may use, keyed by `Task.model`.
    models: Arc<std::collections::BTreeMap<String, SubagentModelBinding>>,
    guidance: Vec<String>,
    /// The session's mode, shared with the sidecar so a mid-session switch follows.
    mode: Arc<std::sync::RwLock<crate::prompt::SessionMode>>,
    infinite_provider_retry: bool,
    cache: crate::provider::CacheRetention,
}

impl SidecarDelegateRunner {
    /// The provider, model and budget a delegate runs with.
    ///
    /// A key the parent named selects that binding's own provider, model id and
    /// window — the delegate then costs what the user chose for it. No key runs
    /// the session's model, which is the reference behaviour when the definition
    /// pins nothing. The key was already checked against the catalog by `Task`,
    /// so a miss here can only mean the two disagree, and the session model is
    /// the safe side of that.
    fn run_binding(
        &self,
        model_key: Option<&str>,
    ) -> (
        Arc<dyn Provider>,
        String,
        Option<crate::context::ModelLimits>,
    ) {
        match model_key.and_then(|key| self.models.get(key)) {
            Some(binding) => (
                binding.provider.clone(),
                binding.model.clone(),
                Some(binding.limits),
            ),
            None => (self.provider.clone(), self.model.clone(), self.model_limits),
        }
    }
}

impl crate::delegate::DelegateRunner for SidecarDelegateRunner {
    fn run<'a>(
        &'a self,
        request: crate::delegate::DelegateRunRequest,
    ) -> BoxFuture<'a, crate::delegate::DelegateOutcome> {
        Box::pin(async move {
            use crate::delegate::{DelegateOutcome, DelegationError, DelegationStatus};
            let mode = self.mode.read().map(|mode| mode.clone()).ok();
            let prompt = crate::delegate::compose_subagent_system_prompt(
                &request.definition,
                &self.guidance,
                &request.definition.tools,
                mode,
            );
            // Depth is one: a worker gets the tools its definition lists, minus the
            // delegation verbs, so it cannot start workers of its own. The reference
            // product spells this out as "maximum recursion depth: 1"; here it is the
            // only depth the kernel offers, because a worker that delegates turns one
            // paid hand-over into an unbounded chain.
            let allowed: Vec<String> = request
                .definition
                .tools
                .iter()
                .filter(|name| !crate::delegate::is_delegation_verb(name))
                .cloned()
                .collect();
            let scoped = Arc::new(self.tools.restricted(&allowed));
            let sink: Arc<dyn crate::EventSink> = Arc::new(DelegateSink {
                inner: self.sink.clone(),
                parent_tool_call_id: request.parent_tool_call_id.clone(),
                agent_name: request.definition.name.clone(),
            });
            let (provider, model, model_limits) = self.run_binding(request.model_key.as_deref());
            let mut engine = TurnEngine::new(provider, scoped, sink);
            if let Some(limits) = model_limits {
                engine = engine.with_model_limits(limits);
            }
            let mut transcript = Transcript::new();
            transcript.push(Message::user_text(request.task.clone()));
            let config = TurnConfig {
                model,
                system: Some(prompt),
                // No step ceiling. A delegate used to be cut off at 24 steps,
                // which failed the delegation with its work half done and handed
                // the parent a failure instead of a report; the parent already
                // bounds it through `TaskWait`/`TaskStop` and can ask again.
                max_steps: None,
                temperature: None,
                max_output_tokens: None,
                thinking: ThinkingLevel::Off,
                // A delegate inherits the session's policy: the same gateway can
                // fail it, and the same retry that saves the parent saves it.
                infinite_provider_retry: self.infinite_provider_retry,
                cache: self.cache,
                // A delegate is the worker: it runs the tools the orchestrator
                // refused to run itself.
                delegate_mechanical: false,
            };
            let outcome = engine
                .run_turn(
                    &request.session_id,
                    // The parent turn, not the delegation id: a delegation is not a turn
                    // row, and host-core legitimately refuses a turn reference it cannot
                    // resolve, which used to strip every worker row of its turn.
                    &request.parent_turn_id,
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

/// The run context one prompt claimed: which run, and which stage of it.
///
/// The kernel keeps only these two facts because they are the ones a notice is
/// matched on; the rest of `ModeTurnContext` (`origin`, `enteredStage`, `input`,
/// `artifactPaths`) is validated for shape and then dropped — composing a stage
/// brief from it is the Node runtime's job, done from the definition snapshot
/// this side never receives.
struct ModeTurnClaim {
    run_id: String,
    stage_id: String,
}

/// A parameter set this kernel refuses is refused by name, as
/// `packages/agent-runtime/src/modes/mode-params.ts` refuses it: JSON-RPC
/// `-32602` plus an `errorCode` main classifies on.
fn reject_mode_params(error_code: &str, message: impl Into<String>) -> RpcError {
    let mut error = RpcError::invalid_params(message);
    error.data = Some(json!({ "errorCode": error_code }));
    error
}

/// `MODE_ID_RE` from `@pi-workspace/shared`: `^[a-z][a-z0-9-]{0,39}$`.
fn is_mode_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    value.len() <= 40 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `modeTurn` of one `agent.prompt`: the trusted run context Electron main
/// claimed for this turn (ADR mode-definitions).
///
/// Ported from `parseModeTurn` in
/// `packages/agent-runtime/src/modes/mode-params.ts`: the same six keys, the
/// same exact-key rule, the same `MODE_ID_RE` and the same 16-artifact bound, so
/// a claim main could not have produced refuses the prompt instead of starting a
/// turn whose stage nobody can name.
///
/// One deliberate difference: the Node parser also checks the stage exists in
/// the mode's `modeDefinition`. This kernel does not read `modeDefinition` — its
/// prompt and tool set are chosen from the mode id — so there is no stage list to
/// check against. Main has already matched the claim to the run's snapshot in
/// `apps/desktop/electron/main/runtime/mode-runs.ts`, which is the boundary the
/// claim is trusted from.
fn parse_mode_turn(value: Option<&Value>) -> Result<Option<ModeTurnClaim>, RpcError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let invalid = |message: String| {
        reject_mode_params("MODE_TURN_INVALID", format!("invalid modeTurn: {message}"))
    };
    let Some(object) = value.as_object() else {
        return Err(invalid("expected an object".into()));
    };
    const KEYS: [&str; 6] = [
        "runId",
        "stageId",
        "origin",
        "enteredStage",
        "input",
        "artifactPaths",
    ];
    if object.len() != KEYS.len() || !KEYS.iter().all(|key| object.contains_key(*key)) {
        return Err(invalid(format!("expected exactly {}", KEYS.join(", "))));
    }
    let run_id = object
        .get("runId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 200)
        .ok_or_else(|| invalid("runId".into()))?;
    let stage_id = object
        .get("stageId")
        .and_then(Value::as_str)
        .filter(|id| is_mode_id(id))
        .ok_or_else(|| invalid("stageId".into()))?;
    match object.get("origin").and_then(Value::as_str) {
        Some("user") | Some("approval") | Some("host") => {}
        _ => return Err(invalid("origin".into())),
    }
    if !matches!(object.get("enteredStage"), Some(Value::Bool(_))) {
        return Err(invalid("enteredStage".into()));
    }
    if !matches!(object.get("input"), Some(Value::String(_))) {
        return Err(invalid("input".into()));
    }
    let paths = object
        .get("artifactPaths")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("artifactPaths".into()))?;
    // `MODE_LIMITS.artifacts` is 16: a claim naming more artifact paths than a
    // definition may declare is not one main can have built.
    if paths.len() > 16
        || paths.iter().any(|(id, path)| {
            !is_mode_id(id) || path.as_str().map(|path| path.is_empty()).unwrap_or(true)
        })
    {
        return Err(invalid("artifactPaths".into()));
    }
    Ok(Some(ModeTurnClaim {
        run_id: run_id.to_string(),
        stage_id: stage_id.to_string(),
    }))
}

/// What main reported about the run: it paused it, or it let it go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModeTurnAction {
    Closeout,
    Release,
}

/// One `agent.modeTurnNotice`, parsed.
struct ModeTurnNotice {
    turn_id: String,
    run_id: String,
    action: ModeTurnAction,
}

impl ModeTurnNotice {
    fn into_parts(self) -> (String, String, ModeTurnAction) {
        (self.turn_id, self.run_id, self.action)
    }
}

/// `agent.modeTurnNotice` from Electron main: `parseModeTurnNotice` in
/// `mode-params.ts`, action for action.
fn parse_mode_turn_notice(params: &Value) -> Result<ModeTurnNotice, RpcError> {
    let invalid = |name: &str| {
        reject_mode_params(
            "INVALID_ARGUMENT",
            format!("invalid mode turn notice: {name}"),
        )
    };
    let id = |name: &str| -> Result<String, RpcError> {
        params
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 200)
            .map(str::to_string)
            .ok_or_else(|| invalid(name))
    };
    let turn_id = id("turnId")?;
    let run_id = id("runId")?;
    let action = match params.get("action").and_then(Value::as_str) {
        Some("closeout") => ModeTurnAction::Closeout,
        Some("release") => {
            // A release names the mode the session returned to. The kernel
            // composed its mode into the turn already running, so the id is
            // validated and not applied: main stamps the session's mode on the
            // next prompt itself.
            let mode = params
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("agent");
            // `parseModeParam`: absent means Agent, `chat` is the legacy Plan id.
            if !(mode == "chat" || is_mode_id(mode)) {
                return Err(reject_mode_params("MODE_INVALID", "mode must be a mode id"));
            }
            ModeTurnAction::Release
        }
        _ => return Err(invalid("action")),
    };
    Ok(ModeTurnNotice {
        turn_id,
        run_id,
        action,
    })
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

/// One delegation model override: the binding main resolved for a key, and the
/// model id a delegate started with that key must send.
struct SubagentModelBinding {
    provider: Arc<dyn Provider>,
    model: String,
    limits: ModelLimits,
}

/// The model a stuck cheap turn continues on, when the launch named one.
///
/// Smart mode sends the strong half of the pair as a provider spec plus the two
/// thresholds the kernel watches. Anything unusable — no binding, no model, a
/// provider this kernel cannot build — leaves the turn on its own provider: a
/// failed hand-over must never be the reason a turn fails.
/// Whether this turn is the orchestrating half of a smart pair with a worker.
///
/// Main sends `smartTurn` for every turn it routed and `delegationDefaultModel`
/// only when the worker half actually resolved, so both together mean the split
/// is enforceable: there is a cheap half to hand the mechanical steps to. Either
/// one alone is not enough — a pair without a worker would refuse every tool and
/// deadlock, and a worker without an orchestrating turn is an ordinary session.
/// The tools an orchestrating turn is allowed to see.
///
/// The gate refuses a worker's tools on that turn, so declaring them only costs a
/// schema on every step and invites the model to try one. What stays: planning and
/// delegation (`TodoWrite`, `ToolSearch`, `Skill`, `memory`, `asktool`, `Task…`).
fn orchestrator_specs(specs: Vec<crate::tool::ToolSpec>) -> Vec<crate::tool::ToolSpec> {
    specs
        .into_iter()
        .filter(|spec| {
            crate::turn::keeps_with_orchestrator(&spec.name)
                || crate::delegate::is_delegation_verb(&spec.name)
        })
        .collect()
}

fn delegate_mechanical_from(request: &Request) -> bool {
    let orchestrating = request
        .params
        .get("smartTurn")
        .and_then(|turn| turn.get("tier"))
        .and_then(Value::as_str)
        .is_some_and(|tier| tier == "main");
    orchestrating
        && request
            .params
            .get("delegationDefaultModel")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
}

fn escalation_target_from(
    request: &Request,
    compaction_enabled: bool,
) -> Option<crate::turn::EscalationTarget> {
    let spec = request.params.get("escalation")?;
    let provider_spec = spec.get("provider")?;
    let model = provider_spec
        .get("modelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())?
        .to_string();
    let provider = match build_provider(provider_spec) {
        Ok(provider) => provider,
        Err(error) => {
            tracing::warn!(
                target: "agent_core::sidecar",
                %error,
                "escalation provider dropped; the turn stays on its own model"
            );
            return None;
        }
    };
    let limits = model_limits_from_model_config(provider_spec.get("modelConfig"))
        .with_compaction_enabled(compaction_enabled);
    let policy = spec.get("policy");
    let after_tool_errors = policy
        .and_then(|policy| policy.get("afterToolErrors"))
        .and_then(Value::as_u64)
        .unwrap_or(2) as usize;
    let after_budget_used = policy
        .and_then(|policy| policy.get("afterBudgetUsed"))
        .and_then(Value::as_f64)
        .unwrap_or(0.6) as f32;
    Some(crate::turn::EscalationTarget {
        provider,
        model,
        limits: Some(limits),
        after_tool_errors,
        after_budget_used,
    })
}

/// The delegation model catalog this turn may use.
///
/// Two launch parameters, both required, exactly as in the Node runtime:
/// `subagentModelKeys` names the models the user authorized for delegation and
/// `subagentProviders` carries the credential-bearing binding for each. A key
/// with no binding is not a usable override; a binding nobody opted into is not
/// an authorization (`availableSubagentModelKeys` in
/// `packages/agent-runtime/src/runtime.ts` intersects the two).
///
/// An entry this kernel cannot build a provider for is dropped rather than
/// failing the turn: the key is then simply not offered, and the session keeps
/// working on its own model.
fn parse_subagent_models(
    request: &Request,
) -> std::collections::BTreeMap<String, SubagentModelBinding> {
    let mut models = std::collections::BTreeMap::new();
    let Some(providers) = request
        .params
        .get("subagentProviders")
        .and_then(Value::as_object)
    else {
        return models;
    };
    let Some(keys) = request
        .params
        .get("subagentModelKeys")
        .and_then(Value::as_array)
    else {
        return models;
    };
    let compaction_enabled = compaction_enabled_from(request);
    for key in keys.iter().filter_map(Value::as_str) {
        let Some(spec) = providers.get(key) else {
            continue;
        };
        // The model the delegate's request carries is the binding's own, not the
        // session's: that is the whole point of the override.
        let Some(model) = spec
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
        else {
            continue;
        };
        let provider = match build_provider(spec) {
            Ok(provider) => provider,
            Err(error) => {
                tracing::debug!(
                    target: "agent_core::sidecar",
                    key,
                    %error,
                    "delegation model binding dropped"
                );
                continue;
            }
        };
        let limits = model_limits_from_model_config(spec.get("modelConfig"))
            .with_compaction_enabled(compaction_enabled);
        models.insert(
            key.to_string(),
            SubagentModelBinding {
                provider,
                model: model.to_string(),
                limits,
            },
        );
    }
    models
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

    /// The window a models.dev config declares lives under `limit`, and that is the
    /// only shape a real prompt carries.
    ///
    /// Regression: the kernel read a flat `contextWindow` off `modelConfig`, which
    /// no production payload has, so every real turn believed its model declared no
    /// window — the context budget was never attached and the transcript grew
    /// unbounded (measured: 48k tokens of history, no compaction).
    #[test]
    fn the_context_window_is_read_from_the_models_dev_shape() {
        let request = serde_json::from_value::<Request>(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "agent.prompt",
            "params": {
                "sessionId": "s",
                "turnId": "t",
                "content": "hi",
                "provider": {
                    "apiStyle": "openai-completions",
                    "modelId": "gw-large",
                    "modelConfig": {
                        "source": "models.dev",
                        "limit": {"context": 262_144, "input": 229_376, "output": 32_768},
                        "cost": {"input": 1.0, "output": 2.0},
                        "modalities": {"input": ["text"], "output": ["text"]}
                    }
                }
            }
        }))
        .expect("a production prompt");
        let limits = model_limits_from(&request).expect("the window is known");
        assert_eq!(limits.context_window, Some(262_144));
        assert_eq!(limits.max_tokens, Some(32_768));
    }

    #[test]
    fn an_orchestrating_turn_is_shown_only_the_tools_it_may_use() {
        // Measured on a real pairing: with the worker's tools still declared, the
        // orchestrator tried `Bash`, read the refusal, and only then dispatched —
        // half of that turn's paid tokens went to a call the split forbids.
        let spec = |name: &str| {
            crate::tool::ToolSpec::new(name, "x", serde_json::json!({"type": "object"}))
        };
        let names: Vec<String> = orchestrator_specs(vec![
            spec("Bash"),
            spec("Read"),
            spec("Edit"),
            spec("TodoWrite"),
            spec("ToolSearch"),
            spec("Task"),
            spec("TaskWait"),
        ])
        .into_iter()
        .map(|spec| spec.name)
        .collect();
        assert_eq!(names, vec!["TodoWrite", "ToolSearch", "Task", "TaskWait"]);
    }

    #[test]
    fn a_prompt_that_declares_no_window_still_reports_what_it_does_have() {
        let flat = serde_json::from_value::<Request>(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "agent.prompt",
            "params": {"sessionId": "s", "provider": {"modelConfig": {"contextWindow": 128_000}}}
        }))
        .expect("a prompt");
        let limits = model_limits_from(&flat).expect("a window");
        assert_eq!(limits.context_window, Some(128_000));

        let nothing = serde_json::from_value::<Request>(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "agent.prompt",
            "params": {"sessionId": "s"}
        }))
        .expect("a prompt");
        assert!(
            model_limits_from(&nothing).is_none(),
            "no window means no automatic compaction, not a guessed one"
        );
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
    fn a_responses_style_selects_the_responses_wire() {
        assert_eq!(
            provider_wire(&production_spec(Some("responses"))).unwrap(),
            ProviderWire::OpenAiResponses
        );
        // `apiStyle` is what main sends; `kind` is the kernel's own spelling and
        // must not be required for a real prompt.
        let provider = build_provider(&production_spec(Some("responses")))
            .expect("a Responses provider builds without a kind");
        assert_eq!(provider.name(), "Gateway");
    }

    #[test]
    fn a_google_style_selects_the_gemini_wire() {
        assert_eq!(
            provider_wire(&production_spec(Some("google_generative_ai"))).unwrap(),
            ProviderWire::GoogleGenerativeAi
        );
        // Regression: an unrecognised style falls back to Chat Completions, so
        // before this arm existed a Gemini row was sent to `/chat/completions`
        // with the wrong envelope and answered with an unexplained 400.
        let provider = build_provider(&production_spec(Some("google_generative_ai")))
            .expect("a Gemini provider builds without a kind");
        assert_eq!(provider.name(), "Gateway");
    }

    #[test]
    fn an_unmigrated_wire_fails_loudly_instead_of_using_the_wrong_endpoint() {
        for style in ["openai_codex_responses", "pi_messages"] {
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

#[cfg(test)]
mod prompt_parameter_tests {
    use super::*;
    use crate::context::{BudgetDecision, ContextLimits};
    use crate::delegate::{DelegateRunRequest, DelegateRunner, SubagentDefinition};
    use crate::event::RecordingSink;
    use crate::message::StopReason;
    use crate::provider::scripted::ScriptedProvider;
    use crate::provider::StreamEvent;
    use crate::tool::{AllowAll, ToolRegistry};

    fn prompt_request(params: Value) -> Request {
        serde_json::from_value::<Request>(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "agent.prompt",
            "params": params
        }))
        .expect("a prompt")
    }

    /// The gate needs both halves of main's message: a turn routed to the
    /// orchestrating half *and* a worker that actually resolved. Either one alone
    /// is wrong in opposite ways — no worker would refuse every tool in a
    /// single-model session, no routing decision would never fire at all.
    #[test]
    fn the_delegation_gate_needs_an_orchestrating_turn_and_a_worker() {
        let mut params = json!({"sessionId": "s", "turnId": "t", "content": "hi"});
        assert!(!delegate_mechanical_from(&prompt_request(params.clone())));

        params["smartTurn"] = json!({"tier": "main", "reason": "smart-off"});
        assert!(
            !delegate_mechanical_from(&prompt_request(params.clone())),
            "a pair with no worker half resolved must keep working as one model"
        );

        params["delegationDefaultModel"] = json!("changan/9554");
        assert!(delegate_mechanical_from(&prompt_request(params.clone())));

        params["smartTurn"] = json!({"tier": "sub", "reason": "simple-turn"});
        assert!(
            !delegate_mechanical_from(&prompt_request(params.clone())),
            "the worker half is the one that runs the tools"
        );

        params["smartTurn"] = json!({"tier": "main", "reason": "smart-off"});
        params["delegationDefaultModel"] = json!("   ");
        assert!(
            !delegate_mechanical_from(&prompt_request(params)),
            "a blank worker key is not a worker"
        );
    }

    /// The shape main sends: a models.dev window on the provider, and whatever the
    /// user's compaction settings are.
    fn session_params(compaction: Option<Value>) -> Value {
        let mut params = json!({
            "sessionId": "s",
            "turnId": "t",
            "content": "hi",
            "provider": {
                "apiStyle": "openai-completions",
                "modelId": "gw-large",
                "modelConfig": {"limit": {"context": 128_000, "output": 8_192}}
            }
        });
        if let Some(settings) = compaction {
            params["compactionSettings"] = settings;
        }
        params
    }

    fn limits_of(params: Value) -> ContextLimits {
        let request = prompt_request(params);
        ContextLimits::for_model(model_limits_from(&request).expect("a window"))
    }

    #[test]
    fn compaction_is_on_when_the_launch_says_nothing() {
        let limits = limits_of(session_params(None));
        assert!(
            limits.compaction_enabled,
            "automatic protection is the default"
        );
        assert_eq!(limits.decide(limits.trigger), BudgetDecision::Compact);
    }

    /// The user's switch, end to end from the launch parameter to the decision the
    /// turn loop reads: `enabled: false` means a request above the trigger is sent,
    /// not summarized.
    #[test]
    fn a_disabled_switch_stops_the_trigger_and_keeps_the_hard_limit() {
        let enabled = limits_of(session_params(None));
        let disabled = limits_of(session_params(Some(json!({
            "enabled": false,
            "reserveTokens": 16_384,
            "keepRecentTokens": 20_000
        }))));

        assert_eq!(
            disabled.decide(disabled.trigger),
            BudgetDecision::Proceed,
            "a session that turned compaction off must not compact at the trigger"
        );
        assert_eq!(
            disabled.decide(disabled.hard_limit - 1),
            BudgetDecision::Proceed
        );
        assert_eq!(
            disabled.decide(disabled.hard_limit),
            BudgetDecision::Overflow,
            "the hard boundary is a safety limit, not a preference"
        );
        // Same numbers: the switch changes the decision, not the budget.
        assert_eq!(disabled.trigger, enabled.trigger);
        assert_eq!(disabled.hard_limit, enabled.hard_limit);
        assert_eq!(disabled.keep_recent_tokens, enabled.keep_recent_tokens);
    }

    /// The legacy token thresholds do not become a second compaction vocabulary.
    /// The Node runtime derives both numbers from the model window and ignores the
    /// configured ones (`prepareCompaction` is handed `budget.requestHeadroom` and
    /// `budget.keepRecentTokens`), so a payload that only moves the thresholds
    /// changes nothing here either.
    #[test]
    fn the_legacy_token_thresholds_do_not_move_the_budget() {
        let plain = limits_of(session_params(None));
        let tuned = limits_of(session_params(Some(json!({
            "enabled": true,
            "reserveTokens": 2_000,
            "keepRecentTokens": 1_000
        }))));
        assert_eq!(tuned.trigger, plain.trigger);
        assert_eq!(tuned.hard_limit, plain.hard_limit);
        assert_eq!(tuned.keep_recent_tokens, plain.keep_recent_tokens);
        assert_eq!(
            tuned.retained_user_message_budget,
            plain.retained_user_message_budget
        );
    }

    fn delegation_params() -> Value {
        json!({
            "sessionId": "s",
            "turnId": "t",
            "content": "hi",
            "provider": {
                "apiStyle": "openai-completions",
                "modelId": "gw-large",
                "modelConfig": {"limit": {"context": 128_000, "output": 8_192}}
            },
            "subagents": [{
                "name": "explorer",
                "description": "Read-only search.",
                "tools": ["Read"]
            }],
            "subagentModelKeys": [
                "cheap/model-x",
                "unauthorized/key",
                "responses/key",
                "no-binding/key"
            ],
            "subagentProviders": {
                "cheap/model-x": {
                    "id": "row-cheap",
                    "name": "Cheap",
                    "baseUrl": "https://cheap.example/v1",
                    "apiStyle": "openai-completions",
                    "modelId": "cheap-model",
                    "apiKey": "test-key",
                    "modelConfig": {"limit": {"context": 32_000, "output": 4_096}}
                },
                "unauthorized/key": {
                    "apiStyle": "openai-completions",
                    "modelId": "not-allowed",
                    "apiKey": "test-key"
                },
                "responses/key": {
                    "apiStyle": "responses",
                    "modelId": "responses-model",
                    "apiKey": "test-key"
                }
            }
        })
    }

    #[test]
    fn the_catalog_is_the_keys_that_also_have_a_usable_binding() {
        let request = prompt_request(delegation_params());
        let models = parse_subagent_models(&request);
        assert_eq!(
            models.keys().cloned().collect::<Vec<_>>(),
            vec!["cheap/model-x".to_string()],
            "only an authorized key with a binding this kernel can build is offered"
        );
        let binding = models.get("cheap/model-x").expect("the cheap binding");
        assert_eq!(binding.model, "cheap-model");
        assert_eq!(binding.limits.context_window, Some(32_000));
        assert_eq!(
            binding.limits.max_tokens,
            Some(4_096),
            "the delegate budget comes from its own model"
        );
    }

    #[test]
    fn a_prompt_without_a_catalog_offers_no_override() {
        let mut params = session_params(None);
        params["subagents"] = json!([{"name": "explorer"}]);
        let request = prompt_request(params);
        assert!(parse_subagent_models(&request).is_empty());
    }

    fn delegate_request(model_key: Option<&str>) -> DelegateRunRequest {
        DelegateRunRequest {
            session_id: "s".into(),
            parent_turn_id: "t".into(),
            parent_tool_call_id: "call_1".into(),
            delegation_id: "d1".into(),
            definition: SubagentDefinition {
                name: "explorer".into(),
                description: "Read-only search.".into(),
                prompt: "Search and report.".into(),
                tools: Vec::new(),
                can_mutate: false,
            },
            task: "find the flag".into(),
            model_key: model_key.map(str::to_string),
            cancel: CancelToken::new(),
        }
    }

    fn runner(
        parent: &ScriptedProvider,
        models: std::collections::BTreeMap<String, SubagentModelBinding>,
    ) -> SidecarDelegateRunner {
        SidecarDelegateRunner {
            provider: Arc::new(parent.clone()),
            tools: Arc::new(ToolRegistry::new(Arc::new(AllowAll))),
            sink: Arc::new(RecordingSink::new()),
            model: "gw-large".into(),
            model_limits: Some(ModelLimits::new(128_000, 8_192)),
            models: Arc::new(models),
            guidance: Vec::new(),
            mode: Arc::new(std::sync::RwLock::new(crate::prompt::SessionMode::Agent)),
            infinite_provider_retry: false,
            cache: crate::provider::CacheRetention::resolve(None, None),
        }
    }

    fn answer(text: &str) -> Vec<StreamEvent> {
        vec![
            StreamEvent::TextDelta(text.to_string()),
            StreamEvent::Finish(StopReason::EndTurn),
        ]
    }

    /// The delegation model the user picked is the model the delegate request
    /// carries, on that key own provider: the whole point of `subagentModelKeys`.
    #[tokio::test]
    async fn a_delegate_runs_on_the_model_its_key_names() {
        let parent = ScriptedProvider::new(vec![answer("parent")]);
        let cheap = ScriptedProvider::new(vec![answer("delegated")]);
        let mut models = std::collections::BTreeMap::new();
        models.insert(
            "cheap/model-x".to_string(),
            SubagentModelBinding {
                provider: Arc::new(cheap.clone()),
                model: "cheap-model".into(),
                limits: ModelLimits::new(32_000, 4_096),
            },
        );

        let outcome = runner(&parent, models)
            .run(delegate_request(Some("cheap/model-x")))
            .await;

        assert_eq!(outcome.report, "delegated");
        let sent = cheap.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].model, "cheap-model",
            "the delegate request must name the model its key stands for"
        );
        assert!(
            parent.requests().is_empty(),
            "the session own provider must not carry the delegate"
        );
    }

    /// A worker's rows belong to the turn that asked for it.
    ///
    /// They used to carry the delegation id as their turn, which host-core cannot
    /// resolve, so every one of them was stored with no turn — the session that lost its
    /// context had 143 such rows and a warning for each.
    #[tokio::test]
    async fn a_delegate_reports_under_the_parent_turn() {
        let parent = ScriptedProvider::new(vec![answer("delegated")]);
        let sink = Arc::new(crate::event::RecordingSink::new());
        let runner = SidecarDelegateRunner {
            provider: Arc::new(parent.clone()),
            tools: Arc::new(ToolRegistry::new(Arc::new(AllowAll))),
            sink: sink.clone(),
            model: "gw-large".into(),
            model_limits: Some(ModelLimits::new(128_000, 8_192)),
            models: Arc::new(std::collections::BTreeMap::new()),
            guidance: Vec::new(),
            mode: Arc::new(std::sync::RwLock::new(crate::prompt::SessionMode::Agent)),
            infinite_provider_retry: false,
            cache: crate::provider::CacheRetention::resolve(None, None),
        };
        let request = delegate_request(None);
        let parent_turn = request.parent_turn_id.clone();
        let delegation = request.delegation_id.clone();

        runner.run(request).await;

        let envelopes = sink.snapshot();
        assert!(!envelopes.is_empty(), "the delegate must publish something");
        for envelope in &envelopes {
            assert_eq!(
                envelope.turn_id.as_deref(), Some(parent_turn.as_str()),
                "a worker row must name the parent turn, not the delegation ({delegation})"
            );
            assert_eq!(
                envelope.parent_tool_call_id.as_deref(),
                Some("call_1"),
                "the call that started it is still what the badge groups on"
            );
        }
    }

    /// No key is the reference default: the delegate runs the session model.
    #[tokio::test]
    async fn a_delegate_without_a_key_runs_the_session_model() {
        let parent = ScriptedProvider::new(vec![answer("parent model")]);
        let outcome = runner(&parent, std::collections::BTreeMap::new())
            .run(delegate_request(None))
            .await;

        assert_eq!(outcome.report, "parent model");
        let sent = parent.requests();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].model, "gw-large");
    }
}
