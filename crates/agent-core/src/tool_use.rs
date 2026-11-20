//! Tool-use coordination: the patterns that decide whether a tool loop works or
//! thrashes.
//!
//! Four practices, taken from the agents that stay fast on long tasks:
//!
//! 1. **A step's calls are independent, so they run together.** The model asked for
//!    them in one message; running them one after another makes the wall clock the
//!    sum of the slowest calls instead of the slowest call. (`TurnEngine::with_parallel_tool_calls`.)
//! 2. **An identical read is not worth paying for twice.** A model that re-reads the
//!    same file three steps later usually forgot it already had the answer; the
//!    result is reused and the reuse is stated, so the model is not misled about
//!    having looked again. ([`RepeatPolicy`])
//! 3. **Big results are bounded at the boundary** (`tool::truncate_result`, the
//!    host's per-class budgets) and aged out of the request under pressure
//!    (`aging`), because tool output is the bulk of a long session's tokens.
//! 4. **A capability is offered as a catalog, not a manual** (`skills`: 60-character
//!    index, body loaded on demand), which is what keeps a large tool or skill set
//!    from costing its own description on every request.
//!
//! This module owns (2) and the helpers the loop needs for both.

use std::collections::VecDeque;

use serde_json::Value;

use crate::message::{ToolCall, ToolResult};

/// Tools whose result depends only on their arguments, so a repeat can reuse the
/// earlier answer. Writes, shells and anything the host declares are excluded: a
/// repeated `Bash` may legitimately mean "run it again".
pub const DEFAULT_REPEATABLE_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];

/// Repeats remembered per turn. Small on purpose: the useful hit is "the model
/// looked at this file a moment ago", not a session-wide cache.
pub const REPEAT_CAPACITY: usize = 32;

/// Which calls a repeated call may reuse an answer from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepeatPolicy {
    pub tools: Vec<String>,
    pub capacity: usize,
}

impl Default for RepeatPolicy {
    fn default() -> Self {
        Self {
            tools: DEFAULT_REPEATABLE_TOOLS
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            capacity: REPEAT_CAPACITY,
        }
    }
}

impl RepeatPolicy {
    /// Suppression for exactly these tools, for a host whose tool names differ.
    pub fn for_tools<I, S>(tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            tools: tools.into_iter().map(Into::into).collect(),
            capacity: REPEAT_CAPACITY,
        }
    }

    pub fn covers(&self, tool_name: &str) -> bool {
        self.tools.iter().any(|name| name == tool_name)
    }
}

/// What one turn has already answered.
#[derive(Debug, Clone)]
pub struct RepeatGuard {
    policy: RepeatPolicy,
    entries: VecDeque<(String, Value, String)>,
    hits: usize,
}

impl RepeatGuard {
    pub fn new(policy: RepeatPolicy) -> Self {
        Self {
            policy,
            entries: VecDeque::new(),
            hits: 0,
        }
    }

    pub fn policy(&self) -> &RepeatPolicy {
        &self.policy
    }

    /// How many calls were answered from the cache instead of run.
    pub fn hits(&self) -> usize {
        self.hits
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The earlier answer for this exact call, if there is one.
    pub fn previous(&self, call: &ToolCall) -> Option<&str> {
        if !self.policy.covers(&call.name) {
            return None;
        }
        self.entries
            .iter()
            .find(|(name, arguments, _)| name == &call.name && arguments == &call.arguments)
            .map(|(_, _, content)| content.as_str())
    }

    /// Remember an answer for reuse, and count the reuse that just happened.
    ///
    /// The notice goes **in front of** the content, never after it. A trailing note
    /// is indistinguishable from the end of the file to a model that is quoting what
    /// it read — one live run had a worker report "my second read returned a file
    /// with this sentence spliced into it", which is exactly the confusion a suffix
    /// causes.
    pub fn reuse(&mut self, call: &ToolCall, content: &str) -> ToolResult {
        self.hits += 1;
        ToolResult {
            call_id: call.id.clone(),
            name: call.name.clone(),
            content: format!(
                "[repeat: this `{}` call with the same arguments already ran earlier in this turn. The text below is that result, not a fresh read.]\n{content}",
                call.name
            ),
            is_error: false,
            truncated: false,
        }
    }

    /// Record a result the tool actually produced.
    pub fn remember(&mut self, call: &ToolCall, content: &str) {
        if !self.policy.covers(&call.name) {
            return;
        }
        if self
            .entries
            .iter()
            .any(|(name, arguments, _)| name == &call.name && arguments == &call.arguments)
        {
            return;
        }
        self.entries.push_back((
            call.name.clone(),
            call.arguments.clone(),
            content.to_string(),
        ));
        while self.entries.len() > self.policy.capacity {
            self.entries.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments,
            raw_arguments: None,
        }
    }

    #[test]
    fn a_repeated_read_is_answered_from_the_earlier_result() {
        let mut guard = RepeatGuard::new(RepeatPolicy::default());
        let first = call("call_1", "Read", json!({"path": "src/lib.rs"}));
        assert!(guard.previous(&first).is_none());
        guard.remember(&first, "fn main() {}");
        let again = call("call_2", "Read", json!({"path": "src/lib.rs"}));
        let cached = guard.previous(&again).expect("a cached answer").to_string();
        assert_eq!(cached, "fn main() {}");
        let result = guard.reuse(&again, &cached);
        assert!(result.content.contains("already ran earlier in this turn"));
        assert!(
            result.content.ends_with("fn main() {}"),
            "the reused text stays the result verbatim, after the notice: {}",
            result.content
        );
        assert_eq!(guard.hits(), 1);
    }

    #[test]
    fn a_different_argument_list_is_a_different_call() {
        let mut guard = RepeatGuard::new(RepeatPolicy::default());
        guard.remember(&call("c1", "Read", json!({"path": "a"})), "a");
        assert!(guard
            .previous(&call("c2", "Read", json!({"path": "b"})))
            .is_none());
    }

    #[test]
    fn a_shell_command_is_never_reused() {
        let mut guard = RepeatGuard::new(RepeatPolicy::default());
        let bash = call("c1", "Bash", json!({"command": "cargo test"}));
        guard.remember(&bash, "ok");
        assert!(
            guard.previous(&bash).is_none(),
            "a repeat may mean run it again"
        );
        assert!(guard.is_empty());
    }

    #[test]
    fn the_cache_is_bounded_and_keeps_the_newest() {
        let mut guard = RepeatGuard::new(RepeatPolicy {
            tools: vec!["Read".into()],
            capacity: 2,
        });
        for index in 0..3 {
            guard.remember(
                &call(
                    &format!("c{index}"),
                    "Read",
                    json!({"path": format!("f{index}")}),
                ),
                "x",
            );
        }
        assert_eq!(guard.len(), 2);
        assert!(guard
            .previous(&call("c0", "Read", json!({"path": "f0"})))
            .is_none());
        assert!(guard
            .previous(&call("c2", "Read", json!({"path": "f2"})))
            .is_some());
    }

    #[test]
    fn a_policy_can_be_tailored_to_a_hosts_tool_names() {
        let guard_policy = RepeatPolicy::for_tools(["read_file", "grep"]);
        assert!(guard_policy.covers("read_file"));
        assert!(!guard_policy.covers("Read"));
    }
}
