//! What one turn left behind, as the extension surface reports it.
//!
//! Upstream counterpart: the members `createExtensionBridge` answers from the
//! Node runtime's live agent state (`packages/agent-runtime/src/runtime.ts`,
//! `getContextUsage` / `getSystemPrompt` / `getActiveTools` / `getAllTools`).
//!
//! Under the Rust kernel Electron main is the JavaScript host for trusted
//! extensions, so those members have to be answered here: main cannot compose
//! the system prompt (the kernel does — `sidecar.rs`, `compose_prompt`), does
//! not know what a turn cost against the model window, and does not hold the
//! two-tier tool activation set (`tool_activation.rs`). None of the three can be
//! re-derived from a read — the composed prompt depends on the host's
//! declaration script, the project instruction files and the provider's own
//! tools, none of which are parameters of a read — so the turn records them as
//! it composes them, and a read reports the record.
//!
//! Two rules follow from the reference:
//!
//! 1. The numbers are the turn loop's own. [`context_usage`] measures the
//!    transcript with [`crate::context::estimate_context_tokens`], the same
//!    estimate compaction decides on, so a report here and a compaction
//!    decision inside the loop cannot disagree. `percent` is `null` when the
//!    budget is zero, exactly as Node's `budget.hardLimit > 0 ? … : null`.
//! 2. Absence is reported, not filled in. A session this process has not
//!    composed a prompt for has no surface, and a read says so rather than
//!    describing an empty conversation: `0` tokens would be a claim about a
//!    transcript the kernel has not seen (history is restored from host-core at
//!    the session's first prompt here), not a measurement.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::context::ContextLimits;
use crate::message::Message;
use crate::tool::ToolSpec;
use crate::tool_activation::{tool_search_spec, ToolActivation};

/// The kernel-owned state one `agent.prompt` leaves for the extension surface.
///
/// One mutex, written once per turn: the three halves always describe the same
/// turn, and a reader that took them one at a time could see a prompt from one
/// turn beside a tool set from the next.
#[derive(Default)]
pub struct SessionSurface {
    state: Mutex<SurfaceState>,
}

#[derive(Default)]
struct SurfaceState {
    /// The prompt the model was sent, after `before_agent_start` replacements.
    system_prompt: Option<String>,
    /// The declaration set the turn ran with. It shares the session's live
    /// activation set, so a name switched on after the turn is visible here at
    /// once — which is what makes `getAllTools().active` agree with the next
    /// request.
    activation: Option<Arc<ToolActivation>>,
    /// The budget the turn planned against. Kept so a read taken between turns
    /// prices against the model the session actually runs, never a default.
    limits: Option<ContextLimits>,
}

impl SessionSurface {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what this turn composed. Called once per prompt, before dispatch.
    ///
    /// A turn that declares no window leaves the previous budget in place: it
    /// did not learn a new one, and replacing it with a default would make the
    /// next read describe a model the session is not running.
    pub fn record_turn(
        &self,
        system_prompt: &str,
        activation: Arc<ToolActivation>,
        limits: Option<ContextLimits>,
    ) {
        if let Ok(mut state) = self.state.lock() {
            state.system_prompt = Some(system_prompt.to_string());
            state.activation = Some(activation);
            if limits.is_some() {
                state.limits = limits;
            }
        }
    }

    /// The prompt the last turn sent, or `None` before this process composed one.
    pub fn system_prompt(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.system_prompt.clone())
    }

    /// The declaration set the last turn ran with.
    pub fn activation(&self) -> Option<Arc<ToolActivation>> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.activation.clone())
    }

    /// The budget the last turn planned against.
    pub fn limits(&self) -> Option<ContextLimits> {
        self.state.lock().ok().and_then(|state| state.limits)
    }
}

