//! Mode instructions.
//!
//! Copied verbatim from `packages/agent-runtime/src/mode-prompts.ts`: these are
//! product policy, not mechanism, and a session must read exactly the same
//! rules it reads today. Editing them here is a product decision.

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SessionMode {
    Plan,
    #[default]
    Agent,
    Goal,
    /// A mode whose definition the session does not have: read-only, and said
    /// so in the prompt.
    Other(String),
}

impl SessionMode {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            None | Some("") | Some("agent") => Self::Agent,
            Some("plan") => Self::Plan,
            Some("goal") => Self::Goal,
            Some(other) => Self::Other(other.to_string()),
        }
    }

    /// Write-capable modes. `Other` is read-only because its definition is not
    /// available to the session — the same rule the prompt states.
    pub fn is_write_capable(&self) -> bool {
        matches!(self, Self::Agent)
    }

    /// How this mode is named on the wire.
    ///
    /// host-core requires `mode` on `tools.execute` (its parameter has no
    /// default) and evaluates the call's permission ceiling against it, so the
    /// name a prompt was launched with is the name every tool call carries.
    pub fn wire_name(&self) -> &str {
        match self {
            Self::Agent => "agent",
            Self::Plan => "plan",
            Self::Goal => "goal",
            Self::Other(other) => other.as_str(),
        }
    }
}

pub const PLAN_MODE_SYSTEM_PROMPT: &str = "You are operating in Plan mode as the same Pi-Workspace agent, in a planning state.\nInspect the workspace and relevant context, reason about the requested change, and formulate a concrete implementation plan with files, behavior, and validation steps.\nDo not use Write, Edit, Task, TaskWait, TaskList, TaskStop, or any unknown tool in Plan mode. Their declarations may remain visible for conversation compatibility, but calls are rejected without execution.\nDo not create, overwrite, delete, or otherwise mutate workspace files in Plan mode — including through Bash. Bash is available under the active permission policy for inspection and planning only (for example reading files, listing directories, or running read-only commands). If the user asks you to implement changes, say that Plan mode cannot apply them and ask them to switch to Agent mode or approve a SubmitPlan first.\nPlugin tools that declare plan-safe actions are available for inspection (for example reading a URL through a browser plugin); only the listed plan-safe actions may run, anything else is denied.\nDo not write or edit a plan file yourself. When any initial or revised plan is ready, call SubmitPlan immediately exactly once in the current turn with one complete Markdown snapshot, a title, and the question that needs approval; the host writes a new .pi/plan artifact and opens the review.\nAn accepted new Plan prompt means no prior approval is pending. Earlier SubmitPlan calls in the transcript are historical immutable checkpoints, not the current plan and not an active approval gate.\nAfter reject, expiry, or interruption closes approval and returns to editable planning, revise the plan in the new turn and follow the same one-SubmitPlan rule; never edit or replace an earlier artifact.\nDo not wait for chat confirmation, continue planning, or implement changes while approval is pending.";

pub const GOAL_MODE_SYSTEM_PROMPT: &str = "You are operating in Goal mode as the same PI-Desktop agent. Goal mode pursues one objective across several turns until every acceptance criterion is verified with evidence.\nThe host owns the goal run: it starts the run from the user's message, starts continuation turns while the run is open, enforces the turn budget, and checks the goal artifact when you complete the stage. When this turn belongs to a run, the Mode run section below names the run, its artifact, and how to complete it.\nWhen no Mode run section is present, no run is active for this turn: answer the user directly and do not report progress on a goal.";

pub const AGENT_MODE_SYSTEM_PROMPT: &str = "You are operating in Agent mode. After the user approves a plan or requests implementation, carry out the requested work with the available tools and report the result clearly.\nFor multi-step work, keep the user's session checklist current with TodoWrite. Mark items completed only after verifying them, keep at most one item in progress, and finish with every item completed or cancelled.";

/// Read-only notice for every `contract`-level mode or stage other than the
/// builtin Plan, whose own prompt already states the same restriction.
pub const CONTRACT_MODE_POLICY_PROMPT: &str = "This mode is read-only at its current permission level. Do not use Write, Edit, Task, TaskWait, TaskList, TaskStop, or any unknown tool: their declarations may remain visible for conversation compatibility, but calls are rejected without execution.\nDo not create, overwrite, delete, or otherwise mutate workspace files, including through Bash. Bash is available under the active permission policy for inspection only. Plugin tools that declare plan-safe actions may run only those actions.";

/// Instructions for the session's mode. A session carrying no definition falls
/// back to the read-only notice, so an unknown mode can never write.
pub fn mode_instructions(mode: SessionMode) -> String {
    match mode {
        SessionMode::Plan => PLAN_MODE_SYSTEM_PROMPT.to_string(),
        SessionMode::Agent => AGENT_MODE_SYSTEM_PROMPT.to_string(),
        SessionMode::Goal => {
            format!("{GOAL_MODE_SYSTEM_PROMPT}\n\n{CONTRACT_MODE_POLICY_PROMPT}")
        }
        SessionMode::Other(name) => format!(
            "You are operating in the \"{name}\" mode, but its definition is not available to this session.\n\n{CONTRACT_MODE_POLICY_PROMPT}"
        ),
    }
}

/// `base` then `mode`, each trimmed, blank parts dropped.
pub fn compose_mode_system_prompt(mode: SessionMode, base: &str, mode_text: &str) -> String {
    let _ = mode;
    [base.trim(), mode_text.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_parse_from_wire_names() {
        assert_eq!(SessionMode::parse(None), SessionMode::Agent);
        assert_eq!(SessionMode::parse(Some("plan")), SessionMode::Plan);
        assert_eq!(SessionMode::parse(Some("goal")), SessionMode::Goal);
        assert_eq!(
            SessionMode::parse(Some("custom-x")),
            SessionMode::Other("custom-x".into())
        );
    }

    #[test]
    fn only_agent_mode_is_write_capable() {
        assert!(SessionMode::Agent.is_write_capable());
        assert!(!SessionMode::Plan.is_write_capable());
        assert!(!SessionMode::Goal.is_write_capable());
        assert!(!SessionMode::Other("x".into()).is_write_capable());
    }

    #[test]
    fn an_unknown_mode_is_told_it_is_read_only() {
        let text = mode_instructions(SessionMode::Other("mystery".into()));
        assert!(text.contains("mystery"));
        assert!(text.contains("read-only"));
    }

    #[test]
    fn plan_mode_forbids_mutation_and_that_text_is_verbatim() {
        let text = mode_instructions(SessionMode::Plan);
        assert!(
            text.contains("Do not create, overwrite, delete, or otherwise mutate workspace files")
        );
        assert!(text.contains("SubmitPlan"));
    }

    #[test]
    fn goal_mode_carries_the_contract_notice() {
        let text = mode_instructions(SessionMode::Goal);
        assert!(text.starts_with("You are operating in Goal mode"));
        assert!(text.contains("read-only at its current permission level"));
    }

    #[test]
    fn compose_drops_blank_parts() {
        assert_eq!(
            compose_mode_system_prompt(SessionMode::Agent, "  ", "  X "),
            "X"
        );
        assert_eq!(
            compose_mode_system_prompt(SessionMode::Agent, "A", "B"),
            "A\n\nB"
        );
    }
}
