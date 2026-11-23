//! Two-tier tool declarations: a core set sent with every request, and the rest
//! activated on demand.
//!
//! Upstream counterpart: `packages/agent-runtime/src/fixed-tool-declarations.ts`
//! (`toolDeclarationPolicy`, `TOOL_ACTIVATION_SECTION`, `toolActivationSection`)
//! plus the `ToolSearch` tool and `deferredToolNames` / `activeDeferredToolNames`
//! handling in `packages/agent-runtime/src/runtime.ts`.
//!
//! Why it exists: every request re-sends the whole declaration set, so a fixed
//! cost paid before the model has read a word of the conversation. The kernel's
//! 25 built-in declarations cost 1 940 tokens on every request, and most of that
//! is a handful of tools with large nested schemas (`OfficeWrite`, the four
//! `ScheduledTask*` tools) that most sessions never call. The Node runtime made
//! the same observation and split its catalog the same way:
//!
//! - **core**: the tools a session reaches for constantly. Declared always —
//!   a capability the model has to go looking for is one it will not use.
//! - **everything else**: listed by name in the system prompt's
//!   [`TOOL_ACTIVATION_SECTION`] and declared only once the model activates them
//!   with [`TOOL_SEARCH_NAME`] (`ToolSearch`).
//!
//! Two rules come across verbatim:
//!
//! 1. A declaration is not activation. A tool the model calls without
//!    activating first is refused with a result that says which call to make —
//!    the mode's permission ceiling is untouched by activation.
//! 2. Activation is sticky for the session (Node #1225). A set that resets on
//!    every prompt leaves the model calling tools that are no longer declared.
//!
//! Deliberately not ported, with the reason:
//!
//! - `toolDeclarationPolicy`'s "declare the whole catalog up front" branch and
//!   its `tool-count` / `context-budget` fallbacks. That branch exists because
//!   DeepSeek's verified route accepts no mid-conversation tool deltas, so Node
//!   buys cache stability by declaring everything and falling back to on-demand
//!   only when it cannot fit. The kernel's provider contract carries no such
//!   capability flag, and the whole point of this module is the on-demand path,
//!   so that is the path implemented. The policy's snapshot key survives as
//!   [`ToolActivation::key`] — FNV-1a rather than SHA-256, because 16 hex
//!   characters distinguish two catalogs just as well as 64 and cost six tokens
//!   instead of one hundred.
//! - `restoredToolActivation` / `syncToolActivation`, which replay activation
//!   from per-message system sections. `Message` has no sections in this kernel:
//!   activation lives in the session (rule 2 above), and the prompt section
//!   records the catalog snapshot and the active names on every request, so a
//!   journaled prompt still says what was declared.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::error::Result;
use crate::message::ToolCall;
use crate::prompt::SessionMode;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// The tool that turns an on-demand name into a declaration.
pub const TOOL_SEARCH_NAME: &str = "ToolSearch";

/// Name of the prompt section that lists the on-demand catalog and records what
/// is active. Node's constant of the same name, same meaning.
pub const TOOL_ACTIVATION_SECTION: &str = "tool_activation";

