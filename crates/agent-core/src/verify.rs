//! The definition-of-done gate: what a turn must have checked before it may say
//! it is finished.
//!
//! Practice from the agents whose output can be trusted without review (Claude
//! Code's verification nudge, the `calling-a-tool` loop in `agents.md`-style
//! harnesses, this project's own rule that "done" means exercised): a model will
//! report success after an edit it never compiled. The kernel cannot compile
//! anything — the host runs the tools — but it *can* count: "you changed three
//! files and have not run a check since". That count is enough to send the model
//! back once, and one nudge per turn is the whole mechanism.
//!
//! The heuristic is honest about being one: a `Bash` call counts as a check only
//! when its command contains a marker the team wrote down (`test`, `cargo`, `lint`
//! …). A guard that guessed more would either nag on every turn or never fire.

use serde_json::Value;

/// Tools whose calls change state on disk. The kernel knows them by name, which is
/// all the declaration set gives it.
pub const DEFAULT_MUTATING_TOOLS: [&str; 2] = ["Write", "Edit"];

/// The tool that runs checks.
pub const DEFAULT_CHECK_TOOL: &str = "Bash";

/// A command counts as a check when it contains one of these fragments.
pub const DEFAULT_CHECK_MARKERS: [&str; 6] =
    ["test", "cargo", "lint", "typecheck", "check", "make"];

/// What the model is told when it tries to finish unverified.
pub const VERIFICATION_NUDGE: &str = "\
Before you report this as done: you changed files and have not run a check since. \
Run the project's verification command (tests, build, lint — whichever proves the change), \
then either fix what it reports or say plainly that it fails and why. \
If no check exists for this change, say so in one line and finish.";

#[derive(Debug, Clone)]
pub struct CompletionPolicy {
    pub enabled: bool,
    pub mutating_tools: Vec<String>,
    pub check_tool: String,
    pub check_markers: Vec<String>,
}

impl Default for CompletionPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            mutating_tools: DEFAULT_MUTATING_TOOLS
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            check_tool: DEFAULT_CHECK_TOOL.to_string(),
            check_markers: DEFAULT_CHECK_MARKERS
                .iter()
                .map(|marker| (*marker).to_string())
                .collect(),
        }
    }
}

impl CompletionPolicy {
    /// A policy that never nudges, for a session whose "done" is a person's call.
    pub fn off() -> Self {
        Self {
            enabled: false,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateVerdict {
    Allow,
    /// Send the model back with [`VERIFICATION_NUDGE`].
    Nudge {
        reason: String,
    },
}

impl GateVerdict {
    pub fn is_nudge(&self) -> bool {
        matches!(self, Self::Nudge { .. })
    }
}

/// Counts the turn's calls and answers whether "done" is credible.
#[derive(Debug, Clone, Default)]
pub struct CompletionTracker {
    mutations: usize,
    checks_since_last_mutation: usize,
    total_checks: usize,
    nudged: bool,
}

impl CompletionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold in one tool call the turn made.
    pub fn record(&mut self, tool_name: &str, arguments: &Value, policy: &CompletionPolicy) {
        if policy.mutating_tools.iter().any(|name| name == tool_name) {
            self.mutations += 1;
            self.checks_since_last_mutation = 0;
            return;
        }
        if tool_name != policy.check_tool {
            return;
        }
        let command = arguments
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let is_check = policy
            .check_markers
            .iter()
            .any(|marker| !marker.is_empty() && command.contains(marker.as_str()));
        if is_check {
            self.checks_since_last_mutation += 1;
            self.total_checks += 1;
        }
    }

    pub fn mutations(&self) -> usize {
        self.mutations
    }

    pub fn checks(&self) -> usize {
        self.total_checks
    }

    pub fn was_nudged(&self) -> bool {
        self.nudged
    }

    pub fn mark_nudged(&mut self) {
        self.nudged = true;
    }

    /// Whether the turn may finish.
    ///
    /// Nothing changed → nothing to verify. Already nudged → the next answer is
    /// final whatever it says: a gate that can loop is a gate that never ends.
    pub fn verdict(&self, policy: &CompletionPolicy) -> GateVerdict {
        if !policy.enabled
            || self.mutations == 0
            || self.checks_since_last_mutation > 0
            || self.nudged
        {
            return GateVerdict::Allow;
        }
        GateVerdict::Nudge {
            reason: format!(
                "{} file-changing call(s) since the last check: run the verification command before reporting the work as done",
                self.mutations
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record_all(
        tracker: &mut CompletionTracker,
        calls: &[(&str, Value)],
        policy: &CompletionPolicy,
    ) {
        for (name, arguments) in calls {
            tracker.record(name, arguments, policy);
        }
    }

    #[test]
    fn an_edit_without_a_check_is_nudged_once() {
        let policy = CompletionPolicy::default();
        let mut tracker = CompletionTracker::new();
        record_all(
            &mut tracker,
            &[
                ("Read", json!({"path": "a.rs"})),
                ("Edit", json!({"path": "a.rs"})),
            ],
            &policy,
        );
        match tracker.verdict(&policy) {
            GateVerdict::Nudge { reason } => assert!(reason.contains("1 file-changing")),
            other => panic!("expected a nudge, got {other:?}"),
        }
        // One nudge per turn: a second verdict allows the finish.
        tracker.mark_nudged();
        assert_eq!(tracker.verdict(&policy), GateVerdict::Allow);
    }

    #[test]
    fn a_check_after_the_last_edit_allows_the_finish() {
        let policy = CompletionPolicy::default();
        let mut tracker = CompletionTracker::new();
        record_all(
            &mut tracker,
            &[
                ("Edit", json!({"path": "a.rs"})),
                ("Bash", json!({"command": "cargo test -p agent-core"})),
            ],
            &policy,
        );
        assert_eq!(tracker.verdict(&policy), GateVerdict::Allow);
        assert_eq!(tracker.checks(), 1);
    }

    #[test]
    fn an_edit_after_the_check_reopens_the_gate() {
        let policy = CompletionPolicy::default();
        let mut tracker = CompletionTracker::new();
        record_all(
            &mut tracker,
            &[
                ("Edit", json!({"path": "a.rs"})),
                ("Bash", json!({"command": "cargo test"})),
                ("Edit", json!({"path": "b.rs"})),
            ],
            &policy,
        );
        assert!(tracker.verdict(&policy).is_nudge());
        assert_eq!(tracker.mutations(), 2);
    }

    #[test]
    fn a_shell_call_that_is_not_a_check_does_not_count() {
        let policy = CompletionPolicy::default();
        let mut tracker = CompletionTracker::new();
        record_all(
            &mut tracker,
            &[
                ("Edit", json!({"path": "a.rs"})),
                ("Bash", json!({"command": "ls -la"})),
            ],
            &policy,
        );
        assert!(tracker.verdict(&policy).is_nudge());
        assert_eq!(tracker.checks(), 0);
    }

    #[test]
    fn a_read_only_turn_has_nothing_to_verify() {
        let policy = CompletionPolicy::default();
        let mut tracker = CompletionTracker::new();
        record_all(&mut tracker, &[("Read", json!({"path": "a.rs"}))], &policy);
        assert_eq!(tracker.verdict(&policy), GateVerdict::Allow);
        assert_eq!(tracker.mutations(), 0);
    }

    #[test]
    fn the_policy_can_be_switched_off() {
        let policy = CompletionPolicy::off();
        let mut tracker = CompletionTracker::new();
        record_all(&mut tracker, &[("Edit", json!({"path": "a.rs"}))], &policy);
        assert_eq!(tracker.verdict(&policy), GateVerdict::Allow);
    }
}
