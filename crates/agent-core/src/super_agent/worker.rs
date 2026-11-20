//! The worker layer: isolated sessions that do the work and report to the router.
//!
//! Two rules shape this module, and both are structural rather than a convention
//! someone has to remember:
//!
//! * **A worker never speaks to a person.** Its output is a [`WorkerReport`] in
//!   the router's inbox; what a panel may show is a [`WorkerView`], which carries
//!   status and counters and no report text at all.
//! * **A worker owns its own context and its own stop button.** Each record holds
//!   a session id distinct from the router's and a [`CancelToken`] that nothing
//!   else can cancel: stopping one worker never affects another, and neither of
//!   them can cancel the router that supervises them.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;

use super::trigger::{ThreadKey, Trigger};

/// Concurrency ceiling, per supervisor.
///
/// A model answers one step at a time and a person can only review so much; past
/// a handful of workers the extra parallelism buys queueing latency, not
/// throughput.
pub const MAX_WORKERS: usize = 8;

/// How much a worker may report back. The same bound as a subagent report: a
/// report is a message to the router's context, not a log.
pub const WORKER_REPORT_MAX_CHARS: usize = 12_000;

/// Triggers a waiting worker may hold. A worker that cannot keep up refuses new
/// work instead of growing a queue nobody reads.
pub const WORKER_INBOX_CAPACITY: usize = 32;

/// Reports the router may have queued before the oldest is dropped.
pub const ROUTER_INBOX_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    /// A turn is in flight.
    #[default]
    Running,
    /// The assignment stands and the worker is waiting for the next event on its
    /// thread. This is a healthy state, not an idle one to be reaped.
    Waiting,
    /// Finished its mission and reported.
    Settled,
    /// Stopped by a person, by the watchdog or by the router.
    Stopped,
    /// Ended in an error; it reported a failure rather than a result.
    Failed,
}

impl WorkerStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Settled => "settled",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    /// Whether the worker can still receive a direct delivery.
    pub fn is_live(&self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }

    /// Whether the record is final.
    pub fn is_settled(&self) -> bool {
        !self.is_live()
    }
}

/// What a thread's worker was told to do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSpec {
    /// Short name the router uses to talk about this worker in later batches.
    pub name: String,
    /// The mission, written by the router: what to achieve, what not to touch,
    /// and what the report has to contain.
    pub mission: String,
    /// Tools this worker may use. `None` means the session's default set; a list
    /// is a restriction, because a worker must not reach a capability the router
    /// deliberately withheld.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

impl WorkerSpec {
    pub fn new(name: impl Into<String>, mission: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            mission: mission.into(),
            tools: None,
        }
    }

    pub fn with_tools<I, S>(mut self, tools: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.tools = Some(tools.into_iter().map(Into::into).collect());
        self
    }
}

/// What a worker hands back. It belongs to the router's inbox — there is no path
/// from here to a person.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReport {
    pub worker_id: String,
    pub name: String,
    pub thread_key: ThreadKey,
    pub status: WorkerStatus,
    /// Bounded to [`WORKER_REPORT_MAX_CHARS`], both ends kept.
    pub text: String,
    pub at_ms: i64,
}

impl WorkerReport {
    pub fn is_failure(&self) -> bool {
        self.status == WorkerStatus::Failed
    }
}

/// A worker as a panel may show it: state and counters, never the report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    pub id: String,
    /// The session the host runs this worker's turns on. It is isolated from the
    /// router's session and from every other worker's — that isolation is the whole
    /// point of the worker layer, so a host that cannot name it cannot drive one.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub name: String,
    pub thread_key: ThreadKey,
    pub status: WorkerStatus,
    /// Started from a written rule rather than from a request. Recorded first;
    /// see [`super::router::Autonomy`].
    pub provisional: bool,
    pub turns: u32,
    pub tool_calls: u32,
    /// That a report exists, not what it says: the report is the router's.
    pub report_ready: bool,
}

