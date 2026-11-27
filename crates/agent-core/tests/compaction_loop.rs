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
    Message, Provider, ProviderErrorKind, ProviderStream, RecordingSink, Result, Role, StopReason,
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

/// The checkpoint has to be durable: a compaction that is only in memory means
/// the next restart rebuilds the rows the summary replaced, which is a different
/// history on every restart. The engine records the cut; the sidecar stores it.
#[tokio::test]
async fn a_threshold_compaction_records_the_cut_it_made() {
    let (model, _, chars) = limits();
    FILLER_CHARS.with(|value| *value.borrow_mut() = chars);
    let provider = Arc::new(BehaviorProvider::new());
    let sink = Arc::new(RecordingSink::new());
    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let engine = engine(provider.clone(), sink.clone())
        .with_model_limits(model)
        .with_compaction_log(log.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("compact me"));

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("the turn must finish even though it compacted");

    let entries = log.lock().expect("log poisoned");
    assert_eq!(entries.len(), 1, "one compaction, one durable record");
    let record = &entries[0];
    assert!(
        record.summary.contains("SUMMARY OF WORK"),
        "the record carries the summary the model wrote: {}",
        record.summary
    );
    assert!(
        !record.through_message_id.is_empty(),
        "the cut must name a stored row, or the store cannot mark the boundary"
    );
    assert!(
        record.tokens_before > 0,
        "the record says what it replaced, so a resume can report it"
    );
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

    // The step after the cut must see the checkpoint in place of the history it
    // replaced — and this turn's own user row, which was never part of that history:
    // the checkpoint rewrites what came before the prompt, never the prompt itself.
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "tool step, then the answer step");
    let after = &requests[1].messages;
    assert_eq!(
        after.len(),
        2,
        "the checkpoint plus this turn's own user row"
    );
    assert!(
        after[0].text().starts_with(CHECKPOINT_HEADER),
        "the model continues from the checkpoint, got: {}",
        after[0].text()
    );
    assert!(after[0].text().contains("SUMMARY OF WORK"));
    assert_eq!(after[1].role, Role::User, "the prompt survived the cut");
    assert_eq!(after[1].text(), "compact me");

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
    assert_eq!(
        transcript.messages().len(),
        3,
        "checkpoint, the turn's own user row, and the answer"
    );
}

/// The user's compaction switch, measured on the loop the sidecar actually runs:
/// a session that turned automatic compaction off is not summarized even though
/// its transcript is past the trigger.
///
/// The case above is the other half of the contract — no setting means the kernel
/// compacts exactly as before this parameter had a reader.
#[tokio::test]
async fn a_session_that_turned_compaction_off_is_not_summarized() {
    let (model, context, chars) = limits();
    FILLER_CHARS.with(|value| *value.borrow_mut() = chars);
    let provider = Arc::new(BehaviorProvider::new());
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone())
        .with_model_limits(model.with_compaction_enabled(false));
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
        .expect("the turn finishes without compacting");

    assert_eq!(outcome.stop_reason, StopReason::EndTurn);
    assert_eq!(
        provider.summaries(),
        0,
        "a session with compaction off must not spend a summary request"
    );
    let requests = provider.requests();
    assert_eq!(requests.len(), 2, "tool step, then the answer step");
    assert!(
        requests
            .iter()
            .flat_map(|request| request.messages.iter())
            .all(|message| !message.text().starts_with(CHECKPOINT_HEADER)),
        "no checkpoint may be installed"
    );
    // The fixture has to have crossed the trigger, or this case proves nothing.
    let tokens = agent_core::context::estimate_context_tokens(&requests[1].messages).tokens;
    assert!(
        tokens >= context.trigger,
        "the later request must be past the trigger: {tokens} < {}",
        context.trigger
    );
    assert!(
        tokens < context.hard_limit,
        "and still below the hard boundary, which is the interval this case is about: {tokens} >= {}",
        context.hard_limit
    );
    assert!(
        !sink
            .events()
            .iter()
            .any(|event| matches!(event, AgentEvent::CompactionStart { .. })),
        "the gate must not even open"
    );
}

/// Characters of filler that carry `tokens` through the tool call's **arguments**
/// alone. Arguments are never aged, so this is the share of an overrun that no
/// free relief can shrink — the request really is that large.
fn argument_chars(tokens: u64) -> usize {
    (tokens as f64 * agent_core::context::ESTIMATED_TEXT_CHARS_PER_TOKEN) as usize
}

