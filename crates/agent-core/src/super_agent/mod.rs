//! The Super-agent supervisor: one continuous entity above many isolated workers.
//!
//! A single ReAct loop answers one request at a time. This module is what makes
//! the kernel *one agent* across many tasks instead of *many sessions a person has
//! to keep in their head*, following the DeepSeek Harness design:
//!
//! | Concept | Where it lives |
//! | --- | --- |
//! | Two-level architecture: a router that talks and workers that work | [`router`], [`worker`] |
//! | Event-driven: triggers, threads, two filter levels, pass-through, batching | [`trigger`], [`router`] |
//! | Inline & spill, chain-of-recall | [`recall`] |
//! | Asynchronous ReAct: `start` instead of wait | [`async_task`] |
//! | Independent watchdog | [`watchdog`] |
//! | Compute / state / environment separation | out of scope, see below |
//!
//! Two boundaries are deliberate.
//!
//! * **Compute/state/environment separation** (the "bring your own machine" half of
//!   the design) is a deployment property, not a kernel one: this process already
//!   *is* the compute side, its state is the host's SQLite through `session.*`, and
//!   the environment is reached through the host tool bridge. A worker here is
//!   therefore "isolated context + own stop button", not "separate machine".
//! * **Speaking to people** is not here either. A worker's report goes to
//!   [`worker::RouterInbox`]; the router session is the only thing that answers a
//!   person, and that answer travels the ordinary `agent.event` path.

pub mod async_task;
pub mod recall;
pub mod router;
pub mod runtime;
pub mod trigger;
pub mod watchdog;
pub mod worker;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::message::now_ms;

pub use async_task::{
    AsyncRequest, AsyncRunner, AsyncStatus, AsyncTask, AsyncTaskView, AsyncTasks, TriggerSink,
    ASYNC_TASK_CAPACITY,
};
pub use recall::{NodeKind, RecallMiss, RecallNode, RecallStore};
pub use router::{
    build_router_prompt, decided_ids, parse_router_decisions, Autonomy, Classification, DropReason,
    RecordedAction, RoutePolicy, RouterAction, RouterDecision, RouterQueue, ROUTER_MAX_BATCH,
    ROUTER_SYSTEM_PROMPT,
};
pub use runtime::{
    PromptRunner, RoutedDecisions, TurnRouter, TurnWorker, WorkerOutcome, WorkerRunRequest,
};
pub use trigger::{
    Source, SourceKind, Thread, ThreadKey, ThreadStatus, ThreadTable, Trigger, Urgency,
    MAX_TRIGGER_BODY_CHARS,
};
pub use watchdog::{
    Applied, Intervention, InterventionKind, Judgement, Suspicion, Verdict, Watchdog,
    WatchdogPolicy,
};
pub use worker::{
    RouterInbox, SpawnRefusal, WorkerRecord, WorkerRegistry, WorkerReport, WorkerSpec,
    WorkerStatus, WorkerTurnClaim, WorkerView, MAX_WORKERS,
};

/// How the supervisor is set up. Everything a person would configure lives here,
/// and everything else has a default that suits almost every team.
#[derive(Debug, Clone)]
pub struct SuperAgentConfig {
    /// The session a person talks to. Everything the supervisor produces is
    /// reported here and nowhere else.
    pub router_session: String,
    pub policy: RoutePolicy,
    pub watchdog: WatchdogPolicy,
    pub max_workers: usize,
}

impl Default for SuperAgentConfig {
    fn default() -> Self {
        Self {
            router_session: "router".into(),
            policy: RoutePolicy::default(),
            watchdog: WatchdogPolicy::default(),
            max_workers: MAX_WORKERS,
        }
    }
}

impl SuperAgentConfig {
    pub fn new(router_session: impl Into<String>) -> Self {
        Self {
            router_session: router_session.into(),
            ..Self::default()
        }
    }

    pub fn with_policy(mut self, policy: RoutePolicy) -> Self {
        self.policy = policy;
        self
    }

    pub fn with_watchdog(mut self, watchdog: WatchdogPolicy) -> Self {
        self.watchdog = watchdog;
        self
    }

    pub fn with_max_workers(mut self, max_workers: usize) -> Self {
        self.max_workers = max_workers;
        self
    }
}

