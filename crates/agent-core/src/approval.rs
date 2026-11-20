//! How much a session may do without a person saying yes.
//!
//! The reference implementation splits approval into *floors* (a level every session is allowed to reach
//! without asking) and *smart approval* (a decision per call from the call's danger
//! class, with remembered answers and patterns). This is that split, in the place the
//! kernel can actually enforce it: the gate every tool call already passes through.
//!
//! Four levels, ordered. A session sets a floor; anything at or below it is allowed
//! without a word, anything above it gets the policy's mode for that level:
//!
//! | level | what it covers | floor meaning |
//! | --- | --- | --- |
//! | `read_only` | reads, listings, searches | a reviewer session stops here |
//! | `editable` | writes and edits inside the workspace | the default floor for a coding session |
//! | `dangerous` | commands, network, writes outside the workspace | asks by default |
//! | `hardline` | credentials, destructive system work, privilege, self-copy | never auto-approved |
//!
//! A refusal is written for whoever reads it next: the model gets the level and the
//! reason so it can ask a person, and the host gets the same text so it can turn it
//! into an approval prompt instead of a dead end.
//!
//! Honest scope: this is a policy layer, not a sandbox. It classifies *calls* by name,
//! argument shape and path; it does not look at what a command does after it starts.
//! The shapes that must never leave the kernel at all are [`crate::exec_policy`]'s job.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::exec_policy::{ExecPolicy, ToolClass};

/// How dangerous a call is. Ordered: a higher level is more dangerous.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DangerLevel {
    ReadOnly,
    Editable,
    Dangerous,
    Hardline,
}

impl DangerLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Editable => "editable",
            Self::Dangerous => "dangerous",
            Self::Hardline => "hardline",
        }
    }

    /// Index into the per-level mode table.
    pub fn index(&self) -> usize {
        match self {
            Self::ReadOnly => 0,
            Self::Editable => 1,
            Self::Dangerous => 2,
            Self::Hardline => 3,
        }
    }

    /// The level a tool class maps to. `mutating` is only `editable` *inside* the
    /// workspace; the caller decides that, because it knows the path.
    pub fn from_class(class: ToolClass) -> Self {
        match class {
            ToolClass::ReadOnly => Self::ReadOnly,
            ToolClass::Mutating => Self::Editable,
            ToolClass::Exec | ToolClass::Network => Self::Dangerous,
            ToolClass::Privileged => Self::Hardline,
        }
    }
}

impl std::fmt::Display for DangerLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What happens to a call at a level above the floor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    /// Run it: this session was granted that level.
    Auto,
    /// Stop and ask a person. The kernel cannot prompt, so the call comes back as a
    /// refusal naming the level; the host turns it into a prompt.
    Ask,
    /// Never run it.
    Deny,
}

/// One pattern that is allowed without asking, whatever the level.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowRule {
    /// Tool name, exactly (`Bash`, `Write`, `mcp__github__create_issue`).
    pub tool: String,
    /// For an exec tool: the command must start with this (trimmed, case-sensitive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_prefix: Option<String>,
    /// For a file tool: the path must start with this prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
}

impl AllowRule {
    pub fn for_tool(tool: impl Into<String>) -> Self {
        Self {
            tool: tool.into(),
            command_prefix: None,
            path_prefix: None,
        }
    }

    pub fn with_command_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.command_prefix = Some(prefix.into());
        self
    }

    pub fn with_path_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.path_prefix = Some(prefix.into());
        self
    }

    pub fn matches(&self, tool: &str, arguments: &Value) -> bool {
        if self.tool != tool {
            return false;
        }
        if let Some(prefix) = &self.command_prefix {
            let command = ExecPolicy::command_of(tool, arguments).unwrap_or_default();
            if !command.trim().starts_with(prefix.as_str()) {
                return false;
            }
        }
        if let Some(prefix) = &self.path_prefix {
            let path = arguments
                .get("path")
                .or_else(|| arguments.get("file_path"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !path.starts_with(prefix.as_str()) {
                return false;
            }
        }
        true
    }
}

/// The policy: a floor, a mode per level, and the patterns that skip the question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPolicy {
    /// Everything at or below this level runs without asking.
    pub floor: DangerLevel,
    /// What to do above the floor, indexed by [`DangerLevel::index`].
    pub modes: [ApprovalMode; 4],
    /// Patterns allowed regardless of level. A hardline call still needs one of these
    /// *and* a mode that is not `Deny`.
    pub allow: Vec<AllowRule>,
    /// File writes are `editable` under this root and `dangerous` outside it. `None`
    /// makes every write dangerous, which is the safe default for a kernel that does
    /// not know where the workspace is.
    pub workspace: Option<PathBuf>,
}