/// Tools an Agent-mode session always declares.
///
/// The evidence is Node's `AGENT_CORE_TOOL_NAMES` (`runtime.ts:861`) with this
/// kernel's own names substituted for its tools: the inspection pair and the
/// writers (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`), asking the user
/// (`asktool`), the skill library (`Skill`, `skill_manage`), durable memory
/// (`memory`), and the delegation lifecycle (`Task`, `TaskWait`, `TaskList`,
/// `TaskStop`).
///
/// Node's reason for each is recorded there and applies unchanged: `Write` and
/// `Edit` are what an implementation turn is *for*; the two writers are core
/// because a measured session reached memory only after spending a `ToolSearch`
/// and never reached `skill_manage` at all; the delegation lifecycle is core
/// because delegation is worth the extra schemas.
///
/// `TodoWrite` is the one deliberate departure: Node defers it, but this
/// kernel's Agent-mode instructions (`prompt/modes.rs`, copied verbatim from
/// Node's own mode prompt) tell every multi-step turn to keep the session
/// checklist current. A tool the prompt orders the model to use on the first
/// turn cannot sit behind an activation round trip — that is the same
/// "a capability the model has to go looking for is one it will not use" rule
/// Node applied to `memory` and `skill_manage`, and it costs 117 tokens.
pub const AGENT_CORE_TOOL_NAMES: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    crate::ask::ASK_TOOL_NAME,
    crate::skills::SKILL_TOOL_NAME,
    crate::skill_manage::SKILL_MANAGE_TOOL_NAME,
    crate::memory::MEMORY_TOOL_NAME,
    crate::delegate::TASK_TOOL_NAME,
    crate::delegate::TASK_WAIT_TOOL_NAME,
    crate::delegate::TASK_LIST_TOOL_NAME,
    crate::delegate::TASK_STOP_TOOL_NAME,
    crate::plan::TODO_TOOL_NAME,
];

/// Tools a contract mode (Plan, Goal, or an unknown read-only mode) always
/// declares.
///
/// Node's `CONTRACT_CORE_TOOL_NAMES` (`runtime.ts:860`: `Read`, `Glob`, `Grep`,
/// `Bash`, `BrowserPreview`, `Ask`), plus `SubmitPlan`: a Plan turn's whole
/// purpose is to hand a plan over, and Node keeps its submit tool in the core
/// set for that reason (`runtime.ts:5283`).
///
/// `AstSearch`, `OfficeRead` and the `Lsp*` tools are read-only and stay
/// available, but they are *deferred* here: a contract mode that has to look a
/// symbol up can spend one `ToolSearch` on it, and most plans never do.
pub const CONTRACT_CORE_TOOL_NAMES: &[&str] = &[
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "BrowserPreview",
    crate::ask::ASK_TOOL_NAME,
    crate::plan::SUBMIT_PLAN_TOOL_NAME,
];

/// Names that must stay on demand even in Agent mode, with the reason the
/// derived split cannot state.
///
/// [`deferrable_names`] would defer both web tools anyway — neither is core — so
/// what this constant records is *why* that must not change. `WebSearch` spends a
/// third party's quota and `WebExtract` fetches a host the model picked; in the
/// core set they would be re-sent on every request of every session, and a model
/// that has a search declared up front reaches for it on turns that never needed
/// one. On demand, the cost is paid by the turn that actually searches.
pub const ON_DEMAND_ONLY_TOOL_NAMES: &[&str] = &["WebSearch", "WebExtract"];

/// The always-declared names for `mode`.
pub fn core_tool_names(mode: &SessionMode) -> &'static [&'static str] {
    match mode {
        SessionMode::Agent => AGENT_CORE_TOOL_NAMES,
        _ => CONTRACT_CORE_TOOL_NAMES,
    }
}

/// The names this kernel declares and is willing to leave on demand: the
/// built-in declarations for `mode`.
///
/// Deliberately *not* every name in the catalog. A host tool that is declared
/// with `tools` (a plugin action, an MCP server's tool) is the host's contract
/// with main, and deferring it would break the composer's tool selection and the
/// permission card the user is shown; a kernel tool outside this list is core by
/// definition. What is left is exactly what this module owns and can measure.
pub fn deferrable_names(mode: &SessionMode) -> Vec<String> {
    crate::builtin_tools::declarations(mode.clone(), None)
        .iter()
        .filter_map(|declaration| declaration["name"].as_str().map(str::to_string))
        .collect()
}

/// The declaration of [`TOOL_SEARCH_NAME`].
///
/// Worded from the Node tool (`runtime.ts:5361`) with one change: it says what
/// activation is *not*. A model that believes a visible schema is permission
/// calls the tool and reads a refusal it could have avoided.
pub fn tool_search_spec() -> ToolSpec {
    ToolSpec::new(
        TOOL_SEARCH_NAME,
        "Find and activate an on-demand tool by exact name or widget. Use this before calling an inactive tool listed under On-demand tools, even when its schema is already visible. Activation does not bypass approval or mode restrictions.",
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Exact tool name or a short widget description, for example `BrowserPreview` or `validate plugin`."
                }
            },
            "required": ["query"]
        }),
    )
}