/// The `usage` object an extension's `getContextUsage()` receives.
///
/// `percent` rounds like Node's `Math.round`: a 3 000-token transcript in a
/// 20 000-token budget is 15%, and an empty transcript is 0% of a real budget.
/// A zero budget has no percentage — `null`, not `0` — because "0% of nothing"
/// would read as a healthy session.
pub fn context_usage(messages: &[Message], limits: &ContextLimits) -> Value {
    let tokens = crate::context::estimate_context_tokens(messages).tokens;
    let percent = if limits.hard_limit > 0 {
        json!(((tokens as f64 / limits.hard_limit as f64) * 100.0).round() as u64)
    } else {
        Value::Null
    };
    json!({
        "tokens": tokens,
        "contextWindow": limits.hard_limit,
        "percent": percent,
    })
}

/// The tool set an extension's `getActiveTools()` / `getAllTools()` receives.
///
/// Upstream counterpart: `getActiveTools` / `getAllTools` in
/// `createExtensionBridge`, over Node's `toolCatalog`. Node's active set is the
/// core tools, the activated on-demand tools, and `ToolSearch` whenever
/// anything is deferred (`runtime.ts:5306`, `activeTools`), and its catalog is
/// every declared tool plus `ToolSearch`; both are reproduced here, so an
/// extension that lists tools sees one catalog on either runtime.
///
/// `None` is a session with no turn yet: `known: false` and empty lists, which
/// is how a caller tells "this kernel composed nothing here" from "this session
/// has no tools".
pub fn tools_report(activation: Option<&ToolActivation>) -> Value {
    let Some(activation) = activation else {
        return json!({
            "known": false,
            "active": Vec::<String>::new(),
            "catalog": Vec::<Value>::new(),
        });
    };
    let active = activation.declared_names();
    let mut catalog = activation
        .core_specs()
        .iter()
        .chain(activation.deferred_specs().iter())
        .map(|spec| {
            (
                spec.name.clone(),
                tool_entry(spec, active.iter().any(|name| name == &spec.name)),
            )
        })
        .collect::<Vec<_>>();
    if !activation.deferred_specs().is_empty() {
        // `ToolSearch` is declared exactly when something is deferred, and it is
        // always active: it is the call that switches the others on.
        let search = tool_search_spec();
        catalog.push((search.name.clone(), tool_entry(&search, true)));
    }
    // Sorted by name, the order the declaration split sorts by: a caller that
    // diffs two reports must not see a different order per turn.
    catalog.sort_by(|left, right| left.0.cmp(&right.0));
    json!({
        "known": true,
        "active": active,
        "catalog": catalog.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>(),
    })
}

