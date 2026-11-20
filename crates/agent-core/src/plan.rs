//! The plan lane, and the session checklist the host owns.
//!
//! Two different things used to share this module, and keeping them apart is the
//! point of it:
//!
//! * `SubmitPlan` is the kernel's. A Plan turn submits a contract, the host
//!   writes the artifact and the approval row, and the kernel keeps a copy of
//!   what is pending so `agent.plan` can answer without re-reading the
//!   transcript.
//! * The session checklist is **the host's**. `TodoWrite` is the Node runtime's
//!   tool name and argument shape (`packages/agent-runtime/src/todo-tool.ts`);
//!   the kernel declares it and relays the call over `tools.execute`, exactly as
//!   it relays `Read` or `Bash`. host-core normalizes the list (trims content,
//!   truncates over-long content with a warning, demotes a second `in_progress`
//!   item), replaces `session_todo` in one transaction and announces
//!   `todos.changed`. The kernel keeps only the receipt of the last accepted
//!   write, for `agent.plan`: a read-only snapshot, never a second list to
//!   validate, truncate or render.
//!
//! The practice — a short checklist rewritten whole, with at most one item in
//! progress — is taken from the coding agents that hold up under long tasks
//! (Claude Code's `TodoWrite`, Codex's plan updates): the middle of a long turn
//! is where a model forgets what it was doing, so the list is written down where
//! it re-reads it. Only the tool name is protocol here: a model told to call a
//! tool the kernel does not register is a model whose checklist never moves, and
//! a list held in kernel memory dies with the process.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AgentError, Result};
use crate::event::{AgentEvent, AgentEventEnvelope, EventSink};
use crate::host_bridge::{HostBridge, HostError};
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// The tool the model calls to rewrite the session checklist.
///
/// The name is protocol, not taste: it is the Node runtime's tool name
/// (`packages/agent-runtime/src/todo-tool.ts`), host-core keys its low-risk
/// permission rule and its `tools.execute` branch on it
/// (`crates/host-core/src/permissions.rs`, `crates/host-core/src/rpc/todos.rs`),
/// and the renderer's checklist panel is built from the `todos.changed`
/// notification that branch emits. A kernel-only spelling would be a second
/// vocabulary for one list.
pub const TODO_TOOL_NAME: &str = "TodoWrite";

/// The tool a Plan turn calls to submit its plan for approval.
///
/// Upstream counterpart: `SUBMIT_TOOL_NAMES.plan` in
/// `packages/agent-runtime/src/runtime.ts`. The name is protocol, not taste: the
/// renderer, the persistence layer and main's plan plumbing all identify a
/// submission by this tool name.
pub const SUBMIT_PLAN_TOOL_NAME: &str = "SubmitPlan";

/// The answer a plan turn reads on success. Kept identical to the Node runtime's
/// so the same transcript reads the same either way.
pub const SUBMIT_PLAN_ACCEPTED: &str =
    "Plan submitted for approval. Execution will begin only after approval.";

/// Machine code for a submission that named too little to approve.
pub const PLAN_INVALID_ARGUMENT: &str = "PLAN_INVALID_ARGUMENT";

/// Machine code for a submission the host refused or answered unreadably.
pub const PLAN_SUBMIT_FAILED: &str = "PLAN_SUBMIT_FAILED";

/// The submission tool's description, copied from the Node runtime's Plan
/// submission tool: product policy, so the model is told exactly what it was
/// told before.
const SUBMIT_PLAN_DESCRIPTION: &str = "Submit one new complete Markdown implementation plan for user approval. Prior submissions are immutable historical checkpoints; after a rejected, expired, or interrupted approval, revise the plan and submit a new full snapshot in this turn. Do not use this until the plan is concrete.";

/// The `TodoWrite` description, verbatim from the Node runtime
/// (`packages/agent-runtime/src/todo-tool.ts`, `todoWriteDescription`).
///
/// Product policy, not prose this kernel gets to improve: the model has been
/// told exactly this before, and the last sentence is what tells it to expect a
/// truncation warning rather than a refusal for a paragraph-long item.
pub const TODO_WRITE_DESCRIPTION: &str = "Write the task checklist for the current session so the user can see progress on multi-step work. Use for work that needs 3+ distinct steps or spans multiple files/subsystems; do not use for a single-step action, a question, a read, or a review. Every call replaces the full list in display order. States are pending, in_progress, completed, and cancelled; only one item may be in_progress. Keep items short and concrete, update the list as work starts and finishes, and never leave pending items when the task is done. Content longer than 500 Unicode characters is truncated by the host with a warning.";

/// The statuses host-core accepts, in the order the declaration lists them
/// (`crates/host-core/src/todos.rs`, `TODO_STATUSES`).
pub const TODO_WRITE_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "cancelled"];

/// The declaration, argument for argument what `todoWriteParameters` produces
/// in `packages/agent-runtime/src/todo-tool.ts`:
///
/// * `todos` — required, at most 50 items (the bound the host enforces);
/// * `content` — required, `minLength: 1`; the host trims it and truncates at
///   500 characters, so the kernel neither trims nor counts;
/// * `status` — required, one of the four the host stores;
/// * `priority` — optional, one of `high | medium | low`; the host defaults a
///   missing one to `medium`.
///
/// Nothing else is declared, because host-core refuses an argument it did not
/// ask for (`todos.rs` `normalize_input`): a `sessionId` invented here would turn
/// every call into a refusal.
pub fn todo_write_spec() -> ToolSpec {
    ToolSpec::new(
        TODO_TOOL_NAME,
        TODO_WRITE_DESCRIPTION,
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "maxItems": 50,
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "minLength": 1},
                            "status": {"type": "string", "enum": TODO_WRITE_STATUSES},
                            "priority": {"type": "string", "enum": ["high", "medium", "low"]}
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["todos"]
        }),
    )
}

