//! The run budget: what one turn may spend before it is stopped.
//!
//! Practice from the agents that run unattended (Codex's turn budgets, Devin's
//! session allowance, this project's own rule that a background pass has a fixed
//! budget): an agent that can always take one more step will take it, and the bill
//! arrives after the useful work is long done. The budget is therefore a *hard*
//! stop with a warning on the way in — the warning is what lets a model wrap up
//! instead of being cut off mid-sentence.
//!
//! Token counts come from the provider's own usage, not from an estimate: the
//! budget guards money, and money is what the provider reports.

use serde::{Deserialize, Serialize};

use crate::message::Usage;

/// Fraction of the budget at which the model is told to start wrapping up.
pub const WARN_AT: f32 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBudget {
    /// Total tokens (input + output) this turn may spend. `None` is unbounded.
    pub max_tokens: Option<u64>,
    /// Provider requests this turn may issue beyond the loop's own step ceiling.
    pub max_steps: Option<usize>,
    /// Where the warning lands, in `0.0..=1.0`.
    pub warn_at: f32,
}

impl Default for RunBudget {
    fn default() -> Self {
        Self {
            max_tokens: None,
            max_steps: None,
            warn_at: WARN_AT,
        }
    }
}

impl RunBudget {
    pub fn tokens(max_tokens: u64) -> Self {
        Self {
            max_tokens: Some(max_tokens),
            ..Self::default()
        }
    }

    pub fn steps(max_steps: usize) -> Self {
        Self {
            max_steps: Some(max_steps),
            ..Self::default()
        }
    }

    pub fn with_warn_at(mut self, warn_at: f32) -> Self {
        self.warn_at = warn_at.clamp(0.0, 1.0);
        self
    }

    pub fn is_unbounded(&self) -> bool {
        self.max_tokens.is_none() && self.max_steps.is_none()
    }
}

/// What the meter says after an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetDecision {
    Continue,
    /// Close to the ceiling: finish the thought, do not start new work.
    Wrap {
        used: u64,
        limit: u64,
    },
    /// At or past the ceiling. The turn stops.
    Exhausted {
        used: u64,
        limit: u64,
        reason: BudgetReason,
    },
}

impl BudgetDecision {
    pub fn is_exhausted(&self) -> bool {
        matches!(self, Self::Exhausted { .. })
    }

