//! Memory decay: which stored memories should stop being recalled, and why.
//!
//! A memory store only gets more convincing as it grows, and every turn pays
//! for it: recall injects the best hits, so a stale fact competes with a fresh
//! one for the same context budget. Stage 2b of the memory spec calls that
//! "confidence decay and periodic tidy-up". This module is the decision half —
//! pure, no clock, no I/O — and `Database::retire_memory` is the reversible
//! write, because a memory the user paid for is never deleted.
//!
//! Retirement is a *belief* change, not a removal: it sets `valid_until`, which
//! is the same column supersession already uses for "believed until this
//! moment". `restore` clears it.

use serde::{Deserialize, Serialize};

/// A memory loses half of its belief every `half_life_days` it goes unused.
pub const DEFAULT_HALF_LIFE_DAYS: f64 = 120.0;
/// Below this decayed confidence, and past the idle window, it is a candidate.
pub const DEFAULT_MIN_CONFIDENCE: f64 = 0.2;
/// How long a memory may go unused before it can be retired at all.
pub const DEFAULT_IDLE_DAYS: u64 = 120;
/// A memory used at least this often is kept regardless of age: repeated use is
/// the strongest evidence a memory is still true.
pub const DEFAULT_KEEP_USE_COUNT: i64 = 2;

const MS_PER_DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecayPolicy {
    pub half_life_days: f64,
    pub min_confidence: f64,
    pub idle_days: u64,
    pub keep_use_count: i64,
}

impl Default for DecayPolicy {
    fn default() -> Self {
        Self {
            half_life_days: DEFAULT_HALF_LIFE_DAYS,
            min_confidence: DEFAULT_MIN_CONFIDENCE,
            idle_days: DEFAULT_IDLE_DAYS,
            keep_use_count: DEFAULT_KEEP_USE_COUNT,
        }
    }
}

