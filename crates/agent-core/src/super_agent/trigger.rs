//! Triggers and threads: what drives the agent when nobody is typing.
//!
//! A Trigger is one semi-structured environment event — a chat message, a Pull
//! Request review comment, a CI result, a mail, a calendar reminder — or an
//! internal event the kernel produced itself (an async tool finishing). A Thread
//! is the sequence of triggers that share a subject: one IM topic, one Pull
//! Request, one mail thread. Threads are the unit an owner is assigned to, which
//! is what makes a later event on the same subject reach the worker that is
//! already holding the context instead of the router.
//!
//! Program-side rules live here and nowhere else: identity (dedupe), bounds (a
//! summary is one line, a body is spillable) and the history ring of a thread.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::message::now_ms;

/// A summary is what a router reads for every trigger of a batch. One line, so a
/// hundred of them still fit in one request.
pub const MAX_TRIGGER_SUMMARY_CHARS: usize = 500;

/// A body over this many characters is spilled out of the prompt and handed back
/// only when something recalls it. Inlining a 200 KB CI log is how a single
/// event evicts the whole conversation.
pub const MAX_TRIGGER_BODY_CHARS: usize = 4_000;

/// External ids remembered for duplicate suppression.
///
/// A source that replays its recent window (an IM client reconnecting, a CI
/// webhook retry) would otherwise start the same work twice. The bound is what
/// keeps a long-lived instance from growing an unbounded set.
pub const SEEN_TRIGGER_CAPACITY: usize = 4_096;

/// Triggers remembered per thread. The ring is a hint for recall and the inline
/// context, never the durable record: durable triggers belong to the host.
pub const THREAD_TRIGGER_HISTORY: usize = 64;

/// Where a trigger came from. The kind decides the program-side policy in
/// [`crate::super_agent::router::RoutePolicy`]; `Internal` is the kernel's own
/// traffic and is never filtered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Chat,
    IssueComment,
    PullRequestReview,
    Ci,
    Mail,
    Calendar,
    /// The kernel produced this event itself: an async tool finishing, a worker
    /// reporting, the watchdog noticing a stall.
    Internal,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::IssueComment => "issue_comment",
            Self::PullRequestReview => "pull_request_review",
            Self::Ci => "ci",
            Self::Mail => "mail",
            Self::Calendar => "calendar",
            Self::Internal => "internal",
        }
    }

    /// Parse the wire spelling. Both `issueComment` and `issue_comment` arrive in
    /// practice: a host that speaks camelCase should not have to know this crate's
    /// serde configuration.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "chat" | "im" | "message" => Some(Self::Chat),
            "issue_comment" | "issuecomment" | "issue" => Some(Self::IssueComment),
            "pull_request_review" | "pullrequestreview" | "pull_request" | "review" => {
                Some(Self::PullRequestReview)
            }
            "ci" | "build" | "pipeline" => Some(Self::Ci),
            "mail" | "email" => Some(Self::Mail),
            "calendar" | "schedule" => Some(Self::Calendar),
            "internal" | "kernel" => Some(Self::Internal),
            _ => None,
        }
    }

    /// Whether a person or a system outside the kernel emitted this.
    pub fn is_environment(&self) -> bool {
        !matches!(self, Self::Internal)
    }
}

/// One channel the events arrive on, e.g. `chat` + `feishu:dev-group`,
/// `pull_request_review` + `github:acme/web`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub kind: SourceKind,
    pub channel: String,
}

impl Source {
    pub fn new(kind: SourceKind, channel: impl Into<String>) -> Self {
        Self {
            kind,
            channel: channel.into(),
        }
    }

    pub fn internal(channel: impl Into<String>) -> Self {
        Self::new(SourceKind::Internal, channel)
    }

    /// Stable identity, used for trigger ids and for the program filter's
    /// channel rules.
    pub fn label(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.channel)
    }
}

/// The subject triggers share. Opaque to the kernel: the source decides what
/// "the same thing" means (`github:acme/web#pr-12`, `feishu:dev-group/topic-3`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ThreadKey(String);

impl ThreadKey {
    pub fn new(key: impl Into<String>) -> Self {
        Self(key.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }
}

impl std::fmt::Display for ThreadKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// How fast the event wants attention. A failing pipeline outranks a chat aside;
/// the router sees the ordering rather than having to infer it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Urgency {
    #[default]
    Normal,
    High,
}

