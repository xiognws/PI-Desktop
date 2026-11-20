//! The watchdog: an independent control loop over the workers.
//!
//! It is deliberately not a worker and not the router. A worker that hangs cannot
//! report that it hangs, and a router that is stuck in a long decision cannot
//! notice that six of its workers are stuck too. So the watchdog keeps its own
//! cancellation token — nothing it watches can stop the thing that watches it —
//! and its answer is an intervention rather than work: nudge, stop, or leave it
//! alone.
//!
//! Two levels again, for the same reason as the trigger path. Program rules catch
//! what can be counted (nothing moved for ten minutes, no turn in forty steps,
//! the worker failed). The model is asked only about what counting cannot see:
//! whether the work is still moving *towards* the goal.

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};

use super::trigger::Trigger;
use super::worker::{WorkerRecord, WorkerRegistry, WorkerStatus};

/// Nothing moved for this long and the worker is presumed stuck.
pub const STALL_AFTER_MS: i64 = 10 * 60 * 1_000;

/// Turns without a progress mark after which a worker is presumed looping.
pub const MAX_TURNS_WITHOUT_PROGRESS: u32 = 40;

/// What the program side noticed. It is a suspicion, not a verdict: the cheap
/// check names the worker, the expensive one decides what to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Suspicion {
    /// Live, but nothing advanced since `idle_ms` ago.
    Stalled { idle_ms: i64, turns: u32 },
    /// Ended in an error rather than a result.
    Failed { text: String },
}

/// What the watchdog decided to do about a worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterventionKind {
    /// Ask the worker for a status line. The cheapest intervention, and the one
    /// that costs the least if the judgement was wrong.
    Nudge,
    /// Stop the worker. Its report says why.
    Stop,
    /// The worker is gone; the router should start a replacement with the same
    /// mission and the failure in hand.
    Recover,
}

impl InterventionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Nudge => "nudge",
            Self::Stop => "stop",
            Self::Recover => "recover",
        }
    }
}

/// One intervention, with the sentence a person or the router reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intervention {
    pub worker_id: String,
    pub worker_name: String,
    pub kind: InterventionKind,
    pub reason: String,
    /// The watchdog's own judgement flag: `true` when the program rule fired but
    /// nobody looked closer.
    pub from_rule: bool,
}

/// Whether the semantic layer runs at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Judgement {
    /// Program rules only. Deterministic, cheap, and blind to direction.
    #[default]
    Off,
    /// Ask the model once a rule has fired, before intervening.
    OnSuspicion,
}

#[derive(Debug, Clone)]
pub struct WatchdogPolicy {
    pub stall_after_ms: i64,
    pub max_turns_without_progress: u32,
    pub judgement: Judgement,
}

impl Default for WatchdogPolicy {
    fn default() -> Self {
        Self {
            stall_after_ms: STALL_AFTER_MS,
            max_turns_without_progress: MAX_TURNS_WITHOUT_PROGRESS,
            judgement: Judgement::Off,
        }
    }
}

/// What a nudge delivers: a kernel-internal event on the worker's own thread.
pub const NUDGE_SUMMARY: &str =
    "watchdog: report the current state in one line — done so far, next step, and whether you need a decision";

/// The control loop.
#[derive(Debug, Clone)]
pub struct Watchdog {
    policy: WatchdogPolicy,
    token: CancelToken,
}

impl Default for Watchdog {
    fn default() -> Self {
        Self::new(WatchdogPolicy::default())
    }
}

impl Watchdog {
    pub fn new(policy: WatchdogPolicy) -> Self {
        Self {
            policy,
            token: CancelToken::new(),
        }
    }

    pub fn policy(&self) -> &WatchdogPolicy {
        &self.policy
    }

    /// The watchdog's own stop button. Cancelling it stops the watchdog; a
    /// worker's or the router's token can never do that.
    pub fn token(&self) -> CancelToken {
        self.token.clone()
    }

    pub fn shutdown(&self) {
        self.token.cancel();
    }

