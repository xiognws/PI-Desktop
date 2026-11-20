//! Subagents: bounded delegate turns started by the `Task` tool.
//!
//! Counterpart of `subagent.ts` / `delegation-chain.ts` (ADR 0062, ADR 0089).
//! A delegate is a second turn in the same process with its own system prompt,
//! its own transcript and only the tools its definition declares. It shares the
//! session's provider and host connection, so every call it makes takes the same
//! permission and containment path as the parent's.
//!
//! Three boundaries define the design:
//!
//! * The parent's context only ever gains the delegate's **report**, never its
//!   messages or tool rows.
//! * A delegate's lifecycle never ends the parent's turn: `Task` starts it and
//!   returns, `TaskWait` may converge early, and `TaskStop` (or the user's Stop)
//!   is the only thing that aborts it.
//! * A report is bounded. A delegate exists to save context; a report that fills
//!   the context it was supposed to save defeats the delegation.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};
use crate::message::{ToolCall, Usage};
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Start a delegate.
pub const TASK_TOOL_NAME: &str = "Task";
/// Converge on running delegates and read their reports.
pub const TASK_WAIT_TOOL_NAME: &str = "TaskWait";
/// Report on this session's delegates without waiting.
pub const TASK_LIST_TOOL_NAME: &str = "TaskList";
/// Stop running delegates.
pub const TASK_STOP_TOOL_NAME: &str = "TaskStop";

/// The report is the only thing that enters the parent's context; keep it from
/// becoming the context problem delegation was supposed to avoid.
pub const MAX_SUBAGENT_REPORT_CHARS: usize = 12_000;

const REPORT_TRUNCATION_MARKER: &str = "\n\n[subagent report truncated]\n\n";

/// Steps a delegate may take before it has to hand back a report.
///
/// A delegate is a bounded run, not a second session: without a ceiling one that
/// loops on a broken command would spend the turn's whole budget in the
/// background.
pub const SUBAGENT_MAX_STEPS: usize = 24;

/// Budget of one resumed delegation report block.
///
/// Wider than a single report because several can settle together, and still
/// bounded: the point of delegating was to keep this context small.
pub const MAX_DELEGATION_RESULT_CHARS: usize = 50_000;

/// Sent as the prompt that resumes the parent once delegates settle.
pub const DELEGATION_RESUME_PROMPT: &str = "The following subagents have finished. Integrate their reports and continue the user's original task. Call TaskStop only if you have decided a still-running delegate should not continue.";

/// What `model` on `Task` means, for the tool description and for a refusal.
///
/// Both sentences are the Node runtime's (`DELEGATION_DEFAULT_MODEL_GUIDANCE`,
/// `DELEGATION_MODEL_OPT_IN_GUIDANCE` in `packages/agent-runtime/src/runtime.ts`):
/// the model reads the same instruction whichever runtime is executing.
pub const TASK_MODEL_DEFAULT_GUIDANCE: &str = "Omit the `model` parameter on Task to use the definition's default model, or inherit the parent conversation's selected model when no default is pinned. Repeating the definition's own Default model key is the same as omitting `model`.";
pub const TASK_MODEL_OPT_IN_GUIDANCE: &str = "To authorize a model override, open Settings → Models, edit the service or account, expand its model Advanced settings, enable \"Available for AI delegation\", and save. Use an exact key from the delegation catalog; never guess a provider/model key.";

/// The one line of advice the Node runtime appends under the catalog.
pub const TASK_MODEL_CHOICE_HINT: &str = "Pick cheaper/faster models for simple searches and read-only reviews. Reserve expensive reasoning models for complex multi-step analysis.";

/// Default and maximum wait windows, in seconds.
pub const TASK_WAIT_DEFAULT_TIMEOUT_SECONDS: u64 = 600;
pub const TASK_WAIT_MAX_TIMEOUT_SECONDS: u64 = 900;

/// One subagent the session may start.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubagentDefinition {
    pub name: String,
    pub description: String,
    /// The definition's own instructions, placed ahead of inherited guidance so
    /// the project's rules still have the last word.
    pub prompt: String,
    /// Tools the delegate may call.
    pub tools: Vec<String>,
    /// Whether any declared tool can change files or run commands.
    pub can_mutate: bool,
}

impl SubagentDefinition {
    /// `Read, Grep, Bash` — the label the tool description and the prompt use.
    pub fn tools_label(&self) -> String {
        if self.tools.is_empty() {
            "none".to_string()
        } else {
            self.tools.join(", ")
        }
    }
}

