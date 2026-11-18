//! Window-scaled budgets for what one tool hands back to the model.
//!
//! `BUDGET_SEARCH` / `BUDGET_SHELL` bound a single result in bytes, and that
//! used to be the whole story: a 32K-window model and a 1M-window model both
//! received up to 128KB from one `Read`. At the repository's own estimate
//! (`packages/agent-runtime/src/pi-runtime-estimates.ts`, 3.5 chars/token) one
//! full-window `Read` is ~37,400 tokens — 67% of the 55,808-token point where a
//! 128K session starts compacting, spent before the read has answered anything.
//!
//! Two limits replace that:
//!
//! * **per result** — 15% of the model window, floor 8,000 chars. The per-tool
//!   constant stays as a ceiling, so scaling can only ever make a result
//!   smaller than today's, never larger.
//! * **per turn** — 30% of the window, floor 16,000 chars, shared by every
//!   builtin result the turn delivers. Once it is spent, later results are
//!   squeezed to what is left, down to a 4,000-char floor so a result is never
//!   empty (and the spill marker still names a file the model can Grep).
//!
//! Host-core hands each result over as it finishes, so a result already sent
//! cannot be revisited. The squeeze therefore lands on the result that would
//! exceed the turn budget and on everything after it — that is where the turn's
//! spending actually is — instead of retroactively shrinking the largest result
//! of the batch.
//!
//! Budgets are expressed in characters and applied as a byte cap. UTF-8 spends
//! at least one byte per character, so a non-ASCII result is capped at or below
//! the character intent; the estimate never becomes looser than it reads.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use super::OutputBudget;

/// Characters per token, the same estimate the runtime uses
/// (`pi-runtime-estimates.ts`).
pub const CHARS_PER_TOKEN: f64 = 3.5;
/// Share of the model window one tool result may occupy.
pub const PER_RESULT_WINDOW_SHARE: f64 = 0.15;
/// Smallest per-result allowance, so a small window still returns something
/// useful instead of a stub for every call.
pub const PER_RESULT_FLOOR_CHARS: usize = 8_000;
/// Share of the model window one turn's tool results may occupy together.
pub const TURN_WINDOW_SHARE: f64 = 0.30;
/// Smallest cumulative allowance for one turn.
pub const TURN_FLOOR_CHARS: usize = 16_000;
/// Floor for one result once the turn's budget is spent: an empty result tells
/// the model nothing, and the spill marker still names a readable file.
pub const TURN_RESULT_FLOOR_CHARS: usize = 4_000;
/// Turns kept for accounting. Bounded because a finished turn is never asked
/// about again: the oldest entry is dropped rather than the map growing.
const MAX_TRACKED_TURNS: usize = 64;

/// Both Bash streams' allowances for one call, resolved from one plan.
#[derive(Debug, Clone, Copy)]
pub struct ShellBudgets {
    pub stdout: OutputBudget,
    pub stderr: OutputBudget,
}

/// What a model window allows, derived once per call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowBudget {
    pub per_result_chars: usize,
    pub turn_chars: usize,
}

impl WindowBudget {
    /// `None` when no window was reported: the per-tool constants then apply
    /// exactly as they did before this module existed.
    pub fn for_window(window_tokens: Option<u64>) -> Option<Self> {
        let tokens = window_tokens.filter(|tokens| *tokens > 0)?;
        let per_result_chars = share(tokens, PER_RESULT_WINDOW_SHARE).max(PER_RESULT_FLOOR_CHARS);
        // A turn budget below one result's allowance would make the first call
        // of every turn the only one that fits.
        let turn_chars = share(tokens, TURN_WINDOW_SHARE)
            .max(TURN_FLOOR_CHARS)
            .max(per_result_chars);
        Some(Self {
            per_result_chars,
            turn_chars,
        })
    }
}

/// Characters for `fraction` of a token window, saturating instead of wrapping.
fn share(window_tokens: u64, fraction: f64) -> usize {
    let chars = window_tokens as f64 * CHARS_PER_TOKEN * fraction;
    if !chars.is_finite() {
        return usize::MAX;
    }
    chars.min(usize::MAX as f64) as usize
}

/// Cumulative tool output delivered per turn.
///
/// Keyed by `(session, turn)` and process-local: it exists to bound one turn's
/// transcript growth, so persisting it would outlive the thing it measures.
#[derive(Debug, Clone, Default)]
pub struct TurnOutputLedger {
    state: Arc<Mutex<LedgerState>>,
}

#[derive(Debug, Default)]
struct LedgerState {
    used: HashMap<String, usize>,
    /// Arrival order of `used`, for the eviction above.
    order: VecDeque<String>,
}

