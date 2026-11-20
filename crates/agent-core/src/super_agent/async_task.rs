//! Asynchronous steps in the ReAct loop: `start` instead of wait.
//!
//! A single loop runs one step at a time, so a tool that takes ten minutes holds
//! the conversation for ten minutes. The fix is to split the call in two: the tool
//! announces that it started and returns at once, and the result arrives later as
//! a new event on the same thread — which is exactly the trigger path the rest of
//! this module already has. The loop keeps serving the person while the work
//! continues in the background.
//!
//! The result is a `Trigger`, so nothing else has to know that a background task
//! produced it: it goes through the same policy, lands on the same thread and, if
//! a worker owns that thread, reaches that worker directly.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;
use crate::error::Result;
use crate::provider::BoxFuture;

use super::trigger::{ThreadKey, Trigger};

/// Background tasks remembered at once. A finished task is dropped oldest-first:
/// what matters about a result is the trigger it produced, not the record.
pub const ASYNC_TASK_CAPACITY: usize = 64;

/// How much of a result travels in the trigger it produces. A background job that
/// dumps a megabyte into the conversation defeats the point of running it in the
/// background.
pub const ASYNC_RESULT_MAX_CHARS: usize = 12_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsyncStatus {
    Running,
    Done,
    Failed,
    Stopped,
}

impl AsyncStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }
}

/// What was started, as the caller sees it: an id and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTask {
    pub id: String,
    pub label: String,
    pub thread_key: ThreadKey,
    pub started_at_ms: i64,
}

/// The request one background run serves.
#[derive(Debug, Clone, PartialEq)]
pub struct AsyncRequest {
    pub id: String,
    pub label: String,
    pub thread_key: ThreadKey,
    /// What the work is: the prompt or the command line the runner needs.
    pub prompt: String,
}

/// Whatever actually does the work. A runner is async and owns nothing of the
/// registry's state, so a test can hand over a future it controls.
pub trait AsyncRunner: Send + Sync {
    fn run<'a>(&'a self, request: AsyncRequest) -> BoxFuture<'a, Result<String>>;
}

/// Where a finished result goes. The supervisor implements this by submitting the
/// trigger, which is what makes the result an ordinary event.
pub trait TriggerSink: Send + Sync {
    fn deliver(&self, trigger: Trigger);
}

#[derive(Debug, Clone)]
pub struct AsyncTaskState {
    pub task: AsyncTask,
    pub status: AsyncStatus,
    /// Stops this task alone.
    pub cancel: CancelToken,
    /// Set when the task ended with a failure.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskView {
    pub id: String,
    pub label: String,
    pub thread_key: ThreadKey,
    pub status: AsyncStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default)]
struct Inner {
    tasks: BTreeMap<String, AsyncTaskState>,
    order: Vec<String>,
    /// Results dropped because the task was stopped first. Counted, so a stop that
    /// silently swallowed work is visible.
    dropped_results: usize,
}

/// The registry of background work.
#[derive(Debug, Clone)]
pub struct AsyncTasks {
    inner: Arc<Mutex<Inner>>,
    capacity: usize,
    next_index: u32,
}

impl Default for AsyncTasks {
    fn default() -> Self {
        Self::new(ASYNC_TASK_CAPACITY)
    }
}