    /// The sentence the model or the log reads.
    pub fn message(&self) -> Option<String> {
        match self {
            Self::Continue => None,
            Self::Wrap { used, limit } => Some(format!(
                "the run budget is at {used} of {limit}: finish the current step and report, do not start new work"
            )),
            Self::Exhausted {
                used,
                limit,
                reason,
            } => Some(format!(
                "the run budget is exhausted ({used} of {limit}, {}): stopping",
                reason.as_str()
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetReason {
    Tokens,
    Steps,
}

impl BudgetReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Tokens => "tokens",
            Self::Steps => "steps",
        }
    }
}

/// Accumulates what a turn has spent and answers whether it may continue.
#[derive(Debug, Clone)]
pub struct BudgetMeter {
    budget: RunBudget,
    used_tokens: u64,
    used_steps: usize,
    /// Whether the wrap-up warning was already delivered, so it is said once.
    warned: bool,
}

impl BudgetMeter {
    pub fn new(budget: RunBudget) -> Self {
        Self {
            budget,
            used_tokens: 0,
            used_steps: 0,
            warned: false,
        }
    }

    pub fn budget(&self) -> &RunBudget {
        &self.budget
    }

    pub fn used_tokens(&self) -> u64 {
        self.used_tokens
    }

    pub fn used_steps(&self) -> usize {
        self.used_steps
    }

    pub fn remaining_tokens(&self) -> Option<u64> {
        self.budget
            .max_tokens
            .map(|limit| limit.saturating_sub(self.used_tokens))
    }

    /// Count one provider request.
    ///
    /// The wrap-up warning is issued here rather than when the tokens are counted,
    /// because this is the first moment there is still work to wrap up: a one-step
    /// turn that answers immediately has nothing to stop, and warning it would only
    /// leave an unanswered user row behind.
    pub fn note_step(&mut self) -> BudgetDecision {
        self.used_steps += 1;
        if let Some(limit) = self.budget.max_steps {
            if self.used_steps >= limit {
                return BudgetDecision::Exhausted {
                    used: self.used_steps as u64,
                    limit: limit as u64,
                    reason: BudgetReason::Steps,
                };
            }
        }
        let Some(limit) = self.budget.max_tokens else {
            return BudgetDecision::Continue;
        };
        if self.used_tokens >= limit {
            return BudgetDecision::Exhausted {
                used: self.used_tokens,
                limit,
                reason: BudgetReason::Tokens,
            };
        }
        let warn_at = (limit as f64 * f64::from(self.budget.warn_at)) as u64;
        if !self.warned && self.used_tokens >= warn_at {
            self.warned = true;
            return BudgetDecision::Wrap {
                used: self.used_tokens,
                limit,
            };
        }
        BudgetDecision::Continue
    }

    /// Fold in what the provider reported for one request.
    pub fn observe(&mut self, usage: &Usage) -> BudgetDecision {
        self.used_tokens += usage.input_tokens + usage.output_tokens;
        match self.budget.max_tokens {
            Some(limit) if self.used_tokens >= limit => BudgetDecision::Exhausted {
                used: self.used_tokens,
                limit,
                reason: BudgetReason::Tokens,
            },
            _ => BudgetDecision::Continue,
        }
    }

    /// One line for a report or a status panel.
    pub fn summary(&self) -> String {
        let tokens = match self.budget.max_tokens {
            Some(limit) => format!("{} / {limit} tokens", self.used_tokens),
            None => format!("{} tokens", self.used_tokens),
        };
        let steps = match self.budget.max_steps {
            Some(limit) => format!("{} / {limit} steps", self.used_steps),
            None => format!("{} steps", self.used_steps),
        };
        format!("{tokens} · {steps}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            ..Usage::default()
        }
    }

    #[test]
    fn an_unbounded_budget_never_stops() {
        let mut meter = BudgetMeter::new(RunBudget::default());
        for _ in 0..100 {
            assert_eq!(meter.note_step(), BudgetDecision::Continue);
            assert_eq!(
                meter.observe(&usage(1_000, 1_000)),
                BudgetDecision::Continue
            );
        }
        assert!(meter.budget().is_unbounded());
        assert_eq!(meter.remaining_tokens(), None);
    }

    #[test]
    fn the_warning_comes_once_and_before_the_stop() {
        let mut meter = BudgetMeter::new(RunBudget::tokens(1_000));
        // Spending alone never warns: there has to be a step left to wrap up in.
        assert_eq!(meter.observe(&usage(500, 0)), BudgetDecision::Continue);
        assert_eq!(meter.observe(&usage(300, 0)), BudgetDecision::Continue);
        match meter.note_step() {
            BudgetDecision::Wrap { used, limit } => {
                assert_eq!((used, limit), (800, 1_000));
            }
            other => panic!("expected the wrap-up warning, got {other:?}"),
        }
        assert_eq!(
            meter.note_step(),
            BudgetDecision::Continue,
            "the warning is said once, not on every step"
        );
        let decision = meter.observe(&usage(200, 0));
        assert!(decision.is_exhausted());
        assert!(decision.message().unwrap().contains("tokens"));
    }

    #[test]
    fn a_step_budget_stops_at_its_limit() {
        let mut meter = BudgetMeter::new(RunBudget::steps(3));
        assert_eq!(meter.note_step(), BudgetDecision::Continue);
        assert_eq!(meter.note_step(), BudgetDecision::Continue);
        let decision = meter.note_step();
        assert!(decision.is_exhausted());
        assert!(decision.message().unwrap().contains("steps"));
    }

    #[test]
    fn the_meter_reports_what_it_spent() {
        let mut meter = BudgetMeter::new(RunBudget::tokens(10_000).with_warn_at(0.9));
        meter.observe(&usage(1_200, 800));
        assert_eq!(meter.used_tokens(), 2_000);
        assert_eq!(meter.remaining_tokens(), Some(8_000));
        assert_eq!(meter.summary(), "2000 / 10000 tokens · 0 steps");
    }

    #[test]
    fn a_warn_threshold_of_one_warns_at_the_ceiling_only() {
        let mut meter = BudgetMeter::new(RunBudget::tokens(100).with_warn_at(1.0));
        assert_eq!(meter.observe(&usage(90, 0)), BudgetDecision::Continue);
        assert_eq!(meter.note_step(), BudgetDecision::Continue);
        assert!(meter.observe(&usage(10, 0)).is_exhausted());
    }
}
