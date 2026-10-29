//! Deterministic skill curation.
//!
//! A learned library only stays useful if something prunes it, and that
//! something cannot be a model acting alone: a merge rewrites the user's own
//! procedure, and a deletion loses it. So this module answers one question with
//! no I/O and no model call — which skills look duplicated, which have gone
//! idle, which are too thin to be worth the context they cost — and the
//! registry turns an accepted answer into an *archive*, never a delete.
//!
//! The inputs are all observable: the catalog the registry already scans, and
//! the activity ledger the learning plugin writes beside it. Nothing here reads
//! a clock of its own, so a plan is a pure function of its arguments.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Two skills whose names and descriptions share this much of their vocabulary
/// are treated as the same procedure learned twice.
pub const DEFAULT_DUPLICATE_SIMILARITY: f32 = 0.72;
/// How long a skill may go unused before it is worth archiving.
pub const DEFAULT_STALE_AFTER_DAYS: u64 = 90;
/// A document below this size is reported as thin: a hint to review it, never
/// a reason to archive on its own.
pub const DEFAULT_THIN_BODY_CHARS: usize = 900;

/// Thresholds for one plan. They are settings, not constants of the algorithm,
/// so a user who wants an aggressive sweep can ask for one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratorPolicy {
    pub duplicate_similarity: f32,
    pub stale_after_days: u64,
    pub thin_body_chars: usize,
}

impl Default for CuratorPolicy {
    fn default() -> Self {
        Self {
            duplicate_similarity: DEFAULT_DUPLICATE_SIMILARITY,
            stale_after_days: DEFAULT_STALE_AFTER_DAYS,
            thin_body_chars: DEFAULT_THIN_BODY_CHARS,
        }
    }
}

/// What the activity ledger knows about one skill. Absent means "no record",
/// which is different from "never used".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    #[serde(default, alias = "use_count")]
    pub use_count: u64,
    #[serde(default, alias = "patch_count")]
    pub patch_count: u64,
    #[serde(default)]
    pub pinned: bool,
    /// Snake case in the ledger the plugin writes, camel case on the wire.
    #[serde(default, alias = "last_activity_at")]
    pub last_activity_at: Option<String>,
}

/// One catalog row as the planner sees it.
#[derive(Debug, Clone)]
pub struct CuratorSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body_chars: usize,
    pub updated_at: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CuratorFinding {
    /// The same procedure as `keeper`, with the shared vocabulary share.
    Duplicate { keeper: String, similarity: f32 },
    /// Unused for at least `stale_after_days`.
    Stale { idle_days: u64, use_count: u64 },
    /// Short enough that its cost is not obviously paid back.
    Thin { body_chars: usize },
    /// The ledger marks it as deliberately kept, so no finding may archive it.
    Pinned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CuratorSuggestion {
    Keep,
    Archive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratorCandidate {
    pub id: String,
    pub name: String,
    pub suggestion: CuratorSuggestion,
    pub findings: Vec<CuratorFinding>,
    pub use_count: u64,
    pub idle_days: Option<u64>,
    pub enabled: bool,
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "use", "using",
    "your", "you", "its", "it's", "are", "was", "were", "will", "can", "may", "must", "should",
    "skill", "step", "steps", "procedure",
];

/// The vocabulary a skill is matched on. Names weigh the same as descriptions
/// because a learned skill's description is usually the trigger sentence the
/// agent wrote for itself.
fn tokens(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() >= 3)
        .map(|word| word.to_lowercase())
        .filter(|word| !STOPWORDS.contains(&word.as_str()))
        .collect()
}

fn vocabulary(skill: &CuratorSkill) -> BTreeSet<String> {
    let mut set = tokens(&skill.name);
    set.extend(tokens(&skill.description));
    set
}

/// Jaccard similarity over the two vocabularies: 1.0 is the same words, 0.0 is
/// nothing in common. Symmetric, and insensitive to how long either side is,
/// which matters because a learned description can run long.
pub fn similarity(left: &CuratorSkill, right: &CuratorSkill) -> f32 {
    let a = vocabulary(left);
    let b = vocabulary(right);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.intersection(&b).count() as f32;
    let union = a.union(&b).count() as f32;
    shared / union
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.with_timezone(&Utc))
}