fn tool_entry(spec: &ToolSpec, active: bool) -> Value {
    json!({
        "name": spec.name,
        "description": spec.description,
        "active": active,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    use crate::context::ModelLimits;
    use crate::prompt::SessionMode;

    fn limits(window: u64) -> ContextLimits {
        ContextLimits::for_model(ModelLimits {
            context_window: Some(window),
            max_tokens: Some(8_192),
            ..ModelLimits::default()
        })
    }

    /// An Agent-mode activation over `specs`, sharing the set it returns so a
    /// test can switch a name on the way `ToolSearch` does.
    fn activation(specs: &[&str]) -> (Arc<ToolActivation>, Arc<Mutex<BTreeSet<String>>>) {
        let active = Arc::new(Mutex::new(BTreeSet::new()));
        let specs = specs
            .iter()
            .map(|name| ToolSpec::new(*name, format!("{name} tool"), json!({ "type": "object" })))
            .collect::<Vec<_>>();
        let activation = Arc::new(ToolActivation::new(
            &SessionMode::parse(Some("agent")),
            specs,
            active.clone(),
        ));
        (activation, active)
    }

    /// The empty transcript of a session that has run no turn is 0 tokens, and
    /// a real budget makes that 0% — not `null`.
    #[test]
    fn an_empty_transcript_is_zero_percent_of_a_real_budget() {
        let budget = limits(128_000);
        let usage = context_usage(&[], &budget);
        assert_eq!(usage["tokens"], json!(0));
        assert_eq!(usage["percent"], json!(0));
        assert_eq!(
            usage["contextWindow"],
            json!(budget.hard_limit),
            "the window reported is the hard limit, as Node's budget.hardLimit"
        );
    }

    /// A transcript past the budget reports above 100 rather than clamping: the
    /// member measures what is there, it is not a health verdict.
    #[test]
    fn the_percentage_rounds_and_can_exceed_a_hundred() {
        let messages = (0..400)
            .map(|index| Message::user_text(format!("message {index} {}", "x".repeat(400))))
            .collect::<Vec<_>>();
        let budget = limits(1_000);
        let usage = context_usage(&messages, &budget);
        let tokens = usage["tokens"].as_u64().expect("tokens");
        assert!(tokens > budget.hard_limit, "the fixture must overflow");
        let expected = ((tokens as f64 / budget.hard_limit as f64) * 100.0).round() as u64;
        assert_eq!(usage["percent"], json!(expected));
        assert!(expected > 100);
    }

    /// A zero budget has no percentage.
    #[test]
    fn a_zero_budget_reports_no_percentage() {
        let mut budget = limits(1);
        budget.hard_limit = 0;
        let usage = context_usage(&[Message::user_text("hello")], &budget);
        assert_eq!(usage["percent"], Value::Null);
    }

    /// The surface reports what the turn recorded — and, before any turn, says
    /// there is nothing rather than describing an empty conversation.
    #[test]
    fn the_surface_reports_the_recorded_turn_and_nothing_before_it() {
        let surface = SessionSurface::new();
        assert_eq!(surface.system_prompt(), None);
        assert!(
            surface.activation().is_none(),
            "a session with no turn has no declaration set to report"
        );
        assert_eq!(
            tools_report(surface.activation().as_deref())["known"],
            json!(false)
        );

        let (recorded, _active) = activation(&["Read", "Bash", "OfficeWrite"]);
        surface.record_turn("composed prompt", recorded, Some(limits(200_000)));

        assert_eq!(surface.system_prompt().as_deref(), Some("composed prompt"));
        assert_eq!(
            surface.limits().map(|budget| budget.hard_limit),
            Some(limits(200_000).hard_limit)
        );
        assert_eq!(
            tools_report(surface.activation().as_deref())["known"],
            json!(true)
        );
    }

    /// `getAllTools` lists the whole catalog with the `active` flag the live
    /// activation set gives it, `ToolSearch` included, and `getActiveTools` is
    /// exactly what that set declares.
    #[test]
    fn the_catalog_carries_the_live_active_flag_and_the_search_tool() {
        // `Read` and `Bash` are core names in this kernel; `OfficeWrite` is not,
        // so the fixture has two core tools, one on-demand tool and `ToolSearch`.
        let (recorded, active) = activation(&["Read", "Bash", "OfficeWrite"]);
        let report = tools_report(Some(recorded.as_ref()));
        let catalog = report["catalog"].as_array().expect("catalog");
        let names = catalog
            .iter()
            .map(|entry| entry["name"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Bash", "OfficeWrite", "Read", "ToolSearch"]);

        let flag = |name: &str| {
            catalog
                .iter()
                .find(|entry| entry["name"] == json!(name))
                .map(|entry| entry["active"].clone())
                .unwrap_or(Value::Null)
        };
        assert_eq!(flag("Read"), json!(true));
        assert_eq!(flag("Bash"), json!(true));
        assert_eq!(
            flag("OfficeWrite"),
            json!(false),
            "an on-demand tool starts inactive"
        );
        assert_eq!(flag("ToolSearch"), json!(true));

        let declared = |report: &Value| {
            let mut names = report["active"]
                .as_array()
                .expect("active")
                .iter()
                .map(|name| name.as_str().unwrap_or_default().to_string())
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        assert_eq!(
            declared(&report),
            vec!["Bash", "Read", "ToolSearch"],
            "the core set plus the search tool, never the inactive on-demand tool"
        );

        // Switching the on-demand tool on is visible in the same report: the
        // activation shares the session's live set.
        active
            .lock()
            .expect("activation set")
            .insert("OfficeWrite".into());
        let switched = tools_report(Some(recorded.as_ref()));
        assert!(declared(&switched).contains(&"OfficeWrite".to_string()));
        assert_eq!(
            switched["catalog"]
                .as_array()
                .expect("catalog")
                .iter()
                .find(|entry| entry["name"] == json!("OfficeWrite"))
                .map(|entry| entry["active"].clone()),
            Some(json!(true))
        );
    }
}