/// What host-core said it committed, as it said it.
///
/// This is the *only* checklist state the kernel holds, and it is read-only: the
/// rows, the revision and the normalization are the host's, so this is the last
/// answer it gave (`crates/host-core/src/rpc/todos.rs` `success`), kept so
/// `agent.plan` can report where the list stands without a second round trip.
/// It is never re-validated, re-truncated or rendered — a second copy that could
/// disagree with the database is the bug this module no longer has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoReceipt {
    /// Monotonic per-session counter the host advances on every write.
    pub revision: u64,
    pub completed: u64,
    /// Items that still matter: cancelled ones are neither done nor outstanding.
    pub total: u64,
    pub in_progress: u64,
    pub cancelled: u64,
    /// The host's bounded notes about what it changed about the input —
    /// truncation, a demoted second `in_progress`. Empty when it changed nothing.
    pub warnings: Vec<String>,
    /// The host's one-line result text, verbatim.
    pub text: String,
}

impl TodoReceipt {
    /// Read the host's `tools.execute` answer.
    ///
    /// `None` means the answer was not a checklist receipt at all; the model
    /// still gets the text, so a host that reshapes its answer cannot cost it the
    /// result — only `agent.plan`'s snapshot.
    pub fn from_content(content: &Value) -> Option<Self> {
        let summary = content.get("summary")?;
        let count = |key: &str| summary.get(key).and_then(Value::as_u64).unwrap_or(0);
        Some(Self {
            revision: content.get("revision").and_then(Value::as_u64)?,
            completed: count("completed"),
            total: count("total"),
            in_progress: count("inProgress"),
            cancelled: count("cancelled"),
            warnings: content
                .get("warnings")
                .and_then(Value::as_array)
                .map(|warnings| {
                    warnings
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            text: content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    /// One line of status, for `agent.plan`. Deliberately the same shape the
    /// kernel used to compute from its own list, so a reader of that RPC sees no
    /// change in meaning.
    pub fn summary(&self) -> String {
        format!("{}/{} done", self.completed, self.total)
    }
}


/// The plan/goal negotiation a session is in.
///
/// Wire names match `PlanningState` in `packages/shared/src/types/plans.ts`: the
/// renderer switches on these three strings, and a fourth would be a state
/// nothing draws.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningStatus {
    /// No contract is being negotiated: an Agent turn, an approved run, or a
    /// mode that never submits one.
    #[default]
    Inactive,
    /// A Plan turn is working: it may inspect, and it has not submitted yet.
    Planning,
    /// A plan was submitted and the user has not answered.
    AwaitingApproval,
}

impl PlanningStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Inactive => "inactive",
            Self::Planning => "planning",
            Self::AwaitingApproval => "awaiting_approval",
        }
    }
}

/// The contract a Plan turn last submitted, as the host accepted it.
///
/// Kept beside the checklist because the two answer different questions: the
/// checklist is what the model is doing, this is what the user was asked to
/// approve. The host owns the artifact and the approval row; this is the
/// kernel's copy, so `agent.plan` can say an approval is pending without
/// re-reading the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmittedPlan {
    pub proposal_id: String,
    /// `plan` for everything this kernel submits; the field exists because the
    /// host's proposal carries it.
    pub kind: String,
    pub title: String,
    pub markdown: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    /// The host's proposal object, forwarded whole: the renderer's checkpoint
    /// row is built from it and every field it reads must still be there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Value>,
}

impl SubmittedPlan {
    /// Read the host's answer to `plans.submit`.
    ///
    /// A shape this cannot read is a failure, not a partial success: the review
    /// the renderer opens needs the proposal id and the artifact it will show,
    /// and inventing either would open a review of nothing.
    pub fn from_response(
        title: &str,
        markdown: &str,
        question: &str,
        response: &Value,
    ) -> Option<Self> {
        if response.get("status").and_then(Value::as_str) != Some("pending") {
            return None;
        }
        let proposal = response.get("proposal")?;
        let proposal_id = proposal.get("id").and_then(Value::as_str)?;
        if proposal_id.trim().is_empty() {
            return None;
        }
        let artifact = proposal.get("artifact").filter(|artifact| {
            artifact
                .get("relativePath")
                .and_then(Value::as_str)
                .map(|path| !path.trim().is_empty())
                .unwrap_or(false)
                && artifact.get("sha256").and_then(Value::as_str).is_some()
                && artifact.get("sizeBytes").and_then(Value::as_u64).is_some()
        })?;
        let text = |key: &str| {
            proposal
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            proposal_id: proposal_id.to_string(),
            kind: proposal
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("plan")
                .to_string(),
            title: text("title").unwrap_or(title).to_string(),
            markdown: text("markdown").unwrap_or(markdown).to_string(),
            question: text("question").unwrap_or(question).to_string(),
            artifact: Some(artifact.clone()),
            version: proposal.get("version").and_then(Value::as_u64),
            proposal: Some(proposal.clone()),
        })
    }
}