/// Whole days since the last activity we can prove. The ledger's timestamp wins;
/// a skill the ledger never saw falls back to the document's own mtime, so a
/// library that predates the ledger still ages.
fn idle_days(
    skill: &CuratorSkill,
    usage: Option<&SkillUsage>,
    now: DateTime<Utc>,
) -> Option<u64> {
    let last = usage
        .and_then(|entry| entry.last_activity_at.as_deref())
        .and_then(parse_timestamp)
        .or_else(|| parse_timestamp(&skill.updated_at))?;
    let elapsed = now.signed_duration_since(last);
    u64::try_from(elapsed.num_days()).ok()
}

/// Rank the keeper of a duplicate pair: the used one wins, then the one that was
/// corrected more often (patches mean someone invested in it), then the newer
/// one, then the longer document, then the smaller id so a plan never depends on
/// iteration order.
fn keeper_of<'a>(left: &'a CuratorSkill, right: &'a CuratorSkill, usage: &BTreeMap<String, SkillUsage>) -> &'a CuratorSkill {
    let stats = |skill: &CuratorSkill| {
        usage
            .get(&skill.id)
            .map(|entry| (entry.use_count, entry.patch_count))
            .unwrap_or((0, 0))
    };
    let left_key = (
        stats(left),
        parse_timestamp(&left.updated_at),
        left.body_chars,
    );
    let right_key = (
        stats(right),
        parse_timestamp(&right.updated_at),
        right.body_chars,
    );
    match right_key.cmp(&left_key) {
        std::cmp::Ordering::Greater => right,
        std::cmp::Ordering::Less => left,
        // Equal on every signal: the id breaks the tie, deterministically.
        std::cmp::Ordering::Equal => {
            if left.id <= right.id {
                left
            } else {
                right
            }
        }
    }
}