/// One environment event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    /// Identity for duplicate suppression. Built from the source's own id so a
    /// replay of the same event is the same trigger.
    pub id: String,
    pub source: Source,
    pub thread_key: ThreadKey,
    /// One line: who wrote what where. This is what a router batch reads.
    pub summary: String,
    /// The payload, bounded. Everything past [`MAX_TRIGGER_BODY_CHARS`] is
    /// spilled and reachable only through recall.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// A person asked the agent, by `@`-mention, by replying to it, or by asking
    /// in a channel that is open to requests. Work that nobody asked for needs a
    /// written rule instead.
    #[serde(default)]
    pub addressed_to_agent: bool,
    #[serde(default)]
    pub urgency: Urgency,
    pub arrived_at_ms: i64,
}

impl Trigger {
    /// A trigger identified by its source's own id, which is what makes a replay
    /// a duplicate instead of a second task.
    pub fn from_source(
        source: Source,
        thread_key: impl Into<String>,
        external_id: impl AsRef<str>,
        summary: impl Into<String>,
    ) -> Self {
        let id = format!("{}#{}", source.channel, external_id.as_ref());
        Self {
            id,
            source,
            thread_key: ThreadKey::new(thread_key),
            summary: summary.into(),
            body: String::new(),
            actor: None,
            addressed_to_agent: false,
            urgency: Urgency::Normal,
            arrived_at_ms: now_ms(),
        }
    }

    /// A trigger the kernel produced. Always addressed: it is the agent's own
    /// continuation, so the addressed-work rule does not apply to it.
    pub fn internal(
        channel: impl Into<String>,
        thread_key: impl Into<String>,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            id: format!("internal:{}", uuid::Uuid::new_v4()),
            source: Source::internal(channel),
            thread_key: ThreadKey::new(thread_key),
            summary: summary.into(),
            body: String::new(),
            actor: None,
            addressed_to_agent: true,
            urgency: Urgency::Normal,
            arrived_at_ms: now_ms(),
        }
    }

    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }

    pub fn with_actor(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    pub fn addressed(mut self) -> Self {
        self.addressed_to_agent = true;
        self
    }

    pub fn with_urgency(mut self, urgency: Urgency) -> Self {
        self.urgency = urgency;
        self
    }

    /// Check the invariants a source has to satisfy, with a sentence the host can
    /// log. A trigger that fails here never reaches a router: a batch with an
    /// empty summary teaches the router nothing and still costs tokens.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("trigger.id is required".into());
        }
        if self.thread_key.is_empty() {
            return Err(format!("trigger `{}` has no threadKey", self.id));
        }
        if self.source.channel.trim().is_empty() {
            return Err(format!("trigger `{}` has no source channel", self.id));
        }
        if self.summary.trim().is_empty() {
            return Err(format!("trigger `{}` has no summary", self.id));
        }
        Ok(())
    }

    /// The summary as a router should see it: one bounded line.
    pub fn bounded_summary(&self) -> String {
        truncate_chars(&self.summary, MAX_TRIGGER_SUMMARY_CHARS)
    }

    /// Read a trigger from the wire, which is how an environment event reaches the
    /// kernel: `{id, source:{kind, channel}, threadKey, summary, body?, actor?,
    /// addressedToAgent?, urgency?}`.
    ///
    /// Field names are the ones an integration already sends; `text` is accepted for
    /// `summary` because a chat adapter usually has only that.
    pub fn from_value(value: &serde_json::Value) -> Result<Self, String> {
        let source = value
            .get("source")
            .ok_or_else(|| "trigger.source is required".to_string())?;
        let kind = source
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .and_then(SourceKind::parse)
            .ok_or_else(|| {
                "trigger.source.kind must be one of chat, issue_comment, pull_request_review, ci, mail, calendar, internal"
                    .to_string()
            })?;
        let channel = source
            .get("channel")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let thread_key = value
            .get("threadKey")
            .or_else(|| value.get("thread"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "trigger.threadKey is required".to_string())?;
        let summary = value
            .get("summary")
            .or_else(|| value.get("text"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "trigger.summary is required".to_string())?;
        let external_id = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let trigger = if external_id.is_empty() {
            Self::internal(channel.clone(), thread_key, summary)
        } else {
            Self::from_source(Source::new(kind, channel), thread_key, external_id, summary)
        };
        let mut trigger = trigger;
        // An explicit id wins over the one derived from the source, because a
        // reconciling host may already have used it as a handle.
        if !external_id.is_empty() && external_id.contains(':') {
            trigger.id = external_id.to_string();
        }
        trigger.body = value
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        trigger.actor = value
            .get("actor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        trigger.addressed_to_agent = value
            .get("addressedToAgent")
            .or_else(|| value.get("addressed"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        trigger.urgency = match value
            .get("urgency")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
        {
            Some("high") => Urgency::High,
            _ => Urgency::Normal,
        };
        trigger.validate()?;
        Ok(trigger)
    }
}

/// Cut to `limit` characters, counting characters rather than bytes: a Chinese
/// summary is three bytes per character.
pub fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

/// Duplicate suppression with a bounded memory.
#[derive(Debug, Default, Clone)]
pub struct TriggerStore {
    seen: HashSet<String>,
    order: VecDeque<String>,
    capacity: usize,
}

impl TriggerStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }

    pub fn knows(&self, id: &str) -> bool {
        self.seen.contains(id)
    }

    /// Remember an id. Returns `false` when it was already known, which is the
    /// caller's signal that the trigger is a replay.
    pub fn remember(&mut self, id: &str) -> bool {
        if !self.seen.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.seen.remove(&evicted);
            }
        }
        true
    }
}