impl TurnOutputLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// The plan for one call. `turn_id` absent means there is no boundary to
    /// reset on, so only the per-result share applies and no turn is charged.
    pub fn plan(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        window_tokens: Option<u64>,
    ) -> OutputBudgetPlan {
        let Some(window) = WindowBudget::for_window(window_tokens) else {
            return OutputBudgetPlan::legacy();
        };
        let Some(turn_id) = turn_id.map(str::trim).filter(|turn| !turn.is_empty()) else {
            return OutputBudgetPlan {
                inner: Some(Arc::new(PlanState {
                    ledger: self.clone(),
                    key: String::new(),
                    per_result_bytes: window.per_result_chars,
                    turn_bytes: usize::MAX,
                })),
            };
        };
        OutputBudgetPlan {
            inner: Some(Arc::new(PlanState {
                ledger: self.clone(),
                key: format!("{session_id}\u{1}{turn_id}"),
                per_result_bytes: window.per_result_chars,
                turn_bytes: window.turn_chars,
            })),
        }
    }

    /// Bytes this turn has already been handed. `""` (no turn) charges nothing.
    fn used(&self, key: &str) -> usize {
        if key.is_empty() {
            return 0;
        }
        self.lock().used.get(key).copied().unwrap_or(0)
    }

    fn record(&self, key: &str, bytes: usize) {
        if key.is_empty() || bytes == 0 {
            return;
        }
        let mut state = self.lock();
        if let Some(entry) = state.used.get_mut(key) {
            *entry = entry.saturating_add(bytes);
            return;
        }
        if state.used.len() >= MAX_TRACKED_TURNS {
            if let Some(oldest) = state.order.pop_front() {
                state.used.remove(&oldest);
            }
        }
        state.used.insert(key.to_string(), bytes);
        state.order.push_back(key.to_string());
    }

    fn lock(&self) -> MutexGuard<'_, LedgerState> {
        // Bounded in-memory arithmetic only: no I/O and no await under this
        // lock. A poisoned lock still carries usable counters.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// The allowance one call runs under, and the counter it charges.
///
/// `OutputBudgetPlan::legacy()` (the default) is the pre-scaling behaviour.
#[derive(Debug, Clone, Default)]
pub struct OutputBudgetPlan {
    inner: Option<Arc<PlanState>>,
}

#[derive(Debug)]
struct PlanState {
    ledger: TurnOutputLedger,
    key: String,
    per_result_bytes: usize,
    turn_bytes: usize,
}

impl OutputBudgetPlan {
    /// Per-tool constants, no turn accounting: what a call gets when the caller
    /// reported no window.
    pub fn legacy() -> Self {
        Self::default()
    }

    /// Whether this call's allowances are scaled at all, for tests.
    #[cfg(test)]
    pub fn is_scaled(&self) -> bool {
        self.inner.is_some()
    }

    /// The allowance for one result of `legacy`'s kind: never larger than
    /// `legacy`, and never larger than what the turn has left.
    pub fn resolve(&self, legacy: OutputBudget) -> OutputBudget {
        let Some(inner) = &self.inner else {
            return legacy;
        };
        let remaining = inner
            .turn_bytes
            .saturating_sub(inner.ledger.used(&inner.key));
        let allowance = inner
            .per_result_bytes
            .min(remaining.max(TURN_RESULT_FLOOR_CHARS));
        OutputBudget {
            max_bytes: allowance.min(legacy.max_bytes),
            ..legacy
        }
    }

