//! The router layer: the program filter, the decision queue and the wire format a
//! model answers with.
//!
//! The event path has two filter levels, and they are kept apart on purpose:
//!
//! 1. **Program side** — [`RoutePolicy::classify`]. Cheap, deterministic rules
//!    (source, channel, who is allowed to ask, whether the agent was addressed)
//!    drop most noise before any token is spent. This is the level that makes
//!    "act only when asked, or when a written rule allows it" checkable.
//! 2. **Semantic side** — [`parse_router_decisions`]. Whatever survives level 1
//!    is judged by the model, one batched request per backlog: dispatch to a new
//!    worker, pass the event to the worker that already owns the thread, or
//!    ignore it with a reason.
//!
//! Batching is the router's throughput mechanism: triggers that arrive while a
//! decision is in flight are decided together by the next request, so a burst
//! costs one request rather than one per event.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::error::{AgentError, Result};

use super::trigger::{SourceKind, ThreadKey, ThreadTable, Trigger, Urgency};
use super::worker::WorkerSpec;

/// Triggers one router request may decide.
///
/// The bound exists for the same reason a step budget does: a backlog that never
/// drains is a bug, and a request with every trigger ever seen in it is a
/// provider error waiting to happen.
pub const ROUTER_MAX_BATCH: usize = 24;

/// How often a trigger may come back undecided before it is dropped.
///
/// A model that forgets a trigger would otherwise keep it pending forever, and
/// the queue would grow a permanent tail.
pub const MAX_ROUTER_ATTEMPTS: u32 = 3;

/// Who may start work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Autonomy {
    /// Requests only. Unsolicited work that matches a written rule is *recorded*,
    /// never done — the default, because a fresh instance has to earn the right
    /// to act on its own.
    #[default]
    AddressedOnly,
    /// Requests, plus unsolicited work a written rule names. Such a worker is
    /// marked `provisional`, so its result is read as a proposal to review
    /// rather than as a delivered change.
    RuleAllowlist,
    /// Nothing acts on its own: every unsolicited event is recorded. What a team
    /// uses while it calibrates its rules.
    RecordOnly,
}

impl Autonomy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AddressedOnly => "addressed_only",
            Self::RuleAllowlist => "rule_allowlist",
            Self::RecordOnly => "record_only",
        }
    }
}

/// Why the program side dropped an event. Every variant is a sentence, because
/// the first question about a missing reaction is always "why didn't it act".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropReason {
    SourceNotAllowed { kind: SourceKind },
    ChannelNotAllowed { channel: String },
    ActorNotAllowed { actor: Option<String> },
    NotAddressed,
}

impl DropReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SourceNotAllowed { .. } => "SOURCE_NOT_ALLOWED",
            Self::ChannelNotAllowed { .. } => "CHANNEL_NOT_ALLOWED",
            Self::ActorNotAllowed { .. } => "ACTOR_NOT_ALLOWED",
            Self::NotAddressed => "NOT_ADDRESSED",
        }
    }
}

impl std::fmt::Display for DropReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceNotAllowed { kind } => {
                write!(f, "`{}` events are not accepted here", kind.as_str())
            }
            Self::ChannelNotAllowed { channel } => {
                write!(f, "channel `{channel}` is not watched")
            }
            Self::ActorNotAllowed { actor } => match actor {
                Some(actor) => write!(f, "`{actor}` is not on the allowed list"),
                None => f.write_str("the event has no actor and the allowed list is not open"),
            },
            Self::NotAddressed => f.write_str(
                "nobody addressed the agent and no written rule covers this thread, so it stays quiet",
            ),
        }
    }
}

/// Level 1's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    /// Goes to the router for a semantic decision. `provisional` marks work that
    /// started from a rule rather than from a request.
    Accept {
        provisional: bool,
    },
    /// Worth acting on, but the policy does not allow acting: recorded so a
    /// person can see what the agent would have done.
    Record {
        reason: &'static str,
    },
    Drop {
        reason: DropReason,
    },
}

