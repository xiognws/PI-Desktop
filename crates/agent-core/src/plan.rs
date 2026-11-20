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
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// The tool the model calls to rewrite its plan.
pub const TODO_TOOL_NAME: &str = "Todo";

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

/// The plan, shared by whatever holds it: the session that renders it and the
/// tool that rewrites it.
#[derive(Debug, Default)]
pub struct PlanState {
    steps: Mutex<Vec<PlanStep>>,
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
