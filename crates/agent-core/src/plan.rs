//! The plan the agent keeps for itself: a todo list it writes and reads back.
//!
//! Practice taken from the coding agents that hold up under long tasks (Claude
//! Code's `TodoWrite`, Codex's plan updates, the `writing-plans` discipline): a
//! task that spans many steps needs its shape written down somewhere the model
//! re-reads, because the middle of a long turn is exactly where a model forgets
//! what it was doing. The list is *short by construction* — a plan with twenty
//! items is a log, not a plan — and it holds one invariant that makes it useful:
//! **at most one step is in progress**, so "what am I doing now" has one answer.
//!
//! The list lives in the kernel, not in the host: it is context, and it is
//! rendered into the request the kernel composes.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AgentError, Result};
use crate::event::{AgentEvent, AgentEventEnvelope, EventSink};
use crate::host_bridge::HostError;
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// The tool the model calls to rewrite its plan.
pub const TODO_TOOL_NAME: &str = "Todo";

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

/// A plan longer than this is a log. The bound is what keeps the rendered section
/// cheap enough to carry in every request.
pub const MAX_PLAN_ITEMS: usize = 20;

/// One line of a plan may not be a paragraph.
pub const MAX_PLAN_ITEM_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
}

impl StepStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "pending" | "todo" => Some(Self::Pending),
            "in_progress" | "inprogress" | "active" | "doing" => Some(Self::InProgress),
            "completed" | "done" => Some(Self::Completed),
            _ => None,
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self, Self::Completed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub content: String,
    pub status: StepStatus,
}

impl PlanStep {
    pub fn pending(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            status: StepStatus::Pending,
        }
    }

    pub fn in_progress(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            status: StepStatus::InProgress,
        }
    }

    pub fn completed(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            status: StepStatus::Completed,
        }
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

/// The plan, shared by whatever holds it: the session that renders it and the
/// tool that rewrites it.
#[derive(Debug, Default)]
pub struct PlanState {
    steps: Mutex<Vec<PlanStep>>,
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

