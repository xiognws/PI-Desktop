//! Provider retry inside a turn.
//!
//! A transient gateway failure used to end the user's turn: the kernel could
//! classify it as retryable and still did nothing with the classification. These
//! tests drive `run_turn` against a provider that fails on purpose, and assert
//! what a real session depends on — that a 502 is retried, that an auth failure
//! is not, and that the budget is bounded unless the session opts out.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_core::{
    AgentError, AllowAll, CancelToken, ChatRequest, Provider, ProviderErrorKind, ProviderStream,
    RecordingSink, Result, StopReason, StreamEvent, ToolRegistry, TurnConfig, TurnEngine,
};

/// Fails `failures` times with `error_kind`/`status`, then answers.
struct FlakyProvider {
    failures: usize,
    kind: ProviderErrorKind,
    status: Option<u16>,
    retry_after_ms: Option<u64>,
    attempts: AtomicUsize,
    requests: Mutex<Vec<ChatRequest>>,
}

impl FlakyProvider {
    fn new(
        failures: usize,
        kind: ProviderErrorKind,
        status: Option<u16>,
        retry_after_ms: Option<u64>,
    ) -> Arc<Self> {
        Arc::new(Self {
            failures,
            kind,
            status,
            retry_after_ms,
            attempts: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        })
    }

    fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    fn requests(&self) -> usize {
        self.requests.lock().expect("requests poisoned").len()
    }
}

impl Provider for FlakyProvider {
    fn name(&self) -> &str {
        "flaky"
    }

    fn stream<'a>(
        &'a self,
        request: ChatRequest,
        _cancel: CancelToken,
    ) -> agent_core::provider::BoxFuture<'a, Result<ProviderStream>> {
        self.requests
            .lock()
            .expect("requests poisoned")
            .push(request);
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        let failing = attempt < self.failures;
        let error = match self.status {
            Some(status) => AgentError::provider_status(self.kind, status, "gateway trouble")
                .with_retry_after(self.retry_after_ms),
            None => AgentError::provider(self.kind, "socket closed"),
        };
        Box::pin(async move {
            if failing {
                return Err(error);
            }
            Ok(ProviderStream::from_events(vec![
                StreamEvent::TextDelta("answered".into()),
                StreamEvent::Finish(StopReason::EndTurn),
            ]))
        })
    }
}

async fn run(provider: Arc<dyn Provider>, config: TurnConfig) -> Result<usize> {
    let engine = TurnEngine::new(
        provider,
        Arc::new(ToolRegistry::new(Arc::new(AllowAll))),
        Arc::new(RecordingSink::new()),
    );
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(agent_core::Message::user_text("do the thing"));
    let outcome = engine
        .run_turn("s1", "t1", &mut transcript, &config, CancelToken::new())
        .await;
    outcome.map(|outcome| outcome.steps)
}

#[tokio::test]
async fn a_transient_gateway_failure_is_retried_and_the_turn_finishes() {
    // 1 ms server-stated delay, so the test costs nothing and still proves the
    // response's own delay is what gets honoured.
    let provider = FlakyProvider::new(2, ProviderErrorKind::Retryable, Some(502), Some(1));
    let steps = run(provider.clone(), TurnConfig::new("m"))
        .await
        .expect("the turn survives two 502s");
    assert_eq!(steps, 1, "a retried request is still one step");
    assert_eq!(provider.attempts(), 3, "two failures then the answer");
}

#[tokio::test]
async fn a_rate_limit_is_retried_on_its_own_budget() {
    let provider = FlakyProvider::new(3, ProviderErrorKind::Retryable, Some(429), Some(1));
    run(provider.clone(), TurnConfig::new("m"))
        .await
        .expect("the turn survives three 429s");
    assert_eq!(provider.attempts(), 4);
}

#[tokio::test]
async fn an_auth_failure_is_not_retried_at_all() {
    let provider = FlakyProvider::new(1, ProviderErrorKind::Fatal, Some(401), None);
    let error = run(provider.clone(), TurnConfig::new("m"))
        .await
        .expect_err("auth is terminal");
    assert!(matches!(error, AgentError::Provider { .. }));
    assert_eq!(
        provider.attempts(),
        1,
        "no retry for a failure resending cannot fix"
    );
}

#[tokio::test]
async fn the_bounded_budget_gives_up_after_ten_retries() {
    // Eleven failures with a bounded budget: ten retries are spent, the eleventh
    // answer never arrives.
    let provider = FlakyProvider::new(11, ProviderErrorKind::Retryable, Some(503), Some(1));
    let error = run(provider.clone(), TurnConfig::new("m"))
        .await
        .expect_err("the budget runs out");
    assert!(matches!(error, AgentError::Provider { .. }));
    assert_eq!(
        provider.attempts(),
        11,
        "one first attempt plus ten retries"
    );
}

#[tokio::test]
async fn a_session_that_opts_in_keeps_retrying_past_the_budget() {
    let provider = FlakyProvider::new(12, ProviderErrorKind::Retryable, Some(503), Some(1));
    let mut config = TurnConfig::new("m");
    config.infinite_provider_retry = true;
    run(provider.clone(), config)
        .await
        .expect("an infinite-retry session waits out the outage");
    assert_eq!(provider.attempts(), 13, "the twelfth retry succeeded");
}

#[tokio::test]
async fn a_cancelled_turn_stops_waiting_between_retries() {
    let provider = FlakyProvider::new(50, ProviderErrorKind::Retryable, Some(503), Some(60_000));
    let engine = TurnEngine::new(
        provider.clone(),
        Arc::new(ToolRegistry::new(Arc::new(AllowAll))),
        Arc::new(RecordingSink::new()),
    );
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(agent_core::Message::user_text("do the thing"));
    let cancel = CancelToken::new();
    let cancelling = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancelling.cancel();
    });
    let error = engine
        .run_turn("s1", "t1", &mut transcript, &TurnConfig::new("m"), cancel)
        .await
        .expect_err("a stop during the wait ends the turn");
    assert!(matches!(error, AgentError::Cancelled));
    assert!(
        provider.requests() < 3,
        "the 60s wait was interrupted, not slept through"
    );
}