/// Compose the delegate's system prompt.
///
/// The framing is fixed; the definition body and the session's guidance follow
/// it. The ordering is the decision: a project's instructions come last so they
/// can override a generic definition.
pub fn compose_subagent_system_prompt(
    definition: &SubagentDefinition,
    guidance: &[String],
    tool_names: &[String],
) -> String {
    let tools = if tool_names.is_empty() {
        definition.tools_label()
    } else {
        tool_names.join(", ")
    };
    let mutation = if definition.can_mutate {
        "You may change files, but only the ones the task is about; leave everything else untouched. If the final report would exceed ~8,000 characters, write the full report to a file yourself and make the final message a compact summary plus the file path."
    } else {
        "You have no tools that change files or run commands, so never report an edit you could not have made."
    };
    let framing = [
        format!(
            "You are the \"{}\" subagent inside Pi-Workspace, working on one task delegated by the main agent.",
            definition.name
        ),
        format!(
            "You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: {tools}."
        ),
        mutation.to_string(),
        "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.".to_string(),
        "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.".to_string(),
        "If you discover in the first few turns that you lack a tool essential to the task (e.g. no Bash when shell commands are needed), stop immediately with a one-sentence report naming the missing capability. Do not attempt workarounds or pad the report with unrelated reading.".to_string(),
    ]
    .join("\n");
    std::iter::once(framing)
        .chain(std::iter::once(definition.prompt.clone()))
        .chain(guidance.iter().cloned())
        .filter(|block| !block.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Bound a report, keeping both ends.
///
/// The head says what the delegate did and the tail is usually where it says
/// what it could not finish, so neither end is dropped. Counting is in
/// characters, not bytes: a report in Chinese must not be cut four times shorter.
pub fn bounded_report(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_SUBAGENT_REPORT_CHARS {
        return text.to_string();
    }
    let available = MAX_SUBAGENT_REPORT_CHARS - REPORT_TRUNCATION_MARKER.chars().count();
    let head = available.div_ceil(2);
    let tail = available / 2;
    let head_text: String = text.chars().take(head).collect();
    let tail_text: String = text
        .chars()
        .rev()
        .take(tail)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{head_text}{REPORT_TRUNCATION_MARKER}{tail_text}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegationStatus {
    Running,
    Completed,
    Failed,
    Aborted,
    Stopped,
}

impl DelegationStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
            Self::Stopped => "stopped",
        }
    }

    /// A run that will not change again.
    pub fn is_settled(&self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DelegationError {
    pub code: String,
    pub message: String,
}

/// What one delegate produced.
#[derive(Debug, Clone)]
pub struct DelegateOutcome {
    pub status: DelegationStatus,
    /// The delegate's final assistant text, unbounded; the registry bounds it.
    pub report: String,
    pub turns: usize,
    pub tool_calls: usize,
    pub usage: Usage,
    pub error: Option<DelegationError>,
}

impl DelegateOutcome {
    pub fn completed(report: impl Into<String>) -> Self {
        Self {
            status: DelegationStatus::Completed,
            report: report.into(),
            turns: 1,
            tool_calls: 0,
            usage: Usage::default(),
            error: None,
        }
    }

    pub fn failed(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: DelegationStatus::Failed,
            report: String::new(),
            turns: 0,
            tool_calls: 0,
            usage: Usage::default(),
            error: Some(DelegationError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

/// What a runner is asked to execute.
#[derive(Debug, Clone)]
pub struct DelegateRunRequest {
    pub session_id: String,
    pub parent_turn_id: String,
    pub parent_tool_call_id: String,
    pub delegation_id: String,
    pub definition: SubagentDefinition,
    pub task: String,
    /// The delegation model key `Task.model` named, already checked against the
    /// catalog. `None` runs the delegate on the session's own model, which is
    /// what the reference does when the definition pins nothing.
    pub model_key: Option<String>,
    pub cancel: CancelToken,
}

/// Runs one delegate turn. The sidecar supplies the real implementation (engine,
/// provider, scoped tools); a test supplies a scripted one.
pub trait DelegateRunner: Send + Sync {
    fn run<'a>(&'a self, request: DelegateRunRequest) -> BoxFuture<'a, DelegateOutcome>;
}

/// One delegation, as the parent can observe it.
#[derive(Debug)]
pub struct DelegationRecord {
    pub delegation_id: String,
    pub parent_tool_call_id: String,
    pub agent_name: String,
    pub task: String,
    pub label: Option<String>,
    pub model_id: String,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub status: DelegationStatus,
    pub report: Option<String>,
    pub turns: usize,
    pub tool_calls: usize,
    pub usage: Usage,
    pub error: Option<DelegationError>,
    /// True once a `TaskWait` result actually carried this report to the parent.
    pub report_delivered: bool,
    cancel: CancelToken,
}

impl DelegationRecord {
    /// Cancel this delegate only. A delegate's abort never aborts the parent.
    pub fn abort(&self) {
        self.cancel.cancel();
    }
}

/// What a stop did to one delegation, so each caller can phrase it for its reader.
pub enum StopOutcome {
    /// Asked to stop; the delegate settles itself as `stopped`.
    Requested { id: String, agent: String },
    /// Already finished, so nothing was cancelled.
    AlreadySettled {
        id: String,
        agent: String,
        status: &'static str,
    },
    /// No delegation by that id exists in this session.
    Unknown { id: String },
}

impl StopOutcome {
    pub fn id(&self) -> &str {
        match self {
            Self::Requested { id, .. } | Self::AlreadySettled { id, .. } | Self::Unknown { id } => id,
        }
    }
}

/// The delegations of one session.
///
/// Kept per session rather than per turn: a report that settled after the parent
/// stopped calling tools must still be readable, and `TaskWait` in a later turn
/// is what reads it.
#[derive(Default)]
pub struct DelegationRegistry {
    session_id: String,
    records: Mutex<BTreeMap<String, Arc<Mutex<DelegationRecord>>>>,
    settled: Notify,
}

impl DelegationRegistry {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            records: Mutex::new(BTreeMap::new()),
            settled: Notify::new(),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn insert(&self, record: DelegationRecord) -> Arc<Mutex<DelegationRecord>> {
        let handle = Arc::new(Mutex::new(record));
        if let Ok(mut records) = self.records.lock() {
            records.insert(handle_record_id(&handle), handle.clone());
        }
        handle
    }

    fn handles(&self) -> Vec<Arc<Mutex<DelegationRecord>>> {
        self.records
            .lock()
            .map(|records| records.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Every delegation, in start order.
    pub fn snapshot(&self) -> Vec<DelegationView> {
        self.handles()
            .into_iter()
            .filter_map(|handle| {
                handle
                    .lock()
                    .ok()
                    .map(|record| DelegationView::from(&*record))
            })
            .collect()
    }

    /// Cancel delegations the caller asked to stop.
    ///
    /// One rule for both callers: the `TaskStop` tool reports per id (including the
    /// ones it could not stop), and `agent.stopSubagents` reports only what the stop
    /// reached. A delegation that already settled is never re-cancelled — that would
    /// rewrite a record the parent may already have read. `ids` of `None` means the
    /// activity group's stop button: every live delegate, with no noise about the
    /// ones that were already done.
    pub fn stop(&self, ids: Option<&[String]>) -> Vec<StopOutcome> {
        let mut outcomes = Vec::new();
        for handle in self.handles() {
            let Ok(mut record) = handle.lock() else {
                continue;
            };
            let id = record.delegation_id.clone();
            let agent = record.agent_name.clone();
            if let Some(ids) = ids {
                if !ids.iter().any(|wanted| wanted == &id) {
                    continue;
                }
            } else if record.status.is_settled() {
                continue;
            }
            if record.status.is_settled() {
                outcomes.push(StopOutcome::AlreadySettled {
                    id,
                    agent,
                    status: record.status.as_str(),
                });
                continue;
            }
            // The delegate notices through its own token and settles itself as
            // `stopped`; the parent turn is never aborted by this.
            record.abort();
            outcomes.push(StopOutcome::Requested { id, agent });
        }
        if let Some(ids) = ids {
            for id in ids {
                if !outcomes.iter().any(|outcome| outcome.id() == id) {
                    outcomes.push(StopOutcome::Unknown { id: id.clone() });
                }
            }
        }
        outcomes
    }

    fn settle(&self, handle: &Arc<Mutex<DelegationRecord>>, outcome: DelegateOutcome) {
        if let Ok(mut record) = handle.lock() {
            let report = match outcome.status {
                DelegationStatus::Completed => bounded_report(&outcome.report),
                // A failed or aborted run still hands back whatever it produced:
                // "failed after 4 turns: <reason>" plus its last output is more
                // useful to the parent than a bare status.
                _ => {
                    let body = bounded_report(&outcome.report);
                    let name = record.agent_name.clone();
                    let turns = outcome.turns;
                    let reason = outcome
                        .error
                        .as_ref()
                        .map(|error| error.message.clone())
                        .unwrap_or_else(|| "unknown error".to_string());
                    if outcome.status == DelegationStatus::Aborted
                        || outcome.status == DelegationStatus::Stopped
                    {
                        format!("The {name} subagent was aborted after {turns} turn(s).")
                    } else if body.is_empty() {
                        format!("The {name} subagent failed after {turns} turn(s): {reason}.")
                    } else {
                        format!(
                            "The {name} subagent failed after {turns} turn(s): {reason}.\n\nIts last output was:\n\n{body}"
                        )
                    }
                }
            };
            record.status = outcome.status;
            record.report = Some(report);
            record.turns = outcome.turns;
            record.tool_calls = outcome.tool_calls;
            record.usage = outcome.usage;
            record.error = outcome.error;
            record.completed_at_ms = Some(now_ms());
        }
        // Every waiter re-reads the records, so one notification serves them all.
        self.settled.notify_waiters();
    }

    /// Wait until `target` of `ids` have settled, or the deadline passes.
    ///
    /// Returns the ids that were waited on; a timeout is not an error, because a
    /// delegate keeps working and its report is still readable later.
    async fn wait_for(
        &self,
        ids: &[String],
        target: usize,
        timeout: Duration,
        cancel: &CancelToken,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if cancel.is_cancelled() {
                return false;
            }
            if self.settled_count(ids) >= target {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            let wake = self.settled.notified();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return false,
                _ = tokio::time::sleep_until(deadline) => return self.settled_count(ids) >= target,
                _ = wake => {}
            }
        }
    }

    /// Wait until every id has settled, with no deadline.
    ///
    /// Used when a delegate keeps the parent's turn open: there is nothing else
    /// for the turn to do, and every delegate is bounded by its own step budget,
    /// so cancellation is the only way out.
    pub async fn wait_until_settled(&self, ids: &[String], cancel: &CancelToken) -> bool {
        loop {
            if cancel.is_cancelled() {
                return false;
            }
            if self.settled_count(ids) >= ids.len() {
                return true;
            }
            let wake = self.settled.notified();
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return false,
                _ = wake => {}
            }
        }
    }

    fn settled_count(&self, ids: &[String]) -> usize {
        self.handles()
            .into_iter()
            .filter_map(|handle| {
                handle
                    .lock()
                    .ok()
                    .map(|record| (record.delegation_id.clone(), record.status))
            })
            .filter(|(id, status)| ids.contains(id) && status.is_settled())
            .count()
    }
}

fn handle_record_id(handle: &Arc<Mutex<DelegationRecord>>) -> String {
    handle
        .lock()
        .map(|record| record.delegation_id.clone())
        .unwrap_or_default()
}

/// A delegation as a tool result renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationView {
    pub delegation_id: String,
    pub agent_name: String,
    pub label: Option<String>,
    pub status: DelegationStatus,
    pub model_id: String,
    pub turns: usize,
    pub tool_calls: usize,
    pub started_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub report: Option<String>,
    pub error: Option<DelegationError>,
    /// True once some answer already carried this report to the parent.
    pub report_delivered: bool,
}

impl From<&DelegationRecord> for DelegationView {
    fn from(record: &DelegationRecord) -> Self {
        Self {
            delegation_id: record.delegation_id.clone(),
            agent_name: record.agent_name.clone(),
            label: record.label.clone(),
            status: record.status,
            model_id: record.model_id.clone(),
            turns: record.turns,
            tool_calls: record.tool_calls,
            started_at_ms: record.started_at_ms,
            completed_at_ms: record.completed_at_ms,
            report: record.report.clone(),
            error: record.error.clone(),
            report_delivered: record.report_delivered,
        }
    }
}

/// Join settled reports into the text that resumes the parent's turn.
///
/// Returns the text and the ids it actually carried: a report that did not fit
/// the budget must stay undelivered so a later `TaskWait` can still read it.
pub fn format_resume_text(
    settled: &[DelegationView],
    still_running: &[DelegationView],
) -> (String, Vec<String>) {
    let mut blocks: Vec<String> = Vec::new();
    let mut delivered: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut omitted = 0usize;
    for view in settled {
        let report = view
            .report
            .clone()
            .unwrap_or_else(|| format!("({} without a report)", view.status.as_str()));
        let block = format!(
            "## {} ({}) — {}\n{report}",
            view.agent_name,
            view.delegation_id,
            view.status.as_str()
        );
        if used + block.chars().count() > MAX_DELEGATION_RESULT_CHARS {
            omitted += 1;
            continue;
        }
        used += block.chars().count() + 2;
        delivered.push(view.delegation_id.clone());
        blocks.push(block);
    }
    if omitted > 0 {
        blocks.push(format!(
            "[{omitted} more result{} omitted to protect this context; call TaskWait with their delegationIds to re-read one.]",
            if omitted == 1 { "" } else { "s" }
        ));
    }
    let heartbeat = if still_running.is_empty() {
        String::new()
    } else {
        let lines: Vec<String> = still_running
            .iter()
            .map(|view| {
                format!(
                    "- {} ({}) — {} turn(s), {} tool call(s)",
                    view.agent_name, view.delegation_id, view.turns, view.tool_calls
                )
            })
            .collect();
        format!("Still running:\n{}", lines.join("\n"))
    };
    let text = [
        DELEGATION_RESUME_PROMPT.to_string(),
        blocks.join("\n\n"),
        heartbeat,
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    (text, delivered)
}

/// Delegations that should keep the parent's turn open: still running, or
/// settled with a report nobody has read.
///
/// Stopped and aborted runs are excluded: the parent asked for them to end.
pub fn pending_delegations(registry: &DelegationRegistry) -> Vec<DelegationView> {
    registry
        .snapshot()
        .into_iter()
        .filter(|view| {
            !matches!(
                view.status,
                DelegationStatus::Stopped | DelegationStatus::Aborted
            )
        })
        .filter(|view| !view.status.is_settled() || !view.report_delivered)
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Everything the four tools need.
pub struct DelegationHub {
    pub registry: Arc<DelegationRegistry>,
    pub definitions: Vec<SubagentDefinition>,
    runner: Arc<dyn DelegateRunner>,
    /// Delegation model override keys this turn may use (`subagentModelKeys`
    /// that also had a `subagentProviders` binding). Empty means delegation runs
    /// on the session's own model, which is the reference default.
    models: Vec<String>,
}

impl DelegationHub {
    pub fn new(
        registry: Arc<DelegationRegistry>,
        definitions: Vec<SubagentDefinition>,
        runner: Arc<dyn DelegateRunner>,
    ) -> Self {
        Self {
            registry,
            definitions,
            runner,
            models: Vec::new(),
        }
    }

    /// The model keys `Task.model` may name, in the order main authorized them.
    pub fn with_models(mut self, models: Vec<String>) -> Self {
        self.models = models;
        self
    }

    fn has_model(&self, key: &str) -> bool {
        self.models.iter().any(|available| available == key)
    }

    /// What to tell the model when the key it named is not usable: the keys it
    /// may pick from, or — when the session has none — how to authorize one. The
    /// wording is the Node runtime's (`availableSubagentModelKeys`).
    fn model_hint(&self) -> String {
        if self.models.is_empty() {
            format!(
                " No delegation model overrides are configured. {TASK_MODEL_DEFAULT_GUIDANCE} {TASK_MODEL_OPT_IN_GUIDANCE}"
            )
        } else {
            format!(" Available: {}.", self.models.join(", "))
        }
    }

    /// The delegation catalog as the `Task` description carries it, so the model
    /// can choose a model before calling. Empty when nothing was authorized.
    fn models_prompt(&self) -> Option<String> {
        if self.models.is_empty() {
            return None;
        }
        let lines = self
            .models
            .iter()
            .map(|key| format!("- `{key}`"))
            .collect::<Vec<_>>()
            .join("\n");
        Some(format!(
            "Available models for delegation (pass as `model` parameter on Task):\n{lines}\n\n{TASK_MODEL_CHOICE_HINT}"
        ))
    }

    fn definition(&self, name: &str) -> Option<&SubagentDefinition> {
        self.definitions
            .iter()
            .find(|definition| definition.name == name)
    }

    fn names(&self) -> String {
        self.definitions
            .iter()
            .map(|definition| definition.name.clone())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// `Task`: start one delegate and return immediately.
pub struct TaskTool {
    hub: Arc<DelegationHub>,
}

impl TaskTool {
    pub fn new(hub: Arc<DelegationHub>) -> Self {
        Self { hub }
    }
}

impl Tool for TaskTool {
    fn spec(&self) -> ToolSpec {
        let catalog = self
            .hub
            .definitions
            .iter()
            .map(|definition| {
                format!(
                    "- {} (tools: {}): {}",
                    definition.name,
                    definition.tools_label(),
                    definition.description
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        // The delegation model catalog, when the user authorized one. It belongs
        // in the declaration rather than in the system prompt: it is this tool's
        // argument, and the model can only pick a key it was shown.
        let models = self.hub.models_prompt();
        let mut properties = json!({
            "agent": {
                "type": "string",
                "description": format!("Name of the subagent to run: {}.", self.hub.names())
            },
            "task": {
                "type": "string",
                "description": "The complete brief: goal, context the delegate cannot infer, and the exact report you want back."
            },
            "description": {
                "type": "string",
                "description": "Short label for this delegation (3-6 words), shown to the user."
            }
        });
        if models.is_some() {
            properties["model"] = json!({
                "type": "string",
                "description": "Delegation model key, from the available-models list. Omit to run the delegate on the session's own model."
            });
        }
        let catalog_section = match &models {
            Some(models) => format!("{catalog}\n\n{models}"),
            None => catalog,
        };
        ToolSpec::new(
            TASK_TOOL_NAME,
            format!(
                "Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.\n\nPrefer doing the work yourself. Only delegate when it saves significant context or enables genuine parallelism — not for tasks you can finish in a few tool calls.\n\n`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.\n\nTo run delegates concurrently, emit several Task calls in one assistant message. Call TaskStop only to cancel.\n\nAvailable subagents:\n{catalog_section}"
            ),
            json!({
                "type": "object",
                "properties": properties,
                "required": ["agent", "task"],
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let requested = call
                .arguments
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let Some(definition) = self.hub.definition(&requested).cloned() else {
                return Err(AgentError::Refused(format!(
                    "Unknown subagent \"{requested}\". Available: {}.",
                    self.hub.names()
                )));
            };
            let task = call
                .arguments
                .get("task")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if task.is_empty() {
                return Err(AgentError::Refused(format!(
                    "Delegating to {} needs a non-empty `task` brief.",
                    definition.name
                )));
            }
            let label = call
                .arguments
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            // Model override, the reference's `Task.model`: a key from the
            // delegation catalog this turn was launched with. A key outside the
            // catalog is refused here — the Node runtime answers the same call
            // with a tool error rather than quietly running on the parent's
            // model, because a delegate on an expensive model the user did not
            // authorize is a spend decision, not a fallback.
            let model_key = call
                .arguments
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string);
            if let Some(key) = &model_key {
                if !self.hub.has_model(key) {
                    return Err(AgentError::Refused(format!(
                        "Model \"{key}\" is not available for delegation.{}",
                        self.hub.model_hint()
                    )));
                }
            }
            let delegation_id = uuid::Uuid::new_v4().to_string();
            let delegate_cancel = ctx.cancel.child();
            let handle = self.hub.registry.insert(DelegationRecord {
                delegation_id: delegation_id.clone(),
                parent_tool_call_id: call.id.clone(),
                agent_name: definition.name.clone(),
                task: task.clone(),
                label: label.clone(),
                model_id: model_key.clone().unwrap_or_default(),
                started_at_ms: now_ms(),
                completed_at_ms: None,
                status: DelegationStatus::Running,
                report: None,
                turns: 0,
                tool_calls: 0,
                usage: Usage::default(),
                error: None,
                report_delivered: false,
                cancel: delegate_cancel.clone(),
            });

            // The delegate runs on its own task: `Task` returns now, and the
            // parent's turn keeps its own steps.
            let runner = self.hub.runner.clone();
            let registry = self.hub.registry.clone();
            let request = DelegateRunRequest {
                session_id: ctx.session_id.clone(),
                parent_turn_id: ctx.turn_id.clone(),
                parent_tool_call_id: call.id.clone(),
                delegation_id: delegation_id.clone(),
                definition,
                task,
                model_key,
                cancel: delegate_cancel,
            };
            tokio::spawn(async move {
                let outcome = runner.run(request).await;
                registry.settle(&handle, outcome);
            });

            let label_note = label.map(|label| format!(" ({label})")).unwrap_or_default();
            Ok(format!(
                "Delegation {delegation_id} started: the {} subagent is working in the background{label_note}. Continue your own independent work, then call TaskWait with this delegationId to converge, or TaskStop to stop it. Job reference: {}",
                self.hub
                    .records_agent_name(&delegation_id)
                    .unwrap_or_else(|| "requested".to_string()),
                json!({"kind": "delegation", "id": delegation_id})
            ))
        })
    }
}

impl DelegationHub {
    fn records_agent_name(&self, delegation_id: &str) -> Option<String> {
        let records = self.registry.records.lock().ok()?;
        records
            .get(delegation_id)
            .and_then(|handle| handle.lock().ok())
            .map(|record| record.agent_name.clone())
    }
}

/// `TaskWait`: converge on delegates and read their reports.
pub struct TaskWaitTool {
    hub: Arc<DelegationHub>,
}

impl TaskWaitTool {
    pub fn new(hub: Arc<DelegationHub>) -> Self {
        Self { hub }
    }
}

impl Tool for TaskWaitTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_WAIT_TOOL_NAME,
            "Wait for subagents started with Task and read their reports. Omit `delegationIds` to wait on every delegation this session started that has not been read yet. A timeout is not a failure: unfinished subagents keep working and their reports stay readable.",
            json!({
                "type": "object",
                "properties": {
                    "delegationIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Delegations to converge on. Omit for every unread delegation of this session."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["all", "any"],
                        "description": "Wait for every target (default) or for one."
                    },
                    "minCompleted": {
                        "type": "number",
                        "description": "With `any`, how many settled targets are enough. Defaults to 1."
                    },
                    "timeoutSeconds": {
                        "type": "number",
                        "description": format!("How long to wait, 1..{TASK_WAIT_MAX_TIMEOUT_SECONDS}. Defaults to {TASK_WAIT_DEFAULT_TIMEOUT_SECONDS}.")
                    }
                },
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let requested_ids: Vec<String> = call
                .arguments
                .get("delegationIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let known = self.hub.registry.snapshot();
            // An id the caller named must exist: silently waiting on nothing
            // would look like a delegate that never settles.
            let unknown: Vec<&str> = requested_ids
                .iter()
                .filter(|id| !known.iter().any(|view| &view.delegation_id == *id))
                .map(String::as_str)
                .collect();
            if !unknown.is_empty() {
                return Err(AgentError::Refused(format!(
                    "No delegation with id {} in this session.",
                    unknown.join(", ")
                )));
            }
            let targets: Vec<DelegationView> = known
                .into_iter()
                .filter(|view| {
                    if requested_ids.is_empty() {
                        !view.status.is_settled() || !report_delivered(&self.hub, view)
                    } else {
                        requested_ids.contains(&view.delegation_id)
                    }
                })
                .collect();
            if targets.is_empty() {
                return Ok(
                    "No delegation to wait on: nothing has been started in this session."
                        .to_string(),
                );
            }
            let mode_any = call.arguments.get("mode").and_then(Value::as_str) == Some("any");
            let min_completed = call
                .arguments
                .get("minCompleted")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1) as usize;
            let timeout_seconds = call
                .arguments
                .get("timeoutSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(TASK_WAIT_DEFAULT_TIMEOUT_SECONDS)
                .clamp(1, TASK_WAIT_MAX_TIMEOUT_SECONDS);
            let ids: Vec<String> = targets
                .iter()
                .map(|view| view.delegation_id.clone())
                .collect();
            let needed = if mode_any {
                min_completed.min(ids.len())
            } else {
                ids.len()
            };
            let settled = self
                .hub
                .registry
                .wait_for(
                    &ids,
                    needed,
                    Duration::from_secs(timeout_seconds),
                    &ctx.cancel,
                )
                .await;
            if ctx.cancel.is_cancelled() {
                return Ok(
                    "Interrupted by new user input. Unfinished subagents keep working; handle the user's message before waiting again."
                        .to_string(),
                );
            }

            let views = self.hub.registry.snapshot();
            let mut lines: Vec<String> = Vec::new();
            let mut delivered: Vec<(String, bool)> = Vec::new();
            for id in &ids {
                let Some(view) = views.iter().find(|view| &view.delegation_id == id) else {
                    continue;
                };
                delivered.push((id.clone(), view.status.is_settled()));
                lines.push(format!(
                    "## {} — {} ({})",
                    view.agent_name,
                    view.status.as_str(),
                    view.delegation_id
                ));
                match (&view.report, view.status) {
                    (Some(report), status) if status.is_settled() => lines.push(report.clone()),
                    _ => lines.push(
                        "Still running. It keeps working; call TaskWait again when its report is needed."
                            .to_string(),
                    ),
                }
                lines.push(String::new());
            }
            if settled {
                self.hub.registry.mark_delivered(&ids);
            } else {
                // A timeout settles nothing: the reports of whatever did finish
                // are in this answer, and the rest stay pending for the next call.
                let done: Vec<String> = delivered
                    .iter()
                    .filter(|(_, settled)| *settled)
                    .map(|(id, _)| id.clone())
                    .collect();
                self.hub.registry.mark_delivered(&done);
                lines.insert(
                    0,
                    format!(
                        "Waited {timeout_seconds}s: {} of {} finished. This is not a failure — unfinished delegates keep working and the runtime will read their reports when asked again.\n",
                        done.len(),
                        ids.len()
                    ),
                );
            }
            Ok(lines.join("\n").trim_end().to_string())
        })
    }
}

fn report_delivered(hub: &Arc<DelegationHub>, view: &DelegationView) -> bool {
    hub.registry
        .records
        .lock()
        .ok()
        .and_then(|records| records.get(&view.delegation_id).cloned())
        .and_then(|handle| handle.lock().ok().map(|record| record.report_delivered))
        .unwrap_or(false)
}

impl DelegationRegistry {
    /// Record that these reports reached the parent, so a later `TaskWait` does
    /// not hand the same text over twice.
    pub fn mark_delivered(&self, ids: &[String]) {
        let Ok(records) = self.records.lock() else {
            return;
        };
        for id in ids {
            if let Some(handle) = records.get(id) {
                if let Ok(mut record) = handle.lock() {
                    if record.status.is_settled() {
                        record.report_delivered = true;
                    }
                }
            }
        }
    }

    /// Reports that settled but were never read by the parent.
    pub fn undelivered(&self) -> Vec<DelegationView> {
        self.snapshot()
            .into_iter()
            .filter(|view| view.status.is_settled() && view.report.is_some())
            .filter(|view| !view.report_delivered)
            .collect()
    }
}

/// `TaskList`: what this session started, without waiting.
pub struct TaskListTool {
    hub: Arc<DelegationHub>,
}

impl TaskListTool {
    pub fn new(hub: Arc<DelegationHub>) -> Self {
        Self { hub }
    }
}

impl Tool for TaskListTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_LIST_TOOL_NAME,
            "List this session's subagents: each delegation's id, agent, status, turns and whether its report is ready. Use it to decide what to converge on with TaskWait.",
            json!({"type": "object", "properties": {}, "additionalProperties": false}),
        )
    }

    fn call<'a>(
        &'a self,
        _call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let views = self.hub.registry.snapshot();
            if views.is_empty() {
                return Ok("This session has started no subagents.".to_string());
            }
            let mut lines = vec![format!("{} delegation(s):", views.len())];
            for view in views {
                let note = match view.status {
                    DelegationStatus::Running => "report not ready".to_string(),
                    _ => match (&view.report, &view.error) {
                        (Some(_), _) => "report ready".to_string(),
                        (None, Some(error)) => format!("failed: {}", error.code),
                        (None, None) => "no report".to_string(),
                    },
                };
                lines.push(format!(
                    "- {} — {} ({}), {} turn(s), {} tool call(s); {note}",
                    view.delegation_id,
                    view.agent_name,
                    view.status.as_str(),
                    view.turns,
                    view.tool_calls
                ));
            }
            Ok(lines.join("\n"))
        })
    }
}

/// `TaskStop`: abort delegates.
pub struct TaskStopTool {
    hub: Arc<DelegationHub>,
}

impl TaskStopTool {
    pub fn new(hub: Arc<DelegationHub>) -> Self {
        Self { hub }
    }
}

impl Tool for TaskStopTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TASK_STOP_TOOL_NAME,
            "Stop running subagents by delegation id. A stopped delegate settles as `stopped`; a settled one is left alone. This is the only way to cancel a delegate besides the user's Stop.",
            json!({
                "type": "object",
                "properties": {
                    "delegationIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Delegations to stop."
                    }
                },
                "required": ["delegationIds"],
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let ids: Vec<String> = call
                .arguments
                .get("delegationIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                return Err(AgentError::Refused(
                    "delegationIds is required: pass at least one delegation id from Task or TaskList."
                        .into(),
                ));
            }
            let mut lines: Vec<String> = Vec::new();
            for outcome in self.hub.registry.stop(Some(&ids)) {
                lines.push(match outcome {
                    StopOutcome::Requested { id, agent } => {
                        format!("- {id}: stop requested ({agent})")
                    }
                    StopOutcome::AlreadySettled { id, agent, status } => {
                        format!("- {id}: already {status} ({agent})")
                    }
                    StopOutcome::Unknown { id } => {
                        format!("- {id}: no such delegation in this session")
                    }
                });
            }
            Ok(lines.join("\n"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A runner whose delegates settle when the test says so.
    struct ManualRunner {
        started: Arc<AtomicUsize>,
        gate: Arc<Notify>,
    }

    impl DelegateRunner for ManualRunner {
        fn run<'a>(&'a self, request: DelegateRunRequest) -> BoxFuture<'a, DelegateOutcome> {
            self.started.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.clone();
            Box::pin(async move {
                tokio::select! {
                    _ = request.cancel.cancelled() => DelegateOutcome {
                        status: DelegationStatus::Stopped,
                        report: String::new(),
                        turns: 1,
                        tool_calls: 0,
                        usage: Usage::default(),
                        error: None,
                    },
                    _ = gate.notified() => DelegateOutcome::completed("all done"),
                }
            })
        }
    }

    /// A runner that answers immediately, for tests that need a settled record.
    struct InstantRunner;

    impl DelegateRunner for InstantRunner {
        fn run<'a>(&'a self, _request: DelegateRunRequest) -> BoxFuture<'a, DelegateOutcome> {
            Box::pin(async move { DelegateOutcome::completed("found it at src/main.rs:12") })
        }
    }

    fn definition() -> SubagentDefinition {
        SubagentDefinition {
            name: "explorer".into(),
            description: "Read-only search across the repository.".into(),
            prompt: "Search widely and report exact paths.".into(),
            tools: vec!["Read".into(), "Grep".into()],
            can_mutate: false,
        }
    }

    fn hub(runner: Arc<dyn DelegateRunner>) -> Arc<DelegationHub> {
        Arc::new(DelegationHub::new(
            Arc::new(DelegationRegistry::new("s1")),
            vec![definition()],
            runner,
        ))
    }

    fn context(cancel: CancelToken) -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            steering: None,
            cancel,
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

    #[test]
    fn the_delegate_prompt_frames_the_job_and_puts_project_rules_last() {
        let prompt = compose_subagent_system_prompt(
            &definition(),
            &["Follow the repository AGENTS.md.".to_string()],
            &["Read".to_string(), "Grep".to_string()],
        );
        assert!(prompt.starts_with("You are the \"explorer\" subagent"));
        assert!(prompt.contains("You cannot see the user, ask questions, or delegate further"));
        assert!(prompt.contains("Read, Grep"));
        assert!(prompt.contains("no tools that change files"));
        assert!(prompt.contains("Search widely and report exact paths."));
        let rules = prompt.find("Follow the repository AGENTS.md.").unwrap();
        let body = prompt.find("Search widely").unwrap();
        assert!(body < rules, "project guidance has the last word");
    }

    #[test]
    fn a_writable_definition_is_told_it_may_edit_only_what_the_task_is_about() {
        let writable = SubagentDefinition {
            can_mutate: true,
            ..definition()
        };
        let prompt = compose_subagent_system_prompt(&writable, &[], &[]);
        assert!(prompt.contains("You may change files, but only the ones the task is about"));
    }

    #[test]
    fn a_long_report_keeps_both_ends() {
        let head = "h".repeat(MAX_SUBAGENT_REPORT_CHARS);
        let tail = "t".repeat(MAX_SUBAGENT_REPORT_CHARS);
        let report = format!("{head}{tail}");
        let bounded = bounded_report(&report);
        assert_eq!(bounded.chars().count(), MAX_SUBAGENT_REPORT_CHARS);
        assert!(bounded.contains("[subagent report truncated]"));
        assert!(bounded.starts_with('h'), "the beginning survives");
        assert!(bounded.ends_with('t'), "and so does the end");
    }

    #[test]
    fn a_report_in_chinese_is_measured_in_characters_not_bytes() {
        let report = "汉".repeat(MAX_SUBAGENT_REPORT_CHARS);
        let bounded = bounded_report(&report);
        assert_eq!(
            bounded.chars().count(),
            MAX_SUBAGENT_REPORT_CHARS,
            "three-byte characters must not be cut three times shorter"
        );
    }

    /// A runner that only records which model key it was asked for.
    struct ModelKeyRunner {
        seen: Arc<Mutex<Vec<Option<String>>>>,
    }

    impl DelegateRunner for ModelKeyRunner {
        fn run<'a>(&'a self, request: DelegateRunRequest) -> BoxFuture<'a, DelegateOutcome> {
            let seen = self.seen.clone();
            Box::pin(async move {
                if let Ok(mut seen) = seen.lock() {
                    seen.push(request.model_key.clone());
                }
                DelegateOutcome::completed("done")
            })
        }
    }

    fn hub_with_models(runner: Arc<dyn DelegateRunner>, models: Vec<&str>) -> Arc<DelegationHub> {
        Arc::new(
            DelegationHub::new(
                Arc::new(DelegationRegistry::new("s1")),
                vec![definition()],
                runner,
            )
            .with_models(models.into_iter().map(str::to_string).collect()),
        )
    }

    /// `Task.model` is the reference's own argument: the key the parent picks is
    /// what the delegate runs on, and it reaches the runner unchanged.
    #[tokio::test]
    async fn a_delegation_carries_the_model_key_it_was_started_with() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hub = hub_with_models(
            Arc::new(ModelKeyRunner { seen: seen.clone() }),
            vec!["cheap/model-x", "fast/model-y"],
        );
        let tool = TaskTool::new(hub.clone());
        tool.call(
            &call(
                TASK_TOOL_NAME,
                json!({"agent": "explorer", "task": "find it", "model": "cheap/model-x"}),
            ),
            &context(CancelToken::new()),
        )
        .await
        .expect("started");
        for _ in 0..200 {
            if seen.lock().map(|seen| !seen.is_empty()).unwrap_or(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            seen.lock().expect("lock").clone(),
            vec![Some("cheap/model-x".to_string())],
            "the key travels to the runner instead of being dropped"
        );
        // The record names the model the delegation runs on, so TaskList and the
        // transcript can show it.
        assert_eq!(hub.registry.snapshot()[0].model_id, "cheap/model-x");
    }

    /// A key outside the catalog is refused, not silently replaced by the session
    /// model: the Node runtime answers `Task` with the same tool error.
    #[tokio::test]
    async fn an_unauthorized_model_key_is_refused_with_the_catalog() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let hub = hub_with_models(
            Arc::new(ModelKeyRunner { seen: seen.clone() }),
            vec!["cheap/model-x"],
        );
        let error = TaskTool::new(hub.clone())
            .call(
                &call(
                    TASK_TOOL_NAME,
                    json!({"agent": "explorer", "task": "find it", "model": "expensive/model-z"}),
                ),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("a model nobody authorized is not a fallback");
        let message = error.to_string();
        assert!(
            message.contains("\"expensive/model-z\" is not available for delegation"),
            "{message}"
        );
        assert!(message.contains("Available: cheap/model-x"), "{message}");
        assert!(hub.registry.snapshot().is_empty(), "nothing was started");
        assert!(seen.lock().expect("lock").is_empty());
    }

    /// With no catalog the parameter is not offered at all, and the refusal says
    /// how to authorize one — the reference's guidance, verbatim.
    #[tokio::test]
    async fn without_a_catalog_the_task_declaration_offers_no_model() {
        let hub = hub(Arc::new(InstantRunner));
        let spec = TaskTool::new(hub.clone()).spec();
        assert!(
            spec.parameters["properties"].get("model").is_none(),
            "a parameter with no possible value is noise in every request"
        );
        assert!(!spec.description.contains("Available models for delegation"));

        let error = TaskTool::new(hub)
            .call(
                &call(
                    TASK_TOOL_NAME,
                    json!({"agent": "explorer", "task": "find it", "model": "cheap/model-x"}),
                ),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("no catalog, no override");
        assert!(
            error
                .to_string()
                .contains("No delegation model overrides are configured."),
            "{error}"
        );
    }

    /// With a catalog the keys are on the declaration, so the model can only pick
    /// one it was shown.
    #[test]
    fn the_task_declaration_lists_the_authorized_models() {
        let hub = hub_with_models(Arc::new(InstantRunner), vec!["cheap/model-x", "fast/model-y"]);
        let spec = TaskTool::new(hub).spec();
        assert_eq!(spec.parameters["properties"]["model"]["type"], "string");
        assert!(spec.description.contains("- `cheap/model-x`"));
        assert!(spec.description.contains("- `fast/model-y`"));
        assert!(spec.description.contains(TASK_MODEL_CHOICE_HINT));
    }

    #[tokio::test]
    async fn task_starts_a_delegate_and_returns_immediately() {
        let started = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Notify::new());
        let hub = hub(Arc::new(ManualRunner {
            started: started.clone(),
            gate: gate.clone(),
        }));
        let tool = TaskTool::new(hub.clone());
        let answer = tool
            .call(
                &call(
                    TASK_TOOL_NAME,
                    json!({"agent": "explorer", "task": "find the parser"}),
                ),
                &context(CancelToken::new()),
            )
            .await
            .expect("started");
        assert!(answer.contains("is working in the background"));
        assert!(answer.contains("\"kind\":\"delegation\""));
        for _ in 0..200 {
            if started.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(started.load(Ordering::SeqCst), 1);
        let views = hub.registry.snapshot();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].status, DelegationStatus::Running);
        gate.notify_waiters();
    }

    #[tokio::test]
    async fn an_unknown_agent_is_refused_with_the_available_names() {
        let hub = hub(Arc::new(InstantRunner));
        let tool = TaskTool::new(hub);
        let error = tool
            .call(
                &call(TASK_TOOL_NAME, json!({"agent": "nope", "task": "x"})),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("refused");
        assert!(error.to_string().contains("Unknown subagent \"nope\""));
        assert!(error.to_string().contains("explorer"));
    }

    #[tokio::test]
    async fn an_empty_brief_is_refused() {
        let hub = hub(Arc::new(InstantRunner));
        let tool = TaskTool::new(hub);
        let error = tool
            .call(
                &call(TASK_TOOL_NAME, json!({"agent": "explorer", "task": "   "})),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("refused");
        assert!(error.to_string().contains("non-empty `task` brief"));
    }

    #[tokio::test]
    async fn task_wait_returns_the_report_and_marks_it_read() {
        let hub = hub(Arc::new(InstantRunner));
        let task = TaskTool::new(hub.clone());
        task.call(
            &call(
                TASK_TOOL_NAME,
                json!({"agent": "explorer", "task": "find it"}),
            ),
            &context(CancelToken::new()),
        )
        .await
        .expect("started");

        let wait = TaskWaitTool::new(hub.clone());
        let first = wait
            .call(
                &call(TASK_WAIT_TOOL_NAME, json!({})),
                &context(CancelToken::new()),
            )
            .await
            .expect("waited");
        assert!(first.contains("## explorer — completed"));
        assert!(first.contains("found it at src/main.rs:12"));
        assert_eq!(hub.registry.undelivered().len(), 0, "read once");

        // Nothing unread is left, so a second wait says so instead of repeating.
        let second = wait
            .call(
                &call(TASK_WAIT_TOOL_NAME, json!({})),
                &context(CancelToken::new()),
            )
            .await
            .expect("waited");
        assert!(second.contains("No delegation to wait on"));
    }

    #[tokio::test]
    async fn a_wait_that_times_out_says_so_and_leaves_the_delegate_running() {
        let gate = Arc::new(Notify::new());
        let hub = hub(Arc::new(ManualRunner {
            started: Arc::new(AtomicUsize::new(0)),
            gate: gate.clone(),
        }));
        let task = TaskTool::new(hub.clone());
        task.call(
            &call(TASK_TOOL_NAME, json!({"agent": "explorer", "task": "slow"})),
            &context(CancelToken::new()),
        )
        .await
        .expect("started");
        let wait = TaskWaitTool::new(hub.clone());
        let answer = wait
            .call(
                &call(TASK_WAIT_TOOL_NAME, json!({"timeoutSeconds": 1})),
                &context(CancelToken::new()),
            )
            .await
            .expect("waited");
        assert!(answer.contains("This is not a failure"));
        assert!(answer.contains("Still running"));
        assert_eq!(
            hub.registry.snapshot()[0].status,
            DelegationStatus::Running,
            "a timeout must not settle or kill the delegate"
        );
        gate.notify_waiters();
    }

    #[tokio::test]
    async fn stopping_a_delegate_settles_it_without_touching_the_parent() {
        let gate = Arc::new(Notify::new());
        let hub = hub(Arc::new(ManualRunner {
            started: Arc::new(AtomicUsize::new(0)),
            gate,
        }));
        let task = TaskTool::new(hub.clone());
        let parent_cancel = CancelToken::new();
        task.call(
            &call(TASK_TOOL_NAME, json!({"agent": "explorer", "task": "slow"})),
            &context(parent_cancel.clone()),
        )
        .await
        .expect("started");
        let id = hub.registry.snapshot()[0].delegation_id.clone();

        let stop = TaskStopTool::new(hub.clone());
        let answer = stop
            .call(
                &call(TASK_STOP_TOOL_NAME, json!({"delegationIds": [id.clone()]})),
                &context(parent_cancel.clone()),
            )
            .await
            .expect("stopped");
        assert!(answer.contains("stop requested"));
        for _ in 0..200 {
            if hub.registry.snapshot()[0].status.is_settled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let view = &hub.registry.snapshot()[0];
        assert_eq!(view.status, DelegationStatus::Stopped);
        assert!(view.report.as_deref().unwrap_or("").contains("was aborted"));
        assert!(
            !parent_cancel.is_cancelled(),
            "a delegate's stop never cancels the parent turn"
        );
    }

    #[tokio::test]
    async fn stopping_by_id_reports_what_it_reached_and_what_it_did_not() {
        let gate = Arc::new(Notify::new());
        let hub = hub(Arc::new(ManualRunner {
            started: Arc::new(AtomicUsize::new(0)),
            gate,
        }));
        let task = TaskTool::new(hub.clone());
        for brief in ["first", "second"] {
            task.call(
                &call(TASK_TOOL_NAME, json!({"agent": "explorer", "task": brief})),
                &context(CancelToken::new()),
            )
            .await
            .expect("started");
        }
        let ids: Vec<String> = hub
            .registry
            .snapshot()
            .iter()
            .map(|view| view.delegation_id.clone())
            .collect();
        assert_eq!(ids.len(), 2);

        // One known id and one that never existed: the caller learns both, and the
        // delegate it did not name keeps running.
        let outcomes = hub
            .registry
            .stop(Some(&[ids[0].clone(), "ghost".to_string()]));
        assert!(matches!(
            &outcomes[0],
            StopOutcome::Requested { id, .. } if id == &ids[0]
        ));
        assert!(matches!(&outcomes[1], StopOutcome::Unknown { id } if id == "ghost"));
        assert_eq!(hub.registry.snapshot()[1].status, DelegationStatus::Running);

        // No ids means the activity group's stop button: every delegate still live,
        // including the one already asked to stop — asking twice is harmless because
        // the delegate settles itself exactly once.
        let all = hub.registry.stop(None);
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|outcome| matches!(
            outcome,
            StopOutcome::Requested { .. }
        )));
    }

    #[tokio::test]
    async fn task_list_reports_every_delegation_and_whether_its_report_is_ready() {
        let hub = hub(Arc::new(InstantRunner));
        let task = TaskTool::new(hub.clone());
        task.call(
            &call(
                TASK_TOOL_NAME,
                json!({"agent": "explorer", "task": "find it"}),
            ),
            &context(CancelToken::new()),
        )
        .await
        .expect("started");
        for _ in 0..200 {
            if hub.registry.snapshot()[0].status.is_settled() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let list = TaskListTool::new(hub.clone());
        let answer = list
            .call(
                &call(TASK_LIST_TOOL_NAME, json!({})),
                &context(CancelToken::new()),
            )
            .await
            .expect("listed");
        assert!(answer.starts_with("1 delegation(s):"));
        assert!(answer.contains("explorer"));
        assert!(answer.contains("report ready"));
    }

    #[tokio::test]
    async fn a_failed_delegate_still_hands_back_what_it_produced() {
        struct FailingRunner;
        impl DelegateRunner for FailingRunner {
            fn run<'a>(&'a self, _request: DelegateRunRequest) -> BoxFuture<'a, DelegateOutcome> {
                Box::pin(async move {
                    let mut outcome = DelegateOutcome::failed("PROVIDER_ERROR", "gateway 502");
                    outcome.report = "read src/a.rs and found nothing".into();
                    outcome.turns = 3;
                    outcome
                })
            }
        }
        let hub = Arc::new(DelegationHub::new(
            Arc::new(DelegationRegistry::new("s1")),
            vec![definition()],
            Arc::new(FailingRunner),
        ));
        let task = TaskTool::new(hub.clone());
        task.call(
            &call(TASK_TOOL_NAME, json!({"agent": "explorer", "task": "x"})),
            &context(CancelToken::new()),
        )
        .await
        .expect("started");
        let wait = TaskWaitTool::new(hub.clone());
        let answer = wait
            .call(
                &call(TASK_WAIT_TOOL_NAME, json!({})),
                &context(CancelToken::new()),
            )
            .await
            .expect("waited");
        assert!(answer.contains("failed after 3 turn(s): gateway 502"));
        assert!(answer.contains("Its last output was"));
        assert!(answer.contains("read src/a.rs and found nothing"));
    }

    #[tokio::test]
    async fn an_unknown_delegation_id_is_refused_rather_than_silently_ignored() {
        let hub = hub(Arc::new(InstantRunner));
        let wait = TaskWaitTool::new(hub);
        let error = wait
            .call(
                &call(TASK_WAIT_TOOL_NAME, json!({"delegationIds": ["nope"]})),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("refused");
        assert!(error.to_string().contains("No delegation with id nope"));
    }
}