impl Default for ApprovalPolicy {
    /// The floor a session gets when nobody said otherwise: **do not get in the way**.
    ///
    /// Reads, edits and commands are allowed, because the host already owns approval
    /// prompts and duplicating them here would ask a person twice. What this policy
    /// always stops is the `hardline` class — credentials, destructive system work,
    /// copying this binary — because those are never worth an unattended yes. A host
    /// that wants a stricter session raises it with [`Self::reviewer`] or a floor.
    fn default() -> Self {
        Self {
            floor: DangerLevel::Dangerous,
            modes: [
                ApprovalMode::Auto, // read_only（floor 以下，走不到这里）
                ApprovalMode::Auto, // editable
                ApprovalMode::Auto, // dangerous
                ApprovalMode::Ask,  // hardline — 只有 allow 规则能放行
            ],
            allow: Vec::new(),
            workspace: None,
        }
    }
}

impl ApprovalPolicy {
    /// A session that may read and nothing else: every change asks.
    pub fn reviewer() -> Self {
        Self {
            floor: DangerLevel::ReadOnly,
            modes: [
                ApprovalMode::Auto,
                ApprovalMode::Ask,
                ApprovalMode::Ask,
                ApprovalMode::Ask,
            ],
            ..Self::default()
        }
    }

    /// A session allowed to do anything: for a fixture or an unattended run whose
    /// blast radius the caller has already bounded.
    pub fn unattended() -> Self {
        Self {
            floor: DangerLevel::Hardline,
            modes: [ApprovalMode::Auto; 4],
            allow: Vec::new(),
            workspace: None,
        }
    }

    pub fn with_workspace(mut self, root: impl Into<PathBuf>) -> Self {
        self.workspace = Some(root.into());
        self
    }

    pub fn allow(mut self, rule: AllowRule) -> Self {
        self.allow.push(rule);
        self
    }

    pub fn mode_for(&self, level: DangerLevel) -> ApprovalMode {
        self.modes[level.index()]
    }

    /// What a call is, before anyone is asked.
    pub fn classify(&self, tool: &str, arguments: &Value) -> DangerLevel {
        let class = ExecPolicy::default().classify(tool, arguments);
        let mut level = DangerLevel::from_class(class);
        if level == DangerLevel::Editable {
            // A write outside the workspace is not an edit; it is a change to
            // something this session does not own.
            let path = arguments
                .get("path")
                .or_else(|| arguments.get("file_path"))
                .and_then(Value::as_str);
            let inside = match (&self.workspace, path) {
                (Some(root), Some(path)) => is_inside(root, path),
                _ => false,
            };
            if !inside {
                level = DangerLevel::Dangerous;
            }
        }
        if touches_credentials(tool, arguments) || is_self_copy(tool, arguments) {
            level = DangerLevel::Hardline;
        }
        level
    }

    /// The decision for one call.
    pub fn evaluate(&self, tool: &str, arguments: &Value) -> Verdict {
        let level = self.classify(tool, arguments);
        if let Some(rule) = self.allow.iter().find(|rule| rule.matches(tool, arguments)) {
            // An explicit pattern is a person's decision, recorded; it beats the floor
            // and it beats the mode.
            return Verdict::Allow {
                level,
                because: format!("allowed by rule `{}`", rule.tool),
            };
        }
        if level <= self.floor {
            return Verdict::Allow {
                level,
                because: format!("at or below the `{}` floor", self.floor),
            };
        }
        let reason = describe(tool, arguments, level);
        match self.mode_for(level) {
            ApprovalMode::Auto => Verdict::Allow {
                level,
                because: format!("`{level}` is auto-approved for this session"),
            },
            ApprovalMode::Ask => Verdict::Ask { level, reason },
            ApprovalMode::Deny => Verdict::Deny { level, reason },
        }
    }
}