/// The switch is off and the next step sits at the hard boundary. The reference
/// refuses that step (`CONTEXT_TOO_LARGE` from `prepareNextTurn`,
/// `packages/agent-runtime/src/runtime.ts:8455`) instead of summarizing around a
/// switch its owner turned off; before this behaviour was ported the kernel
/// opened its overflow compaction there, spending a checkpoint the user had
/// declined and sending a request the boundary exists to prevent.
#[tokio::test]
async fn a_disabled_session_at_the_hard_limit_refuses_the_step_instead_of_compacting() {
    let (model, context, _) = limits();
    // Argument-side filler only: whatever aging does to the tool result, this part
    // of the request stays and pushes it over the hard boundary.
    FILLER_CHARS.with(|value| {
        *value.borrow_mut() = argument_chars(context.hard_limit + context.hard_limit / 4)
    });
    let provider = Arc::new(BehaviorProvider::new());
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone())
        .with_model_limits(model.with_compaction_enabled(false));
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("compact me"));

    let error = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect_err("a session at the hard boundary must not issue the request");

    // The failure is the dedicated budget verdict, not a generic refusal.
    assert!(
        matches!(error, AgentError::ContextTooLarge),
        "expected ContextTooLarge, got: {error:?}"
    );
    assert_eq!(error.code(), "CONTEXT_TOO_LARGE");
    assert!(
        error
            .to_string()
            .contains("while automatic compaction is disabled"),
        "the sentence has to name the switch: {error}"
    );

    // The fixture crossed the boundary, or the case proves nothing.
    let tokens = agent_core::context::estimate_context_tokens(transcript.messages()).tokens;
    assert!(
        tokens >= context.hard_limit,
        "the transcript must be at the hard boundary: {tokens} < {}",
        context.hard_limit
    );

    // No checkpoint was asked for, and no over-budget continuation was sent:
    // the one request recorded is the step before the boundary.
    assert_eq!(
        provider.summaries(),
        0,
        "compaction is off; a summary request would be exactly the ignored switch"
    );
    assert_eq!(
        provider.requests().len(),
        1,
        "the over-budget continuation must not reach the provider"
    );
    let events = sink.events();
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentEvent::CompactionStart { .. })),
        "the gate must not compact around a switch the user turned off"
    );
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::Error { code, message }
                if code == "CONTEXT_TOO_LARGE"
                    && message.contains("automatic compaction is disabled")
        )),
        "the renderer learns why the turn stopped: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentEvent::AgentEnd { .. })),
        "the turn ends on the error, not on a normal agent end"
    );
}

/// The other half of the same branch: with no `compactionSettings` at all the
/// hard boundary is still an escape valve, not a refusal. This is the behaviour
/// the change above must leave untouched — if the refusal ever stopped checking
/// the switch, this case fails.
#[tokio::test]
async fn an_unconfigured_session_at_the_hard_limit_still_compacts_and_continues() {
    // A window whose summary budget can actually hold the overrun, so the
    // checkpoint succeeds and the turn continues on evidence rather than on a
    // fallback.
    let model = ModelLimits::new(32_768, 4_096);
    let context = ContextLimits::for_model(model);
    FILLER_CHARS.with(|value| {
        *value.borrow_mut() = argument_chars(context.hard_limit + context.hard_limit / 4)
    });
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
        .expect("an unconfigured session compacts at the boundary and finishes");

    assert_eq!(outcome.stop_reason, StopReason::EndTurn);
    assert!(
        provider.summaries() >= 1,
        "the escape valve still asks for a checkpoint"
    );
    let events = sink.events();
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::CompactionStart {
                reason: CompactionReason::Overflow
            }
        )),
        "the compaction is the overflow one: {events:?}"
    );
    let requests = provider.requests();
    assert_eq!(
        requests.len(),
        2,
        "the turn continued: tool step, then the answer step"
    );
    let after = agent_core::context::estimate_context_tokens(&requests[1].messages).tokens;
    assert!(
        after < context.hard_limit,
        "the request that went out fits after the checkpoint: {after} >= {}",
        context.hard_limit
    );
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
