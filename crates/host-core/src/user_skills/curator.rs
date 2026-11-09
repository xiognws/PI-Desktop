//! Skill maintenance: which documents stopped earning their place.
//!
//! Hermes retires skills with a curator that reads per-skill activity and moves
//! stale ones to an archive. This is the same idea with one deliberate
//! difference: **the scheduled pass never disables anything**. A skill that
//! disappears from the catalog because a timer fired is indistinguishable, from
//! the user's side, from a bug or a lost file — there is no "why did this turn
//! off" surface here yet. So the daily pass only *reports* what it would retire,
//! and the one-click archive in the settings page is the thing that acts, with
//! the list in front of the person doing it.
//!
//! The rule itself is small and explainable:
//!
//! | State | Condition |
//! | --- | --- |
//! | `archive` | age ≥ `archive_after_days`, counted from the last load, or from the document's own timestamp when nothing ever loaded it |
//! | `stale` | age ≥ `stale_after_days` but younger than the archive threshold |
//! | `keep` | everything else |
//!
//! "Age" always means *time since the last evidence of use*. An edited document
//! resets it (the file timestamp moves), which is the behaviour a person expects:
//! a skill you just improved is not idle.

use anyhow::Result;
use serde::Serialize;

use super::usage::SkillUsageStore;
use super::{CapabilityLevel, UserSkillRecord};

/// Days without a load before a skill is reported as idle.
pub const DEFAULT_STALE_AFTER_DAYS: i64 = 30;
/// Days without a load before a skill is reported as archivable.
pub const DEFAULT_ARCHIVE_AFTER_DAYS: i64 = 90;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratorPolicy {
    pub stale_after_days: i64,
    pub archive_after_days: i64,
}

impl Default for CuratorPolicy {
    fn default() -> Self {
        Self {
            stale_after_days: DEFAULT_STALE_AFTER_DAYS,
            archive_after_days: DEFAULT_ARCHIVE_AFTER_DAYS,
        }
    }
}