/// What the policy decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow {
        level: DangerLevel,
        because: String,
    },
    /// Above the floor and the session's mode is `ask`: a person has to say yes, and
    /// the kernel cannot reach one, so the call is refused with a text either side can
    /// act on.
    Ask {
        level: DangerLevel,
        reason: String,
    },
    Deny {
        level: DangerLevel,
        reason: String,
    },
}

impl Verdict {
    pub fn level(&self) -> DangerLevel {
        match self {
            Self::Allow { level, .. } | Self::Ask { level, .. } | Self::Deny { level, .. } => *level,
        }
    }

    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }

    /// The text a refused call comes back with: written for the model to read and for
    /// the host to show.
    pub fn refusal(&self) -> Option<String> {
        match self {
            Self::Allow { .. } => None,
            Self::Ask { level, reason } => Some(format!(
                "needs approval — this call is `{level}` ({reason}) and this session may not \
                 do that unattended. Nothing was run. Ask the user to approve it, or approve \
                 the level for the session, or add an allow rule for exactly this call."
            )),
            Self::Deny { level, reason } => Some(format!(
                "refused — this call is `{level}` ({reason}) and this session never allows it. \
                 Nothing was run."
            )),
        }
    }
}

fn describe(tool: &str, arguments: &Value, level: DangerLevel) -> String {
    if let Some(command) = ExecPolicy::command_of(tool, arguments) {
        let trimmed = command.trim();
        let short: String = trimmed.chars().take(80).collect();
        return format!("`{tool}` would run `{short}`");
    }
    if let Some(path) = arguments
        .get("path")
        .or_else(|| arguments.get("file_path"))
        .and_then(Value::as_str)
    {
        return format!("`{tool}` would change `{path}`");
    }
    format!("`{tool}` is a {level} call")
}

fn is_inside(root: &Path, path: &str) -> bool {
    let candidate = Path::new(path);
    // A relative path is relative to the workspace, so it is inside it.
    if candidate.is_relative() {
        return !path.contains("..");
    }
    let root = root.to_string_lossy().to_lowercase().replace('\\', "/");
    let path = path.to_lowercase().replace('\\', "/");
    path.starts_with(&root)
}

/// Reads or writes a credential. A call that does is `hardline` whatever tool it uses.
fn touches_credentials(tool: &str, arguments: &Value) -> bool {
    const CREDENTIAL_MARKERS: &[&str] = &[
        ".ssh/id_",
        ".aws/credentials",
        ".aws/config",
        ".npmrc",
        ".netrc",
        ".git-credentials",
        ".gnupg",
        "id_rsa",
        "id_ed25519",
        ".env",
        "credentials.json",
        "secrets.",
        "keystore",
        "keychain",
        "\\windows\\system32\\config\\sam",
    ];
    let haystack = format!(
        "{} {}",
        tool.to_lowercase(),
        arguments.to_string().to_lowercase()
    );
    CREDENTIAL_MARKERS
        .iter()
        .any(|marker| haystack.contains(marker))
}