/// A thread's state. `Waiting` is the state a worker leaves its thread in: the
/// assignment stands, nothing is running, and the next trigger on this subject
/// goes straight to that worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    #[default]
    Open,
    Working,
    Waiting,
    Closed,
}

impl ThreadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Closed => "closed",
        }
    }

    /// Whether a trigger on this thread has someone to go to.
    pub fn has_owner(&self) -> bool {
        matches!(self, Self::Working | Self::Waiting)
    }
}

/// One subject's history: the ring of trigger ids, the owner, and the state a
/// panel or a router reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Thread {
    pub key: ThreadKey,
    pub source: Source,
    pub subject: String,
    pub triggers: Vec<String>,
    pub worker: Option<String>,
    pub status: ThreadStatus,
    pub updated_at_ms: i64,
}

impl Thread {
    fn new(trigger: &Trigger) -> Self {
        Self {
            key: trigger.thread_key.clone(),
            source: trigger.source.clone(),
            subject: trigger.bounded_summary(),
            triggers: vec![trigger.id.clone()],
            worker: None,
            status: ThreadStatus::Open,
            updated_at_ms: trigger.arrived_at_ms,
        }
    }

    /// Remember one more trigger, keeping the ring bounded and the ids unique.
    fn remember(&mut self, trigger: &Trigger) {
        self.updated_at_ms = trigger.arrived_at_ms;
        if self.triggers.last().map(String::as_str) != Some(trigger.id.as_str()) {
            self.triggers.push(trigger.id.clone());
        }
        while self.triggers.len() > THREAD_TRIGGER_HISTORY {
            self.triggers.remove(0);
        }
    }

    /// The newest `n` trigger ids, oldest first.
    pub fn recent(&self, n: usize) -> &[String] {
        let start = self.triggers.len().saturating_sub(n);
        &self.triggers[start..]
    }
}

/// The table of live threads. A thread is created by its first trigger and never
/// removed while the process lives: it is the cheap index that lets a repeated
/// subject find its owner.
#[derive(Debug, Default, Clone)]
pub struct ThreadTable {
    threads: HashMap<ThreadKey, Thread>,
}