impl CuratorPolicy {
    /// Keep the thresholds ordered, so "stale" can never mean "more idle than
    /// archivable". A caller that passes them backwards gets a policy that still
    /// makes sense rather than one that classifies everything two ways.
    pub fn normalized(self) -> Self {
        let stale = self.stale_after_days.max(1);
        let archive = self.archive_after_days.max(stale);
        Self {
            stale_after_days: stale,
            archive_after_days: archive,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CurationState {
    Keep,
    Stale,
    Archive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationEntry {
    pub id: String,
    pub name: String,
    /// Storage spelling of the level (`global` / `project`).
    pub level: String,
    pub project_path: Option<String>,
    pub use_count: u32,
    /// Last load, or the document's own timestamp when it never loaded.
    pub last_activity_at: i64,
    pub idle_days: i64,
    pub state: CurationState,
}

/// Classify a skill. Pure, so the thresholds are testable without a filesystem.
pub fn classify(
    usage: Option<(u32, Option<i64>)>,
    document_timestamp_ms: i64,
    now_ms: i64,
    policy: CuratorPolicy,
) -> (i64, CurationState) {
    let policy = policy.normalized();
    let last_activity = usage
        .and_then(|(_, last_used_at)| last_used_at)
        .unwrap_or(document_timestamp_ms);
    let idle_days = ((now_ms - last_activity).max(0)) / DAY_MS;
    let state = if idle_days >= policy.archive_after_days {
        CurationState::Archive
    } else if idle_days >= policy.stale_after_days {
        CurationState::Stale
    } else {
        CurationState::Keep
    };
    (idle_days, state)
}

/// What a pass found, and — when it was not a dry run — what it turned off.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationReport {
    pub entries: Vec<CurationEntry>,
    pub archived: Vec<String>,
    pub dry_run: bool,
    pub policy: Option<CuratorPolicy>,
}

fn now_ms() -> i64 {
    crate::db::now_ms()
}

/// Timestamp of a record's document, in the same epoch-ms unit as usage rows.
///
/// `created_at` / `updated_at` are ISO strings produced by the scanner; a record
/// whose stamp cannot be parsed is treated as "just touched" so an unreadable
/// clock can never archive a document.
fn document_timestamp_ms(record: &UserSkillRecord) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&record.updated_at)
        .map(|stamp| stamp.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Report, and optionally archive, the user skills of every level whose
/// documents are already loaded by the caller.
///
/// The caller owns scanning (and therefore the activation state); this function
/// only decides and — when `dry_run` is false — asks [`UserSkillRegistry::set_enabled`]
/// to switch the archivable ones off. Nothing is deleted.
pub fn plan(
    records: &[UserSkillRecord],
    usage: &SkillUsageStore,
    policy: CuratorPolicy,
) -> Result<CurationReport> {
    let policy = policy.normalized();
    let now = now_ms();
    let mut report = CurationReport {
        entries: Vec::new(),
        archived: Vec::new(),
        dry_run: true,
        policy: Some(policy),
    };
    for record in records {
        let level = record
            .level
            .as_deref()
            .and_then(|value| CapabilityLevel::parse(Some(value)).ok())
            .unwrap_or(CapabilityLevel::Global);
        let usage_entry = usage.get(level, &record.id, record.project_path.as_deref());
        let (idle_days, state) = classify(
            usage_entry.map(|entry| (entry.use_count, Some(entry.last_used_at))),
            document_timestamp_ms(record),
            now,
            policy,
        );
        report.entries.push(CurationEntry {
            id: record.id.clone(),
            name: record.name.clone(),
            level: level.as_str().to_string(),
            project_path: record.project_path.clone(),
            use_count: usage_entry.map(|entry| entry.use_count).unwrap_or(0),
            last_activity_at: usage_entry
                .map(|entry| entry.last_used_at)
                .unwrap_or_else(|| document_timestamp_ms(record)),
            idle_days,
            state,
        });
    }
    // Most idle first: the report is read top-down when somebody decides.
    report
        .entries
        .sort_by(|a, b| b.idle_days.cmp(&a.idle_days).then(a.id.cmp(&b.id)));
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn days_ago(days: i64) -> i64 {
        NOW - days * DAY_MS
    }

    #[test]
    fn a_recently_loaded_skill_is_kept() {
        let (idle, state) = classify(
            Some((4, Some(days_ago(2)))),
            days_ago(300),
            NOW,
            CuratorPolicy::default(),
        );
        assert_eq!(idle, 2);
        assert_eq!(state, CurationState::Keep);
    }

    #[test]
    fn the_last_load_wins_over_the_document_timestamp() {
        // Written a year ago, loaded this morning: the load is the evidence.
        let (_, state) = classify(
            Some((1, Some(days_ago(0)))),
            days_ago(365),
            NOW,
            CuratorPolicy::default(),
        );
        assert_eq!(state, CurationState::Keep);
    }

    #[test]
    fn a_never_used_document_ages_from_its_own_timestamp() {
        let (idle, state) = classify(None, days_ago(100), NOW, CuratorPolicy::default());
        assert_eq!(idle, 100);
        assert_eq!(state, CurationState::Archive);
        // …and a fresh one is not a candidate just because it has no history.
        let (_, fresh) = classify(None, days_ago(3), NOW, CuratorPolicy::default());
        assert_eq!(fresh, CurationState::Keep);
    }

    #[test]
    fn the_stale_band_sits_between_the_two_thresholds() {
        let policy = CuratorPolicy::default();
        let (_, stale) = classify(Some((2, Some(days_ago(30)))), days_ago(30), NOW, policy);
        assert_eq!(stale, CurationState::Stale);
        let (_, archive) = classify(Some((2, Some(days_ago(90)))), days_ago(90), NOW, policy);
        assert_eq!(archive, CurationState::Archive);
    }

    #[test]
    fn backwards_thresholds_are_put_in_order_instead_of_failing() {
        let policy = CuratorPolicy {
            stale_after_days: 90,
            archive_after_days: 5,
        }
        .normalized();
        assert_eq!(policy.stale_after_days, 90);
        assert_eq!(policy.archive_after_days, 90);
        // Zero or negative days would archive everything the moment it is created.
        let zero = CuratorPolicy {
            stale_after_days: 0,
            archive_after_days: 0,
        }
        .normalized();
        assert_eq!(zero.stale_after_days, 1);
        assert_eq!(zero.archive_after_days, 1);
    }

    #[test]
    fn a_clock_that_runs_backwards_is_not_an_archive_reason() {
        let (idle, state) = classify(
            Some((1, Some(NOW + 5 * DAY_MS))),
            NOW,
            NOW,
            CuratorPolicy::default(),
        );
        assert_eq!(idle, 0);
        assert_eq!(state, CurationState::Keep);
    }
}