/// The program-side policy: which events reach the semantic layer at all.
#[derive(Debug, Clone)]
pub struct RoutePolicy {
    pub autonomy: Autonomy,
    /// Source kinds accepted. Empty means every environment kind.
    pub allowed_sources: Vec<SourceKind>,
    /// Channels accepted, matched exactly or by a trailing `*`. Empty means every
    /// channel of an accepted kind.
    pub allowed_channels: Vec<String>,
    /// People whose requests count. Empty means anyone in a watched channel.
    pub allowed_actors: Vec<String>,
    /// The written rules: thread keys work nobody asked for may act on. A rule
    /// ending in `*` is a prefix rule (`github:acme/web#pr-*`).
    pub rules: Vec<String>,
    pub max_batch: usize,
}

impl Default for RoutePolicy {
    fn default() -> Self {
        Self {
            autonomy: Autonomy::AddressedOnly,
            allowed_sources: Vec::new(),
            allowed_channels: Vec::new(),
            allowed_actors: Vec::new(),
            rules: Vec::new(),
            max_batch: ROUTER_MAX_BATCH,
        }
    }
}

impl RoutePolicy {
    /// A policy that watches everything and acts only when addressed.
    pub fn permissive() -> Self {
        Self::default()
    }

    pub fn with_autonomy(mut self, autonomy: Autonomy) -> Self {
        self.autonomy = autonomy;
        self
    }

    pub fn with_sources(mut self, kinds: impl IntoIterator<Item = SourceKind>) -> Self {
        self.allowed_sources = kinds.into_iter().collect();
        self
    }

    pub fn with_channels<S: Into<String>>(mut self, channels: impl IntoIterator<Item = S>) -> Self {
        self.allowed_channels = channels.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_actors<S: Into<String>>(mut self, actors: impl IntoIterator<Item = S>) -> Self {
        self.allowed_actors = actors.into_iter().map(Into::into).collect();
        self
    }

    /// A written rule: unsolicited work on matching threads is allowed (or
    /// recorded, depending on [`Autonomy`]).
    pub fn with_rule(mut self, rule: impl Into<String>) -> Self {
        self.rules.push(rule.into());
        self
    }

    /// Whether `rule` covers `key`: exact match, or a `*`-terminated prefix.
    pub fn rule_matches(rule: &str, key: &ThreadKey) -> bool {
        match rule.strip_suffix('*') {
            Some(prefix) => key.as_str().starts_with(prefix),
            None => rule == key.as_str(),
        }
    }

    fn channel_allowed(&self, channel: &str) -> bool {
        if self.allowed_channels.is_empty() {
            return true;
        }
        self.allowed_channels.iter().any(|allowed| {
            allowed == channel
                || allowed
                    .strip_suffix('*')
                    .map(|prefix| channel.starts_with(prefix))
                    .unwrap_or(false)
        })
    }

    fn actor_allowed(&self, actor: Option<&str>) -> bool {
        if self.allowed_actors.is_empty() {
            return true;
        }
        match actor {
            Some(actor) => self.allowed_actors.iter().any(|allowed| allowed == actor),
            None => false,
        }
    }

    fn rule_covers(&self, key: &ThreadKey) -> bool {
        self.rules.iter().any(|rule| Self::rule_matches(rule, key))
    }

    /// Level 1: decide from program rules alone, without spending a token.
    pub fn classify(&self, trigger: &Trigger) -> Classification {
        // The kernel's own traffic is never filtered: an async tool finishing is
        // the continuation of work a person already asked for.
        if !trigger.source.kind.is_environment() {
            return Classification::Accept { provisional: false };
        }
        if !self.allowed_sources.is_empty() && !self.allowed_sources.contains(&trigger.source.kind)
        {
            return Classification::Drop {
                reason: DropReason::SourceNotAllowed {
                    kind: trigger.source.kind,
                },
            };
        }
        if !self.channel_allowed(&trigger.source.channel) {
            return Classification::Drop {
                reason: DropReason::ChannelNotAllowed {
                    channel: trigger.source.channel.clone(),
                },
            };
        }
        if !self.actor_allowed(trigger.actor.as_deref()) {
            return Classification::Drop {
                reason: DropReason::ActorNotAllowed {
                    actor: trigger.actor.clone(),
                },
            };
        }
        if trigger.addressed_to_agent {
            return Classification::Accept { provisional: false };
        }
        // Nobody asked. Only a written rule may move this forward, and how far it
        // moves depends on the autonomy the team granted.
        if !self.rule_covers(&trigger.thread_key) {
            return Classification::Drop {
                reason: DropReason::NotAddressed,
            };
        }
        match self.autonomy {
            Autonomy::RuleAllowlist => Classification::Accept { provisional: true },
            Autonomy::AddressedOnly => Classification::Record {
                reason: "an unsolicited event matched a rule, but this instance only acts when addressed",
            },
            Autonomy::RecordOnly => Classification::Record {
                reason: "this instance only records what it would have done",
            },
        }
    }
}

/// What the policy recorded instead of doing. Kept so the "would have done"
/// answer exists after the fact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedAction {
    pub trigger_id: String,
    pub thread_key: ThreadKey,
    pub summary: String,
    pub reason: String,
    pub at_ms: i64,
}