/// The session's activation state: which catalog this was built from, what is
/// always declared, and what the model has switched on.
///
/// `active` is shared with the session rather than owned here, because a
/// `ToolSearch` call arrives through the registry on a later step of the same
/// turn — the object that executes it and the object that builds the next
/// request have to be looking at the same set.
pub struct ToolActivation {
    core: Vec<ToolSpec>,
    deferred: Vec<ToolSpec>,
    active: Arc<Mutex<BTreeSet<String>>>,
    /// The catalog snapshot these names belong to. Node's `toolDeclarationPolicy`
    /// key: activation recorded against a different catalog names tools that may
    /// no longer exist.
    key: String,
}

impl ToolActivation {
    /// Split a catalog into core and on-demand, for `mode`.
    ///
    /// Node's rule is "not core ⇒ deferred" over its whole catalog, because that
    /// runtime owns every tool in it. This kernel does not: main declares plugin
    /// and MCP tools of its own, and hiding one of those would change what the
    /// renderer's permission cards, the composer's tool selection and host-core's
    /// own refusals are talking about. So only a tool **this kernel declares**
    /// (see [`deferrable_names`]) can be deferred; anything the host declared is
    /// always declared, and so is a core name.
    ///
    /// [`TOOL_SEARCH_NAME`] itself is neither: it is declared by this module
    /// exactly when something is deferred.
    pub fn new(
        mode: &SessionMode,
        specs: Vec<ToolSpec>,
        active: Arc<Mutex<BTreeSet<String>>>,
    ) -> Self {
        let core_names = core_tool_names(mode);
        let deferrable = deferrable_names(mode);
        let mut core = Vec::new();
        let mut deferred = Vec::new();
        for spec in specs {
            if spec.name == TOOL_SEARCH_NAME {
                continue;
            }
            let deferred_here = deferrable.iter().any(|name| name == &spec.name)
                && !core_names.contains(&spec.name.as_str());
            if deferred_here {
                deferred.push(spec);
            } else {
                core.push(spec);
            }
        }
        core.sort_by(|left, right| left.name.cmp(&right.name));
        deferred.sort_by(|left, right| left.name.cmp(&right.name));
        let key = snapshot_key(mode, &core, &deferred);
        Self {
            core,
            deferred,
            active,
            key,
        }
    }

    /// A fresh activation state for a new session.
    pub fn empty_active() -> Arc<Mutex<BTreeSet<String>>> {
        Arc::new(Mutex::new(BTreeSet::new()))
    }

    /// The catalog snapshot. Stable for one catalog, different for another.
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn core_specs(&self) -> &[ToolSpec] {
        &self.core
    }

    pub fn deferred_specs(&self) -> &[ToolSpec] {
        &self.deferred
    }

    pub fn deferred_names(&self) -> Vec<String> {
        self.deferred
            .iter()
            .map(|spec| spec.name.clone())
            .collect()
    }

    pub fn core_names(&self) -> Vec<String> {
        self.core.iter().map(|spec| spec.name.clone()).collect()
    }

    /// What is on demand *and* switched on, filtered to names still in the
    /// catalog: activation cannot outlive the tool it names.
    pub fn active_names(&self) -> Vec<String> {
        let active = match self.active.lock() {
            Ok(active) => active.clone(),
            Err(_) => return Vec::new(),
        };
        self.deferred
            .iter()
            .filter(|spec| active.contains(&spec.name))
            .map(|spec| spec.name.clone())
            .collect()
    }

    /// The declarations one request carries: core, the activated on-demand
    /// tools, and `ToolSearch` when anything is deferred.
    pub fn declared(&self) -> Vec<ToolSpec> {
        let active = self.active_names();
        let mut declared = self.core.clone();
        declared.extend(
            self.deferred
                .iter()
                .filter(|spec| active.iter().any(|name| name == &spec.name))
                .cloned(),
        );
        if !self.deferred.is_empty() {
            declared.push(tool_search_spec());
        }
        declared
    }

