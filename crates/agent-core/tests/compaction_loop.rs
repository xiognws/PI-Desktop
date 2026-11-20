//! Compaction inside the turn loop.
//!
//! These enter from `TurnEngine::run_turn` — the entry the sidecar uses — so
//! what is covered is the real order: gate before the request, summary request
//! through the provider, checkpoint installed, then the next request. A test
//! that called `plan_compaction` directly would pass while the loop silently
//! never compacts, which is the failure this file exists to catch.

use std::sync::Arc;

use agent_core::compaction::CHECKPOINT_HEADER;
use agent_core::context::{ContextLimits, ModelLimits};
use agent_core::provider::scripted::ScriptedProvider;
use agent_core::{
    AgentError, AgentEvent, AllowAll, CancelToken, CompactionFallback, CompactionReason, EventSink,
    Message, Provider, ProviderErrorKind, ProviderStream, RecordingSink, Result, StopReason,
    StreamEvent, Tool, ToolCall, ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine,
};
use serde_json::Value;

struct EchoTool;

impl Tool for EchoTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "echo",
            "Echo text",
            serde_json::json!({"type": "object", "properties": {"text": {"type": "string"}}}),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            Ok(format!(
                "echo: {}",
                call.arguments
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ))
        })
    }
}

fn engine(provider: Arc<dyn Provider>, sink: Arc<RecordingSink>) -> TurnEngine {
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(EchoTool));
    TurnEngine::new(provider, Arc::new(registry), sink as Arc<dyn EventSink>)
}

fn tool_call_events(id: &str, name: &str, arguments: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ToolCallStart {
            index: 0,
            id: id.into(),
            name: name.into(),
        },
        StreamEvent::ToolCallDelta {
            index: 0,
            arguments_delta: arguments.into(),
        },
        StreamEvent::Finish(StopReason::ToolUse),
    ]
}

fn answer_events(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta(text.into()),
        StreamEvent::Finish(StopReason::EndTurn),
    ]
}

/// A window small enough that one large tool result crosses the trigger, and
/// large enough that the same result does not cross the hard boundary: the
/// difference is what distinguishes a threshold compaction from an overflow.
fn limits() -> (ModelLimits, ContextLimits, usize) {
    let model = ModelLimits::new(2_000, 256);
    let context = ContextLimits::for_model(model);
    // Aim at the middle of the trigger..hard window, in characters (3.5 chars
    // per token is the estimator the kernel itself uses). The filler is counted
    // twice on purpose: it travels in the tool call's arguments and again in the
    // result, and both are part of the request the gate measures.
    let target = context.trigger + (context.hard_limit - context.trigger) / 2;
    let chars =
        (target as f64 * agent_core::context::ESTIMATED_TEXT_CHARS_PER_TOKEN / 2.0) as usize;
    (model, context, chars)
}

/// Answers by role rather than by position: the first non-summary request calls
/// the tool, later ones finish, and every summary request gets the same text.
/// Positional scripts cannot express this because how many summary requests the
/// engine needs depends on how the range is chunked, which is exactly what the
/// engine is allowed to vary.
struct BehaviorProvider {
    requests: std::sync::Mutex<Vec<agent_core::ChatRequest>>,
    steps: std::sync::atomic::AtomicUsize,
    summaries: std::sync::atomic::AtomicUsize,
}

impl BehaviorProvider {
    fn new() -> Self {
        Self {
            requests: std::sync::Mutex::new(Vec::new()),
            steps: std::sync::atomic::AtomicUsize::new(0),
            summaries: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn requests(&self) -> Vec<agent_core::ChatRequest> {
        self.requests.lock().expect("requests poisoned").clone()
    }

    fn summaries(&self) -> usize {
        self.summaries.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn is_summary(request: &agent_core::ChatRequest) -> bool {
        request
            .system
            .as_deref()
            .is_some_and(|system| system.contains("compacting a long agent conversation"))
    }
}

impl Provider for BehaviorProvider {
    fn name(&self) -> &str {
        "behavior"
    }

    fn stream<'a>(
        &'a self,
        request: agent_core::ChatRequest,
        _cancel: CancelToken,
    ) -> agent_core::provider::BoxFuture<'a, Result<ProviderStream>> {
        let is_summary = Self::is_summary(&request);
        if is_summary {
            self.summaries
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        } else {
            self.requests
                .lock()
                .expect("requests poisoned")
                .push(request);
        }
        let step = self.steps.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if is_summary {
                return Ok(ProviderStream::from_events(answer_events(
                    "SUMMARY OF WORK",
                )));
            }
            // The tool call is what makes the transcript grow; every later step
            // just answers.
            let events = if step == 0 {
                let filler = "x".repeat(FILLER_CHARS.with(|chars| *chars.borrow()));
                tool_call_events("call_1", "echo", &format!("{{\"text\":\"{filler}\"}}"))
            } else {
                answer_events("finished")
            };
            Ok(ProviderStream::from_events(events))
        })
    }
}