/// The plan lane's own state: the contract awaiting approval, and the receipt of
/// the checklist the host last accepted.
///
/// It holds no checklist rows. The rows, the revision and the normalization are
/// host-core's (`session_todo`); what lives here is the last answer it gave, so
/// `agent.plan` can report where the list stands without a second round trip —
/// and so two processes can never disagree about what the user's list says.
#[derive(Debug, Default)]
pub struct PlanState {
    /// The last `TodoWrite` the host accepted, exactly as it answered.
    todos: Mutex<Option<TodoReceipt>>,
    /// The plan last submitted for approval, if any.
    submitted: Mutex<Option<SubmittedPlan>>,
    /// The planning state this session last announced on the event stream. A
    /// prompt declares its mode every turn; only a change is worth an event, so
    /// the previous value lives here rather than in the caller.
    planning: Mutex<PlanningStatus>,
}

impl PlanState {
    pub fn new() -> Self {
        Self::default()
    }

    /// The host's last accepted write, if one ever landed.
    pub fn todos(&self) -> Option<TodoReceipt> {
        self.todos.lock().ok().and_then(|todos| todos.clone())
    }

    /// Keep what the host said it committed. Overwrites: the newest write is the
    /// list, and the older receipt describes a revision that no longer exists.
    pub fn record_todos(&self, receipt: TodoReceipt) {
        if let Ok(mut slot) = self.todos.lock() {
            *slot = Some(receipt);
        }
    }

    /// One line for `agent.plan`.
    ///
    /// `no plan` is the answer this RPC gave for a session that had written
    /// nothing before the host owned the list, kept verbatim: the caller that
    /// reads it has no way to tell which store produced the words.
    pub fn checklist_summary(&self) -> String {
        self.todos()
            .map(|receipt| receipt.summary())
            .unwrap_or_else(|| "no plan".to_string())
    }

    /// Remember the contract the host accepted, replacing any earlier one: an
    /// approval is per submission, and the newest submission is the pending one.
    pub fn submit(&self, submitted: SubmittedPlan) {
        if let Ok(mut slot) = self.submitted.lock() {
            *slot = Some(submitted);
        }
    }

    /// The contract this session last submitted for approval, if any.
    pub fn submitted(&self) -> Option<SubmittedPlan> {
        self.submitted.lock().ok().and_then(|slot| slot.clone())
    }

    /// The planning state this session last announced.
    pub fn planning(&self) -> PlanningStatus {
        self.planning.lock().map(|status| *status).unwrap_or_default()
    }

    /// Record the planning state a turn announced, reporting whether it changed.
    ///
    /// A prompt declares its mode on every turn, so announcing unconditionally
    /// would put one event on the stream per turn for a state that did not move.
    pub fn notice_planning(&self, status: PlanningStatus) -> bool {
        match self.planning.lock() {
            Ok(mut current) if *current != status => {
                *current = status;
                true
            }
            _ => false,
        }
    }
}

/// The `TodoWrite` tool: one call replaces the whole checklist, in the host.
///
/// The kernel declares it and relays it; it does not interpret, trim or validate
/// it. That is the division of labour `Read` and `Bash` already have
/// (`host_bridge::HostTool`), and it is why a restart cannot lose the list:
/// host-core's `session_todo` rows are the only copy, and the `todos.changed`
/// notification it emits after the commit is what moves the panel.
pub struct TodoWriteTool {
    bridge: std::sync::Arc<HostBridge>,
    plan: std::sync::Arc<PlanState>,
}

impl TodoWriteTool {
    pub fn new(bridge: std::sync::Arc<HostBridge>, plan: std::sync::Arc<PlanState>) -> Self {
        Self { bridge, plan }
    }
}

/// The host's `tools.execute` answer, in the ordinary shapes the loop turns into
/// a tool result.
///
/// The failure rules are `host_bridge::HostTool::interpret`'s, on purpose: the
/// model must see one shape of failure whichever tool it called, and a denial
/// must stay a denial. The difference is that a success is read *before* it is
/// flattened into text, so [`TodoReceipt`] survives.
fn interpret(name: &str, value: &Value) -> Result<(String, Option<TodoReceipt>)> {
    let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let is_error = value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = value.get("content").cloned().unwrap_or(Value::Null);
    // An object is forwarded as it arrived, laid out for reading — the Node
    // runtime's `JSON.stringify(content, null, 2)` — so the `text` the host wrote
    // and the `warnings` it attached are both in the result the model sees.
    let text = match &content {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    };

    if ok && !is_error {
        return Ok((text, TodoReceipt::from_content(&content)));
    }

    let error_code = value
        .get("errorCode")
        .and_then(Value::as_str)
        .unwrap_or("TOOL_FAILED");
    let message = if text.is_empty() {
        format!("`{name}` failed ({error_code})")
    } else {
        text
    };
    let denied = value.get("denied").and_then(Value::as_bool).unwrap_or(false)
        || error_code == "PERMISSION_DENIED";
    Err(if denied {
        AgentError::ToolDenied {
            tool: name.to_string(),
            reason: message,
        }
    } else {
        AgentError::Tool {
            tool: name.to_string(),
            message,
        }
    })
}