impl RecordedAction {
    pub fn new(trigger: &Trigger, reason: impl Into<String>) -> Self {
        Self {
            trigger_id: trigger.id.clone(),
            thread_key: trigger.thread_key.clone(),
            summary: trigger.bounded_summary(),
            reason: reason.into(),
            at_ms: crate::message::now_ms(),
        }
    }
}

/// One trigger waiting for a semantic decision, with the number of times it has
/// come back undecided.
#[derive(Debug, Clone)]
struct Pending {
    trigger: Trigger,
    attempts: u32,
}

/// The backlog between the program filter and the router's request.
#[derive(Debug, Default, Clone)]
pub struct RouterQueue {
    pending: VecDeque<Pending>,
    /// Attempts per trigger id, kept for ids that came back undecided. Bounded,
    /// and cleared when the trigger is decided.
    attempts: std::collections::HashMap<String, u32>,
    attempt_order: VecDeque<String>,
    /// Triggers dropped for reaching [`MAX_ROUTER_ATTEMPTS`]; the count is the
    /// only trace left, so it must be visible.
    exhausted: usize,
}

/// How many undecided ids the attempt ledger remembers.
const ATTEMPT_LEDGER_CAPACITY: usize = 1_024;

impl RouterQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn exhausted(&self) -> usize {
        self.exhausted
    }

    /// Queue a trigger. High urgency goes to the front: a red pipeline should not
    /// wait behind three chat asides.
    pub fn push(&mut self, trigger: Trigger) {
        if trigger.urgency == Urgency::High {
            self.pending.push_front(Pending {
                trigger,
                attempts: 0,
            });
        } else {
            self.pending.push_back(Pending {
                trigger,
                attempts: 0,
            });
        }
    }

    /// Take up to `max` triggers for one decision request. They are out of the
    /// queue until [`Self::requeue`] puts them back.
    pub fn take_batch(&mut self, max: usize) -> Vec<Trigger> {
        let take = max.min(self.pending.len());
        self.pending
            .drain(..take)
            .map(|pending| pending.trigger)
            .collect()
    }

    /// Put an undecided trigger back, counting the attempt. Past the limit it is
    /// dropped, because a permanent tail is worse than a lost event whose
    /// absence is counted.
    pub fn requeue(&mut self, trigger: Trigger) {
        let attempts = self.attempts.get(&trigger.id).copied().unwrap_or(0) + 1;
        if attempts >= MAX_ROUTER_ATTEMPTS {
            self.exhausted += 1;
            self.forget_attempts(&trigger.id);
            return;
        }
        if self.attempts.insert(trigger.id.clone(), attempts).is_none() {
            self.attempt_order.push_back(trigger.id.clone());
            while self.attempt_order.len() > ATTEMPT_LEDGER_CAPACITY {
                if let Some(evicted) = self.attempt_order.pop_front() {
                    self.attempts.remove(&evicted);
                }
            }
        }
        self.pending.push_back(Pending { trigger, attempts });
    }

    /// A decided trigger's attempt record is dead weight.
    pub fn settle(&mut self, ids: &[String]) {
        for id in ids {
            self.forget_attempts(id);
        }
    }

    fn forget_attempts(&mut self, id: &str) {
        self.attempts.remove(id);
        if let Some(slot) = self.attempt_order.iter().position(|known| known == id) {
            self.attempt_order.remove(slot);
        }
    }

    /// How many times `id` has come back undecided.
    pub fn attempts(&self, id: &str) -> Option<u32> {
        self.attempts.get(id).copied().or_else(|| {
            self.pending
                .iter()
                .find(|pending| pending.trigger.id == id)
                .map(|pending| pending.attempts)
        })
    }
}