    /// Whether a call to `name` must be refused until it is activated.
    ///
    /// A declaration is not activation (Node `runtime.ts:3241`): the tool stays
    /// in the catalog — it can run — but the model was told to activate it first,
    /// and a call that silently works teaches it that the instruction is noise.
    pub fn blocks(&self, name: &str) -> bool {
        if !self.deferred.iter().any(|spec| spec.name == name) {
            return false;
        }
        !self.active_names().iter().any(|active| active == name)
    }

    /// The refusal text for a blocked call.
    pub fn refusal(name: &str) -> String {
        format!(
            "Call {TOOL_SEARCH_NAME} to activate {name} before using it. A tool declaration does not grant execution permission."
        )
    }

    /// The names a `ToolSearch` query resolves to, best match first.
    ///
    /// Ported from `findDeferredTools` (`runtime.ts:7110`): an exact name wins,
    /// a name that contains the query beats a description match, and at most four
    /// names come back so one call cannot declare half the catalog.
    pub fn resolve(&self, query: &str) -> Vec<String> {
        let normalized = query.trim().to_lowercase();
        if normalized.is_empty() {
            return Vec::new();
        }
        let terms: Vec<&str> = normalized
            .split([' ', ',', ';', '|', '/'])
            .filter(|term| !term.is_empty())
            .collect();
        let mut scored: Vec<(String, i64)> = self
            .deferred
            .iter()
            .filter_map(|spec| {
                let name = spec.name.to_lowercase();
                let description = spec.description.to_lowercase();
                let mut score = 0;
                if name == normalized {
                    score += 10_000;
                } else if name.contains(&normalized) {
                    score += 2_000;
                }
                for term in &terms {
                    if name.contains(term) {
                        score += 300;
                    }
                    if description.contains(term) {
                        score += 25;
                    }
                }
                (score > 0).then(|| (spec.name.clone(), score))
            })
            .collect();
        scored.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        scored
            .into_iter()
            .take(4)
            .map(|(name, _)| name)
            .collect()
    }

    /// Switch `names` on, returning the ones that were not active yet.
    pub fn activate(&self, names: &[String]) -> Vec<String> {
        let Ok(mut active) = self.active.lock() else {
            // A poisoned lock is a bug elsewhere; failing closed means the model
            // is told nothing was activated, which it can retry.
            return Vec::new();
        };
        let mut activated = Vec::new();
        for name in names {
            if self.deferred.iter().any(|spec| &spec.name == name) && active.insert(name.clone()) {
                activated.push(name.clone());
            }
        }
        activated
    }

    /// The system-prompt section listing what is on demand.
    ///
    /// Upstream counterpart: `optionalToolsPrompt` (`runtime.ts:5315`) plus
    /// `toolActivationSection` (`fixed-tool-declarations.ts:46`). `None` when
    /// nothing is deferred: a session with nothing on demand pays nothing for
    /// saying so.
    pub fn activation_section(&self) -> Option<String> {
        if self.deferred.is_empty() {
            return None;
        }
        let mut lines = vec![
            "# On-demand tools".to_string(),
            // One sentence: this block is re-sent with every request, and the
            // names below already say what each tool is for.
            format!(
                "Call {TOOL_SEARCH_NAME} with an exact name or a short description to activate one before using it; a visible schema is not activation."
            ),
        ];
        for spec in &self.deferred {
            lines.push(format!("- {}: {}", spec.name, spec.description));
        }
        let active = self.active_names();
        lines.push(format!(
            "Active on-demand tools: {} (catalog {})",
            if active.is_empty() {
                "none".to_string()
            } else {
                active.join(", ")
            },
            self.key
        ));
        Some(lines.join("\n"))
    }
}