impl Tool for TodoWriteTool {
    fn spec(&self) -> ToolSpec {
        todo_write_spec()
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            // The owner session and turn travel as trusted-transport fields, never
            // as arguments: host-core refuses a `sessionId` inside `args`, and it
            // re-authorizes the write against the running turn of the session named
            // here (`crates/host-core/src/todos.rs`).
            let answer = self
                .bridge
                .call(
                    "tools.execute",
                    json!({
                        "sessionId": ctx.session_id,
                        "turnId": ctx.turn_id,
                        "toolCallId": ctx.tool_call_id,
                        "toolName": TODO_TOOL_NAME,
                        // Forwarded untouched. Trimming, the 500-character
                        // truncation and the one-in-progress rule are the host's;
                        // a kernel-side copy of them would be the second authority
                        // this change removed.
                        "args": call.arguments,
                        // `TodoWrite` is an Agent-mode tool in host-core's policy and
                        // in the Node runtime alike: `mode-tool-access.ts` keeps it
                        // out of every contract mode.
                        "mode": "agent",
                    }),
                )
                .await
                .map_err(|error| AgentError::Tool {
                    tool: TODO_TOOL_NAME.into(),
                    message: error.to_string(),
                })?;

            let (text, receipt) = interpret(TODO_TOOL_NAME, &answer)?;
            if let Some(receipt) = receipt {
                self.plan.record_todos(receipt);
            }
            Ok(text)
        })
    }
}

/// The host call a submission needs: `plans.submit` writes the artifact and the
/// approval row, and tells the UI. A test supplies a fake; the sidecar supplies
/// the real bridge.
pub trait PlanHost: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>>;
}

impl PlanHost for crate::host_bridge::HostBridge {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
        Box::pin(async move { crate::host_bridge::HostBridge::call(self, method, params).await })
    }
}

/// The `SubmitPlan` tool: the one way a Plan turn asks for approval.
///
/// Upstream counterpart: `buildSubmitTool("plan")` in
/// `packages/agent-runtime/src/runtime.ts`. The host owns the `.pi/plan`
/// artifact, the approval row and the review panel, so this tool validates the
/// call, forwards it as `plans.submit`, and announces the state the renderer
/// draws. A submission the host accepts is the only thing that opens the gate:
/// writing the plan anywhere else would be a review of nothing.
pub struct SubmitPlanTool {
    host: std::sync::Arc<dyn PlanHost>,
    plan: std::sync::Arc<PlanState>,
    sink: std::sync::Arc<dyn EventSink>,
}

impl SubmitPlanTool {
    pub fn new(
        host: std::sync::Arc<dyn PlanHost>,
        plan: std::sync::Arc<PlanState>,
        sink: std::sync::Arc<dyn EventSink>,
    ) -> Self {
        Self { host, plan, sink }
    }
}

impl Tool for SubmitPlanTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            SUBMIT_PLAN_TOOL_NAME,
            SUBMIT_PLAN_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "A concise title for the implementation plan."
                    },
                    "markdown": {
                        "type": "string",
                        "description": "The exact Markdown implementation plan, including files, behavior, and validation."
                    },
                    "question": {
                        "type": "string",
                        "description": "The question or decision the user should answer when approving this plan."
                    }
                },
                "required": ["title", "markdown", "question"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            // The same three arguments the Node runtime's Plan submission takes,
            // trimmed the same way: a whitespace-only field is a field the user
            // cannot approve.
            let field = |key: &str| {
                call.arguments
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            };
            let (Some(title), Some(markdown), Some(question)) =
                (field("title"), field("markdown"), field("question"))
            else {
                return Err(AgentError::Refused(format!(
                    "{SUBMIT_PLAN_TOOL_NAME} requires non-empty title, markdown, and question. ({PLAN_INVALID_ARGUMENT})"
                )));
            };
            let response = self
                .host
                .call(
                    "plans.submit",
                    json!({
                        "sessionId": ctx.session_id,
                        "turnId": ctx.turn_id,
                        "toolCallId": ctx.tool_call_id,
                        "kind": "plan",
                        "title": title,
                        "markdown": markdown,
                        "question": question,
                    }),
                )
                .await
                .map_err(|error| AgentError::Tool {
                    tool: SUBMIT_PLAN_TOOL_NAME.into(),
                    message: format!("{PLAN_SUBMIT_FAILED}: {error}"),
                })?;
            let submitted = SubmittedPlan::from_response(title, markdown, question, &response)
                .ok_or_else(|| AgentError::Tool {
                    tool: SUBMIT_PLAN_TOOL_NAME.into(),
                    message: format!(
                        "{PLAN_SUBMIT_FAILED}: the host returned no pending proposal with an artifact"
                    ),
                })?;
            // The kernel keeps its own copy of what is pending, and says so on
            // the event stream: main renders the review from the event, and a
            // session reopened after a restart still knows an approval is open.
            self.plan.submit(submitted.clone());
            self.plan.notice_planning(PlanningStatus::AwaitingApproval);
            self.sink.emit(AgentEventEnvelope::new(
                &ctx.session_id,
                &ctx.turn_id,
                AgentEvent::plan_submitted(&submitted),
            ));
            Ok(SUBMIT_PLAN_ACCEPTED.to_string())
        })
    }
}