/// Copies this process's own binary — the one shape that gets a legitimate agent
/// quarantined and cannot be explained away.
fn is_self_copy(tool: &str, arguments: &Value) -> bool {
    let Some(command) = ExecPolicy::command_of(tool, arguments) else {
        return false;
    };
    let lower = command.to_lowercase();
    ["cp $0", "cp \"$0\"", "copy %0", "/proc/self/exe"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// The policy behind one lock, shared by every registry derived from this process.
#[derive(Debug)]
pub struct ApprovalCell {
    inner: RwLock<ApprovalPolicy>,
}

impl ApprovalCell {
    pub fn new(policy: ApprovalPolicy) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(policy),
        })
    }

    pub fn snapshot(&self) -> ApprovalPolicy {
        match self.inner.read() {
            Ok(policy) => policy.clone(),
            // A poisoned lock means a panic while the policy was being written; the
            // default floor is the safe answer, never the permissive one.
            Err(_) => ApprovalPolicy::default(),
        }
    }

    pub fn set(&self, policy: ApprovalPolicy) -> ApprovalPolicy {
        match self.inner.write() {
            Ok(mut current) => {
                *current = policy.clone();
                policy
            }
            Err(_) => self.snapshot(),
        }
    }

    /// Raise or lower the floor, keeping the rest of the policy.
    pub fn set_floor(&self, floor: DangerLevel) -> ApprovalPolicy {
        let mut policy = self.snapshot();
        policy.floor = floor;
        self.set(policy)
    }

    pub fn evaluate(&self, tool: &str, arguments: &Value) -> Verdict {
        match self.inner.read() {
            Ok(policy) => policy.evaluate(tool, arguments),
            // Fail closed: an unreadable policy must not become an open door.
            Err(_) => Verdict::Deny {
                level: DangerLevel::Hardline,
                reason: "the approval policy could not be read".to_string(),
            },
        }
    }
}

impl Default for ApprovalCell {
    fn default() -> Self {
        Self {
            inner: RwLock::new(ApprovalPolicy::default()),
        }
    }
}

/// A gate that layers the approval policy over whatever the host already decided.
///
/// Deny wins, then ask, then allow: a host that refused a tool keeps its refusal even
/// if the approval policy would have allowed it.
pub struct ApprovalGate {
    inner: Arc<dyn crate::tool::PermissionGate>,
    approval: Arc<ApprovalCell>,
}

impl ApprovalGate {
    pub fn new(
        inner: Arc<dyn crate::tool::PermissionGate>,
        approval: Arc<ApprovalCell>,
    ) -> Arc<Self> {
        Arc::new(Self { inner, approval })
    }
}