impl AsyncTasks {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            capacity: capacity.max(1),
            next_index: 0,
        }
    }

    /// Start work and return immediately with the id.
    ///
    /// The future runs on the current runtime; when it finishes the registry
    /// records the outcome and the [`TriggerSink`] receives one trigger. A task
    /// stopped before it finished delivers nothing: a result nobody is waiting for
    /// is noise, and the stop already said what happened.
    pub fn start(
        &mut self,
        runner: Arc<dyn AsyncRunner>,
        mut request: AsyncRequest,
        sink: Arc<dyn TriggerSink>,
    ) -> AsyncTask {
        self.next_index += 1;
        let id = if request.id.trim().is_empty() {
            format!("async-{}", self.next_index)
        } else {
            request.id.clone()
        };
        request.id = id.clone();
        let task = AsyncTask {
            id: id.clone(),
            label: request.label.clone(),
            thread_key: request.thread_key.clone(),
            started_at_ms: crate::message::now_ms(),
        };
        let cancel = CancelToken::new();
        {
            let mut inner = self.inner.lock().expect("async registry poisoned");
            inner.tasks.insert(
                id.clone(),
                AsyncTaskState {
                    task: task.clone(),
                    status: AsyncStatus::Running,
                    cancel: cancel.clone(),
                    error: None,
                },
            );
            inner.order.push(id.clone());
            let overflow = inner.order.len().saturating_sub(self.capacity);
            for _ in 0..overflow {
                if let Some(evicted) = inner.order.first().cloned() {
                    // Only a finished task may be evicted: a running one is still
                    // reachable by the id the model holds.
                    let finished = inner
                        .tasks
                        .get(&evicted)
                        .map(|state| !state.status.is_running())
                        .unwrap_or(true);
                    if !finished {
                        break;
                    }
                    inner.order.remove(0);
                    inner.tasks.remove(&evicted);
                }
            }
        }

        let registry = self.clone();
        let run_cancel = cancel.clone();
        let thread_key = request.thread_key.clone();
        let label = request.label.clone();
        tokio::spawn(async move {
            let outcome = tokio::select! {
                biased;
                _ = run_cancel.cancelled() => None,
                outcome = runner.run(request) => Some(outcome),
            };
            let Some(outcome) = outcome else {
                // Stopped: the state already says so and nothing is delivered.
                return;
            };
            match outcome {
                Ok(text) => {
                    registry.finish(&id, AsyncStatus::Done, None);
                    sink.deliver(
                        Trigger::internal(
                            "async",
                            thread_key.as_str(),
                            format!("{label} finished"),
                        )
                        .with_body(bounded_result(&text)),
                    );
                }
                Err(error) => {
                    let message = error.to_string();
                    registry.finish(&id, AsyncStatus::Failed, Some(message.clone()));
                    sink.deliver(
                        Trigger::internal(
                            "async",
                            thread_key.as_str(),
                            format!(
                                "{label} failed: {}",
                                super::trigger::truncate_chars(&message, 200)
                            ),
                        )
                        .with_body(bounded_result(&message)),
                    );
                }
            }
        });

        task
    }

    fn finish(&self, id: &str, status: AsyncStatus, error: Option<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(state) = inner.tasks.get_mut(id) {
                if state.status.is_running() {
                    state.status = status;
                    state.error = error;
                }
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<AsyncTaskState> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.tasks.get(id).cloned())
    }

    pub fn status(&self, id: &str) -> Option<AsyncStatus> {
        self.get(id).map(|state| state.status)
    }

    pub fn running(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .tasks
                    .values()
                    .filter(|state| state.status.is_running())
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn dropped_results(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.dropped_results)
            .unwrap_or(0)
    }

    pub fn views(&self) -> Vec<AsyncTaskView> {
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .order
                    .iter()
                    .filter_map(|id| inner.tasks.get(id))
                    .map(|state| AsyncTaskView {
                        id: state.task.id.clone(),
                        label: state.task.label.clone(),
                        thread_key: state.task.thread_key.clone(),
                        status: state.status,
                        error: state.error.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Stop one task. Its token is cancelled, so the run's own `select` ends it and
    /// no result is delivered.
    pub fn stop(&mut self, id: &str) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return false,
        };
        let Some(state) = inner.tasks.get_mut(id) else {
            return false;
        };
        if !state.status.is_running() {
            return false;
        }
        state.cancel.cancel();
        state.status = AsyncStatus::Stopped;
        inner.dropped_results += 1;
        true
    }

    /// Stop everything, for shutdown or a person's global Stop.
    pub fn stop_all(&mut self) -> usize {
        let ids: Vec<String> = match self.inner.lock() {
            Ok(inner) => inner
                .tasks
                .values()
                .filter(|state| state.status.is_running())
                .map(|state| state.task.id.clone())
                .collect(),
            Err(_) => return 0,
        };
        ids.iter().filter(|id| self.stop(id)).count()
    }
}