/// What a worker is asked to do about a batch of triggers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouterAction {
    /// Start a worker on the triggers' thread.
    Dispatch,
    /// Hand the triggers to the worker that already owns the thread.
    #[serde(rename = "passthrough")]
    PassThrough,
    /// Stay quiet, with a reason the record keeps.
    Ignore,
}

impl RouterAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dispatch => "dispatch",
            Self::PassThrough => "passthrough",
            Self::Ignore => "ignore",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "dispatch" => Some(Self::Dispatch),
            "passthrough" | "pass_through" | "pass-through" => Some(Self::PassThrough),
            "ignore" => Some(Self::Ignore),
            _ => None,
        }
    }
}

/// One decision about one or more triggers of the batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDecision {
    pub trigger_ids: Vec<String>,
    pub action: RouterAction,
    /// Required by `dispatch`: what the new worker is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<WorkerSpec>,
    /// Required by `passthrough`: the worker that owns the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RouterDecision {
    /// Check what the wire format cannot express, with a sentence written for the
    /// model: these are refusals it can fix by answering again.
    pub fn validate(&self) -> Result<()> {
        if self.trigger_ids.is_empty() {
            return Err(AgentError::Refused(
                "every decision needs `triggerIds`: name the ids from the batch it decides.".into(),
            ));
        }
        match self.action {
            RouterAction::Dispatch => match &self.worker {
                Some(worker) if !worker.name.trim().is_empty() && !worker.mission.trim().is_empty() => {
                    Ok(())
                }
                _ => Err(AgentError::Refused(
                    "a `dispatch` decision needs `worker.name` and `worker.mission`: the name identifies it in later batches, the mission is what it must achieve.".into(),
                )),
            },
            RouterAction::PassThrough => {
                if self.worker_id.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(AgentError::Refused(
                        "a `passthrough` decision needs `workerId`: use the id of the worker that owns the thread.".into(),
                    ));
                }
                Ok(())
            }
            RouterAction::Ignore => Ok(()),
        }
    }
}