/// The instruction that turns an approved plan descriptor into one Agent turn.
///
/// Ported from `executeApprovedPlanTurn` in
/// `packages/agent-runtime/src/runtime.ts`: same sections, same order, same
/// "do not renegotiate" rule. `execution` is main's `PlanExecution` descriptor.
///
/// One deliberate difference from `executeApprovedPlanTurn`: it names `TodoWrite`,
/// which is this kernel's registered checklist tool *and* the Node runtime's, so
/// the sentence points at a tool that exists here instead of at the kernel-only
/// spelling (`Todo`) it used to have.
pub fn approved_execution_instruction(
    execution: &Value,
) -> std::result::Result<String, String> {
    let not_found = |what: &str| format!("{what} (PLAN_EXECUTION_NOT_FOUND)");
    let artifact = execution
        .get("artifact")
        .and_then(|artifact| artifact.get("relativePath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| not_found("the approved execution names no plan artifact path"))?;
    let plan = execution
        .get("plan")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| not_found("the approved execution carries no plan text"))?;
    let title = execution
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let question = execution
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let todo = TODO_TOOL_NAME;
    let lines: Vec<String> = if execution.get("kind").and_then(Value::as_str) == Some("goal") {
        vec![
            "The user approved the goal contract below. Reach that goal now, autonomously.".into(),
            format!("Use the host-created goal artifact at the workspace-relative path: {artifact}"),
            format!("Approved goal title: {title}"),
            format!("Approval question: {question}"),
            "Treat the following Markdown as the exact approved contract. Do not renegotiate it, replace it with a new contract, or ask for approval again.".into(),
            "<approved-goal-markdown>".into(),
            plan.to_string(),
            "</approved-goal-markdown>".into(),
            format!(
                "Open your work list before you start: call {todo} with the steps you intend to take, taken from the contract above, exactly one in_progress and the rest pending. Update it as each step starts and finishes so the user can follow the run."
            ),
            "Choose your own approach with the normal Agent tools. Then verify every acceptance criterion yourself, running the checks the contract names rather than assuming they pass.".into(),
            "Keep working while a criterion is still unmet and you have an untried approach. Stop early only if a boundary in the contract blocks you or a criterion cannot be verified; say which one and why.".into(),
            "Finish with a report that walks the acceptance criteria one by one, each marked met or unmet with the evidence you observed. Leave no todo pending or in_progress when you report.".into(),
        ]
    } else {
        vec![
            "Execute the approved implementation plan now.".into(),
            format!("Use the host-created plan artifact at the workspace-relative path: {artifact}"),
            format!("Approved plan title: {title}"),
            format!("Approval question: {question}"),
            "Treat the following Markdown as the exact approved snapshot. Do not replace it with a new plan or ask for approval again.".into(),
            "<approved-plan-markdown>".into(),
            plan.to_string(),
            "</approved-plan-markdown>".into(),
            format!(
                "Open your work list before you start: call {todo} with the steps you intend to take, taken from the approved plan above, exactly one in_progress and the rest pending. Update it as each step starts and finishes so the user can follow the run."
            ),
            "Implement the approved plan with the normal Agent tools, then report the result. Leave no todo pending or in_progress when you report.".into(),
        ]
    };
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::RecordingSink;
    use crate::message::ToolResult;
    use crate::tool::{AllowAll, ToolRegistry};
    use std::sync::Arc;

    fn context() -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            steering: None,
            cancel: crate::cancel::CancelToken::new(),
        }
    }

    fn call(arguments: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: TODO_TOOL_NAME.into(),
            arguments,
            raw_arguments: None,
        }
    }

    /// Drive one `TodoWrite` call as far as its `tools.execute` frame, answer it
    /// with the reply host-core would give, and hand back both the result the
    /// model sees and the frame the kernel actually put on the wire.
    async fn execute(plan: Arc<PlanState>, arguments: Value, answer: Value) -> (ToolResult, Value) {
        let lines = crate::sidecar::RecordingLines::new();
        let bridge = Arc::new(HostBridge::new(Arc::new(lines.clone())));
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(TodoWriteTool::new(bridge.clone(), plan)));
        let tool_call = call(arguments);
        let ctx = context();
        let running = tokio::spawn(async move { registry.call(&tool_call, &ctx).await });

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let frame = loop {
            let found = lines.host_calls().into_iter().find(|frame| {
                frame.pointer("/params/method").and_then(Value::as_str) == Some("tools.execute")
            });
            if let Some(frame) = found {
                break frame;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the kernel never sent `tools.execute`"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };

        let id = frame
            .get("id")
            .and_then(Value::as_str)
            .expect("the frame's id")
            .to_string();
        let payload = frame
            .pointer("/params/params")
            .cloned()
            .expect("the proxied params");
        // Answer, so the call ends here instead of waiting out the bridge timeout.
        bridge.complete(&id, Ok(answer));
        (running.await.expect("the call task"), payload)
    }

    /// What host-core's `tools.execute` answers for one `TodoWrite`
    /// (`crates/host-core/src/rpc/todos.rs` `success`): the one-line text, the
    /// committed revision, the counts and the normalization warnings.
    fn host_receipt() -> Value {
        json!({
            "ok": true,
            "content": {
                "text": "Checklist updated: 0/2 completed; current: read the failing test [1 item(s) were truncated to 500 characters]",
                "revision": 7,
                "summary": {"completed": 0, "total": 2, "inProgress": 1, "cancelled": 0},
                "warnings": ["1 item(s) were truncated to 500 characters"]
            }
        })
    }

    #[test]
    fn todo_write_declares_the_node_runtime_tool_verbatim() {
        let spec = todo_write_spec();
        // The name host-core's permission rule, its `tools.execute` branch and the
        // renderer's checklist panel are all keyed on.
        assert_eq!(spec.name, "TodoWrite");
        assert_eq!(spec.name, TODO_TOOL_NAME);
        assert!(spec
            .description
            .starts_with("Write the task checklist for the current session"));
        assert!(
            spec.description
                .ends_with("Content longer than 500 Unicode characters is truncated by the host with a warning."),
            "the truncation policy is part of the contract, not a surprise"
        );

        // `todoWriteParameters` in `packages/agent-runtime/src/todo-tool.ts`.
        let properties = spec.parameters["properties"].as_object().expect("properties");
        assert_eq!(properties.len(), 1, "no invented arguments");
        let required: Vec<&str> = spec.parameters["required"]
            .as_array()
            .expect("required list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(required, vec!["todos"]);

        let todos = &spec.parameters["properties"]["todos"];
        assert_eq!(todos["type"], "array");
        assert_eq!(todos["maxItems"], 50, "the bound host-core enforces");

        let item = &todos["items"];
        let item_required: Vec<&str> = item["required"]
            .as_array()
            .expect("item required list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(item_required, vec!["content", "status"]);
        assert_eq!(item["properties"]["content"]["type"], "string");
        assert_eq!(item["properties"]["content"]["minLength"], 1);
        let statuses: Vec<&str> = item["properties"]["status"]["enum"]
            .as_array()
            .expect("status enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            statuses,
            vec!["pending", "in_progress", "completed", "cancelled"],
            "the four states host-core stores"
        );
        let priorities: Vec<&str> = item["properties"]["priority"]["enum"]
            .as_array()
            .expect("priority enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(priorities, vec!["high", "medium", "low"]);
    }

    #[tokio::test]
    async fn todo_write_forwards_the_call_to_the_host_and_returns_its_answer() {
        let plan = Arc::new(PlanState::new());
        // 501 characters: the host truncates, and the kernel must not — a kernel
        // that clipped first would hide the warning from the model.
        let overlong = "日".repeat(501);
        let (result, payload) = execute(
            plan.clone(),
            json!({"todos": [
                {"content": overlong, "status": "in_progress"},
                {"content": "run the suite", "status": "pending", "priority": "high"}
            ]}),
            host_receipt(),
        )
        .await;

        // The frame host-core's `TodoWrite` body reads: owner session and turn from
        // the trusted transport, the arguments as the model wrote them, Agent mode.
        assert_eq!(payload["toolName"], "TodoWrite");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["turnId"], "t1");
        assert_eq!(payload["toolCallId"], "call_1");
        assert_eq!(payload["mode"], "agent");
        assert_eq!(
            payload["args"]["todos"][0]["content"],
            json!(overlong),
            "the kernel neither trims nor truncates: the host does"
        );
        assert_eq!(payload["args"]["todos"][1]["priority"], "high");
        assert!(
            payload.get("planSafeActions").is_none(),
            "not a plugin tool: {payload}"
        );

        // The host's own words come back to the model, warning included.
        assert!(!result.is_error, "{}", result.content);
        assert!(
            result.content.contains("truncated to 500 characters"),
            "{}",
            result.content
        );
        assert!(result.content.contains("\"revision\": 7"), "{}", result.content);
        assert!(
            result.content.contains("Checklist updated: 0/2 completed"),
            "{}",
            result.content
        );

        // And what the host said it committed is the snapshot `agent.plan` reports.
        let receipt = plan.todos().expect("the host's receipt");
        assert_eq!(receipt.revision, 7);
        assert_eq!(receipt.total, 2);
        assert_eq!(receipt.in_progress, 1);
        assert_eq!(receipt.completed, 0);
        assert_eq!(receipt.warnings.len(), 1);
        assert_eq!(plan.checklist_summary(), "0/2 done");
    }

    #[tokio::test]
    async fn a_write_the_host_refuses_is_a_tool_error_and_leaves_no_snapshot() {
        let plan = Arc::new(PlanState::new());
        let (result, payload) = execute(
            plan.clone(),
            json!({"todos": [{"content": "x", "status": "pending"}]}),
            json!({
                "ok": false,
                "isError": true,
                "denied": true,
                "errorCode": "TOOL_DISABLED_IN_PLAN",
                "content": {"error": "TodoWrite requires Agent mode", "code": "TOOL_DISABLED_IN_PLAN"}
            }),
        )
        .await;

        assert_eq!(payload["toolName"], "TodoWrite");
        assert!(result.is_error, "{}", result.content);
        assert!(
            result.content.contains("TodoWrite requires Agent mode"),
            "the host's refusal reaches the model: {}",
            result.content
        );
        assert!(plan.todos().is_none(), "a refused write changed nothing");
        assert_eq!(plan.checklist_summary(), "no plan");
    }

    #[tokio::test]
    async fn a_host_that_answers_without_a_receipt_still_answers_the_model() {
        // Nothing here is the kernel's to insist on: the text the host wrote is the
        // tool result, and only `agent.plan`'s snapshot goes without.
        let plan = Arc::new(PlanState::new());
        let (result, _) = execute(
            plan.clone(),
            json!({"todos": []}),
            json!({"ok": true, "content": "Checklist cleared"}),
        )
        .await;
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.content, "Checklist cleared");
        assert!(plan.todos().is_none());
    }

    /// Stands in for Electron main: records the call, answers with a proposal.
    #[derive(Default)]
    struct FakeHost {
        calls: Mutex<Vec<(String, Value)>>,
        reply: Mutex<Value>,
        failure: Mutex<Option<String>>,
    }

    impl FakeHost {
        fn answering(reply: Value) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.reply.lock().unwrap() = reply;
            host
        }

        fn failing(message: &str) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.failure.lock().unwrap() = Some(message.to_string());
            host
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl PlanHost for FakeHost {
        fn call<'a>(
            &'a self,
            method: &'a str,
            params: Value,
        ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let reply = self.reply.lock().unwrap().clone();
            let failure = self.failure.lock().unwrap().clone();
            Box::pin(async move {
                match failure {
                    Some(message) => Err(HostError::Rpc(crate::rpc::RpcError::app(
                        "PLAN_WORKSPACE_REQUIRED",
                        message,
                    ))),
                    None => Ok(reply),
                }
            })
        }
    }

    /// The answer host-core's `plans.submit` gives (rpc/mod.rs), trimmed to the
    /// fields the tool reads.
    fn pending_proposal() -> Value {
        json!({
            "status": "pending",
            "proposal": {
                "id": "proposal-1",
                "sessionId": "s1",
                "turnId": "t1",
                "toolCallId": "call_1",
                "kind": "plan",
                "title": "Fix the parser",
                "markdown": "# Plan\n1. read the test\n2. fix the parser",
                "question": "Run this plan?",
                "artifact": {
                    "relativePath": ".pi/plan/proposal-1.md",
                    "sha256": "abc123",
                    "sizeBytes": 42
                },
                "version": 1,
                "status": "pending",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "plan": "# Plan\n1. read the test\n2. fix the parser"
            }
        })
    }

    fn submit_registry(
        plan: Arc<PlanState>,
        host: Arc<FakeHost>,
        sink: Arc<RecordingSink>,
    ) -> ToolRegistry {
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(SubmitPlanTool::new(host, plan, sink)));
        registry
    }

    fn submit_call(arguments: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: SUBMIT_PLAN_TOOL_NAME.into(),
            arguments,
            raw_arguments: None,
        }
    }

    #[tokio::test]
    async fn a_submitted_plan_goes_to_the_host_and_is_announced() {
        // The transition the renderer draws comes from one place only: the host's
        // accepted proposal, forwarded as `plans.submit` exactly as the Node
        // runtime forwards it (`{...params}` in runtime.ts `buildSubmitTool`).
        let plan = Arc::new(PlanState::new());
        let host = FakeHost::answering(pending_proposal());
        let sink = Arc::new(RecordingSink::new());
        let result = submit_registry(plan.clone(), host.clone(), sink.clone())
            .call(
                &submit_call(json!({
                    "title": "  Fix the parser  ",
                    "markdown": "# Plan\n1. read the test\n2. fix the parser",
                    "question": "Run this plan?"
                })),
                &context(),
            )
            .await;
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.content, SUBMIT_PLAN_ACCEPTED);

        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "plans.submit");
        assert_eq!(calls[0].1["sessionId"], "s1");
        assert_eq!(calls[0].1["turnId"], "t1");
        assert_eq!(calls[0].1["toolCallId"], "call_1");
        assert_eq!(calls[0].1["kind"], "plan");
        assert_eq!(calls[0].1["title"], "Fix the parser", "the argument is trimmed");
        assert_eq!(calls[0].1["question"], "Run this plan?");

        let submitted = plan.submitted().expect("the kernel keeps what is pending");
        assert_eq!(submitted.proposal_id, "proposal-1");
        assert_eq!(submitted.artifact.unwrap()["relativePath"], ".pi/plan/proposal-1.md");
        assert_eq!(plan.planning(), PlanningStatus::AwaitingApproval);

        let events = sink.events();
        assert_eq!(events.len(), 1, "events: {events:?}");
        match &events[0] {
            AgentEvent::PlanningState {
                state,
                kind,
                proposal_id,
                title,
                question,
                version,
                ..
            } => {
                assert_eq!(*state, PlanningStatus::AwaitingApproval);
                assert_eq!(kind.as_deref(), Some("plan"));
                assert_eq!(proposal_id.as_deref(), Some("proposal-1"));
                assert_eq!(title.as_deref(), Some("Fix the parser"));
                assert_eq!(question.as_deref(), Some("Run this plan?"));
                assert_eq!(*version, Some(1));
            }
            other => panic!("expected a planning state, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_submission_missing_a_field_never_reaches_the_host() {
        let plan = Arc::new(PlanState::new());
        let host = FakeHost::answering(pending_proposal());
        let sink = Arc::new(RecordingSink::new());
        let result = submit_registry(plan.clone(), host.clone(), sink.clone())
            .call(
                &submit_call(json!({ "title": "Fix it", "markdown": "  ", "question": "ok?" })),
                &context(),
            )
            .await;
        assert!(result.is_error);
        assert!(
            result.content
                .contains("requires non-empty title, markdown, and question"),
            "{}",
            result.content
        );
        assert!(result.content.contains(PLAN_INVALID_ARGUMENT));
        assert!(host.calls().is_empty(), "the host is never asked");
        assert!(sink.is_empty(), "no state changed");
        assert!(plan.submitted().is_none());
    }

    #[tokio::test]
    async fn a_refused_submission_reports_the_code_and_keeps_the_state() {
        let plan = Arc::new(PlanState::new());
        let host = FakeHost::failing("this session has no workspace");
        let sink = Arc::new(RecordingSink::new());
        let result = submit_registry(plan.clone(), host, sink.clone())
            .call(
                &submit_call(json!({
                    "title": "Fix it",
                    "markdown": "# Plan",
                    "question": "ok?"
                })),
                &context(),
            )
            .await;
        assert!(result.is_error);
        assert!(result.content.contains(PLAN_SUBMIT_FAILED), "{}", result.content);
        assert!(result.content.contains("no workspace"), "{}", result.content);
        assert!(sink.is_empty());
        assert!(plan.submitted().is_none());
        assert_eq!(plan.planning(), PlanningStatus::Inactive);
    }

    #[tokio::test]
    async fn a_proposal_without_an_artifact_is_not_reported_as_success() {
        // The review the renderer opens needs the artifact it will show, so a
        // pending status alone is not enough.
        let plan = Arc::new(PlanState::new());
        let host = FakeHost::answering(json!({
            "status": "pending",
            "proposal": {"id": "proposal-1", "kind": "plan", "title": "t"}
        }));
        let sink = Arc::new(RecordingSink::new());
        let result = submit_registry(plan.clone(), host, sink.clone())
            .call(
                &submit_call(json!({
                    "title": "Fix it",
                    "markdown": "# Plan",
                    "question": "ok?"
                })),
                &context(),
            )
            .await;
        assert!(result.is_error);
        assert!(result.content.contains(PLAN_SUBMIT_FAILED));
        assert!(sink.is_empty());
    }

    #[test]
    fn the_tool_names_and_arguments_match_the_node_runtime() {
        let plan = Arc::new(PlanState::new());
        let registry = submit_registry(
            plan,
            FakeHost::answering(pending_proposal()),
            Arc::new(RecordingSink::new()),
        );
        let spec = registry
            .specs()
            .into_iter()
            .find(|spec| spec.name == "SubmitPlan")
            .expect("the Node runtime's Plan submission tool name");
        let required: Vec<&str> = spec.parameters["required"]
            .as_array()
            .expect("required list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        // runtime.ts `buildSubmitTool("plan")`: title, markdown, question — and no
        // other argument, because the host derives everything else.
        assert_eq!(required, vec!["title", "markdown", "question"]);
        let properties = spec.parameters["properties"].as_object().expect("properties");
        assert_eq!(properties.len(), 3, "no invented arguments");
    }

    #[test]
    fn an_approved_plan_becomes_one_instruction_naming_the_artifact_and_the_snapshot() {
        let execution = json!({
            "id": "execution-1",
            "proposalId": "proposal-1",
            "sessionId": "s1",
            "kind": "plan",
            "plan": "# Plan\n1. read the test\n2. fix the parser",
            "title": "Fix the parser",
            "question": "Run this plan?",
            "artifact": {
                "relativePath": ".pi/plan/proposal-1.md",
                "sha256": "abc123",
                "sizeBytes": 42
            },
            "targetPermissionMode": "ask",
            "state": "queued"
        });
        let instruction = approved_execution_instruction(&execution).expect("an instruction");
        // The sections `executeApprovedPlanTurn` builds, in its order.
        assert!(instruction.starts_with("Execute the approved implementation plan now."));
        assert!(instruction.contains("workspace-relative path: .pi/plan/proposal-1.md"));
        assert!(instruction.contains("Approved plan title: Fix the parser"));
        assert!(instruction.contains("Approval question: Run this plan?"));
        assert!(instruction.contains("<approved-plan-markdown>\n# Plan\n1. read the test\n2. fix the parser\n</approved-plan-markdown>"));
        // The work-list line names the tool the model can actually call: the Node
        // runtime's `TodoWrite`, which host-core executes. A kernel-only spelling
        // here was a model calling into the void.
        assert!(instruction.contains("call TodoWrite with the steps"));
        assert_eq!(TODO_TOOL_NAME, "TodoWrite");
        assert!(instruction.ends_with("Leave no todo pending or in_progress when you report."));
    }

    #[test]
    fn an_approved_goal_asks_for_the_criteria_to_be_verified() {
        let execution = json!({
            "id": "execution-2",
            "sessionId": "s1",
            "kind": "goal",
            "plan": "# Goal\nShip the parser fix.",
            "title": "Parser fix",
            "question": "Accept this contract?",
            "artifact": {"relativePath": ".pi/plan/proposal-2.md", "sha256": "d", "sizeBytes": 1}
        });
        let instruction = approved_execution_instruction(&execution).expect("an instruction");
        assert!(instruction.starts_with("The user approved the goal contract below."));
        assert!(instruction.contains("<approved-goal-markdown>"));
        assert!(instruction.contains("verify every acceptance criterion yourself"));
    }

    #[test]
    fn an_execution_that_names_no_artifact_or_no_plan_is_refused() {
        let no_artifact = json!({"kind": "plan", "plan": "# Plan"});
        let error = approved_execution_instruction(&no_artifact).expect_err("no artifact");
        assert!(error.contains("PLAN_EXECUTION_NOT_FOUND"), "{error}");

        let no_plan = json!({
            "kind": "plan",
            "plan": "   ",
            "artifact": {"relativePath": ".pi/plan/x.md"}
        });
        let error = approved_execution_instruction(&no_plan).expect_err("no plan text");
        assert!(error.contains("PLAN_EXECUTION_NOT_FOUND"), "{error}");
    }

    #[test]
    fn only_a_changed_planning_state_is_worth_an_event() {
        let plan = PlanState::new();
        assert!(plan.notice_planning(PlanningStatus::Planning));
        assert!(!plan.notice_planning(PlanningStatus::Planning), "same state");
        assert!(plan.notice_planning(PlanningStatus::AwaitingApproval));
        assert!(plan.notice_planning(PlanningStatus::Inactive));
        assert_eq!(plan.planning(), PlanningStatus::Inactive);
    }
}
