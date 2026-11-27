//! Behavior parity for the context thresholds against the TypeScript reference.
//!
//! `packages/agent-runtime/src/context-budget.ts` (`contextBudgetLimitsFor`) is the
//! reference implementation; [`ContextLimits::for_model`] is its Rust port. The cases in
//! `fixtures/context-budget-reference.json` were recorded from that reference with
//! `rust-anything record` (218 generated cases, 2026-11-27) and reduced to the windows
//! this port's `ModelLimits` can carry: `Option<u64>` cannot hold NaN, ±Infinity, a
//! negative or a fractional window, and a case whose reference result is itself
//! NaN/Infinity has no integer to assert against. 80 cases survive; the fixture header
//! records what was dropped and why.
//!
//! Two kinds of assertion live here, and they mean different things:
//!
//! * [`thresholds_match_the_reference`] — the arithmetic this port claims to share with
//!   the reference. A red case means the two runtimes would budget differently.
//! * [`deliberate_divergences_stay_deliberate`] — the places this product intentionally
//!   does **not** follow the reference. They are pinned with their numbers so a later
//!   edit that "restores parity" has to delete a documented decision, not silently
//!   change user-visible budgeting.

use agent_core::context::{ContextLimits, ModelLimits, PROMPT_BUDGET_CEILING};
use serde_json::Value;

const RECORDED: &str = include_str!("fixtures/context-budget-reference.json");

/// One recorded reference case: the model facts that went in, and the four thresholds
/// the reference produced.
struct Case {
    /// `model.contextWindow`; `None` is the key absent (or `null`), which the reference
    /// reads as the default through `||`.
    window: Option<u64>,
    /// `model.maxTokens`, same convention.
    max_tokens: Option<u64>,
    /// Reference `ContextBudgetLimits.window`.
    ref_window: u64,
    /// Reference `ContextBudgetLimits.hardLimit`.
    ref_hard_limit: u64,
    /// Reference `ContextBudgetLimits.requestHeadroom`.
    ref_request_headroom: u64,
    /// Reference `ContextBudgetLimits.keepRecentTokens`.
    ref_keep_recent: u64,
}

fn recorded_cases() -> Vec<Case> {
    let document: Value = serde_json::from_str(RECORDED).expect("fixture must be valid JSON");
    let cases = document["cases"]
        .as_array()
        .expect("fixture must carry a `cases` array");
    assert!(
        !cases.is_empty(),
        "an empty fixture would make every assertion below vacuously green"
    );
    cases
        .iter()
        .map(|case| Case {
            window: case["contextWindow"].as_u64(),
            max_tokens: case["maxTokens"].as_u64(),
            ref_window: case["window"].as_u64().expect("recorded window"),
            ref_hard_limit: case["hardLimit"].as_u64().expect("recorded hardLimit"),
            ref_request_headroom: case["requestHeadroom"]
                .as_u64()
                .expect("recorded requestHeadroom"),
            ref_keep_recent: case["keepRecentTokens"]
                .as_u64()
                .expect("recorded keepRecentTokens"),
        })
        .collect()
}

fn limits_for(case: &Case) -> ContextLimits {
    ContextLimits::for_model(ModelLimits {
        context_window: case.window,
        max_tokens: case.max_tokens,
        compaction_enabled: true,
    })
}

fn label(case: &Case) -> String {
    format!("window={:?}, maxTokens={:?}", case.window, case.max_tokens)
}

/// Every recorded case whose window this port plans against whole: the window, the hard
/// boundary and the request headroom must be the reference's numbers, not merely close.
#[test]
fn thresholds_match_the_reference() {
    let mut compared = 0;
    for case in &recorded_cases() {
        // The ceiling is what separates the two sets of cases, so take it from the
        // port's own constant rather than from a copied number. A case above it cannot
        // match on `window` by design; the divergence test covers those.
        if case.ref_window > PROMPT_BUDGET_CEILING {
            continue;
        }
        compared += 1;
        let limits = limits_for(case);
        let label = label(case);
        assert_eq!(
            limits.window, case.ref_window,
            "{label}: window must be what the reference plans against"
        );
        assert_eq!(
            limits.hard_limit, case.ref_hard_limit,
            "{label}: hard_limit must match the reference"
        );
        assert_eq!(
            limits.request_headroom, case.ref_request_headroom,
            "{label}: request_headroom must match the reference"
        );
    }
    assert!(
        compared > 60,
        "only {compared} recorded cases were compared; the fixture is meant to carry the \
         full set of windows this port can plan against"
    );
}