/// One running or waiting worker.
#[derive(Debug, Clone)]
pub struct WorkerRecord {
    pub id: String,
    /// A session id of its own: worker contexts are isolated from the router's
    /// and from each other's, which is what lets several tasks run at once
    /// without their intermediate detail interleaving.
    pub session_id: String,
    pub thread_key: ThreadKey,
    pub spec: WorkerSpec,
    pub status: WorkerStatus,
    pub provisional: bool,
    pub started_at_ms: i64,
    /// Last moment the worker showed it was making progress. The watchdog reads
    /// this; a worker that has run for hours but advanced nothing is stalled.
    pub last_progress_ms: i64,
    pub turns: u32,
    pub tool_calls: u32,
    /// Stops this worker and nothing else.
    pub cancel: CancelToken,
    /// Triggers delivered straight to this worker because it owns their thread.
    pub inbox: VecDeque<Trigger>,
    pub report: Option<WorkerReport>,
    /// A turn is being run right now — by the kernel's driver or by the host after
    /// `superagent.pump`. Claiming a turn sets it, finishing one clears it, and it
    /// is what keeps two turns from running on one worker's transcript at once.
    pub in_flight: bool,
}

/// One worker turn the kernel should run: everything the runtime needs, taken out
/// of the record so the turn can run without holding the supervisor's lock.
#[derive(Debug, Clone)]
pub struct WorkerTurnClaim {
    pub worker_id: String,
    pub session_id: String,
    pub spec: WorkerSpec,
    pub thread_key: ThreadKey,
    /// The events this turn answers, drained from the inbox in arrival order.
    pub events: Vec<Trigger>,
    /// The worker's own token: a stop cancels the turn in flight.
    pub cancel: CancelToken,
    pub provisional: bool,
}

impl WorkerRecord {
    pub fn view(&self) -> WorkerView {
        WorkerView {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            name: self.spec.name.clone(),
            thread_key: self.thread_key.clone(),
            status: self.status,
            provisional: self.provisional,
            turns: self.turns,
            tool_calls: self.tool_calls,
            report_ready: self.report.is_some(),
        }
    }

    /// Take the next event delivered to this worker's thread.
    pub fn next_event(&mut self) -> Option<Trigger> {
        self.inbox.pop_front()
    }
}

/// Why a spawn was refused. Both are answers a router can act on, so they carry
/// what the router needs to choose differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnRefusal {
    /// Every worker slot is live.
    CapacityReached { live: usize, max: usize },
    /// The thread already has an owner; send the event to that worker instead.
    ThreadBusy { worker_id: String },
}

impl std::fmt::Display for SpawnRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CapacityReached { live, max } => write!(
                f,
                "all {max} worker slots are busy ({live} live): wait for one to settle or stop one"
            ),
            Self::ThreadBusy { worker_id } => write!(
                f,
                "thread already has a worker ({worker_id}): deliver the event to it instead of starting a second one"
            ),
        }
    }
}

/// The router's inbox of finished work.
#[derive(Debug, Default, Clone)]
pub struct RouterInbox {
    queue: VecDeque<WorkerReport>,
    capacity: usize,
    /// Reports lost to the bound. Surfaced so a silent drop is visible.
    dropped: usize,
}

impl RouterInbox {
    pub fn new(capacity: usize) -> Self {
        Self {
            queue: VecDeque::new(),
            capacity: capacity.max(1),
            dropped: 0,
        }
    }

    pub fn push(&mut self, report: WorkerReport) {
        while self.queue.len() >= self.capacity {
            self.queue.pop_front();
            self.dropped += 1;
        }
        self.queue.push_back(report);
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// Take everything pending: one router decision covers them together, which
    /// is the same batching rule triggers follow.
    pub fn drain(&mut self) -> Vec<WorkerReport> {
        self.queue.drain(..).collect()
    }

    pub fn peek(&self) -> Option<&WorkerReport> {
        self.queue.front()
    }
}

/// Every worker of one supervisor.
#[derive(Debug, Clone)]
pub struct WorkerRegistry {
    router_session: String,
    workers: BTreeMap<String, WorkerRecord>,
    by_thread: HashMap<ThreadKey, String>,
    next_index: u32,
    max_workers: usize,
}

impl WorkerRegistry {
    pub fn new(router_session: impl Into<String>, max_workers: usize) -> Self {
        Self {
            router_session: router_session.into(),
            workers: BTreeMap::new(),
            by_thread: HashMap::new(),
            next_index: 0,
            max_workers: max_workers.max(1),
        }
    }