    /// Charge what this call actually handed the model.
    pub fn record(&self, delivered_bytes: usize) {
        if let Some(inner) = &self.inner {
            inner.ledger.record(&inner.key, delivered_bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Direction, BUDGET_SEARCH, BUDGET_SHELL, BUDGET_SHELL_ERR};

    const SMALL_WINDOW: u64 = 32_000;
    const DEFAULT_WINDOW: u64 = 128_000;
    const LARGE_WINDOW: u64 = 1_000_000;

    #[test]
    fn an_absent_window_keeps_every_legacy_budget() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), None);
        assert!(!plan.is_scaled());
        for legacy in [BUDGET_SEARCH, BUDGET_SHELL, BUDGET_SHELL_ERR] {
            assert_eq!(plan.resolve(legacy).max_bytes, legacy.max_bytes);
        }
        // Charging an unscaled plan cannot squeeze a later result.
        plan.record(usize::MAX / 2);
        assert_eq!(
            plan.resolve(BUDGET_SEARCH).max_bytes,
            BUDGET_SEARCH.max_bytes
        );
    }

    #[test]
    fn a_small_window_tightens_the_per_result_budget() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), Some(SMALL_WINDOW));
        // 32,000 tokens * 3.5 chars * 15% = 16,800 chars.
        let read = plan.resolve(BUDGET_SEARCH);
        assert_eq!(read.max_bytes, 16_800);
        assert!(read.max_bytes < BUDGET_SEARCH.max_bytes);
        assert_eq!(plan.resolve(BUDGET_SHELL).max_bytes, 16_800);
        // Lines and direction are the tool's own contract, not the window's.
        assert_eq!(read.max_lines, BUDGET_SEARCH.max_lines);
        assert_eq!(read.direction, Direction::Head);
        assert_eq!(plan.resolve(BUDGET_SHELL_ERR).direction, Direction::Tail);
    }

    #[test]
    fn a_large_window_never_exceeds_the_legacy_ceiling() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), Some(LARGE_WINDOW));
        // 1M tokens would allow 525,000 chars, so the constant is the ceiling.
        assert_eq!(
            plan.resolve(BUDGET_SEARCH).max_bytes,
            BUDGET_SEARCH.max_bytes
        );
        assert_eq!(plan.resolve(BUDGET_SHELL).max_bytes, BUDGET_SHELL.max_bytes);
        assert_eq!(
            plan.resolve(BUDGET_SHELL_ERR).max_bytes,
            BUDGET_SHELL_ERR.max_bytes
        );
    }

    #[test]
    fn a_default_window_takes_a_single_result_to_a_sixth_of_the_constant() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), Some(DEFAULT_WINDOW));
        // 128,000 * 3.5 * 15% = 67,200 chars, versus the 131,072-byte cap.
        assert_eq!(plan.resolve(BUDGET_SEARCH).max_bytes, 67_200);
        assert!(plan.resolve(BUDGET_SEARCH).max_bytes < BUDGET_SEARCH.max_bytes);
    }

    #[test]
    fn a_tiny_window_falls_back_to_the_floors() {
        let window = WindowBudget::for_window(Some(8_000)).unwrap();
        assert_eq!(window.per_result_chars, PER_RESULT_FLOOR_CHARS);
        assert_eq!(window.turn_chars, TURN_FLOOR_CHARS);
        // A nonsensical window (0) is treated as "not reported".
        assert!(WindowBudget::for_window(Some(0)).is_none());
    }

    #[test]
    fn a_turn_squeezes_the_results_that_would_exceed_its_budget() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), Some(DEFAULT_WINDOW));
        // 128,000 * 3.5 * 30% = 134,400 chars for the whole turn.
        let first = plan.resolve(BUDGET_SEARCH);
        assert_eq!(first.max_bytes, 67_200);
        plan.record(130_000);
        let second = plan.resolve(BUDGET_SEARCH);
        assert_eq!(second.max_bytes, 4_400, "what is left of the turn");
        assert!(second.max_bytes < first.max_bytes);
    }

    #[test]
    fn a_spent_turn_still_returns_the_result_floor() {
        let ledger = TurnOutputLedger::new();
        let plan = ledger.plan("s", Some("t"), Some(DEFAULT_WINDOW));
        plan.record(usize::MAX / 2);
        assert_eq!(
            plan.resolve(BUDGET_SEARCH).max_bytes,
            TURN_RESULT_FLOOR_CHARS
        );
        // Even the floor never exceeds the tool's own constant.
        assert!(TURN_RESULT_FLOOR_CHARS < BUDGET_SHELL.max_bytes);
    }

    #[test]
    fn a_turn_without_an_id_is_charged_to_nobody() {
        let ledger = TurnOutputLedger::new();
        let first = ledger.plan("s", None, Some(DEFAULT_WINDOW));
        assert_eq!(first.resolve(BUDGET_SEARCH).max_bytes, 67_200);
        first.record(1_000_000);
        // No boundary to reset on, so no cumulative cap either: the next call in
        // the same session keeps its full per-result allowance.
        let second = ledger.plan("s", None, Some(DEFAULT_WINDOW));
        assert_eq!(second.resolve(BUDGET_SEARCH).max_bytes, 67_200);
    }

    #[test]
    fn turns_and_sessions_are_accounted_separately() {
        let ledger = TurnOutputLedger::new();
        let turn_one = ledger.plan("s1", Some("t1"), Some(DEFAULT_WINDOW));
        let turn_two = ledger.plan("s1", Some("t2"), Some(DEFAULT_WINDOW));
        let other_session = ledger.plan("s2", Some("t1"), Some(DEFAULT_WINDOW));
        turn_one.record(134_400);
        assert_eq!(
            turn_one.resolve(BUDGET_SEARCH).max_bytes,
            TURN_RESULT_FLOOR_CHARS
        );
        assert_eq!(turn_two.resolve(BUDGET_SEARCH).max_bytes, 67_200);
        assert_eq!(other_session.resolve(BUDGET_SEARCH).max_bytes, 67_200);
    }

    #[test]
    fn the_ledger_is_bounded_by_the_turn_window_it_tracks() {
        let ledger = TurnOutputLedger::new();
        for index in 0..(MAX_TRACKED_TURNS * 2) {
            let plan = ledger.plan("s", Some(&format!("t{index}")), Some(DEFAULT_WINDOW));
            plan.record(1);
        }
        assert!(ledger.lock().used.len() <= MAX_TRACKED_TURNS);
    }
}