/// A short, stable identifier for one catalog.
///
/// FNV-1a over the sorted declaration set plus the mode: deterministic across
/// runs and platforms, which is what a journaled prompt needs. Node hashes the
/// same material with SHA-256 (`fixed-tool-declarations.ts:26`); a 64-character
/// digest buys nothing here, because this key only has to distinguish catalogs.
fn snapshot_key(mode: &SessionMode, core: &[ToolSpec], deferred: &[ToolSpec]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |text: &str| {
        for byte in text.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    feed(mode.wire_name());
    for spec in core.iter().chain(deferred) {
        feed(&spec.name);
        feed("\u{1}");
        feed(&spec.description);
        feed("\u{2}");
    }
    format!("{hash:016x}")
}

/// `ToolSearch`: the tool that activates an on-demand tool.
pub struct ToolSearchTool {
    activation: Arc<ToolActivation>,
}

impl ToolSearchTool {
    pub fn new(activation: Arc<ToolActivation>) -> Self {
        Self { activation }
    }
}

impl Tool for ToolSearchTool {
    fn spec(&self) -> ToolSpec {
        tool_search_spec()
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let query = call
                .arguments
                .get("query")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let matches = self.activation.resolve(&query);
            let activated = self.activation.activate(&matches);
            let available = self.activation.deferred_names();
            let preview: Vec<&str> = available.iter().take(24).map(String::as_str).collect();
            let remaining = available.len() - preview.len();
            Ok(if !activated.is_empty() {
                format!(
                    "Activated on-demand tools: {}. They are available on the next model turn.",
                    activated.join(", ")
                )
            } else if !matches.is_empty() {
                format!("These tools are already active: {}.", matches.join(", "))
            } else {
                format!(
                    "No matching on-demand tool. Available names: {}{}",
                    preview.join(", "),
                    if remaining > 0 {
                        format!(", and {remaining} more")
                    } else {
                        String::new()
                    }
                )
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin_tools;

    fn shell() -> builtin_tools::ShellIdentity {
        builtin_tools::ShellIdentity::new("git-bash", Some("posix".into()))
    }

    fn activation(mode: SessionMode) -> Arc<ToolActivation> {
        let specs: Vec<ToolSpec> = builtin_tools::declarations(mode.clone(), Some(&shell()))
            .iter()
            .map(|value| crate::host_bridge::tool_spec_from_value(value).expect("a declaration"))
            .collect();
        Arc::new(ToolActivation::new(
            &mode,
            specs,
            ToolActivation::empty_active(),
        ))
    }

    fn names(specs: &[ToolSpec]) -> Vec<String> {
        specs.iter().map(|spec| spec.name.clone()).collect()
    }

    /// The core set is a token budget, so a name that silently joins it is a
    /// regression. Every entry has to be a tool this kernel can actually declare.
    #[test]
    fn every_core_name_is_a_tool_the_kernel_declares_or_ships() {
        let known: Vec<&str> = [
            AGENT_CORE_TOOL_NAMES,
            CONTRACT_CORE_TOOL_NAMES,
            &[crate::plan::TODO_TOOL_NAME, crate::skills::SKILL_TOOL_NAME],
        ]
        .concat();
        for name in known {
            assert!(
                builtin_tools::declarations(SessionMode::Agent, Some(&shell()))
                    .iter()
                    .any(|tool| tool["name"] == *name)
                    || [
                        crate::ask::ASK_TOOL_NAME,
                        crate::memory::MEMORY_TOOL_NAME,
                        crate::skill_manage::SKILL_MANAGE_TOOL_NAME,
                        crate::delegate::TASK_TOOL_NAME,
                        crate::delegate::TASK_WAIT_TOOL_NAME,
                        crate::delegate::TASK_LIST_TOOL_NAME,
                        crate::delegate::TASK_STOP_TOOL_NAME,
                        crate::plan::SUBMIT_PLAN_TOOL_NAME,
                        "Skill",
                    ]
                    .contains(&name),
                "`{name}` is named as core but no module declares it"
            );
        }
    }

    /// Agent mode: the twelve-declaration core, and the rest on demand.
    #[test]
    fn agent_mode_declares_only_its_core_until_something_is_activated() {
        let activation = activation(SessionMode::Agent);
        let declared = names(&activation.declared());
        for core in ["Read", "Glob", "Grep", "Write", "Edit", "Bash"] {
            assert!(declared.contains(&core.to_string()), "{core}: {declared:?}");
        }
        // Deferred: the big schemas, and the tools a coding turn seldom needs.
        for deferred in [
            "OfficeRead",
            "OfficeWrite",
            "ScheduledTaskList",
            "BrowserExec",
            "VisionAnalyze",
            "LspDefinition",
            "AstSearch",
        ] {
            assert!(
                !declared.contains(&deferred.to_string()),
                "`{deferred}` must not be declared up front: {declared:?}"
            );
            assert!(activation.deferred_names().contains(&deferred.to_string()));
        }
        // `TodoWrite` is core despite Node deferring it: the Agent-mode
        // instructions order every multi-step turn to use it.
        assert!(declared.contains(&"TodoWrite".to_string()), "{declared:?}");
        // Exactly one extra declaration: the tool that activates the rest.
        assert_eq!(declared.len(), activation.core_specs().len() + 1);
        assert_eq!(declared.last().unwrap(), TOOL_SEARCH_NAME);
    }

    /// The bug this whole module exists to prevent, stated as a test: a contract
    /// mode never declares a writer, whatever the previous turn declared.
    #[test]
    fn a_contract_mode_declares_no_writer() {
        for mode in [SessionMode::Plan, SessionMode::Goal] {
            let activation = activation(mode.clone());
            let declared = names(&activation.declared());
            for writer in ["Write", "Edit", "ExecuteCode", "OfficeWrite", "AstEdit"] {
                assert!(
                    !declared.contains(&writer.to_string()),
                    "{mode:?}: {writer} in {declared:?}"
                );
            }
            for reader in ["Read", "Glob", "Grep", "Bash", "BrowserPreview"] {
                assert!(declared.contains(&reader.to_string()), "{mode:?}: {reader}");
            }
            // `SubmitPlan` is a contract-mode core name too, but it is one of the
            // session's own tools rather than a built-in declaration, so it only
            // appears once the sidecar has registered it (covered by
            // `tests/tool_activation.rs`).
            assert!(CONTRACT_CORE_TOOL_NAMES.contains(&"SubmitPlan"));
        }
    }

    #[test]
    fn activating_a_tool_declares_it_on_the_next_request() {
        let activation = activation(SessionMode::Agent);
        assert!(!names(&activation.declared()).contains(&"OfficeRead".to_string()));
        assert!(activation.blocks("OfficeRead"));

        let matched = activation.resolve("OfficeRead");
        assert_eq!(matched, vec!["OfficeRead".to_string()]);
        assert_eq!(activation.activate(&matched), vec!["OfficeRead".to_string()]);

        assert!(names(&activation.declared()).contains(&"OfficeRead".to_string()));
        assert!(!activation.blocks("OfficeRead"));
        // Activating twice is not an error and does not duplicate the declaration.
        assert!(activation.activate(&matched).is_empty());
        let declared = names(&activation.declared());
        assert_eq!(declared.iter().filter(|name| *name == "OfficeRead").count(), 1);
    }

    /// The web pair is reachable only through `ToolSearch`, and never from a
    /// contract mode: a plan proposes, it does not search.
    #[test]
    fn the_web_tools_are_on_demand_and_only_in_agent_mode() {
        let agent = activation(SessionMode::Agent);
        let declared = names(&agent.declared());
        for name in ON_DEMAND_ONLY_TOOL_NAMES {
            assert!(
                !AGENT_CORE_TOOL_NAMES.contains(name) && !CONTRACT_CORE_TOOL_NAMES.contains(name),
                "`{name}` must not be core: a networking tool in the core set is billed every turn"
            );
            assert!(
                agent.deferred_names().contains(&name.to_string()),
                "`{name}` is missing from the on-demand catalog"
            );
            assert!(
                !declared.contains(&name.to_string()),
                "`{name}` must not be declared before it is activated: {declared:?}"
            );
            assert!(agent.blocks(name), "`{name}` is not gated by activation");
        }

        let matched = agent.resolve("WebSearch");
        assert_eq!(matched, vec!["WebSearch".to_string()]);
        assert_eq!(agent.activate(&matched), vec!["WebSearch".to_string()]);
        assert!(names(&agent.declared()).contains(&"WebSearch".to_string()));

        let plan = activation(SessionMode::Plan);
        assert!(!plan.deferred_names().contains(&"WebSearch".to_string()));
        assert!(plan.resolve("WebSearch").is_empty());
    }

    /// Activation never reaches a tool the mode does not declare, and an unknown
    /// name is not silently swallowed.
    #[test]
    fn activation_cannot_reach_a_name_outside_the_catalog() {
        let activation = activation(SessionMode::Plan);
        assert!(activation.resolve("Write").is_empty());
        assert!(activation.activate(&["Write".to_string()]).is_empty());
        assert!(!names(&activation.declared()).contains(&"Write".to_string()));
    }

    /// A host-declared tool is not this kernel's to hide.
    ///
    /// `tools` on a prompt is main's contract: a plugin action, an MCP server's
    /// tool. Deferring one would leave the composer's selection pointing at a
    /// tool the model was never offered, so only the kernel's own built-ins can
    /// be deferred.
    #[test]
    fn a_host_declared_tool_is_always_declared() {
        let mut specs: Vec<ToolSpec> = builtin_tools::declarations(SessionMode::Agent, None)
            .iter()
            .map(|value| crate::host_bridge::tool_spec_from_value(value).expect("a declaration"))
            .collect();
        specs.push(ToolSpec::new(
            "plugin_alpha",
            "Validate a plugin.",
            json!({"type": "object"}),
        ));
        let activation = ToolActivation::new(
            &SessionMode::Agent,
            specs,
            ToolActivation::empty_active(),
        );
        assert!(names(&activation.declared()).contains(&"plugin_alpha".to_string()));
        assert!(!activation.deferred_names().contains(&"plugin_alpha".to_string()));
        assert!(!activation.blocks("plugin_alpha"));
        // The kernel's own big schemas are still deferred, so the rule did not
        // simply turn the split off.
        assert!(activation.deferred_names().contains(&"OfficeWrite".to_string()));
    }

    /// A widget description still finds its tool: the whole point of accepting a
    /// query rather than only a name.
    #[test]
    fn a_short_description_finds_the_tool() {
        let activation = activation(SessionMode::Agent);
        assert!(activation.resolve("validate plugin").contains(&"PluginCheck".to_string()));
        assert!(activation.resolve("").is_empty());
        assert!(activation.resolve("nothing matches this").is_empty());
    }

    /// The section is what tells the model the catalogue exists at all; without
    /// it, deferring a tool hides it.
    #[test]
    fn the_prompt_section_lists_the_catalog_and_the_active_set() {
        let activation = activation(SessionMode::Agent);
        let section = activation.activation_section().expect("a section");
        assert!(section.starts_with("# On-demand tools"));
        assert!(section.contains("ToolSearch"));
        assert!(section.contains("- OfficeRead:"));
        assert!(section.contains("Active on-demand tools: none"));

        activation.activate(&["OfficeRead".to_string()]);
        let section = activation.activation_section().unwrap();
        assert!(section.contains("Active on-demand tools: OfficeRead"));
        // The snapshot identifies the catalog the activation belongs to.
        assert!(section.contains(activation.key()));
    }

    /// Plan mode has few enough tools that deferring them all would be theatre —
    /// but it still has more than its core, so a section is still owed.
    #[test]
    fn a_mode_with_nothing_deferred_pays_nothing_for_the_section() {
        let activation = ToolActivation::new(
            &SessionMode::Plan,
            vec![ToolSpec::new("Read", "Read a file.", json!({"type": "object"}))],
            ToolActivation::empty_active(),
        );
        assert!(activation.activation_section().is_none());
        assert_eq!(names(&activation.declared()), vec!["Read".to_string()]);
    }

    #[test]
    fn two_catalogs_have_two_keys_and_one_catalog_has_one() {
        let calls: Vec<ToolSpec> = [tool_search_spec()].to_vec();
        let first = ToolActivation::new(
            &SessionMode::Agent,
            [calls.clone(), vec![ToolSpec::new("Read", "Read a file.", json!({}))]].concat(),
            ToolActivation::empty_active(),
        );
        let second = ToolActivation::new(
            &SessionMode::Agent,
            [calls, vec![ToolSpec::new("Read", "Read a file.", json!({}))]].concat(),
            ToolActivation::empty_active(),
        );
        assert_eq!(first.key(), second.key());
        let with_write = ToolActivation::new(
            &SessionMode::Agent,
            vec![ToolSpec::new("Write", "Write a file.", json!({}))],
            ToolActivation::empty_active(),
        );
        assert_ne!(first.key(), with_write.key());
    }

    /// The numbers this module exists to move, printed so a change to the core
    /// set has to justify itself: the whole built-in set, then what is left after
    /// the split — the core declarations, the one tool that activates the rest,
    /// and the prompt section that names them.
    #[test]
    fn the_split_costs_less_than_declaring_the_catalog() {
        let tokens = |specs: &[ToolSpec]| -> u64 {
            crate::token_report::tools_cost(specs)
                .iter()
                .map(|line| line.tokens)
                .sum()
        };
        let all: Vec<ToolSpec> = builtin_tools::declarations(SessionMode::Agent, Some(&shell()))
            .iter()
            .map(|value| crate::host_bridge::tool_spec_from_value(value).expect("a declaration"))
            .collect();
        let before = tokens(&all);
        let activation = ToolActivation::new(
            &SessionMode::Agent,
            all.clone(),
            ToolActivation::empty_active(),
        );
        let section = activation.activation_section().expect("a section");
        let section_tokens =
            (section.chars().count() as f64 / crate::context::ESTIMATED_TEXT_CHARS_PER_TOKEN).ceil()
                as u64;
        let core = tokens(activation.core_specs());
        let search = tokens(&[tool_search_spec()]);
        let after = core + search + section_tokens;
        let deferred = tokens(activation.deferred_specs());
        println!(
            "built-ins: {} tools / {before} tokens -> {} core / {core} + {TOOL_SEARCH_NAME} {search} + section {section_tokens} = {after} ({:.0}% saved); {} deferred / {deferred} tokens",
            all.len(),
            activation.core_specs().len(),
            100.0 - (after as f64 / before as f64) * 100.0,
            activation.deferred_specs().len(),
        );
        assert!(
            after < before,
            "the split has to pay for itself: {after} vs {before}"
        );
        // A tool that is neither declared nor listed is a tool the model cannot
        // find at all, so the deferred set is exactly what the section names.
        assert!(section.contains("- ScheduledTaskUpdate:"));
    }

    /// A `ToolSearch` call is answered by the kernel; it never reaches the host.
    #[tokio::test]
    async fn the_tool_search_tool_activates_and_says_so() {
        let activation = activation(SessionMode::Agent);
        let tool = ToolSearchTool::new(activation.clone());
        let context = ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "c1".into(),
            cancel: crate::cancel::CancelToken::new(),
            steering: None,
        };
        let call = ToolCall {
            id: "c1".into(),
            name: TOOL_SEARCH_NAME.into(),
            arguments: json!({"query": "OfficeRead"}),
            raw_arguments: None,
        };
        let answer = tool.call(&call, &context).await.expect("an answer");
        assert_eq!(
            answer,
            "Activated on-demand tools: OfficeRead. They are available on the next model turn."
        );
        let again = tool.call(&call, &context).await.expect("an answer");
        assert_eq!(again, "These tools are already active: OfficeRead.");

        let call = ToolCall {
            id: "c2".into(),
            name: TOOL_SEARCH_NAME.into(),
            arguments: json!({"query": "nothing matches this"}),
            raw_arguments: None,
        };
        let answer = tool.call(&call, &context).await.expect("an answer");
        assert!(answer.starts_with("No matching on-demand tool. Available names: "));
    }
}