    pub fn max_workers(&self) -> usize {
        self.max_workers
    }

    pub fn router_session(&self) -> &str {
        &self.router_session
    }

    /// Start a worker on `thread_key`.
    ///
    /// A thread with a live owner is refused rather than given a second worker:
    /// two workers on one Pull Request produce two answers and a conflict nobody
    /// arbitrates.
    pub fn spawn(
        &mut self,
        thread_key: ThreadKey,
        spec: WorkerSpec,
        provisional: bool,
        now_ms: i64,
    ) -> Result<String, SpawnRefusal> {
        if let Some(existing) = self.by_thread.get(&thread_key) {
            if self
                .workers
                .get(existing)
                .map(|record| record.status.is_live())
                .unwrap_or(false)
            {
                return Err(SpawnRefusal::ThreadBusy {
                    worker_id: existing.clone(),
                });
            }
        }
        let live = self.live_count();
        if live >= self.max_workers {
            return Err(SpawnRefusal::CapacityReached {
                live,
                max: self.max_workers,
            });
        }
        self.next_index += 1;
        let id = format!("worker-{}", self.next_index);
        let record = WorkerRecord {
            session_id: format!("{}#{}", self.router_session, id),
            id: id.clone(),
            thread_key: thread_key.clone(),
            spec,
            status: WorkerStatus::Running,
            provisional,
            started_at_ms: now_ms,
            last_progress_ms: now_ms,
            turns: 0,
            tool_calls: 0,
            cancel: CancelToken::new(),
            inbox: VecDeque::new(),
            report: None,
            in_flight: false,
        };
        self.workers.insert(id.clone(), record);
        self.by_thread.insert(thread_key, id.clone());
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Option<&WorkerRecord> {
        self.workers.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut WorkerRecord> {
        self.workers.get_mut(id)
    }

    pub fn by_thread(&self, key: &ThreadKey) -> Option<&WorkerRecord> {
        self.by_thread
            .get(key)
            .and_then(|id| self.workers.get(id))
            .filter(|record| record.status.is_live())
    }

    pub fn live_count(&self) -> usize {
        self.workers
            .values()
            .filter(|record| record.status.is_live())
            .count()
    }

    pub fn len(&self) -> usize {
        self.workers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.workers.is_empty()
    }

    pub fn ids(&self) -> Vec<String> {
        self.workers.keys().cloned().collect()
    }

    /// Every record, live or settled, oldest first. The watchdog looks at all of
    /// them: a worker that failed an hour ago and was never replaced is exactly
    /// what it exists to find.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &WorkerRecord)> {
        self.workers.iter()
    }

    pub fn views(&self) -> Vec<WorkerView> {
        self.workers.values().map(WorkerRecord::view).collect()
    }

    /// Hand an event to the worker that owns its thread.
    ///
    /// This is the subscription pass-through: once a thread is assigned, its
    /// events reach the worker without a router decision, which is what keeps a
    /// busy router from becoming the bottleneck for work already in progress.
    pub fn deliver(&mut self, worker_id: &str, trigger: Trigger) -> Result<(), String> {
        let Some(record) = self.workers.get_mut(worker_id) else {
            return Err(format!("no worker `{worker_id}` in this supervisor"));
        };
        if !record.status.is_live() {
            return Err(format!(
                "worker `{worker_id}` is {}, so the event was not delivered",
                record.status.as_str()
            ));
        }
        if record.inbox.len() >= WORKER_INBOX_CAPACITY {
            return Err(format!(
                "worker `{worker_id}` already holds {} undelivered events: it is behind, not accepting more",
                record.inbox.len()
            ));
        }
        record.inbox.push_back(trigger);
        Ok(())
    }

    /// Record that the worker advanced, so the watchdog does not mistake a long
    /// task for a stuck one.
    pub fn note_progress(&mut self, worker_id: &str, now_ms: i64, turns: u32, tool_calls: u32) {
        if let Some(record) = self.workers.get_mut(worker_id) {
            record.last_progress_ms = now_ms;
            record.turns = turns;
            record.tool_calls = tool_calls;
        }
    }

    /// The worker is between tasks: keep the assignment, stop calling it busy.
    ///
    /// Allowed from `Settled` as well as from a live state, because a worker whose
    /// task finished stays assigned to its thread — its context *is* that thread,
    /// and the next event on it belongs there rather than in a fresh worker.
    pub fn mark_waiting(&mut self, worker_id: &str, now_ms: i64) {
        if let Some(record) = self.workers.get_mut(worker_id) {
            if record.status.is_live() || record.status == WorkerStatus::Settled {
                record.status = WorkerStatus::Waiting;
                record.last_progress_ms = now_ms;
            }
        }
    }

    /// Claim the next turn to run: a live worker with events waiting and no turn in
    /// flight already.
    ///
    /// `only` restricts the claim to one worker, which is what the driver uses for
    /// the worker it was started for. Claiming drains the inbox, so an event is
    /// answered exactly once.
    pub fn claim_turn(&mut self, only: Option<&str>, now_ms: i64) -> Option<WorkerTurnClaim> {
        let candidate = self
            .workers
            .values()
            .find(|record| {
                record.status.is_live()
                    && !record.in_flight
                    && !record.inbox.is_empty()
                    && only.map(|id| id == record.id).unwrap_or(true)
            })
            .map(|record| record.id.clone())?;

        let record = self.workers.get_mut(&candidate)?;
        record.in_flight = true;
        record.status = WorkerStatus::Running;
        record.last_progress_ms = now_ms;
        let events: Vec<Trigger> = record.inbox.drain(..).collect();
        Some(WorkerTurnClaim {
            worker_id: record.id.clone(),
            session_id: record.session_id.clone(),
            spec: record.spec.clone(),
            thread_key: record.thread_key.clone(),
            events,
            cancel: record.cancel.clone(),
            provisional: record.provisional,
        })
    }

    /// A turn finished: report it, and decide whether the worker has more to do.
    ///
    /// A worker with events still queued stays `running` (the driver claims the next
    /// turn); an empty inbox makes it `waiting`, which keeps its thread assigned
    /// without pretending work is in progress.
    pub fn finish_turn(
        &mut self,
        worker_id: &str,
        status: WorkerStatus,
        text: impl Into<String>,
        now_ms: i64,
    ) -> Option<WorkerReport> {
        let report = self.settle(worker_id, status, text, now_ms)?;
        if let Some(record) = self.workers.get_mut(worker_id) {
            record.in_flight = false;
            if report.status == WorkerStatus::Settled {
                record.status = if record.inbox.is_empty() {
                    WorkerStatus::Waiting
                } else {
                    WorkerStatus::Running
                };
            }
        }
        Some(report)
    }

    /// Whether any worker has a turn the kernel should run.
    pub fn has_pending_turn(&self) -> bool {
        self.workers
            .values()
            .any(|record| record.status.is_live() && !record.in_flight && !record.inbox.is_empty())
    }

    /// Finish a worker and return the report the router should read.
    ///
    /// The report is returned rather than stored towards a person: the caller's
    /// only option is the router's inbox.
    pub fn settle(
        &mut self,
        worker_id: &str,
        status: WorkerStatus,
        text: impl Into<String>,
        now_ms: i64,
    ) -> Option<WorkerReport> {
        let record = self.workers.get_mut(worker_id)?;
        if record.status.is_settled() && record.report.is_some() {
            // Already settled: a second settle must not overwrite the report the
            // router may not have read yet.
            return None;
        }
        let status = if status.is_live() {
            WorkerStatus::Settled
        } else {
            status
        };
        let report = WorkerReport {
            worker_id: record.id.clone(),
            name: record.spec.name.clone(),
            thread_key: record.thread_key.clone(),
            status,
            text: crate::delegate::bounded_report(&text.into()),
            at_ms: now_ms,
        };
        record.status = status;
        record.last_progress_ms = now_ms;
        record.report = Some(report.clone());
        Some(report)
    }

    /// Stop one worker: its own token is cancelled and nothing else is.
    pub fn stop(&mut self, worker_id: &str, now_ms: i64, reason: &str) -> bool {
        let Some(record) = self.workers.get_mut(worker_id) else {
            return false;
        };
        if record.status.is_settled() {
            return false;
        }
        record.cancel.cancel();
        record.status = WorkerStatus::Stopped;
        record.last_progress_ms = now_ms;
        record.report = Some(WorkerReport {
            worker_id: record.id.clone(),
            name: record.spec.name.clone(),
            thread_key: record.thread_key.clone(),
            status: WorkerStatus::Stopped,
            text: crate::delegate::bounded_report(reason),
            at_ms: now_ms,
        });
        true
    }

    /// Stop everything, for shutdown or a person's global Stop.
    pub fn stop_all(&mut self, now_ms: i64, reason: &str) -> usize {
        let ids: Vec<String> = self
            .workers
            .values()
            .filter(|record| record.status.is_live())
            .map(|record| record.id.clone())
            .collect();
        for id in &ids {
            self.stop(id, now_ms, reason);
        }
        ids.len()
    }

    /// Release a finished worker's thread so it can be assigned again.
    pub fn release_thread(&mut self, thread_key: &ThreadKey) {
        if let Some(id) = self.by_thread.get(thread_key) {
            let live = self
                .workers
                .get(id)
                .map(|record| record.status.is_live())
                .unwrap_or(false);
            if !live {
                self.by_thread.remove(thread_key);
            }
        }
    }
}

impl Default for WorkerRegistry {
    fn default() -> Self {
        Self::new("router", MAX_WORKERS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::trigger::{Source, SourceKind};

    fn spec(name: &str) -> WorkerSpec {
        WorkerSpec::new(name, "fix the failing pipeline")
    }

    fn trigger(id: &str, thread: &str) -> Trigger {
        Trigger::from_source(
            Source::new(SourceKind::Ci, "ci:main"),
            thread,
            id,
            "build red",
        )
    }

    fn registry() -> WorkerRegistry {
        WorkerRegistry::new("router-1", 2)
    }

    #[test]
    fn a_worker_gets_its_own_session_and_token() {
        let mut registry = registry();
        let first = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        let second = registry
            .spawn(ThreadKey::new("b"), spec("b"), false, 1)
            .unwrap();
        let first_record = registry.get(&first).unwrap();
        let second_record = registry.get(&second).unwrap();
        assert_eq!(first_record.session_id, "router-1#worker-1");
        assert_ne!(first_record.session_id, second_record.session_id);
        assert_eq!(registry.router_session(), "router-1");
        assert_ne!(first_record.session_id, registry.router_session());
    }

    #[test]
    fn one_worker_per_thread_and_a_busy_thread_is_refused() {
        let mut registry = registry();
        registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        let refusal = registry
            .spawn(ThreadKey::new("a"), spec("again"), false, 1)
            .unwrap_err();
        assert!(matches!(refusal, SpawnRefusal::ThreadBusy { .. }));
        assert!(refusal.to_string().contains("deliver the event"));
    }

    #[test]
    fn capacity_is_refused_with_numbers() {
        let mut registry = registry();
        registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        registry
            .spawn(ThreadKey::new("b"), spec("b"), false, 1)
            .unwrap();
        let refusal = registry
            .spawn(ThreadKey::new("c"), spec("c"), false, 1)
            .unwrap_err();
        match &refusal {
            SpawnRefusal::CapacityReached { live, max } => {
                assert_eq!((*live, *max), (2, 2));
            }
            other => panic!("unexpected refusal: {other:?}"),
        }
    }

    #[test]
    fn stopping_one_worker_leaves_the_others_running() {
        let mut registry = registry();
        let first = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        let second = registry
            .spawn(ThreadKey::new("b"), spec("b"), false, 1)
            .unwrap();
        assert!(registry.stop(&first, 2, "person pressed stop"));
        let first = registry.get(&first).unwrap();
        let second = registry.get(&second).unwrap();
        assert!(first.cancel.is_cancelled());
        assert_eq!(first.status, WorkerStatus::Stopped);
        assert!(!second.cancel.is_cancelled());
        assert_eq!(second.status, WorkerStatus::Running);
        assert_eq!(registry.live_count(), 1);
    }

    #[test]
    fn a_panel_view_never_carries_the_report_text() {
        let mut registry = registry();
        let id = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        let report = registry
            .settle(
                &id,
                WorkerStatus::Settled,
                "the fix is in src/main.rs:12",
                5,
            )
            .unwrap();
        assert!(report.text.contains("src/main.rs:12"));
        assert!(!report.is_failure());
        let view = registry.get(&id).unwrap().view();
        assert!(view.report_ready);
        let value = serde_json::to_value(&view).unwrap();
        assert!(
            value.get("report").is_none(),
            "a view must not carry the text"
        );
        assert!(value.get("text").is_none());
        assert_eq!(value["status"], "settled");
    }

    #[test]
    fn a_settled_worker_reports_once() {
        let mut registry = registry();
        let id = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        assert!(registry
            .settle(&id, WorkerStatus::Settled, "first", 2)
            .is_some());
        assert!(
            registry
                .settle(&id, WorkerStatus::Failed, "second", 3)
                .is_none(),
            "the second settle must not overwrite a report the router has not read"
        );
        assert_eq!(
            registry.get(&id).unwrap().report.as_ref().unwrap().text,
            "first"
        );
    }

    #[test]
    fn reports_are_bounded_and_keep_both_ends() {
        let mut registry = registry();
        let id = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        let long = format!("{}TAIL", "x".repeat(WORKER_REPORT_MAX_CHARS + 100));
        let report = registry
            .settle(&id, WorkerStatus::Settled, long, 2)
            .unwrap();
        assert!(report.text.chars().count() <= WORKER_REPORT_MAX_CHARS + 80);
        assert!(report.text.ends_with("TAIL"));
    }

    #[test]
    fn delivery_is_refused_to_a_settled_worker_and_bounded_for_a_live_one() {
        let mut registry = registry();
        let id = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        for index in 0..WORKER_INBOX_CAPACITY {
            registry
                .deliver(&id, trigger(&format!("t-{index}"), "a"))
                .unwrap();
        }
        let refusal = registry.deliver(&id, trigger("t-over", "a")).unwrap_err();
        assert!(refusal.contains("behind"), "{refusal}");
        registry
            .settle(&id, WorkerStatus::Settled, "done", 2)
            .unwrap();
        assert!(registry.deliver(&id, trigger("t-after", "a")).is_err());
    }

    #[test]
    fn a_waiting_worker_still_owns_its_thread() {
        let mut registry = registry();
        let id = registry
            .spawn(ThreadKey::new("a"), spec("a"), false, 1)
            .unwrap();
        registry.mark_waiting(&id, 2);
        let owner = registry.by_thread(&ThreadKey::new("a")).unwrap();
        assert_eq!(owner.id, id);
        assert!(registry.deliver(&id, trigger("t-1", "a")).is_ok());
        registry
            .settle(&id, WorkerStatus::Settled, "done", 3)
            .unwrap();
        assert!(
            registry.by_thread(&ThreadKey::new("a")).is_none(),
            "a settled worker no longer owns the thread"
        );
    }

    #[test]
    fn router_inbox_bounds_and_counts_what_it_drops() {
        let mut inbox = RouterInbox::new(2);
        for index in 0..3 {
            inbox.push(WorkerReport {
                worker_id: format!("w{index}"),
                name: "n".into(),
                thread_key: ThreadKey::new("a"),
                status: WorkerStatus::Settled,
                text: "t".into(),
                at_ms: index as i64,
            });
        }
        assert_eq!(inbox.len(), 2);
        assert_eq!(inbox.dropped(), 1);
        let drained = inbox.drain();
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].worker_id, "w1");
        assert!(inbox.is_empty());
    }
}