/// The reference removed its window ceiling on purpose; this product keeps one, so a
/// 1M-window model budgets against 200K. Pinned so the divergence stays a decision.
#[test]
fn deliberate_divergences_stay_deliberate() {
    let large = ContextLimits::for_model(ModelLimits::new(1_000_000, 32_768));
    assert_eq!(
        large.window, PROMPT_BUDGET_CEILING,
        "a 1M window must budget against PROMPT_BUDGET_CEILING ({}), not the reported \
         window: the reference removed its ceiling so the settings row and the budget \
         agree, this product re-added one so a single request stays sendable",
        PROMPT_BUDGET_CEILING
    );
    // Reference, recorded: window 1_000_000 / maxTokens 32_768 → hard_limit 950_000.
    assert!(
        large.hard_limit < 950_000,
        "hard_limit {} must stay below the reference's 950_000 while the ceiling stands",
        large.hard_limit
    );

    // The retained tail is measured against the trigger here and against the hard limit
    // in the reference, and the trigger itself is capped — so this port never keeps a
    // wider tail than the reference would. That direction is the whole safety argument:
    // a smaller tail cannot overflow a window the reference already accepted.
    for case in &recorded_cases() {
        let limits = limits_for(case);
        assert!(
            limits.keep_recent_tokens <= case.ref_keep_recent,
            "{}: keep_recent_tokens {} must not exceed the reference's {} — this port \
             keeps less, never more",
            label(case),
            limits.keep_recent_tokens,
            case.ref_keep_recent
        );
    }
    let at_ceiling = ContextLimits::for_model(ModelLimits::new(200_000, 32_768));
    assert!(
        at_ceiling.keep_recent_tokens < 33_446,
        "the divergence itself still exists: a 200K window keeps less than the \
         reference's 33_446 while keep_recent is measured against the trigger"
    );
    assert!(
        at_ceiling.keep_recent_tokens >= 8_000,
        "the retained tail must not fall under COMPACTION_MIN_KEEP_RECENT_TOKENS"
    );
}

/// The reference reads `model.contextWindow || DEFAULT`, so a zero window falls back to
/// the default window. Treating `Some(0)` as a real window put `hard_limit` at 1 and made
/// every turn overflow.
#[test]
fn a_zero_window_falls_back_to_the_default_like_the_reference() {
    // The expected numbers come from the fixture, i.e. from the reference itself.
    let recorded = recorded_cases()
        .into_iter()
        .find(|case| case.window == Some(0))
        .expect("the fixture must include a `contextWindow: 0` case");
    let limits = limits_for(&recorded);
    assert_eq!(limits.window, recorded.ref_window);
    assert_eq!(limits.hard_limit, recorded.ref_hard_limit, "not 1");
    assert_eq!(limits.request_headroom, recorded.ref_request_headroom);

    // And it budgets exactly like a missing window, because `0` is falsy in `||`.
    assert_eq!(limits, ContextLimits::for_model(ModelLimits::default()));
}

/// Same rule for the output budget: `maxTokens: 0` is falsy in the reference and must
/// fall back to the default rather than reserving a single token of headroom.
#[test]
fn a_zero_output_budget_falls_back_to_the_default_like_the_reference() {
    let recorded = recorded_cases()
        .into_iter()
        .find(|case| case.max_tokens == Some(0) && case.window.unwrap_or(1) > 0)
        .expect("the fixture must include a `maxTokens: 0` case");
    let limits = limits_for(&recorded);
    assert_eq!(
        limits.request_headroom, recorded.ref_request_headroom,
        "not 16_384"
    );

    let absent = ContextLimits::for_model(ModelLimits {
        context_window: recorded.window,
        max_tokens: None,
        compaction_enabled: true,
    });
    assert_eq!(
        limits, absent,
        "`maxTokens: 0` must budget exactly like a missing output budget"
    );
}