/// Which skills the curator would archive, and why. Read-only by construction:
/// the caller decides what to do with the answer.
///
/// Archiving is proposed for exactly two reasons — a duplicate of a better row,
/// or a skill that has gone unused past the window. Thin documents and pinned
/// rows are reported but never archived here, so a first sweep on an existing
/// library cannot empty it.
pub fn plan(
    skills: &[CuratorSkill],
    usage: &BTreeMap<String, SkillUsage>,
    policy: &CuratorPolicy,
    now: DateTime<Utc>,
) -> Vec<CuratorCandidate> {
    let mut findings: BTreeMap<String, Vec<CuratorFinding>> = skills
        .iter()
        .map(|skill| (skill.id.clone(), Vec::new()))
        .collect();

    // Age and size first: they hold for a row regardless of what else it is.
    for skill in skills {
        let stats = usage.get(&skill.id);
        let idle = idle_days(skill, stats, now);
        if stats.map(|entry| entry.pinned).unwrap_or(false) {
            findings
                .entry(skill.id.clone())
                .or_default()
                .push(CuratorFinding::Pinned);
            continue;
        }
        let use_count = stats.map(|entry| entry.use_count).unwrap_or(0);
        if let Some(idle) = idle {
            if idle >= policy.stale_after_days && use_count == 0 {
                findings
                    .entry(skill.id.clone())
                    .or_default()
                    .push(CuratorFinding::Stale { idle_days: idle, use_count });
            }
        }
        if skill.body_chars < policy.thin_body_chars {
            findings
                .entry(skill.id.clone())
                .or_default()
                .push(CuratorFinding::Thin {
                    body_chars: skill.body_chars,
                });
        }
    }

    // Then duplicates: an unordered pair is scored once, and only the row that
    // loses the keeper comparison carries the finding.
    for (index, left) in skills.iter().enumerate() {
        for right in skills.iter().skip(index + 1) {
            if left.id == right.id {
                continue;
            }
            let score = similarity(left, right);
            if score < policy.duplicate_similarity {
                continue;
            }
            let keeper = keeper_of(left, right, usage);
            let loser = if keeper.id == left.id { right } else { left };
            findings
                .entry(loser.id.clone())
                .or_default()
                .push(CuratorFinding::Duplicate {
                    keeper: keeper.id.clone(),
                    similarity: score,
                });
        }
    }

    let mut candidates: Vec<CuratorCandidate> = skills
        .iter()
        .map(|skill| {
            let mut mine = findings.remove(&skill.id).unwrap_or_default();
            let stats = usage.get(&skill.id);
            let idle = idle_days(skill, stats, now);
            let archived = mine.iter().any(|finding| {
                matches!(
                    finding,
                    CuratorFinding::Duplicate { .. } | CuratorFinding::Stale { .. }
                )
            });
            // Report the strongest signal first: a duplicate explains a row
            // better than its age does.
            mine.sort_by_key(|finding| match finding {
                CuratorFinding::Duplicate { .. } => 0,
                CuratorFinding::Stale { .. } => 1,
                CuratorFinding::Thin { .. } => 2,
                CuratorFinding::Pinned => 3,
            });
            CuratorCandidate {
                id: skill.id.clone(),
                name: skill.name.clone(),
                suggestion: if archived {
                    CuratorSuggestion::Archive
                } else {
                    CuratorSuggestion::Keep
                },
                findings: mine,
                use_count: stats.map(|entry| entry.use_count).unwrap_or(0),
                idle_days: idle,
                enabled: skill.enabled,
            }
        })
        .collect();

    // Archivable rows first, then the most idle, then by id: a plan the UI can
    // render without re-sorting.
    candidates.sort_by(|left, right| {
        let rank = |candidate: &CuratorCandidate| {
            (
                candidate.suggestion != CuratorSuggestion::Archive,
                std::cmp::Reverse(candidate.idle_days.unwrap_or(0)),
                candidate.id.clone(),
            )
        };
        rank(left).cmp(&rank(right))
    });
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&Utc)
    }

    fn skill(id: &str, name: &str, description: &str) -> CuratorSkill {
        CuratorSkill {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            body_chars: 2_000,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            enabled: true,
        }
    }

    #[test]
    fn the_same_procedure_learned_twice_is_one_duplicate() {
        let left = skill(
            "restart-sidecar",
            "Restart the sidecar",
            "Restart the host sidecar after a provider change so the new credentials load",
        );
        let right = skill(
            "host-restart",
            "Restart the host sidecar",
            "Restart the host sidecar after changing a provider so new credentials load",
        );
        let mut ledger = BTreeMap::new();
        ledger.insert(
            right.id.clone(),
            SkillUsage {
                use_count: 4,
                ..Default::default()
            },
        );
        let plan = plan(
            &[left, right],
            &ledger,
            &CuratorPolicy::default(),
            at("2026-02-01T00:00:00Z"),
        );
        let archived: Vec<_> = plan
            .iter()
            .filter(|candidate| candidate.suggestion == CuratorSuggestion::Archive)
            .collect();
        assert_eq!(archived.len(), 1, "exactly one row loses the pair: {plan:?}");
        assert_eq!(archived[0].id, "restart-sidecar", "the used row keeps its place");
        assert!(matches!(
            archived[0].findings[0],
            CuratorFinding::Duplicate { ref keeper, .. } if keeper == "host-restart"
        ));
    }

    #[test]
    fn unrelated_skills_are_left_alone() {
        let plan = plan(
            &[
                skill("deploy", "Deploy the desktop build", "Ship a signed installer to the release channel"),
                skill("ocr", "Read text out of a screenshot", "Run the bundled OCR model over an image"),
            ],
            &BTreeMap::new(),
            &CuratorPolicy::default(),
            at("2026-02-01T00:00:00Z"),
        );
        assert!(plan.iter().all(|candidate| candidate.suggestion == CuratorSuggestion::Keep));
    }

    #[test]
    fn an_idle_skill_past_the_window_is_archived() {
        let plan = plan(
            &[skill("old", "Old note", "Something about a legacy build flag")],
            &BTreeMap::new(),
            &CuratorPolicy::default(),
            at("2026-06-01T00:00:00Z"),
        );
        assert_eq!(plan[0].suggestion, CuratorSuggestion::Archive);
        assert!(matches!(plan[0].findings[0], CuratorFinding::Stale { .. }));
    }

    #[test]
    fn a_skill_that_gets_used_is_never_stale() {
        let mut ledger = BTreeMap::new();
        ledger.insert(
            "old".to_string(),
            SkillUsage {
                use_count: 3,
                last_activity_at: Some("2025-12-01T00:00:00Z".to_string()),
                ..Default::default()
            },
        );
        let plan = plan(
            &[skill("old", "Old note", "Something about a legacy build flag")],
            &ledger,
            &CuratorPolicy::default(),
            at("2026-06-01T00:00:00Z"),
        );
        assert_eq!(plan[0].suggestion, CuratorSuggestion::Keep);
        assert!(plan[0].findings.iter().all(|finding| !matches!(finding, CuratorFinding::Stale { .. })));
    }

    #[test]
    fn a_pinned_skill_is_reported_but_never_archived() {
        let mut ledger = BTreeMap::new();
        ledger.insert(
            "keep-me".to_string(),
            SkillUsage {
                pinned: true,
                ..Default::default()
            },
        );
        let plan = plan(
            &[skill("keep-me", "Keep me", "A procedure the user marked as deliberate")],
            &ledger,
            &CuratorPolicy::default(),
            at("2026-06-01T00:00:00Z"),
        );
        assert_eq!(plan[0].suggestion, CuratorSuggestion::Keep);
        assert!(plan[0].findings.contains(&CuratorFinding::Pinned));
    }

    #[test]
    fn a_thin_document_is_reported_without_being_archived() {
        let mut doc = skill("thin", "Tiny", "A short note about one flag");
        doc.body_chars = 120;
        doc.updated_at = "2026-05-30T00:00:00Z".to_string();
        let plan = plan(&[doc], &BTreeMap::new(), &CuratorPolicy::default(), at("2026-06-01T00:00:00Z"));
        assert_eq!(plan[0].suggestion, CuratorSuggestion::Keep);
        assert!(matches!(plan[0].findings[0], CuratorFinding::Thin { .. }));
    }

    #[test]
    fn the_ledger_timestamp_beats_the_document_mtime() {
        let mut doc = skill("fresh", "Fresh", "Recently used procedure");
        doc.updated_at = "2025-01-01T00:00:00Z".to_string();
        let mut ledger = BTreeMap::new();
        ledger.insert(
            "fresh".to_string(),
            SkillUsage {
                use_count: 1,
                last_activity_at: Some("2026-05-31T00:00:00Z".to_string()),
                ..Default::default()
            },
        );
        let plan = plan(&[doc], &ledger, &CuratorPolicy::default(), at("2026-06-01T00:00:00Z"));
        assert_eq!(plan[0].idle_days, Some(1));
        assert_eq!(plan[0].suggestion, CuratorSuggestion::Keep);
    }

    #[test]
    fn a_plan_is_order_independent() {
        let rows = [
            skill("a", "Restart the sidecar", "Restart the host sidecar after a provider change"),
            skill("b", "Restart host sidecar", "Restart the host sidecar after changing a provider"),
            skill("c", "Read a screenshot", "Run OCR over an image"),
        ];
        let forward = plan(&rows, &BTreeMap::new(), &CuratorPolicy::default(), at("2026-06-01T00:00:00Z"));
        let mut reversed = rows.clone();
        reversed.reverse();
        let backward = plan(&reversed, &BTreeMap::new(), &CuratorPolicy::default(), at("2026-06-01T00:00:00Z"));
        let ids = |plan: &[CuratorCandidate]| {
            plan.iter()
                .map(|candidate| (candidate.id.clone(), candidate.suggestion))
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&forward), ids(&backward));
    }
}