    pub fn is_shutdown(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Program-side scan: everything that can be decided by counting.
    pub fn scan(&self, registry: &WorkerRegistry, now_ms: i64) -> Vec<Intervention> {
        let mut interventions = Vec::new();
        for (_, record) in registry.iter() {
            match record.status {
                WorkerStatus::Failed => {
                    let text = record
                        .report
                        .as_ref()
                        .map(|report| report.text.clone())
                        .unwrap_or_else(|| "no report".to_string());
                    interventions.push(Intervention {
                        worker_id: record.id.clone(),
                        worker_name: record.spec.name.clone(),
                        kind: InterventionKind::Recover,
                        reason: format!("worker failed: {text}"),
                        from_rule: true,
                    });
                }
                WorkerStatus::Running => {
                    let idle_ms = now_ms.saturating_sub(record.last_progress_ms);
                    if idle_ms >= self.policy.stall_after_ms {
                        interventions.push(Intervention {
                            worker_id: record.id.clone(),
                            worker_name: record.spec.name.clone(),
                            kind: InterventionKind::Nudge,
                            reason: format!(
                                "nothing advanced for {} minute(s) after {} turn(s)",
                                idle_ms / 60_000,
                                record.turns
                            ),
                            from_rule: true,
                        });
                    } else if record.turns >= self.policy.max_turns_without_progress {
                        interventions.push(Intervention {
                            worker_id: record.id.clone(),
                            worker_name: record.spec.name.clone(),
                            kind: InterventionKind::Nudge,
                            reason: format!("{} turns without a progress mark", record.turns),
                            from_rule: true,
                        });
                    }
                }
                _ => {}
            }
        }
        interventions
    }

    /// Apply one intervention. A `Nudge` is a delivery on the worker's own thread,
    /// a `Stop` cancels that worker alone, and a `Recover` is left to the router
    /// because starting a replacement is a routing decision, not a supervision one.
    pub fn apply(
        &self,
        registry: &mut WorkerRegistry,
        intervention: &Intervention,
        now_ms: i64,
    ) -> Applied {
        match intervention.kind {
            InterventionKind::Nudge => {
                let Some(record) = registry.get(&intervention.worker_id) else {
                    return Applied::Skipped("the worker is gone".into());
                };
                let thread_key = record.thread_key.clone();
                let nudge = Trigger::internal("watchdog", thread_key.as_str(), NUDGE_SUMMARY)
                    .with_body(intervention.reason.clone());
                match registry.deliver(&intervention.worker_id, nudge) {
                    Ok(()) => Applied::Nudged,
                    Err(reason) => Applied::Skipped(reason),
                }
            }
            InterventionKind::Stop => {
                if registry.stop(&intervention.worker_id, now_ms, &intervention.reason) {
                    Applied::Stopped
                } else {
                    Applied::Skipped("the worker was already settled".into())
                }
            }
            InterventionKind::Recover => Applied::ReportedToRouter,
        }
    }
}

/// What applying an intervention did, so a caller can count it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    Nudged,
    Stopped,
    ReportedToRouter,
    Skipped(String),
}

impl Applied {
    /// A stable word for logs and RPC answers.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Nudged => "nudged",
            Self::Stopped => "stopped",
            Self::ReportedToRouter => "reported_to_router",
            Self::Skipped(_) => "skipped",
        }
    }
}

/// The question the semantic layer answers, built from what the program side saw.
pub fn build_judgement_prompt(record: &WorkerRecord, suspicion: &Suspicion) -> String {
    let observation = match suspicion {
        Suspicion::Stalled { idle_ms, turns } => format!(
            "The program side counted no progress for {} minute(s) over {turns} turn(s).",
            idle_ms / 60_000
        ),
        Suspicion::Failed { text } => format!("The worker ended with an error: {text}"),
    };
    format!(
        "Worker {id} ({name}) on thread {thread} is {status}.\n{observation}\n\
Mission: {mission}\n\
Answer with JSON only: {{\"progressing\":true|false,\"onTrack\":true|false,\"action\":\"nudge\"|\"stop\"|\"recover\",\"reason\":\"…\"}}\n\
Use `nudge` when it is probably working but silent, `stop` when it is going the wrong way, `recover` when the failure needs a fresh worker.",
        id = record.id,
        name = record.spec.name,
        thread = record.thread_key,
        status = record.status.as_str(),
        mission = record.spec.mission,
    )
}

/// The semantic layer's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub progressing: bool,
    pub on_track: bool,
    pub action: InterventionKind,
    pub reason: String,
}

/// Parse the judgement. Unusable answers are refused rather than guessed: acting
/// on a misread verdict means stopping the wrong worker.
pub fn parse_verdict(text: &str) -> Result<Verdict> {
    let value: serde_json::Value = serde_json::from_str(extract_json(text)).map_err(|error| {
        AgentError::Refused(format!(
            "the judgement was not valid JSON ({error}): answer with {{\"progressing\":…,\"onTrack\":…,\"action\":…,\"reason\":…}}"
        ))
    })?;
    let action = value
        .get("action")
        .and_then(serde_json::Value::as_str)
        .and_then(|raw| match raw.trim().to_ascii_lowercase().as_str() {
            "nudge" => Some(InterventionKind::Nudge),
            "stop" => Some(InterventionKind::Stop),
            "recover" => Some(InterventionKind::Recover),
            _ => None,
        })
        .ok_or_else(|| {
            AgentError::Refused(
                "the judgement has no usable `action`: use `nudge`, `stop` or `recover`.".into(),
            )
        })?;
    Ok(Verdict {
        progressing: value
            .get("progressing")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        on_track: value
            .get("onTrack")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        action,
        reason: value
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("no reason given")
            .to_string(),
    })
}