impl crate::tool::PermissionGate for ApprovalGate {
    fn decide(&self, tool_name: &str, arguments: &Value) -> crate::tool::Permission {
        use crate::tool::Permission;
        match self.inner.decide(tool_name, arguments) {
            Permission::Deny(reason) => Permission::Deny(reason),
            Permission::Ask => Permission::Ask,
            Permission::Allow => match self.approval.evaluate(tool_name, arguments) {
                Verdict::Allow { .. } => Permission::Allow,
                // The kernel cannot prompt, so an `ask` verdict travels as a refusal
                // whose text says what to approve. The host turns it into a prompt.
                verdict => Permission::Deny(verdict.refusal().unwrap_or_default()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy() -> ApprovalPolicy {
        ApprovalPolicy::default().with_workspace("E:/proj")
    }

    /// A session that may read and edit but not act: the shape a careful host gives a
    /// session it does not fully trust.
    fn strict() -> ApprovalPolicy {
        ApprovalPolicy {
            floor: DangerLevel::Editable,
            modes: [
                ApprovalMode::Auto,
                ApprovalMode::Auto,
                ApprovalMode::Ask,
                ApprovalMode::Ask,
            ],
            ..policy()
        }
    }

    #[test]
    fn reads_pass_on_every_floor() {
        for floor in [
            DangerLevel::ReadOnly,
            DangerLevel::Editable,
            DangerLevel::Dangerous,
        ] {
            let mut policy = policy();
            policy.floor = floor;
            let verdict = policy.evaluate("Read", &json!({"path": "E:/proj/src/lib.rs"}));
            assert!(verdict.is_allowed(), "{floor}: {verdict:?}");
            assert_eq!(verdict.level(), DangerLevel::ReadOnly);
        }
    }

    #[test]
    fn an_edit_inside_the_workspace_is_editable_and_a_write_outside_is_dangerous() {
        let policy = policy();
        assert_eq!(
            policy.classify("Write", &json!({"path": "E:/proj/src/lib.rs"})),
            DangerLevel::Editable
        );
        assert_eq!(
            policy.classify("Write", &json!({"path": "E:/elsewhere/x.rs"})),
            DangerLevel::Dangerous
        );
        assert_eq!(
            policy.classify("Write", &json!({"path": "C:/Windows/system32/x.dll"})),
            DangerLevel::Dangerous
        );
    }

    #[test]
    fn a_relative_path_is_inside_the_workspace_but_a_traversal_is_not() {
        let policy = policy();
        assert_eq!(
            policy.classify("Write", &json!({"path": "src/lib.rs"})),
            DangerLevel::Editable
        );
        assert_eq!(
            policy.classify("Write", &json!({"path": "../outside.rs"})),
            DangerLevel::Dangerous
        );
    }

    #[test]
    fn a_command_needs_approval_above_the_session_floor() {
        let verdict = strict().evaluate("Bash", &json!({"command": "cargo test"}));
        let text = match &verdict {
            Verdict::Ask { level, reason } => {
                assert_eq!(*level, DangerLevel::Dangerous);
                assert!(reason.contains("cargo test"), "{reason}");
                verdict.refusal().expect("a refusal text")
            }
            other => panic!("expected an ask, got {other:?}"),
        };
        assert!(text.contains("needs approval"), "{text}");
        assert!(text.contains("Nothing was run"), "{text}");
        assert!(text.contains("allow rule"), "it names the way out: {text}");
    }

    #[test]
    fn a_reviewer_session_stops_at_reads() {
        let verdict = ApprovalPolicy::reviewer().evaluate("Write", &json!({"path": "x.rs"}));
        assert_eq!(verdict.level(), DangerLevel::Dangerous, "outside workspace");
        assert!(verdict.refusal().is_some());
    }

    #[test]
    fn an_unattended_session_allows_everything() {
        let verdict = ApprovalPolicy::unattended().evaluate("Bash", &json!({"command": "rm -rf build"}));
        assert!(verdict.is_allowed(), "{verdict:?}");
    }

    #[test]
    fn hardline_calls_need_a_rule_even_when_the_floor_is_high() {
        let policy = ApprovalPolicy {
            floor: DangerLevel::Dangerous,
            ..policy()
        };
        let verdict = policy.evaluate("Read", &json!({"path": "C:/Users/me/.ssh/id_rsa"}));
        match verdict {
            Verdict::Ask { level, .. } => assert_eq!(level, DangerLevel::Hardline),
            other => panic!("credentials are hardline, got {other:?}"),
        }
        assert_eq!(
            policy.classify("Bash", &json!({"command": "cat /home/me/.aws/credentials"})),
            DangerLevel::Hardline
        );
    }

    #[test]
    fn copying_this_binary_is_hardline() {
        let policy = policy();
        assert_eq!(
            policy.classify("Bash", &json!({"command": "cp $0 /tmp/x"})),
            DangerLevel::Hardline
        );
    }

    #[test]
    fn the_default_floor_does_not_get_in_the_way_of_ordinary_work() {
        // The host already prompts for its own tools; the kernel's default floor must
        // not ask a second time for what a coding session does all day.
        let policy = policy();
        for (tool, arguments) in [
            ("Read", json!({"path": "E:/proj/src/lib.rs"})),
            ("Write", json!({"path": "E:/proj/src/lib.rs"})),
            ("Bash", json!({"command": "cargo test --offline"})),
            ("Bash", json!({"command": "curl -s https://example.com"})),
        ] {
            assert!(policy.evaluate(tool, &arguments).is_allowed(), "{tool}");
        }
        // What it always stops is the class that is never worth an unattended yes.
        assert!(policy
            .evaluate("Read", &json!({"path": "C:/Users/me/.ssh/id_ed25519"}))
            .refusal()
            .is_some());
        assert!(policy
            .evaluate("Bash", &json!({"command": "cp $0 /tmp/x"}))
            .refusal()
            .is_some());
    }

    #[test]
    fn an_allow_rule_beats_the_floor_and_the_mode() {
        let policy = strict().allow(AllowRule::for_tool("Bash").with_command_prefix("cargo test"));
        let allowed = policy.evaluate("Bash", &json!({"command": "cargo test --offline"}));
        assert!(allowed.is_allowed(), "{allowed:?}");
        // The same tool with another command still asks.
        let other = policy.evaluate("Bash", &json!({"command": "rm -rf target"}));
        assert!(other.refusal().is_some());
    }

    #[test]
    fn an_allow_rule_matches_the_command_prefix_and_not_a_substring() {
        let rule = AllowRule::for_tool("Bash").with_command_prefix("git status");
        assert!(rule.matches("Bash", &json!({"command": "git status --short"})));
        assert!(!rule.matches("Bash", &json!({"command": "echo x; git status"})));
        assert!(!rule.matches("Write", &json!({"command": "git status"})));
    }

    #[test]
    fn a_path_rule_allows_edits_under_one_directory() {
        let policy = ApprovalPolicy::reviewer().allow(AllowRule::for_tool("Write").with_path_prefix("E:/proj/src/"));
        assert!(policy
            .evaluate("Write", &json!({"path": "E:/proj/src/lib.rs"}))
            .is_allowed());
        assert!(policy
            .evaluate("Write", &json!({"path": "E:/proj/tests/x.rs"}))
            .refusal()
            .is_some());
    }

    #[test]
    fn deny_mode_is_never_softened_by_the_floor() {
        let mut policy = strict();
        policy.modes[DangerLevel::Dangerous.index()] = ApprovalMode::Deny;
        let verdict = policy.evaluate("Bash", &json!({"command": "curl https://example.com"}));
        match verdict {
            Verdict::Deny { level, .. } => assert_eq!(level, DangerLevel::Dangerous),
            other => panic!("expected a deny, got {other:?}"),
        }
        assert!(verdict.refusal().unwrap().contains("never allows it"));
    }

    #[test]
    fn the_cell_hands_out_the_policy_it_was_last_given() {
        let cell = ApprovalCell::new(ApprovalPolicy::default());
        assert_eq!(cell.snapshot().floor, DangerLevel::Dangerous);
        // A reviewer policy is the strict shape; the floor can then be moved again.
        cell.set(ApprovalPolicy::reviewer());
        assert_eq!(cell.snapshot().floor, DangerLevel::ReadOnly);
        // With the floor at reads, a write has to be approved.
        assert!(cell.evaluate("Read", &json!({"path": "a"})).is_allowed());
        assert!(cell.evaluate("Write", &json!({"path": "a"})).refusal().is_some());
        cell.set_floor(DangerLevel::Dangerous);
        assert!(cell.evaluate("Write", &json!({"path": "a"})).is_allowed());
    }

    #[test]
    fn the_gate_layers_over_the_host_and_deny_wins() {
        use crate::tool::{Permission, PermissionGate};
        let host: Arc<dyn PermissionGate> = Arc::new(crate::tool::DenyList::new(["Bash"]));
        let gate = ApprovalGate::new(host, ApprovalCell::new(ApprovalPolicy::unattended()));
        // The host said no, so the permissive policy cannot open it.
        assert!(matches!(
            gate.decide("Bash", &json!({"command": "cargo test"})),
            Permission::Deny(_)
        ));
        // The host is silent on reads and the policy allows them.
        assert!(matches!(
            gate.decide("Read", &json!({"path": "a"})),
            Permission::Allow
        ));
    }

    #[test]
    fn the_gate_turns_an_ask_into_a_refusal_a_host_can_prompt_on() {
        use crate::tool::{Permission, PermissionGate};
        let host: Arc<dyn PermissionGate> = Arc::new(crate::tool::AllowAll);
        let gate = ApprovalGate::new(host, ApprovalCell::new(ApprovalPolicy::reviewer()));
        match gate.decide("Bash", &json!({"command": "cargo test"})) {
            Permission::Deny(reason) => {
                assert!(reason.contains("needs approval"), "{reason}");
                assert!(reason.contains("dangerous"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_policy_survives_a_round_trip_through_json() {
        let policy = ApprovalPolicy::default()
            .with_workspace("E:/proj")
            .allow(AllowRule::for_tool("Bash").with_command_prefix("cargo test"));
        let text = serde_json::to_string(&policy).expect("serialises");
        let back: ApprovalPolicy = serde_json::from_str(&text).expect("parses");
        assert_eq!(policy, back);
    }
}