/// The fields decay reasons about, taken off one stored memory.
#[derive(Debug, Clone)]
pub struct DecayInput {
    pub id: String,
    pub title: String,
    pub scope: String,
    pub confidence: f64,
    pub pinned: bool,
    pub use_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub valid_until: Option<i64>,
    pub superseded_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum DecayFinding {
    /// Unused for at least the policy window.
    Idle { idle_days: u64 },
    /// Decayed confidence fell below the policy floor.
    Faded { confidence: f64, decayed: f64 },
    /// Repeated use outweighs age, so it stays.
    WellUsed { use_count: i64 },
    /// The user marked it as deliberately kept.
    Pinned,
    /// Already replaced by another memory.
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DecaySuggestion {
    Keep,
    Retire,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecayProposal {
    pub id: String,
    pub title: String,
    pub scope: String,
    pub confidence: f64,
    pub decayed_confidence: f64,
    pub use_count: i64,
    pub idle_days: i64,
    pub suggestion: DecaySuggestion,
    pub findings: Vec<DecayFinding>,
}

/// How much of a memory's belief survives `idle_days` without a recall.
///
/// Exponential with a half-life, so a fact does not fall off a cliff and a
/// never-used memory still decays smoothly instead of being kept forever by a
/// rounding step.
pub fn decayed_confidence(confidence: f64, idle_days: i64, half_life_days: f64) -> f64 {
    let half_life = if half_life_days.is_finite() && half_life_days > 0.0 {
        half_life_days
    } else {
        DEFAULT_HALF_LIFE_DAYS
    };
    let idle = idle_days.max(0) as f64;
    let factor = 0.5_f64.powf(idle / half_life);
    (confidence * factor).clamp(0.0, 1.0)
}

/// Which memories the store should stop recalling, and why.
///
/// `now_ms` is passed in so the plan is reproducible. Retiring is proposed only
/// for a live, unpinned memory that has both faded below the floor and gone
/// unused past the window, and that was never used often enough to earn a
/// permanent place. Everything else is reported and kept.
pub fn plan(inputs: &[DecayInput], policy: &DecayPolicy, now_ms: i64) -> Vec<DecayProposal> {
    let mut proposals: Vec<DecayProposal> = inputs
        .iter()
        .map(|input| {
            let anchor = input.last_used_at.unwrap_or(input.updated_at).max(input.created_at);
            let idle_days = ((now_ms - anchor) / MS_PER_DAY).max(0);
            let decayed = decayed_confidence(input.confidence, idle_days, policy.half_life_days);

            if input.superseded_by.is_some() {
                return DecayProposal {
                    id: input.id.clone(),
                    title: input.title.clone(),
                    scope: input.scope.clone(),
                    confidence: input.confidence,
                    decayed_confidence: decayed,
                    use_count: input.use_count,
                    idle_days,
                    suggestion: DecaySuggestion::Keep,
                    findings: vec![DecayFinding::Superseded],
                };
            }

            let mut findings = Vec::new();
            if input.pinned {
                findings.push(DecayFinding::Pinned);
            }
            if input.use_count >= policy.keep_use_count {
                findings.push(DecayFinding::WellUsed {
                    use_count: input.use_count,
                });
            }
            if idle_days as u64 >= policy.idle_days {
                findings.push(DecayFinding::Idle {
                    idle_days: idle_days as u64,
                });
            }
            if decayed < policy.min_confidence {
                findings.push(DecayFinding::Faded {
                    confidence: input.confidence,
                    decayed,
                });
            }

            let retire = !input.pinned
                && input.use_count < policy.keep_use_count
                && idle_days as u64 >= policy.idle_days
                && decayed < policy.min_confidence;

            DecayProposal {
                id: input.id.clone(),
                title: input.title.clone(),
                scope: input.scope.clone(),
                confidence: input.confidence,
                decayed_confidence: decayed,
                use_count: input.use_count,
                idle_days,
                suggestion: if retire {
                    DecaySuggestion::Retire
                } else {
                    DecaySuggestion::Keep
                },
                findings,
            }
        })
        .collect();

    // Retirements first, the most faded first, then by id: a caller never has to
    // re-sort a plan to render or act on it.
    proposals.sort_by(|left, right| {
        let rank = |proposal: &DecayProposal| {
            (
                proposal.suggestion != DecaySuggestion::Retire,
                (proposal.decayed_confidence * 1_000.0) as i64,
                proposal.id.clone(),
            )
        };
        rank(left).cmp(&rank(right))
    });
    proposals
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;
    const DAY: i64 = MS_PER_DAY;

    fn memory(id: &str) -> DecayInput {
        DecayInput {
            id: id.to_string(),
            title: format!("Memory {id}"),
            scope: "project".to_string(),
            confidence: 0.9,
            pinned: false,
            use_count: 0,
            created_at: NOW - 400 * DAY,
            updated_at: NOW - 400 * DAY,
            last_used_at: None,
            valid_until: None,
            superseded_by: None,
        }
    }

    #[test]
    fn an_idle_faded_memory_is_retired() {
        let plan = plan(&[memory("old")], &DecayPolicy::default(), NOW);
        assert_eq!(plan[0].suggestion, DecaySuggestion::Retire);
        assert!(plan[0]
            .findings
            .iter()
            .any(|finding| matches!(finding, DecayFinding::Idle { .. })));
        assert!(plan[0]
            .findings
            .iter()
            .any(|finding| matches!(finding, DecayFinding::Faded { .. })));
    }

    #[test]
    fn a_recently_used_memory_keeps_its_confidence() {
        let mut fresh = memory("fresh");
        fresh.last_used_at = Some(NOW - 2 * DAY);
        let plan = plan(&[fresh], &DecayPolicy::default(), NOW);
        assert_eq!(plan[0].suggestion, DecaySuggestion::Keep);
        assert!(plan[0].decayed_confidence > 0.85);
    }

    #[test]
    fn a_pinned_memory_is_never_retired_even_when_faded() {
        let mut pinned = memory("pinned");
        pinned.pinned = true;
        let plan = plan(&[pinned], &DecayPolicy::default(), NOW);
        assert_eq!(plan[0].suggestion, DecaySuggestion::Keep);
        assert!(plan[0].findings.contains(&DecayFinding::Pinned));
    }

    #[test]
    fn a_well_used_memory_survives_age() {
        let mut used = memory("used");
        used.use_count = 6;
        let plan = plan(&[used], &DecayPolicy::default(), NOW);
        assert_eq!(plan[0].suggestion, DecaySuggestion::Keep);
        assert!(plan[0].findings.contains(&DecayFinding::WellUsed { use_count: 6 }));
    }

    #[test]
    fn a_superseded_memory_is_reported_and_kept_for_history() {
        let mut replaced = memory("replaced");
        replaced.superseded_by = Some("newer".to_string());
        let plan = plan(&[replaced], &DecayPolicy::default(), NOW);
        assert_eq!(plan[0].suggestion, DecaySuggestion::Keep);
        assert!(plan[0].findings.contains(&DecayFinding::Superseded));
    }

    #[test]
    fn decay_halves_every_half_life() {
        let one = decayed_confidence(0.8, 120, 120.0);
        let two = decayed_confidence(0.8, 240, 120.0);
        assert!((one - 0.4).abs() < 1e-9, "{one}");
        assert!((two - 0.2).abs() < 1e-9, "{two}");
    }

    #[test]
    fn a_plan_is_order_independent_and_puts_retirements_first() {
        let mut kept = memory("kept");
        kept.last_used_at = Some(NOW - DAY);
        let rows = [memory("a"), memory("b"), kept];
        let forward = plan(&rows, &DecayPolicy::default(), NOW);
        let mut reversed = rows.clone();
        reversed.reverse();
        let backward = plan(&reversed, &DecayPolicy::default(), NOW);
        let ids = |plan: &[DecayProposal]| {
            plan.iter()
                .map(|proposal| (proposal.id.clone(), proposal.suggestion))
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&forward), ids(&backward));
        assert_eq!(forward.last().unwrap().id, "kept");
    }
}