/// Where a submitted trigger ended up. This is the answer to the only question a
/// person asks about a silent agent: did it see my event, and what did it do with
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitRoute {
    /// Waiting for a router decision.
    Queued,
    /// Handed to the worker that already owns the thread.
    Delivered,
    /// Recorded instead of done: nobody asked, and the policy does not act on it.
    Recorded,
    /// Filtered out. `reason` says which rule.
    Dropped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitOutcome {
    pub trigger_id: String,
    pub route: SubmitRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SubmitOutcome {
    fn new(trigger_id: impl Into<String>, route: SubmitRoute) -> Self {
        Self {
            trigger_id: trigger_id.into(),
            route,
            worker_id: None,
            reason: None,
        }
    }

    fn with_reason(mut self, reason: impl Into<String>) -> Self {
        self.reason = Some(reason.into());
        self
    }

    fn with_worker(mut self, worker_id: impl Into<String>) -> Self {
        self.worker_id = Some(worker_id.into());
        self
    }
}

/// The batch a router request decides, with its prompt already composed.
#[derive(Debug, Clone)]
pub struct RouterBatch {
    pub triggers: Vec<Trigger>,
    pub system: String,
    pub prompt: String,
}

/// What applying a batch's decisions did.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    /// Workers started, by id, with the name the router gave them.
    pub dispatched: Vec<(String, String)>,
    /// Triggers delivered to an existing worker.
    pub delivered: usize,
    pub ignored: usize,
    /// Decisions that could not be applied (a full team, a vanished worker) and
    /// went back to the queue.
    pub requeued: usize,
    /// Batch triggers the answer never mentioned.
    pub undecided: usize,
}

/// One worker turn the kernel is about to run: the runtime request plus what the
/// supervisor needs to record about it.
#[derive(Debug, Clone)]
pub struct WorkerTurnTask {
    pub request: WorkerRunRequest,
    /// How many events this turn answers.
    pub events: usize,
    /// Started from a written rule rather than from a request.
    pub provisional: bool,
}

/// Render the events of one turn into the text the worker reads.
fn compose_event_text(events: &[Trigger]) -> String {
    events
        .iter()
        .map(|trigger| {
            let body = if trigger.body.is_empty() {
                String::new()
            } else {
                format!("\n{}", trigger.body)
            };
            format!(
                "[{}] {}: {}{}",
                trigger.arrived_at_ms,
                trigger.source.label(),
                trigger.bounded_summary(),
                body
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The supervisor's state, for a panel or a health check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperAgentStatus {
    pub router_session: String,
    pub pending: usize,
    /// Triggers dropped for coming back undecided too often.
    pub exhausted: usize,
    pub threads: usize,
    pub live_workers: usize,
    pub workers: Vec<WorkerView>,
    pub reports_pending: usize,
    /// Reports lost to the inbox bound.
    pub reports_dropped: usize,
    /// Filtered triggers by reason code, so "why so quiet" has an answer.
    pub dropped: BTreeMap<String, usize>,
    pub recorded: usize,
    pub invalid: usize,
    pub async_running: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub key: String,
    pub subject: String,
    pub status: ThreadStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    pub triggers: usize,
    pub updated_at_ms: i64,
}

#[derive(Default)]
struct State {
    triggers: trigger::TriggerStore,
    threads: ThreadTable,
    queue: RouterQueue,
    workers: WorkerRegistry,
    inbox: RouterInbox,
    recorded: Vec<RecordedAction>,
    recall: RecallStore,
    /// Triggers whose policy classification marked them as unsolicited-but-allowed,
    /// so the worker they start is `provisional`.
    provisional: std::collections::HashSet<String>,
    dropped: BTreeMap<String, usize>,
    invalid: usize,
}

/// The supervisor itself. Every method is synchronous: it decides and records, and
/// the actual turns happen in [`runtime`] or in the host, driven by whoever holds
/// the supervisor. That keeps the rules testable without a provider.
pub struct SuperAgent {
    config: SuperAgentConfig,
    state: Mutex<State>,
    async_tasks: Mutex<AsyncTasks>,
    watchdog: Watchdog,
}

impl SuperAgent {
    pub fn new(config: SuperAgentConfig) -> Self {
        let workers = WorkerRegistry::new(config.router_session.clone(), config.max_workers);
        Self {
            state: Mutex::new(State {
                triggers: trigger::TriggerStore::new(trigger::SEEN_TRIGGER_CAPACITY),
                threads: ThreadTable::new(),
                queue: RouterQueue::new(),
                workers,
                inbox: RouterInbox::new(worker::ROUTER_INBOX_CAPACITY),
                recorded: Vec::new(),
                recall: RecallStore::default(),
                provisional: std::collections::HashSet::new(),
                dropped: BTreeMap::new(),
                invalid: 0,
            }),
            async_tasks: Mutex::new(AsyncTasks::default()),
            watchdog: Watchdog::new(config.watchdog.clone()),
            config,
        }
    }

    /// A fresh supervisor over the default policy, for a router session.
    pub fn with_router_session(router_session: impl Into<String>) -> Self {
        Self::new(SuperAgentConfig::new(router_session))
    }

    pub fn config(&self) -> &SuperAgentConfig {
        &self.config
    }

    pub fn watchdog(&self) -> &Watchdog {
        &self.watchdog
    }

    /// The router's session id. A worker's session is derived from it, so the host
    /// can attribute a worker's turns without a second mapping.
    pub fn router_session(&self) -> &str {
        &self.config.router_session
    }

    /// Accept one event.
    ///
    /// The order is the whole design in four steps: identity (a replay is not
    /// work), ownership (an event on an owned thread goes straight to the worker),
    /// program policy (rules drop noise before a token is spent), and finally the
    /// queue the router decides from.
    pub fn submit(&self, trigger: Trigger) -> SubmitOutcome {
        let mut state = self.state.lock().expect("super agent state poisoned");

        if let Err(reason) = trigger.validate() {
            state.invalid += 1;
            return SubmitOutcome::new(trigger.id, SubmitRoute::Dropped).with_reason(reason);
        }
        if !state.triggers.remember(&trigger.id) {
            let outcome = SubmitOutcome::new(trigger.id, SubmitRoute::Dropped)
                .with_reason("this trigger id was already accepted: a replay is not new work");
            Self::count(&mut state, "DUPLICATE");
            return outcome;
        }

        // Inline & spill: the body is stored either way, so a recall never depends
        // on whether it happened to be short enough for the prompt.
        Self::store_trigger(&mut state, &trigger);
        let owner = state.threads.observe(&trigger).worker.clone();
        // The thread node exists as soon as the thread does: a recall from a
        // trigger has to reach its thread whether or not a batch was ever taken.
        Self::sync_thread_node(&mut state, &trigger.thread_key);
        let owner = owner.filter(|worker_id| {
            state
                .workers
                .get(worker_id)
                .map(|record| record.status.is_live())
                .unwrap_or(false)
        });
        if let Some(worker_id) = owner {
            let delivered = state.workers.deliver(&worker_id, trigger.clone());
            return match delivered {
                Ok(()) => {
                    SubmitOutcome::new(trigger.id, SubmitRoute::Delivered).with_worker(worker_id)
                }
                Err(reason) => {
                    // The owner could not take it: fall back to the router rather
                    // than losing the event.
                    state.queue.push(trigger.clone());
                    SubmitOutcome::new(trigger.id, SubmitRoute::Queued).with_reason(format!(
                        "the thread's worker refused it ({reason}); queued instead"
                    ))
                }
            };
        }

        match self.config.policy.classify(&trigger) {
            Classification::Accept { provisional } => {
                if provisional {
                    state.provisional.insert(trigger.id.clone());
                }
                state.queue.push(trigger.clone());
                SubmitOutcome::new(trigger.id, SubmitRoute::Queued)
            }
            Classification::Record { reason } => {
                state.recorded.push(RecordedAction::new(&trigger, reason));
                SubmitOutcome::new(trigger.id, SubmitRoute::Recorded).with_reason(reason)
            }
            Classification::Drop { reason } => {
                Self::count(&mut state, reason.as_str());
                SubmitOutcome::new(trigger.id, SubmitRoute::Dropped).with_reason(reason.to_string())
            }
        }
    }

    fn count(state: &mut State, code: &str) {
        *state.dropped.entry(code.to_string()).or_insert(0) += 1;
    }

    fn store_trigger(state: &mut State, trigger: &Trigger) {
        let thread_id = RecallStore::thread_id(trigger.thread_key.as_str());
        let body = if trigger.body.chars().count() > MAX_TRIGGER_BODY_CHARS {
            let head: String = trigger.body.chars().take(MAX_TRIGGER_BODY_CHARS).collect();
            format!(
                "{head}\n[... {} characters spilled; recall `{}` for the rest ...]",
                trigger.body.chars().count() - MAX_TRIGGER_BODY_CHARS,
                RecallStore::trigger_id(&trigger.id)
            )
        } else if trigger.body.is_empty() {
            trigger.bounded_summary()
        } else {
            trigger.body.clone()
        };
        state.recall.insert(
            RecallNode::new(
                NodeKind::Trigger,
                &trigger.id,
                trigger.bounded_summary(),
                body,
            )
            .with_refs([thread_id]),
        );
    }

    fn sync_thread_node(state: &mut State, thread_key: &ThreadKey) {
        let Some(thread) = state.threads.get(thread_key) else {
            return;
        };
        let refs: Vec<String> = thread
            .triggers
            .iter()
            .map(|id| RecallStore::trigger_id(id))
            .collect();
        let text = format!(
            "status: {}\nowner: {}\n{} event(s) recorded",
            thread.status.as_str(),
            thread.worker.as_deref().unwrap_or("none"),
            thread.triggers.len()
        );
        state.recall.insert(
            RecallNode::new(
                NodeKind::Thread,
                thread_key.as_str(),
                thread.subject.clone(),
                text,
            )
            .with_refs(refs),
        );
    }

    /// Take the next router batch, or `None` when nothing waits.
    pub fn take_batch(&self) -> Option<RouterBatch> {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let batch = state.queue.take_batch(self.config.policy.max_batch.max(1));
        if batch.is_empty() {
            return None;
        }
        for trigger in &batch {
            Self::sync_thread_node(&mut state, &trigger.thread_key);
        }
        let workers = state.workers.views();
        let pending_reports = state.inbox.len();
        let prompt = build_router_prompt(&batch, &state.threads, &workers, pending_reports);
        Some(RouterBatch {
            triggers: batch,
            system: ROUTER_SYSTEM_PROMPT.to_string(),
            prompt,
        })
    }

    /// Apply what the router decided, and put back anything it did not decide.
    pub fn apply_decisions(&self, batch: &[Trigger], decisions: &[RouterDecision]) -> ApplyReport {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let mut report = ApplyReport::default();
        let mut decided: Vec<String> = Vec::new();

        for decision in decisions {
            for trigger_id in &decision.trigger_ids {
                let Some(trigger) = batch.iter().find(|trigger| &trigger.id == trigger_id) else {
                    // An id from another batch: ignore it rather than act on an
                    // event this decision never saw.
                    continue;
                };
                decided.push(trigger_id.clone());
                match decision.action {
                    RouterAction::Dispatch => {
                        let Some(spec) = decision.worker.clone() else {
                            state.queue.requeue(trigger.clone());
                            report.requeued += 1;
                            continue;
                        };
                        let provisional = state.provisional.contains(trigger_id);
                        let spawned = state.workers.spawn(
                            trigger.thread_key.clone(),
                            spec.clone(),
                            provisional,
                            now,
                        );
                        match spawned {
                            Ok(worker_id) => {
                                state.threads.attach(&trigger.thread_key, &worker_id);
                                Self::store_worker(
                                    &mut state,
                                    &worker_id,
                                    &spec,
                                    &trigger.thread_key,
                                );
                                // The trigger that started the worker is its first
                                // event: a worker's work queue is its inbox, whether
                                // the event came from a dispatch or a pass-through.
                                if let Err(reason) =
                                    state.workers.deliver(&worker_id, trigger.clone())
                                {
                                    tracing::debug!(
                                        target: "agent_core::super_agent",
                                        %worker_id,
                                        %reason,
                                        "the dispatching event could not be queued on the new worker"
                                    );
                                }
                                Self::sync_thread_node(&mut state, &trigger.thread_key);
                                report.dispatched.push((worker_id, spec.name));
                            }
                            Err(SpawnRefusal::ThreadBusy { worker_id }) => {
                                // A race: the thread got an owner between the
                                // batch and this decision. Deliver instead.
                                let delivered = state.workers.deliver(&worker_id, trigger.clone());
                                match delivered {
                                    Ok(()) => report.delivered += 1,
                                    Err(_) => {
                                        state.queue.requeue(trigger.clone());
                                        report.requeued += 1;
                                    }
                                }
                            }
                            Err(refusal) => {
                                state.queue.requeue(trigger.clone());
                                report.requeued += 1;
                                tracing::debug!(
                                    target: "agent_core::super_agent",
                                    %trigger_id,
                                    %refusal,
                                    "dispatch refused"
                                );
                            }
                        }
                    }
                    RouterAction::PassThrough => {
                        let worker_id = decision.worker_id.clone().unwrap_or_default();
                        let delivered = state.workers.deliver(&worker_id, trigger.clone());
                        match delivered {
                            Ok(()) => report.delivered += 1,
                            Err(reason) => {
                                tracing::debug!(
                                    target: "agent_core::super_agent",
                                    %trigger_id,
                                    %reason,
                                    "passthrough could not be delivered"
                                );
                                state.queue.requeue(trigger.clone());
                                report.requeued += 1;
                            }
                        }
                    }
                    RouterAction::Ignore => report.ignored += 1,
                }
            }
        }

        for trigger in batch {
            if !decided.iter().any(|id| id == &trigger.id) {
                report.undecided += 1;
                state.queue.requeue(trigger.clone());
            }
        }
        state.queue.settle(&decided);
        report
    }

    fn store_worker(state: &mut State, worker_id: &str, spec: &WorkerSpec, thread_key: &ThreadKey) {
        state.recall.insert(
            RecallNode::new(
                NodeKind::Worker,
                worker_id,
                format!("{} ({worker_id})", spec.name),
                format!("mission: {}\nthread: {thread_key}", spec.mission),
            )
            .with_refs([
                RecallStore::thread_id(thread_key.as_str()),
                RecallStore::report_id(worker_id),
            ]),
        );
    }

    /// A worker finished. Its report goes to the router's inbox and nowhere else,
    /// and the thread keeps its owner so the next event on it continues there.
    ///
    /// This is the host-driven path (`superagent.report`); a turn the kernel ran
    /// itself comes back through [`Self::finish_worker_turn`].
    pub fn complete_worker(
        &self,
        worker_id: &str,
        status: WorkerStatus,
        text: impl Into<String>,
    ) -> Option<WorkerReport> {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let text = text.into();
        let report = state.workers.settle(worker_id, status, text, now)?;
        let report = Self::publish_report(&mut state, report);
        if report.status == WorkerStatus::Settled {
            // The worker stays assigned: its context is this thread, and the next
            // event belongs in it.
            state.workers.mark_waiting(worker_id, now);
        }
        Some(report)
    }

    /// A turn the kernel ran finished: the report goes to the router's inbox and the
    /// worker is either waiting for the next event or freed.
    pub fn finish_worker_turn(
        &self,
        worker_id: &str,
        status: WorkerStatus,
        text: impl Into<String>,
    ) -> Option<WorkerReport> {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let text = text.into();
        let report = state.workers.finish_turn(worker_id, status, text, now)?;
        Some(Self::publish_report(&mut state, report))
    }

    /// The one path a report takes: into the router's inbox, into the recall store,
    /// and into the thread's state. Nothing here can reach a person.
    fn publish_report(state: &mut State, report: WorkerReport) -> WorkerReport {
        let thread_key = report.thread_key.clone();
        state.inbox.push(report.clone());
        state.recall.insert(
            RecallNode::new(
                NodeKind::Report,
                &report.worker_id,
                format!("report from {}", report.name),
                report.text.clone(),
            )
            .with_refs([
                RecallStore::worker_id(&report.worker_id),
                RecallStore::thread_id(thread_key.as_str()),
            ]),
        );
        match report.status {
            WorkerStatus::Settled => state.threads.wait(&thread_key),
            // A stopped or failed worker is replaced by a fresh dispatch, so the
            // thread is released.
            _ => {
                state.threads.release(&thread_key);
                state.workers.release_thread(&thread_key);
            }
        }
        Self::sync_thread_node(state, &thread_key);
        report
    }

    /// Claim a worker turn to run, if any worker has events waiting.
    ///
    /// The kernel runs these itself, so a host only has to deliver events and read
    /// reports. `worker_id` restricts the claim to one worker, which is how a driver
    /// task keeps to the worker it was started for.
    pub fn claim_worker_turn(&self, worker_id: Option<&str>) -> Option<WorkerTurnTask> {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let claim = state.workers.claim_turn(worker_id, now)?;
        let context = state
            .threads
            .get(&claim.thread_key)
            .map(|thread| recall::inline_thread_context(&state.recall, thread));
        let event = compose_event_text(&claim.events);
        tracing::debug!(
            target: "agent_core::super_agent",
            worker = %claim.worker_id,
            events = claim.events.len(),
            provisional = claim.provisional,
            "claimed a worker turn"
        );
        Some(WorkerTurnTask {
            request: WorkerRunRequest {
                session_id: claim.session_id,
                worker_id: claim.worker_id,
                spec: claim.spec,
                context,
                event,
                cancel: claim.cancel,
                // The engine's own ceiling: a worker that needs more than that is
                // looping, and the supervisor hears about it as a failure.
                max_steps: 0,
            },
            events: claim.events.len(),
            provisional: claim.provisional,
        })
    }

    /// Whether any worker has a turn waiting to be run.
    pub fn has_pending_worker_turn(&self) -> bool {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .workers
            .has_pending_turn()
    }

    /// The reports the router has not read yet. One decision covers them all.
    pub fn drain_reports(&self) -> Vec<WorkerReport> {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .inbox
            .drain()
    }

    pub fn pending_reports(&self) -> usize {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .inbox
            .len()
    }

    /// Stop one worker. Returns whether anything was stopped.
    pub fn stop_worker(&self, worker_id: &str) -> bool {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let Some(thread_key) = state
            .workers
            .get(worker_id)
            .map(|record| record.thread_key.clone())
        else {
            return false;
        };
        let stopped = state.workers.stop(worker_id, now, "stopped by a person");
        if stopped {
            state.threads.release(&thread_key);
            state.workers.release_thread(&thread_key);
            Self::sync_thread_node(&mut state, &thread_key);
        }
        stopped
    }

    pub fn status(&self) -> SuperAgentStatus {
        let state = self.state.lock().expect("super agent state poisoned");
        SuperAgentStatus {
            router_session: self.config.router_session.clone(),
            pending: state.queue.len(),
            exhausted: state.queue.exhausted(),
            threads: state.threads.len(),
            live_workers: state.workers.live_count(),
            workers: state.workers.views(),
            reports_pending: state.inbox.len(),
            reports_dropped: state.inbox.dropped(),
            dropped: state.dropped.clone(),
            recorded: state.recorded.len(),
            invalid: state.invalid,
            async_running: self
                .async_tasks
                .lock()
                .map(|tasks| tasks.running())
                .unwrap_or(0),
        }
    }

    pub fn threads(&self) -> Vec<ThreadView> {
        let state = self.state.lock().expect("super agent state poisoned");
        state
            .threads
            .by_recency()
            .into_iter()
            .map(|thread| ThreadView {
                key: thread.key.as_str().to_string(),
                subject: thread.subject.clone(),
                status: thread.status,
                worker: thread.worker.clone(),
                triggers: thread.triggers.len(),
                updated_at_ms: thread.updated_at_ms,
            })
            .collect()
    }

    pub fn worker(&self, worker_id: &str) -> Option<WorkerView> {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .workers
            .get(worker_id)
            .map(WorkerRecord::view)
    }

    /// What the policy recorded instead of doing.
    pub fn recorded(&self) -> Vec<RecordedAction> {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .recorded
            .clone()
    }

    /// Chain-of-recall from one id.
    pub fn recall(&self, id: &str) -> Result<String, RecallMiss> {
        self.state
            .lock()
            .expect("super agent state poisoned")
            .recall
            .recall(id)
    }

    /// The inline block a worker gets with a new event on its thread.
    pub fn inline_context(&self, thread_key: &ThreadKey) -> Option<String> {
        let state = self.state.lock().expect("super agent state poisoned");
        let thread = state.threads.get(thread_key)?;
        Some(recall::inline_thread_context(&state.recall, thread))
    }

    /// Run the program side of the watchdog.
    pub fn watchdog_scan(&self) -> Vec<Intervention> {
        let state = self.state.lock().expect("super agent state poisoned");
        self.watchdog.scan(&state.workers, now_ms())
    }

    pub fn apply_intervention(&self, intervention: &Intervention) -> Applied {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let applied = self.watchdog.apply(&mut state.workers, intervention, now);
        if applied == Applied::Stopped {
            if let Some(thread_key) = state
                .workers
                .get(&intervention.worker_id)
                .map(|record| record.thread_key.clone())
            {
                state.threads.release(&thread_key);
                state.workers.release_thread(&thread_key);
                Self::sync_thread_node(&mut state, &thread_key);
            }
        }
        applied
    }

    /// Start background work that returns its result as a trigger on `thread_key`.
    ///
    /// Requires a Tokio runtime: the work is spawned, which is what "start and
    /// return" means here.
    pub fn start_async(
        self: &Arc<Self>,
        runner: Arc<dyn AsyncRunner>,
        request: AsyncRequest,
    ) -> AsyncTask {
        let sink: Arc<dyn TriggerSink> = self.clone();
        self.async_tasks
            .lock()
            .expect("async registry poisoned")
            .start(runner, request, sink)
    }

    pub fn stop_async(&self, task_id: &str) -> bool {
        self.async_tasks
            .lock()
            .map(|mut tasks| tasks.stop(task_id))
            .unwrap_or(false)
    }

    pub fn async_tasks(&self) -> Vec<AsyncTaskView> {
        self.async_tasks
            .lock()
            .map(|tasks| tasks.views())
            .unwrap_or_default()
    }

    /// Stop everything: workers, background tasks, the watchdog.
    pub fn shutdown(&self) -> usize {
        let mut state = self.state.lock().expect("super agent state poisoned");
        let now = now_ms();
        let stopped = state
            .workers
            .stop_all(now, "the supervisor is shutting down");
        let threads: Vec<ThreadKey> = state
            .threads
            .iter()
            .map(|thread| thread.key.clone())
            .collect();
        for key in threads {
            state.threads.release(&key);
            state.workers.release_thread(&key);
        }
        self.watchdog.shutdown();
        if let Ok(mut tasks) = self.async_tasks.lock() {
            tasks.stop_all();
        }
        stopped
    }
}

impl TriggerSink for SuperAgent {
    fn deliver(&self, trigger: Trigger) {
        let outcome = self.submit(trigger);
        tracing::debug!(
            target: "agent_core::super_agent",
            trigger = %outcome.trigger_id,
            route = ?outcome.route,
            "background result re-entered the event path"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::trigger::Source;

    fn chat(id: &str, thread: &str) -> Trigger {
        Trigger::from_source(
            Source::new(SourceKind::Chat, "feishu:dev"),
            thread,
            id,
            format!("message {id}"),
        )
        .with_actor("xiongws")
        .addressed()
    }

    fn dispatch(name: &str, ids: &[&str]) -> RouterDecision {
        RouterDecision {
            trigger_ids: ids.iter().map(|id| (*id).to_string()).collect(),
            action: RouterAction::Dispatch,
            worker: Some(WorkerSpec::new(name, "make it green")),
            worker_id: None,
            reason: Some("nobody owns it".into()),
        }
    }

    fn agent() -> SuperAgent {
        SuperAgent::new(
            SuperAgentConfig::new("router-1")
                .with_policy(RoutePolicy::permissive().with_autonomy(Autonomy::RuleAllowlist)),
        )
    }

    #[test]
    fn an_addressed_event_is_queued_and_a_replay_is_dropped() {
        let agent = agent();
        let outcome = agent.submit(chat("m-1", "topic-1"));
        assert_eq!(outcome.route, SubmitRoute::Queued);
        let replay = agent.submit(chat("m-1", "topic-1"));
        assert_eq!(replay.route, SubmitRoute::Dropped);
        assert!(replay.reason.unwrap().contains("replay"));
        let status = agent.status();
        assert_eq!(status.pending, 1);
        assert_eq!(status.dropped.get("DUPLICATE"), Some(&1));
    }

    #[test]
    fn an_invalid_trigger_never_reaches_the_queue() {
        let agent = agent();
        let mut broken = chat("m-1", "topic-1");
        broken.summary = "  ".into();
        let outcome = agent.submit(broken);
        assert_eq!(outcome.route, SubmitRoute::Dropped);
        assert!(outcome.reason.unwrap().contains("summary"));
        assert_eq!(agent.status().invalid, 1);
        assert_eq!(agent.status().pending, 0);
    }

    #[test]
    fn unaddressed_work_is_recorded_instead_of_done() {
        let agent = SuperAgent::with_router_session("router-1");
        let trigger = Trigger::from_source(
            Source::new(SourceKind::Chat, "feishu:dev"),
            "topic-1",
            "m-2",
            "why is the build red",
        );
        let outcome = agent.submit(trigger);
        assert_eq!(outcome.route, SubmitRoute::Dropped);
        assert!(outcome.reason.unwrap().contains("nobody addressed"));

        let recording = SuperAgent::new(
            SuperAgentConfig::new("router-1")
                .with_policy(RoutePolicy::permissive().with_rule("topic-1")),
        );
        let outcome = recording.submit(Trigger::from_source(
            Source::new(SourceKind::Chat, "feishu:dev"),
            "topic-1",
            "m-3",
            "why is the build red",
        ));
        assert_eq!(outcome.route, SubmitRoute::Recorded);
        let recorded = recording.recorded();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].trigger_id, "feishu:dev#m-3");
        assert!(recorded[0].reason.contains("only acts when addressed"));
    }

    #[test]
    fn a_dispatch_starts_one_worker_that_owns_the_thread() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().expect("a batch");
        assert_eq!(batch.triggers.len(), 1);
        assert!(batch.prompt.contains("feishu:dev#m-1"));
        let report =
            agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);
        assert_eq!(report.dispatched.len(), 1);
        let status = agent.status();
        assert_eq!(status.live_workers, 1);
        assert_eq!(status.workers[0].name, "fix-ci");
        assert_eq!(agent.threads()[0].worker.as_deref(), Some("worker-1"));
        assert_eq!(agent.threads()[0].status, ThreadStatus::Working);
    }

    #[test]
    fn a_later_event_on_an_owned_thread_skips_the_router() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().unwrap();
        agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);

        let outcome = agent.submit(chat("m-2", "topic-1"));
        assert_eq!(outcome.route, SubmitRoute::Delivered);
        assert_eq!(outcome.worker_id.as_deref(), Some("worker-1"));
        assert_eq!(agent.status().pending, 0, "the router never saw it");
    }

    #[test]
    fn an_undecided_trigger_goes_back_to_the_queue() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        agent.submit(chat("m-2", "topic-2"));
        let batch = agent.take_batch().unwrap();
        let report =
            agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);
        assert_eq!(report.undecided, 1);
        assert_eq!(
            agent.status().pending,
            1,
            "the undecided event waits for the next batch"
        );
        assert_eq!(agent.status().exhausted, 0);
    }

    #[test]
    fn a_full_team_requeues_instead_of_dropping() {
        let agent = SuperAgent::new(SuperAgentConfig::new("router-1").with_max_workers(1));
        agent.submit(chat("m-1", "topic-1"));
        agent.submit(chat("m-2", "topic-2"));
        let batch = agent.take_batch().unwrap();
        let report = agent.apply_decisions(
            &batch.triggers,
            &[
                dispatch("a", &["feishu:dev#m-1"]),
                dispatch("b", &["feishu:dev#m-2"]),
            ],
        );
        assert_eq!(report.dispatched.len(), 1);
        assert_eq!(report.requeued, 1);
        assert_eq!(agent.status().pending, 1);
    }

    #[test]
    fn a_report_goes_to_the_router_inbox_and_keeps_the_thread_owned() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().unwrap();
        agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);

        let report = agent
            .complete_worker("worker-1", WorkerStatus::Settled, "fixed in src/main.rs:12")
            .unwrap();
        assert_eq!(report.worker_id, "worker-1");
        assert_eq!(agent.pending_reports(), 1);
        let drained = agent.drain_reports();
        assert_eq!(drained.len(), 1);
        assert!(drained[0].text.contains("src/main.rs:12"));
        // Still assigned, now waiting: the next event on the thread continues there.
        assert_eq!(agent.threads()[0].status, ThreadStatus::Waiting);
        assert_eq!(
            agent.submit(chat("m-2", "topic-1")).route,
            SubmitRoute::Delivered
        );
    }

    #[test]
    fn stopping_a_worker_releases_the_thread_for_a_fresh_dispatch() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().unwrap();
        agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);
        assert!(agent.stop_worker("worker-1"));
        assert_eq!(agent.threads()[0].worker, None);
        assert_eq!(agent.threads()[0].status, ThreadStatus::Open);
        assert_eq!(
            agent.submit(chat("m-2", "topic-1")).route,
            SubmitRoute::Queued
        );
    }

    #[test]
    fn the_inline_block_and_the_recall_chain_are_reachable_from_the_agent() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1").with_body("the pipeline broke after 4f2c1"));
        let recall = agent.recall("trigger:feishu:dev#m-1").unwrap();
        assert!(recall.contains("the pipeline broke"));
        assert!(recall.contains("thread:topic-1"));
        let chain = agent.recall("thread:topic-1").unwrap();
        assert!(chain.contains("recent") || chain.contains("recalled thread"));
        let inline = agent
            .inline_context(&ThreadKey::new("topic-1"))
            .expect("an inline block");
        assert!(inline.contains("message m-1"));
        assert!(agent.recall("trigger:nope").is_err());
    }

    #[test]
    fn the_watchdog_scans_through_the_supervisor() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().unwrap();
        agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);
        assert!(
            agent.watchdog_scan().is_empty(),
            "a worker that just started is not stalled"
        );
    }

    #[test]
    fn a_large_body_is_spilled_and_recallable_in_full() {
        let agent = agent();
        let huge = "x".repeat(MAX_TRIGGER_BODY_CHARS + 500);
        agent.submit(chat("m-1", "topic-1").with_body(huge.clone()));
        let recalled = agent.recall("trigger:feishu:dev#m-1").unwrap();
        assert!(recalled.contains("spilled"), "{recalled}");
        assert!(recalled.contains("recall `trigger:feishu:dev#m-1`"));
        let inline = agent.inline_context(&ThreadKey::new("topic-1")).unwrap();
        assert!(inline.chars().count() < MAX_TRIGGER_BODY_CHARS);
    }

    #[test]
    fn shutting_down_stops_workers_and_the_watchdog() {
        let agent = agent();
        agent.submit(chat("m-1", "topic-1"));
        let batch = agent.take_batch().unwrap();
        agent.apply_decisions(&batch.triggers, &[dispatch("fix-ci", &["feishu:dev#m-1"])]);
        assert_eq!(agent.shutdown(), 1);
        assert_eq!(agent.status().live_workers, 0);
        assert!(agent.watchdog().is_shutdown());
    }
}