fn bounded_result(text: &str) -> String {
    crate::delegate::bounded_report(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    /// A sink that keeps what it was given.
    #[derive(Default)]
    struct RecordingSink {
        triggers: Mutex<Vec<Trigger>>,
    }

    impl RecordingSink {
        fn drained(&self) -> Vec<Trigger> {
            self.triggers
                .lock()
                .map(|mut triggers| triggers.drain(..).collect())
                .unwrap_or_default()
        }
    }

    impl TriggerSink for RecordingSink {
        fn deliver(&self, trigger: Trigger) {
            if let Ok(mut triggers) = self.triggers.lock() {
                triggers.push(trigger);
            }
        }
    }

    /// A runner the test releases when it wants the result.
    struct GatedRunner {
        gate: Arc<Notify>,
        started: Arc<AtomicUsize>,
    }

    impl GatedRunner {
        fn new() -> Self {
            Self {
                gate: Arc::new(Notify::new()),
                started: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl AsyncRunner for GatedRunner {
        fn run<'a>(&'a self, request: AsyncRequest) -> BoxFuture<'a, Result<String>> {
            self.started.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                self.gate.notified().await;
                Ok(format!("ran {}", request.prompt))
            })
        }
    }

    struct FailingRunner;

    impl AsyncRunner for FailingRunner {
        fn run<'a>(&'a self, _request: AsyncRequest) -> BoxFuture<'a, Result<String>> {
            Box::pin(async move {
                Err(crate::error::AgentError::Invalid(
                    "the compiler is missing".into(),
                ))
            })
        }
    }

    fn request() -> AsyncRequest {
        AsyncRequest {
            id: String::new(),
            label: "cargo test".into(),
            thread_key: ThreadKey::new("pr-12"),
            prompt: "cargo test -p agent-core".into(),
        }
    }

    #[tokio::test]
    async fn start_returns_before_the_work_finishes() {
        let runner = Arc::new(GatedRunner::new());
        let sink = Arc::new(RecordingSink::default());
        let mut tasks = AsyncTasks::new(8);
        let task = tasks.start(runner.clone(), request(), sink.clone());
        tokio::task::yield_now().await;
        assert_eq!(task.id, "async-1");
        assert_eq!(runner.started.load(Ordering::SeqCst), 1);
        assert_eq!(tasks.status(&task.id), Some(AsyncStatus::Running));
        assert!(
            sink.drained().is_empty(),
            "no result before the work is done"
        );
        assert_eq!(tasks.running(), 1);
    }

    #[tokio::test]
    async fn a_finished_task_delivers_one_trigger_on_its_thread() {
        let runner = Arc::new(GatedRunner::new());
        let sink = Arc::new(RecordingSink::default());
        let mut tasks = AsyncTasks::new(8);
        let task = tasks.start(runner.clone(), request(), sink.clone());
        runner.gate.notify_one();
        for _ in 0..100 {
            if tasks.status(&task.id) == Some(AsyncStatus::Done) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(tasks.status(&task.id), Some(AsyncStatus::Done));
        let delivered = sink.drained();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].thread_key, ThreadKey::new("pr-12"));
        assert!(delivered[0].summary.contains("cargo test finished"));
        assert!(delivered[0].body.contains("cargo test -p agent-core"));
        assert!(
            delivered[0].addressed_to_agent,
            "a result is the agent's own continuation"
        );
    }

    #[tokio::test]
    async fn a_failed_task_delivers_a_failure_trigger() {
        let sink = Arc::new(RecordingSink::default());
        let mut tasks = AsyncTasks::new(8);
        let task = tasks.start(Arc::new(FailingRunner), request(), sink.clone());
        for _ in 0..100 {
            if tasks.status(&task.id) == Some(AsyncStatus::Failed) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(tasks.status(&task.id), Some(AsyncStatus::Failed));
        let delivered = sink.drained();
        assert_eq!(delivered.len(), 1);
        assert!(delivered[0].summary.contains("failed"));
        assert!(delivered[0].body.contains("the compiler is missing"));
    }

    #[tokio::test]
    async fn a_stopped_task_delivers_nothing() {
        let runner = Arc::new(GatedRunner::new());
        let sink = Arc::new(RecordingSink::default());
        let mut tasks = AsyncTasks::new(8);
        let task = tasks.start(runner.clone(), request(), sink.clone());
        assert!(tasks.stop(&task.id));
        assert_eq!(tasks.status(&task.id), Some(AsyncStatus::Stopped));
        assert_eq!(tasks.dropped_results(), 1);
        runner.gate.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(
            sink.drained().is_empty(),
            "a stopped task's late result must not arrive"
        );
        assert!(!tasks.stop(&task.id), "stopping twice is a no-op");
    }

    #[tokio::test]
    async fn stop_all_ends_every_running_task() {
        let runner = Arc::new(GatedRunner::new());
        let sink = Arc::new(RecordingSink::default());
        let mut tasks = AsyncTasks::new(8);
        tasks.start(runner.clone(), request(), sink.clone());
        tasks.start(runner.clone(), request(), sink.clone());
        assert_eq!(tasks.running(), 2);
        assert_eq!(tasks.stop_all(), 2);
        assert_eq!(tasks.running(), 0);
        assert_eq!(tasks.views().len(), 2);
    }
}