    pub fn snapshot(&self) -> Vec<PlanStep> {
        self.steps
            .lock()
            .map(|steps| steps.clone())
            .unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.steps.lock().map(|steps| steps.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The step being worked on, if the plan is being followed.
    pub fn current(&self) -> Option<PlanStep> {
        self.snapshot()
            .into_iter()
            .find(|step| step.status == StepStatus::InProgress)
    }

    pub fn done_count(&self) -> usize {
        self.snapshot()
            .iter()
            .filter(|step| step.status.is_done())
            .count()
    }

    pub fn clear(&self) {
        if let Ok(mut steps) = self.steps.lock() {
            steps.clear();
        }
    }

    /// Replace the plan, enforcing the invariants that make it readable.
    ///
    /// A refusal is written for the model: it can fix the call by answering again.
    pub fn replace(&self, steps: Vec<PlanStep>) -> Result<Vec<PlanStep>> {
        validate_plan(&self.snapshot(), &steps)?;
        let mut guard = self
            .steps
            .lock()
            .map_err(|_| AgentError::Invalid("the plan state is poisoned".into()))?;
        *guard = steps.clone();
        Ok(steps)
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

/// The rules a plan has to satisfy. Kept as a free function so the same rules
/// apply to a plan read back from anywhere.
pub fn validate_plan(previous: &[PlanStep], next: &[PlanStep]) -> Result<()> {
    if next.len() > MAX_PLAN_ITEMS {
        return Err(AgentError::Refused(format!(
            "a plan holds at most {MAX_PLAN_ITEMS} steps; this one has {}. Merge related steps instead of listing every action.",
            next.len()
        )));
    }
    let in_progress: Vec<&PlanStep> = next
        .iter()
        .filter(|step| step.status == StepStatus::InProgress)
        .collect();
    if in_progress.len() > 1 {
        return Err(AgentError::Refused(format!(
            "at most one step may be `in_progress`; {} are. Finish or park the others first — two steps in progress means the plan does not say what you are doing.",
            in_progress.len()
        )));
    }
    for step in next {
        let trimmed = step.content.trim();
        if trimmed.is_empty() {
            return Err(AgentError::Refused(
                "every step needs `content`: a blank line in a plan is a step nobody can do."
                    .into(),
            ));
        }
        if trimmed.chars().count() > MAX_PLAN_ITEM_CHARS {
            return Err(AgentError::Refused(format!(
                "a step is {} characters; keep it under {MAX_PLAN_ITEM_CHARS} and put the detail in the work, not the plan.",
                trimmed.chars().count()
            )));
        }
    }
    // Completed work may not silently become pending again: either it was done
    // and stays done, or the plan needs a new step that says what broke.
    for step in next {
        if step.status != StepStatus::Pending {
            continue;
        }
        let was_done = previous
            .iter()
            .any(|old| old.content.trim() == step.content.trim() && old.status.is_done());
        if was_done {
            return Err(AgentError::Refused(format!(
                "`{}` was completed and cannot go back to pending. Add a new step for the follow-up work instead.",
                step.content.trim()
            )));
        }
    }
    Ok(())
}

/// Render the plan as the section a request carries. An empty plan renders to
/// nothing: a section that says "no plan" costs tokens on every request.
pub fn render_plan(steps: &[PlanStep]) -> String {
    if steps.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!(
        "## plan ({} of {} done)",
        steps.iter().filter(|step| step.status.is_done()).count(),
        steps.len()
    )];
    for step in steps {
        let marker = match step.status {
            StepStatus::Pending => "[ ]",
            StepStatus::InProgress => "[~]",
            StepStatus::Completed => "[x]",
        };
        lines.push(format!("{marker} {}", step.content.trim()));
    }
    lines.join("\n")
}

/// The plan as one line of status, for a panel or a report.
pub fn plan_summary(steps: &[PlanStep]) -> String {
    match steps
        .iter()
        .find(|step| step.status == StepStatus::InProgress)
    {
        Some(current) => format!(
            "{}/{} done · now: {}",
            steps.iter().filter(|step| step.status.is_done()).count(),
            steps.len(),
            current.content.trim()
        ),
        None if steps.is_empty() => "no plan".to_string(),
        None => format!(
            "{}/{} done",
            steps.iter().filter(|step| step.status.is_done()).count(),
            steps.len()
        ),
    }
}

/// The `Todo` tool: one call replaces the whole plan.
///
/// A whole-list rewrite rather than per-item edits is deliberate — it is what
/// makes the call one atomic statement of intent, and it is what the record shows
/// afterwards: the plan at each point in the task, not a diff of it.
pub struct TodoTool {
    plan: std::sync::Arc<PlanState>,
}

impl TodoTool {
    pub fn new(plan: std::sync::Arc<PlanState>) -> Self {
        Self { plan }
    }
}

impl Tool for TodoTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            TODO_TOOL_NAME,
            "Replace the task plan.",
            json!({
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["steps"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let items = call
                .arguments
                .get("steps")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AgentError::Refused(
                        "`steps` is required: pass the whole plan as an array of {content, status}.".into(),
                    )
                })?;
            let mut steps = Vec::with_capacity(items.len());
            for item in items {
                let content = item
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let status = item
                    .get("status")
                    .and_then(Value::as_str)
                    .and_then(StepStatus::parse)
                    .ok_or_else(|| {
                        AgentError::Refused(format!(
                            "status must be `pending`, `in_progress` or `completed`; got {:?}",
                            item.get("status").and_then(Value::as_str).unwrap_or("")
                        ))
                    })?;
                steps.push(PlanStep { content, status });
            }
            let steps = self.plan.replace(steps)?;
            Ok(format!(
                "{}\n\n{}",
                plan_summary(&steps),
                render_plan(&steps)
            ))
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
/// One deliberate difference: the work-list line names the tool this kernel
/// registers (`Todo`), not the Node runtime's `TodoWrite`. Pointing a model at a
/// tool that does not exist is the exact failure this change is fixing — a plan
/// turn told to call `SubmitPlan` while nothing answered it.
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

    fn registry(plan: Arc<PlanState>) -> ToolRegistry {
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(TodoTool::new(plan)));
        registry
    }

    #[tokio::test]
    async fn a_plan_is_replaced_and_rendered() {
        let plan = Arc::new(PlanState::new());
        let result = registry(plan.clone())
            .call(
                &call(json!({"steps": [
                    {"content": "read the failing test", "status": "completed"},
                    {"content": "fix the parser", "status": "in_progress"},
                    {"content": "run the suite", "status": "pending"}
                ]})),
                &context(),
            )
            .await;
        assert!(!result.is_error, "{}", result.content);
        assert!(result.content.contains("1/3 done · now: fix the parser"));
        let rendered = render_plan(&plan.snapshot());
        assert!(rendered.contains("[x] read the failing test"));
        assert!(rendered.contains("[~] fix the parser"));
        assert!(rendered.contains("[ ] run the suite"));
        assert_eq!(plan.current().unwrap().content, "fix the parser");
        assert_eq!(plan.done_count(), 1);
    }

    #[tokio::test]
    async fn two_steps_in_progress_are_refused_with_a_reason() {
        let plan = Arc::new(PlanState::new());
        let result = registry(plan.clone())
            .call(
                &call(json!({"steps": [
                    {"content": "a", "status": "in_progress"},
                    {"content": "b", "status": "in_progress"}
                ]})),
                &context(),
            )
            .await;
        assert!(result.is_error);
        assert!(
            result.content.contains("at most one step"),
            "{}",
            result.content
        );
        assert!(plan.is_empty(), "a refused plan changed nothing");
    }

    #[tokio::test]
    async fn completed_work_cannot_go_back_to_pending() {
        let plan = Arc::new(PlanState::new());
        plan.replace(vec![PlanStep::completed("write the fix")])
            .unwrap();
        let result = registry(plan.clone())
            .call(
                &call(json!({"steps": [
                    {"content": "write the fix", "status": "pending"}
                ]})),
                &context(),
            )
            .await;
        assert!(result.is_error);
        assert!(result.content.contains("cannot go back to pending"));
        assert_eq!(plan.done_count(), 1, "the plan is unchanged");
    }

    #[test]
    fn the_plan_is_short_and_its_lines_are_short() {
        let long: Vec<PlanStep> = (0..(MAX_PLAN_ITEMS + 1))
            .map(|index| PlanStep::pending(format!("step {index}")))
            .collect();
        assert!(validate_plan(&[], &long).is_err());
        let paragraph = PlanStep::pending("x".repeat(MAX_PLAN_ITEM_CHARS + 1));
        assert!(validate_plan(&[], &[paragraph]).is_err());
        assert!(validate_plan(&[], &[PlanStep::pending("   ")]).is_err());
    }

    #[test]
    fn an_empty_plan_renders_to_nothing() {
        assert!(render_plan(&[]).is_empty());
        assert_eq!(plan_summary(&[]), "no plan");
    }

    #[test]
    fn statuses_accept_the_spellings_a_model_actually_writes() {
        assert_eq!(
            StepStatus::parse("in_progress"),
            Some(StepStatus::InProgress)
        );
        assert_eq!(
            StepStatus::parse("in-progress"),
            Some(StepStatus::InProgress)
        );
        assert_eq!(StepStatus::parse("Done"), Some(StepStatus::Completed));
        assert_eq!(StepStatus::parse("later"), None);
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
        // The work-list line names the tool this kernel actually registers.
        assert!(instruction.contains(&format!("call {TODO_TOOL_NAME} with the steps")));
        assert!(!instruction.contains("TodoWrite"));
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