impl ThreadTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a trigger on its thread, creating the thread the first time.
    pub fn observe(&mut self, trigger: &Trigger) -> &mut Thread {
        let entry = self
            .threads
            .entry(trigger.thread_key.clone())
            .or_insert_with(|| Thread::new(trigger));
        entry.remember(trigger);
        entry.updated_at_ms = trigger.arrived_at_ms;
        entry
    }

    pub fn get(&self, key: &ThreadKey) -> Option<&Thread> {
        self.threads.get(key)
    }

    pub fn get_mut(&mut self, key: &ThreadKey) -> Option<&mut Thread> {
        self.threads.get_mut(key)
    }

    pub fn len(&self) -> usize {
        self.threads.len()
    }

    pub fn is_empty(&self) -> bool {
        self.threads.is_empty()
    }

    /// Attach an owner and mark the thread as being worked on. One worker per
    /// thread is the invariant that keeps two workers from both answering the
    /// same Pull Request.
    pub fn attach(&mut self, key: &ThreadKey, worker_id: &str) -> bool {
        let Some(thread) = self.threads.get_mut(key) else {
            return false;
        };
        if thread.worker.is_some() {
            return false;
        }
        thread.worker = Some(worker_id.to_string());
        thread.status = ThreadStatus::Working;
        true
    }

    /// The owner is between tasks: still assigned, nothing running.
    pub fn wait(&mut self, key: &ThreadKey) {
        if let Some(thread) = self.threads.get_mut(key) {
            thread.status = ThreadStatus::Waiting;
        }
    }

    /// The owner is gone; the thread keeps its history and may be assigned again.
    pub fn release(&mut self, key: &ThreadKey) {
        if let Some(thread) = self.threads.get_mut(key) {
            thread.worker = None;
            thread.status = ThreadStatus::Open;
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &Thread> {
        self.threads.values()
    }

    /// Threads ordered by most recent activity, which is the order a person wants
    /// to see them in.
    pub fn by_recency(&self) -> Vec<&Thread> {
        let mut threads: Vec<&Thread> = self.threads.values().collect();
        threads.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| left.key.cmp(&right.key))
        });
        threads
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(id: &str, thread: &str) -> Trigger {
        Trigger::from_source(
            Source::new(SourceKind::Chat, "feishu:dev"),
            thread,
            id,
            format!("message {id}"),
        )
    }

    #[test]
    fn source_label_is_stable_and_kind_prefixed() {
        let source = Source::new(SourceKind::PullRequestReview, "github:acme/web");
        assert_eq!(source.label(), "pull_request_review:github:acme/web");
        assert!(source.kind.is_environment());
        assert!(!Source::internal("kernel").kind.is_environment());
    }

    #[test]
    fn a_replayed_event_is_the_same_trigger() {
        let first = chat("m-1", "t");
        let second = chat("m-1", "t");
        assert_eq!(first.id, second.id);
        assert_eq!(first.id, "feishu:dev#m-1");
    }

    #[test]
    fn validation_names_the_missing_field() {
        let mut trigger = chat("m-1", "t");
        assert!(trigger.validate().is_ok());
        trigger.summary = "   ".into();
        let error = trigger.validate().unwrap_err();
        assert!(error.contains("summary"), "{error}");

        let mut trigger = chat("m-1", "");
        trigger.thread_key = ThreadKey::new("");
        assert!(trigger.validate().unwrap_err().contains("threadKey"));
    }

    #[test]
    fn summaries_are_cut_to_one_bounded_line() {
        let long = "长".repeat(MAX_TRIGGER_SUMMARY_CHARS + 10);
        let trigger = chat("m-1", "t").with_body("x");
        let bounded = Trigger {
            summary: long,
            ..trigger
        }
        .bounded_summary();
        // Characters, not bytes: 500 Chinese characters plus the ellipsis.
        assert_eq!(bounded.chars().count(), MAX_TRIGGER_SUMMARY_CHARS + 1);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn internal_triggers_are_always_addressed() {
        let trigger = Trigger::internal("async", "thread-1", "tool finished");
        assert!(trigger.addressed_to_agent);
        assert!(!trigger.source.kind.is_environment());
        assert!(trigger.id.starts_with("internal:"));
    }

    #[test]
    fn duplicate_suppression_forgets_the_oldest_ids_only() {
        let mut store = TriggerStore::new(2);
        assert!(store.remember("a"));
        assert!(store.remember("b"));
        assert!(!store.remember("a"));
        assert!(store.remember("c"));
        assert!(!store.knows("a"), "the oldest id is evicted");
        assert!(store.knows("b") && store.knows("c"));
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn thread_history_is_bounded_and_ordered() {
        let mut table = ThreadTable::new();
        for index in 0..(THREAD_TRIGGER_HISTORY + 5) {
            let mut trigger = chat(&format!("m-{index}"), "t");
            trigger.arrived_at_ms = index as i64;
            table.observe(&trigger);
        }
        let thread = table.get(&ThreadKey::new("t")).unwrap();
        assert_eq!(thread.triggers.len(), THREAD_TRIGGER_HISTORY);
        assert_eq!(
            thread.triggers.last().unwrap(),
            &format!("feishu:dev#m-{}", THREAD_TRIGGER_HISTORY + 4)
        );
        assert_eq!(thread.recent(2).len(), 2);
    }

    #[test]
    fn one_worker_per_thread() {
        let mut table = ThreadTable::new();
        table.observe(&chat("m-1", "pr-12"));
        assert!(table.attach(&ThreadKey::new("pr-12"), "w1"));
        assert!(!table.attach(&ThreadKey::new("pr-12"), "w2"));
        assert_eq!(
            table
                .get(&ThreadKey::new("pr-12"))
                .unwrap()
                .worker
                .as_deref(),
            Some("w1")
        );
        table.release(&ThreadKey::new("pr-12"));
        assert!(table.attach(&ThreadKey::new("pr-12"), "w2"));
    }

    #[test]
    fn threads_list_newest_activity_first() {
        let mut table = ThreadTable::new();
        let mut older = chat("m-1", "a");
        older.arrived_at_ms = 1;
        let mut newer = chat("m-2", "b");
        newer.arrived_at_ms = 2;
        table.observe(&older);
        table.observe(&newer);
        let keys: Vec<&str> = table
            .by_recency()
            .into_iter()
            .map(|thread| thread.key.as_str())
            .collect();
        assert_eq!(keys, vec!["b", "a"]);
    }
}