fn extract_json(text: &str) -> &str {
    let trimmed = text.trim();
    match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => &trimmed[start..=end],
        _ => trimmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::trigger::ThreadKey;
    use crate::super_agent::worker::{WorkerRegistry, WorkerSpec};

    fn registry() -> (WorkerRegistry, String) {
        let mut registry = WorkerRegistry::new("router-1", 4);
        let id = registry
            .spawn(
                ThreadKey::new("pr-12"),
                WorkerSpec::new("fix-ci", "make main green"),
                false,
                1_000,
            )
            .unwrap();
        (registry, id)
    }

    #[test]
    fn a_quiet_worker_is_nudged_after_the_threshold() {
        let (mut registry, id) = registry();
        let watchdog = Watchdog::default();
        assert!(
            watchdog.scan(&registry, 2_000).is_empty(),
            "one minute is not a stall"
        );
        let interventions = watchdog.scan(&registry, STALL_AFTER_MS + 2_000);
        assert_eq!(interventions.len(), 1);
        assert_eq!(interventions[0].kind, InterventionKind::Nudge);
        assert_eq!(interventions[0].worker_id, id);
        assert!(interventions[0].reason.contains("nothing advanced"));

        let applied = watchdog.apply(&mut registry, &interventions[0], STALL_AFTER_MS + 2_000);
        assert_eq!(applied, Applied::Nudged);
        let record = registry.get(&id).unwrap();
        assert_eq!(
            record.inbox.len(),
            1,
            "the nudge is delivered, not sent to a person"
        );
        assert!(record.inbox[0].summary.contains("report the current state"));
    }

    #[test]
    fn progress_resets_the_stall_clock() {
        let (mut registry, id) = registry();
        let watchdog = Watchdog::default();
        registry.note_progress(&id, 700_000, 3, 9);
        assert!(watchdog.scan(&registry, 800_000).is_empty());
    }

    #[test]
    fn a_worker_that_never_advances_is_flagged_by_turns_too() {
        let (mut registry, id) = registry();
        registry.note_progress(&id, 1_500, MAX_TURNS_WITHOUT_PROGRESS, 0);
        let watchdog = Watchdog::new(WatchdogPolicy {
            stall_after_ms: 60 * 60 * 1_000,
            ..WatchdogPolicy::default()
        });
        let interventions = watchdog.scan(&registry, 2_000);
        assert_eq!(interventions.len(), 1);
        assert!(interventions[0].reason.contains("without a progress mark"));
    }

    #[test]
    fn a_stop_intervention_stops_only_that_worker() {
        let mut registry = WorkerRegistry::new("router-1", 4);
        let first = registry
            .spawn(ThreadKey::new("a"), WorkerSpec::new("a", "m"), false, 1)
            .unwrap();
        let second = registry
            .spawn(ThreadKey::new("b"), WorkerSpec::new("b", "m"), false, 1)
            .unwrap();
        let watchdog = Watchdog::default();
        let intervention = Intervention {
            worker_id: first.clone(),
            worker_name: "a".into(),
            kind: InterventionKind::Stop,
            reason: "going the wrong way".into(),
            from_rule: false,
        };
        assert_eq!(
            watchdog.apply(&mut registry, &intervention, 5),
            Applied::Stopped
        );
        assert!(registry.get(&first).unwrap().cancel.is_cancelled());
        assert!(!registry.get(&second).unwrap().cancel.is_cancelled());
        // A second stop of a settled worker is a no-op, not an error.
        assert!(matches!(
            watchdog.apply(&mut registry, &intervention, 6),
            Applied::Skipped(_)
        ));
    }

    #[test]
    fn a_failed_worker_is_reported_to_the_router_rather_than_restarted_here() {
        let (mut registry, id) = registry();
        registry.settle(
            &id,
            WorkerStatus::Failed,
            "the tests cannot even build",
            2_000,
        );
        let watchdog = Watchdog::default();
        let interventions = watchdog.scan(&registry, 2_001);
        assert_eq!(interventions.len(), 1);
        assert_eq!(interventions[0].kind, InterventionKind::Recover);
        assert_eq!(
            watchdog.apply(&mut registry, &interventions[0], 2_002),
            Applied::ReportedToRouter
        );
    }

    #[test]
    fn the_watchdog_has_its_own_stop_button() {
        let watchdog = Watchdog::default();
        let router_token = CancelToken::new();
        router_token.cancel();
        assert!(
            !watchdog.is_shutdown(),
            "cancelling the router must not stop the thing that watches it"
        );
        let watch = watchdog.token();
        watchdog.shutdown();
        assert!(watch.is_cancelled());
    }

    #[test]
    fn a_verdict_parses_and_an_unusable_one_is_refused() {
        let verdict = parse_verdict(
            "```json\n{\"progressing\":false,\"onTrack\":false,\"action\":\"stop\",\"reason\":\"editing the wrong repo\"}\n```",
        )
        .unwrap();
        assert_eq!(verdict.action, InterventionKind::Stop);
        assert!(!verdict.on_track);
        assert!(parse_verdict("{\"progressing\":true}").is_err());
        assert!(parse_verdict("no idea").is_err());
    }

    #[test]
    fn the_judgement_prompt_carries_the_mission_and_the_count() {
        let (registry, id) = registry();
        let record = registry.get(&id).unwrap();
        let prompt = build_judgement_prompt(
            record,
            &Suspicion::Stalled {
                idle_ms: 12 * 60_000,
                turns: 4,
            },
        );
        assert!(prompt.contains("make main green"));
        assert!(prompt.contains("12 minute(s)"));
        assert!(prompt.contains("\"onTrack\""));
        assert!(prompt.contains("recover"));
    }
}
