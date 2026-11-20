//! Tool hooks: the policy layer between the model's call and the tool that runs.
//!
//! Practice from Claude Code's hooks and from every gateway that survived real
//! traffic: an approval gate answers "may this tool run", but the questions that
//! actually prevent damage are narrower — *is this path outside the project*, *is
//! this command a `rm -rf`*, *does this write need a different argument*. A hook
//! answers those, and it can **rewrite** the arguments rather than only refusing,
//! which is what makes it useful for normalisation (a relative path made absolute,
//! a timeout clamped) as well as for denial.
//!
//! The chain is ordered and the first refusal wins: a policy that says no is not
//! overridden by a later policy that says yes.

use std::sync::Arc;

use serde_json::Value;

/// What a hook decided about one call.
#[derive(Debug, Clone, PartialEq)]
pub enum HookOutcome {
    Allow,
    /// Refuse with a sentence the model reads as the tool result.
    Deny(String),
    /// Run the tool with these arguments instead.
    Rewrite(Value),
}

pub trait ToolHook: Send + Sync {
    /// Name for logs and for the refusal message ("denied by `read_only`").
    fn name(&self) -> &str;

    fn before(&self, tool_name: &str, arguments: &Value) -> HookOutcome;
}

/// An ordered list of hooks.
#[derive(Default, Clone)]
pub struct HookChain {
    hooks: Vec<Arc<dyn ToolHook>>,
}

impl std::fmt::Debug for HookChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookChain")
            .field(
                "hooks",
                &self
                    .hooks
                    .iter()
                    .map(|hook| hook.name())
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl HookChain {
    pub fn new(hooks: Vec<Arc<dyn ToolHook>>) -> Self {
        Self { hooks }
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }

    pub fn len(&self) -> usize {
        self.hooks.len()
    }

    pub fn names(&self) -> Vec<&str> {
        self.hooks.iter().map(|hook| hook.name()).collect()
    }

    /// Run the chain once. A `Deny` short-circuits; rewrites accumulate, so a
    /// later hook sees what an earlier one produced and can still refuse it.
    pub fn decide(&self, tool_name: &str, arguments: &Value) -> HookOutcome {
        let mut effective = arguments.clone();
        let mut rewritten = false;
        for hook in &self.hooks {
            match hook.before(tool_name, &effective) {
                HookOutcome::Allow => {}
                HookOutcome::Deny(reason) => {
                    return HookOutcome::Deny(format!("denied by `{}`: {reason}", hook.name()))
                }
                HookOutcome::Rewrite(next) => {
                    effective = next;
                    rewritten = true;
                }
            }
        }
        if rewritten {
            HookOutcome::Rewrite(effective)
        } else {
            HookOutcome::Allow
        }
    }
}

/// A read-only session: writes and edits are refused, reading is not.
///
/// The check is by tool name, because that is what the declaration set gives the
/// kernel: the host owns execution, the kernel owns what the model may offer.
pub struct ReadOnlyHook {
    denied: Vec<String>,
}

impl Default for ReadOnlyHook {
    fn default() -> Self {
        Self::new(["Write", "Edit"])
    }
}

impl ReadOnlyHook {
    pub fn new<I, S>(denied: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            denied: denied.into_iter().map(Into::into).collect(),
        }
    }
}

impl ToolHook for ReadOnlyHook {
    fn name(&self) -> &str {
        "read_only"
    }

    fn before(&self, tool_name: &str, _arguments: &Value) -> HookOutcome {
        if self.denied.iter().any(|denied| denied == tool_name) {
            return HookOutcome::Deny(format!(
                "`{tool_name}` is not available in this session: propose the change instead of making it"
            ));
        }
        HookOutcome::Allow
    }
}

/// Refuse shell commands whose text contains a forbidden fragment.
///
/// Deliberately textual and blunt: a hook is a guard rail, not a sandbox, and a
/// guard rail that claims to parse shell syntax would be a lie. What it can do
/// honestly is refuse the fragments a team wrote down.
pub struct CommandGuardHook {
    forbidden: Vec<String>,
}

impl CommandGuardHook {
    pub fn new<I, S>(forbidden: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            forbidden: forbidden.into_iter().map(Into::into).collect(),
        }
    }
}

impl ToolHook for CommandGuardHook {
    fn name(&self) -> &str {
        "command_guard"
    }