thread_local! {
    static FILLER_CHARS: std::cell::RefCell<usize> = const { std::cell::RefCell::new(0) };
}

#[tokio::test]
async fn a_transcript_past_the_trigger_is_summarized_before_the_next_request() {
    let (model, _, chars) = limits();
    FILLER_CHARS.with(|value| *value.borrow_mut() = chars);
    let provider = Arc::new(BehaviorProvider::new());
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone()).with_model_limits(model);
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("compact me"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("the turn must finish even though it compacted");

    assert_eq!(outcome.stop_reason, StopReason::EndTurn);
    assert!(provider.summaries() >= 1, "the engine asked for a summary");

    // The step after the cut must see the checkpoint and nothing else.
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "tool step, then the answer step");
    let after = &requests[1].messages;
    assert_eq!(after.len(), 1, "the checkpoint replaced the history");
    assert!(
        after[0].text().starts_with(CHECKPOINT_HEADER),
        "the model continues from the checkpoint, got: {}",
        after[0].text()
    );
    assert!(after[0].text().contains("SUMMARY OF WORK"));

    // A completed-turn checkpoint carries no history forward.
    let events = sink.events();
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::CompactionStart {
            reason: CompactionReason::Threshold
        }
    )));
    let end = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::CompactionEnd { ok, .. } => Some(*ok),
            _ => None,
        })
        .expect("a compaction end event");
    assert!(end, "the summary succeeded");
    assert_eq!(transcript.messages().len(), 2, "checkpoint plus the answer");
}

/// Fails only the summary request, so the test can drive the fallback path
/// without also breaking the turn's own requests.
struct FailingSummaryProvider {
    inner: ScriptedProvider,
    summary_attempts: Arc<std::sync::atomic::AtomicUsize>,
}

impl Provider for FailingSummaryProvider {
    fn name(&self) -> &str {
        "failing-summary"
    }

    fn stream<'a>(
        &'a self,
        request: agent_core::ChatRequest,
        cancel: CancelToken,
    ) -> agent_core::provider::BoxFuture<'a, Result<ProviderStream>> {
        let is_summary = request
            .system
            .as_deref()
            .is_some_and(|system| system.contains("compacting a long agent conversation"));
        if is_summary {
            self.summary_attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            return Box::pin(async move {
                // Fatal, not transient: a retry loop would only delay the
                // fallback this test is about.
                Err(AgentError::provider(
                    ProviderErrorKind::Fatal,
                    "summary provider is down",
                ))
            });
        }
        self.inner.stream(request, cancel)
    }
}

#[tokio::test]
async fn a_failed_summary_keeps_the_recent_window_and_lets_the_turn_continue() {
    let (model, _, chars) = limits();
    let filler = "y".repeat(chars);
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let provider = Arc::new(FailingSummaryProvider {
        inner: ScriptedProvider::new(vec![
            tool_call_events("call_1", "echo", &format!("{{\"text\":\"{filler}\"}}")),
            answer_events("done"),
        ]),
        summary_attempts: attempts.clone(),
    });
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone()).with_model_limits(model);
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("compact me"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("a summary failure must not abandon the turn");

    assert_eq!(outcome.stop_reason, StopReason::EndTurn);
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);

    let events = sink.events();
    let end = events
        .iter()
        .find_map(|event| match event {
            AgentEvent::CompactionEnd {
                ok,
                fallback,
                error,
                ..
            } => Some((*ok, *fallback, error.clone())),
            _ => None,
        })
        .expect("a compaction end event");
    assert!(!end.0, "the summary did not succeed");
    assert_eq!(end.1, Some(CompactionFallback::RetainedTail));
    assert!(end.2.is_some(), "the failure is reported, not swallowed");

    // The model is told the history was cut without a summary, and the retained
    // tail still carries the newest rows.
    assert!(transcript.messages()[0]
        .text()
        .contains("compacted without a summary"));
    assert!(
        transcript.messages().len() > 1,
        "the recent window survived the fallback"
    );
    assert!(matches!(events.last(), Some(AgentEvent::AgentEnd { .. })));
}