/// Parse the model's answer to a router request.
///
/// Tolerant about packaging (a fenced block, prose around the object), strict
/// about content: a decision that cannot be applied is refused with a sentence
/// the model can act on, rather than guessed at.
pub fn parse_router_decisions(text: &str) -> Result<Vec<RouterDecision>> {
    let json = extract_json(text).ok_or_else(|| {
        AgentError::Refused(
            "the answer contained no JSON object: reply with {\"decisions\":[…]} and nothing else."
                .into(),
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
        AgentError::Refused(format!(
            "the answer was not valid JSON ({error}): reply with {{\"decisions\":[…]}} and nothing else."
        ))
    })?;

    let items = match &value {
        serde_json::Value::Array(items) => items.clone(),
        serde_json::Value::Object(map) => match map.get("decisions") {
            Some(serde_json::Value::Array(items)) => items.clone(),
            _ => {
                return Err(AgentError::Refused(
                    "the object has no `decisions` array: reply with {\"decisions\":[…]}.".into(),
                ))
            }
        },
        _ => {
            return Err(AgentError::Refused(
                "the answer is neither a decisions array nor an object with one.".into(),
            ))
        }
    };

    let mut decisions = Vec::with_capacity(items.len());
    for item in items {
        let action = item
            .get("action")
            .and_then(serde_json::Value::as_str)
            .and_then(RouterAction::parse)
            .ok_or_else(|| {
                AgentError::Refused(format!(
                    "a decision has no usable `action`: use one of `dispatch`, `passthrough`, `ignore`. Got: {item}"
                ))
            })?;
        let trigger_ids: Vec<String> = item
            .get("triggerIds")
            .and_then(serde_json::Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let worker = item.get("worker").and_then(|worker| {
            let name = worker.get("name").and_then(serde_json::Value::as_str)?;
            let mission = worker.get("mission").and_then(serde_json::Value::as_str)?;
            let mut spec = WorkerSpec::new(name, mission);
            if let Some(tools) = worker.get("tools").and_then(serde_json::Value::as_array) {
                spec = spec.with_tools(tools.iter().filter_map(serde_json::Value::as_str));
            }
            Some(spec)
        });
        let decision = RouterDecision {
            trigger_ids,
            action,
            worker,
            worker_id: item
                .get("workerId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            reason: item
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        };
        decision.validate()?;
        decisions.push(decision);
    }
    Ok(decisions)
}

/// The first JSON object or array in `text`, fences and prose ignored.
fn extract_json(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
    {
        return Some(trimmed);
    }
    let start = trimmed.find(['{', '['])?;
    let end = trimmed.rfind(['}', ']'])?;
    if end <= start {
        return None;
    }
    Some(&trimmed[start..=end])
}

/// How many triggers of the batch the answer actually decided. Anything left
/// over goes back to the queue.
pub fn decided_ids(decisions: &[RouterDecision]) -> Vec<String> {
    decisions
        .iter()
        .flat_map(|decision| decision.trigger_ids.iter().cloned())
        .collect()
}

/// The system prompt of the router: what it is, what it may decide, and the exact
/// wire format.
pub const ROUTER_SYSTEM_PROMPT: &str = "\
You are the router of a supervisor that keeps many tasks moving at once.

You do not do the work yourself. For each event you are given, you decide one of three things:
- `dispatch`: nobody owns the subject yet and it deserves work. Start one worker with a short name and a mission that says what to achieve, what to leave alone, and what the report must contain.
- `passthrough`: a worker already owns the subject. Hand the event to that worker by id; do not start a second one on the same subject.
- `ignore`: nothing worth doing. Give a reason, because the record keeps it.

Rules:
- Decide every trigger id of the batch, exactly once.
- Work nobody asked for is only dispatched when a rule covers it; otherwise `ignore` and say which rule is missing.
- Do not start a worker to ask a person a question. Report that in your `ignore` reason.
- One subject has at most one worker, so prefer `passthrough` whenever an owner exists.

Answer with JSON only:
{\"decisions\":[{\"triggerIds\":[\"id\"],\"action\":\"dispatch\",\"worker\":{\"name\":\"fix-ci\",\"mission\":\"…\"},\"reason\":\"…\"}]}";

/// Compose the router request: the batch plus everything a decision needs and
/// nothing that only the worker would need.
pub fn build_router_prompt(
    batch: &[Trigger],
    threads: &ThreadTable,
    workers: &[super::worker::WorkerView],
    pending_reports: usize,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Batch: {} event(s).", batch.len()));
    if pending_reports > 0 {
        lines.push(format!(
            "{pending_reports} worker report(s) are waiting; they arrive with the next batch."
        ));
    }
    lines.push(String::new());
    lines.push("Events:".into());
    for trigger in batch {
        let owner = threads
            .get(&trigger.thread_key)
            .and_then(|thread| thread.worker.clone())
            .unwrap_or_else(|| "none".to_string());
        lines.push(format!(
            "- id: {}\n  source: {}\n  thread: {}\n  owner: {}\n  urgency: {}\n  addressed: {}\n  summary: {}",
            trigger.id,
            trigger.source.label(),
            trigger.thread_key,
            owner,
            match trigger.urgency {
                Urgency::High => "high",
                Urgency::Normal => "normal",
            },
            trigger.addressed_to_agent,
            trigger.bounded_summary()
        ));
    }
    if !workers.is_empty() {
        lines.push(String::new());
        lines.push("Live workers:".into());
        for worker in workers {
            lines.push(format!(
                "- {} ({}) on {} — {}, {} turn(s), {} tool call(s){}",
                worker.id,
                worker.name,
                worker.thread_key,
                worker.status.as_str(),
                worker.turns,
                worker.tool_calls,
                if worker.report_ready {
                    ", report ready"
                } else {
                    ""
                }
            ));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::trigger::{Source, Trigger};

    fn chat(channel: &str, id: &str, thread: &str) -> Trigger {
        Trigger::from_source(Source::new(SourceKind::Chat, channel), thread, id, "hello")
    }

    #[test]
    fn internal_traffic_is_never_filtered() {
        let policy = RoutePolicy::default().with_sources([SourceKind::Ci]);
        let trigger = Trigger::internal("kernel", "t", "async result");
        assert_eq!(
            policy.classify(&trigger),
            Classification::Accept { provisional: false }
        );
    }

    #[test]
    fn level_one_drops_by_source_channel_and_actor() {
        let policy = RoutePolicy::permissive()
            .with_sources([SourceKind::Chat])
            .with_channels(["feishu:*"])
            .with_actors(["xiongws"]);

        let source_dropped =
            Trigger::from_source(Source::new(SourceKind::Ci, "feishu:dev"), "t", "1", "red")
                .with_actor("xiongws")
                .addressed();
        assert!(matches!(
            policy.classify(&source_dropped),
            Classification::Drop {
                reason: DropReason::SourceNotAllowed { .. }
            }
        ));

        let channel_dropped = chat("github:acme", "2", "t").addressed();
        assert!(matches!(
            policy.classify(&channel_dropped),
            Classification::Drop {
                reason: DropReason::ChannelNotAllowed { .. }
            }
        ));

        let actor_dropped = chat("feishu:dev", "3", "t").with_actor("stranger");
        assert!(matches!(
            policy.classify(&actor_dropped),
            Classification::Drop {
                reason: DropReason::ActorNotAllowed { .. }
            }
        ));
    }

    #[test]
    fn addressed_work_passes_and_unaddressed_work_needs_a_rule() {
        let policy = RoutePolicy::permissive();
        assert_eq!(
            policy.classify(&chat("feishu:dev", "1", "t").addressed()),
            Classification::Accept { provisional: false }
        );
        assert_eq!(
            policy.classify(&chat("feishu:dev", "2", "t")),
            Classification::Drop {
                reason: DropReason::NotAddressed
            }
        );
        let with_rule = RoutePolicy::permissive().with_rule("feishu:dev/*");
        assert_eq!(
            with_rule.classify(&chat("feishu:dev", "3", "feishu:dev/topic-1")),
            Classification::Record { reason: "an unsolicited event matched a rule, but this instance only acts when addressed" }
        );
    }

    #[test]
    fn autonomy_decides_whether_a_rule_may_act() {
        let trigger = chat("feishu:dev", "1", "topic-1");
        let allow = RoutePolicy::permissive()
            .with_rule("topic-1")
            .with_autonomy(Autonomy::RuleAllowlist);
        assert_eq!(
            allow.classify(&trigger),
            Classification::Accept { provisional: true }
        );
        let record_only = RoutePolicy::permissive()
            .with_rule("topic-1")
            .with_autonomy(Autonomy::RecordOnly);
        assert!(matches!(
            record_only.classify(&trigger),
            Classification::Record { .. }
        ));
    }

    #[test]
    fn prefix_rules_match_on_the_written_prefix_only() {
        let key = ThreadKey::new("github:acme/web#pr-12");
        assert!(RoutePolicy::rule_matches("github:acme/web#pr-*", &key));
        assert!(!RoutePolicy::rule_matches("github:other/web#pr-*", &key));
        assert!(!RoutePolicy::rule_matches("github:acme/web#pr-1", &key));
    }

    #[test]
    fn the_queue_puts_urgent_work_first_and_batches() {
        let mut queue = RouterQueue::new();
        queue.push(chat("feishu:dev", "1", "a"));
        queue.push(
            Trigger::from_source(Source::new(SourceKind::Ci, "ci:main"), "b", "2", "red")
                .with_urgency(Urgency::High),
        );
        queue.push(chat("feishu:dev", "3", "c"));
        let batch = queue.take_batch(2);
        assert_eq!(batch[0].id, "ci:main#2");
        assert_eq!(batch.len(), 2);
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn undecided_triggers_are_requeued_then_dropped_with_a_count() {
        let mut queue = RouterQueue::new();
        let trigger = chat("feishu:dev", "1", "a");
        let id = trigger.id.clone();
        queue.push(trigger.clone());
        let batch = queue.take_batch(1);
        assert_eq!(batch.len(), 1);
        queue.requeue(trigger.clone());
        assert_eq!(queue.attempts(&id), Some(1));
        let batch = queue.take_batch(1);
        queue.requeue(batch[0].clone());
        assert_eq!(queue.attempts(&id), Some(2));
        let batch = queue.take_batch(1);
        queue.requeue(batch[0].clone());
        assert!(queue.is_empty());
        assert_eq!(queue.exhausted(), 1);
    }

    #[test]
    fn decisions_parse_from_a_fenced_answer_with_prose() {
        let answer = "Here is my decision:\n```json\n{\"decisions\":[{\"triggerIds\":[\"t1\"],\"action\":\"dispatch\",\"worker\":{\"name\":\"fix-ci\",\"mission\":\"make main green\"},\"reason\":\"build is red\"}]}\n```\nDone.";
        let decisions = parse_router_decisions(answer).unwrap();
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].action, RouterAction::Dispatch);
        assert_eq!(
            decisions[0].worker.as_ref().unwrap().mission,
            "make main green"
        );
        assert_eq!(decided_ids(&decisions), vec!["t1"]);
    }

    #[test]
    fn a_bare_array_and_the_pass_through_spelling_are_accepted() {
        let answer = r#"[{"triggerIds":["t1"],"action":"pass_through","workerId":"worker-1"}]"#;
        let decisions = parse_router_decisions(answer).unwrap();
        assert_eq!(decisions[0].action, RouterAction::PassThrough);
        assert_eq!(decisions[0].worker_id.as_deref(), Some("worker-1"));
    }

    #[test]
    fn unusable_decisions_are_refused_with_a_sentence_for_the_model() {
        let no_action = parse_router_decisions(r#"{"decisions":[{"triggerIds":["t1"]}]}"#);
        let error = no_action.unwrap_err().to_string();
        assert!(error.contains("dispatch"), "{error}");

        let no_ids = parse_router_decisions(r#"{"decisions":[{"action":"ignore"}]}"#);
        assert!(no_ids.unwrap_err().to_string().contains("triggerIds"));

        let dispatch_without_mission = parse_router_decisions(
            r#"{"decisions":[{"triggerIds":["t1"],"action":"dispatch","worker":{"name":"x"}}]}"#,
        );
        assert!(dispatch_without_mission
            .unwrap_err()
            .to_string()
            .contains("worker.mission"));

        let pass_without_worker = parse_router_decisions(
            r#"{"decisions":[{"triggerIds":["t1"],"action":"passthrough"}]}"#,
        );
        assert!(pass_without_worker
            .unwrap_err()
            .to_string()
            .contains("workerId"));

        let prose = parse_router_decisions("I think we should fix it.");
        assert!(prose.unwrap_err().to_string().contains("JSON"));
    }

    #[test]
    fn the_router_prompt_names_the_owner_and_the_contract() {
        let mut threads = ThreadTable::new();
        let trigger = chat("feishu:dev", "1", "topic-1");
        let thread = threads.observe(&trigger.clone());
        thread.worker = Some("worker-1".into());
        let prompt = build_router_prompt(&[trigger], &threads, &[], 2);
        assert!(prompt.contains("owner: worker-1"));
        assert!(prompt.contains("2 worker report(s)"));
        assert!(ROUTER_SYSTEM_PROMPT.contains("passthrough"));
        assert!(ROUTER_SYSTEM_PROMPT.contains("\"decisions\""));
    }
}