    fn before(&self, tool_name: &str, arguments: &Value) -> HookOutcome {
        if tool_name != "Bash" {
            return HookOutcome::Allow;
        }
        let Some(command) = arguments.get("command").and_then(Value::as_str) else {
            return HookOutcome::Allow;
        };
        match self
            .forbidden
            .iter()
            .find(|fragment| !fragment.is_empty() && command.contains(fragment.as_str()))
        {
            Some(fragment) => HookOutcome::Deny(format!(
                "the command contains `{fragment}`, which this project forbids. Run the equivalent in a way that does not match it."
            )),
            None => HookOutcome::Allow,
        }
    }
}

/// Clamp a numeric argument into a range, rewriting only when it is outside.
pub struct ClampTimeoutHook {
    field: String,
    max: u64,
}

impl ClampTimeoutHook {
    pub fn new(field: impl Into<String>, max: u64) -> Self {
        Self {
            field: field.into(),
            max,
        }
    }
}

impl ToolHook for ClampTimeoutHook {
    fn name(&self) -> &str {
        "clamp_timeout"
    }

    fn before(&self, _tool_name: &str, arguments: &Value) -> HookOutcome {
        let Some(value) = arguments.get(&self.field).and_then(Value::as_u64) else {
            return HookOutcome::Allow;
        };
        if value <= self.max {
            return HookOutcome::Allow;
        }
        let mut rewritten = arguments.clone();
        if let Some(object) = rewritten.as_object_mut() {
            object.insert(self.field.clone(), Value::from(self.max));
        }
        HookOutcome::Rewrite(rewritten)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_read_only_session_refuses_writes_and_allows_reads() {
        let chain = HookChain::new(vec![Arc::new(ReadOnlyHook::default())]);
        assert_eq!(
            chain.decide("Read", &json!({"path": "a"})),
            HookOutcome::Allow
        );
        match chain.decide("Write", &json!({"path": "a"})) {
            HookOutcome::Deny(reason) => {
                assert!(reason.contains("read_only"), "{reason}");
                assert!(reason.contains("propose the change"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_first_refusal_wins() {
        let chain = HookChain::new(vec![
            Arc::new(CommandGuardHook::new(["rm -rf"])),
            Arc::new(ReadOnlyHook::default()),
        ]);
        let decision = chain.decide("Bash", &json!({"command": "rm -rf /"}));
        assert!(matches!(decision, HookOutcome::Deny(_)));
        assert_eq!(chain.names(), vec!["command_guard", "read_only"]);
    }

    #[test]
    fn a_guard_only_looks_at_shell_commands() {
        let chain = HookChain::new(vec![Arc::new(CommandGuardHook::new(["rm -rf"]))]);
        assert_eq!(
            chain.decide("Read", &json!({"path": "rm -rf.txt"})),
            HookOutcome::Allow
        );
        assert_eq!(
            chain.decide("Bash", &json!({"command": "cargo test"})),
            HookOutcome::Allow
        );
    }

    #[test]
    fn a_rewrite_reaches_the_next_hook_and_the_result() {
        let chain = HookChain::new(vec![Arc::new(ClampTimeoutHook::new("timeout", 30))]);
        assert_eq!(
            chain.decide("Bash", &json!({"command": "x", "timeout": 600})),
            HookOutcome::Rewrite(json!({"command": "x", "timeout": 30}))
        );
        assert_eq!(
            chain.decide("Bash", &json!({"command": "x", "timeout": 5})),
            HookOutcome::Allow
        );
    }

    #[test]
    fn a_later_hook_can_refuse_what_an_earlier_one_rewrote() {
        struct RewriteThenRefuse;
        impl ToolHook for RewriteThenRefuse {
            fn name(&self) -> &str {
                "rewrite_then_refuse"
            }
            fn before(&self, _tool_name: &str, arguments: &Value) -> HookOutcome {
                match arguments.get("timeout").and_then(Value::as_u64) {
                    Some(30) => HookOutcome::Deny("thirty is the dangerous value".into()),
                    _ => HookOutcome::Allow,
                }
            }
        }
        let chain = HookChain::new(vec![
            Arc::new(ClampTimeoutHook::new("timeout", 30)),
            Arc::new(RewriteThenRefuse),
        ]);
        match chain.decide("Bash", &json!({"timeout": 600})) {
            HookOutcome::Deny(reason) => assert!(reason.contains("rewrite_then_refuse")),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_chain_allows_everything() {
        let chain = HookChain::default();
        assert!(chain.is_empty());
        assert_eq!(chain.decide("Bash", &json!({})), HookOutcome::Allow);
    }
}
