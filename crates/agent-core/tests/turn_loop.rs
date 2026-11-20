//! End-to-end turn tests: real loop, real registry, scripted provider.
//!
//! These enter from the same public entry point the sidecar will use
//! (`TurnEngine::run_turn`) rather than from an extracted helper, so the
//! ordering the renderer depends on is actually covered.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::provider::scripted::ScriptedProvider;
use agent_core::{
    AgentError, AgentEvent, AllowAll, CancelToken, ContentPart, EventSink, Message, Provider,
    ProviderStream, RecordingSink, Result, Role, StopReason, StreamEvent, Tool, ToolCall,
    ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine, Usage,
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

fn registry() -> Arc<ToolRegistry> {
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(EchoTool));
    Arc::new(registry)
}

fn engine(provider: Arc<dyn Provider>, sink: Arc<RecordingSink>) -> TurnEngine {
    TurnEngine::new(provider, registry(), sink as Arc<dyn EventSink>)
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

#[tokio::test]
async fn a_turn_runs_the_tool_and_answers_with_its_output() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call_events("call_1", "echo", "{\"text\":\"hi\"}"),
        answer_events("echo: hi"),
    ]));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("say hi"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("turn must succeed");

    assert_eq!(outcome.steps, 2);
    assert_eq!(outcome.stop_reason, StopReason::EndTurn);
    assert_eq!(outcome.message_ids.len(), 3, "assistant, tool, assistant");

    // Transcript is the provider-visible truth: user, call, result, answer.
    let roles: Vec<Role> = transcript.messages().iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        vec![Role::User, Role::Assistant, Role::Tool, Role::Assistant]
    );
    let result = &transcript.messages()[2].tool_results()[0];
    assert_eq!(result.content, "echo: hi");
    assert!(!result.is_error);
    let answer = transcript.messages()[3].text();
    assert_eq!(answer, "echo: hi");

    // The second request must carry the tool result and the tool declarations.
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].messages.len(), 3);
    assert_eq!(requests[1].tools.len(), 1);
    assert_eq!(requests[1].tools[0].name, "echo");

    // Event ordering the renderer relies on.
    let events = sink.events();
    let first_tool_start = events
        .iter()
        .position(|event| matches!(event, AgentEvent::ToolStart { .. }))
        .expect("a tool start event");
    let first_message_end = events
        .iter()
        .position(|event| matches!(event, AgentEvent::MessageEnd { .. }))
        .expect("a message end event");
    assert!(first_message_end < first_tool_start);
    assert!(matches!(events.first(), Some(AgentEvent::AgentStart)));
    assert!(matches!(events.last(), Some(AgentEvent::AgentEnd { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::TurnEnd)));

    // Streamed row and stored row share one id.
    let ended_ids: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageEnd { message } => Some(message.id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ended_ids[0], outcome.message_ids[0]);
}

#[tokio::test]
async fn a_failing_tool_becomes_a_result_and_the_turn_continues() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call_events("call_1", "missing_tool", "{}"),
        answer_events("I could not do that"),
    ]));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider, sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("go"));

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("a tool failure must not fail the turn");

    let tool_row = transcript
        .messages()
        .iter()
        .find(|message| message.role == Role::Tool)
        .expect("a tool row");
    assert!(tool_row.tool_results()[0].is_error);
    assert!(sink
        .events()
        .iter()
        .any(|event| matches!(event, AgentEvent::ToolEnd { is_error: true, .. })));
}

#[tokio::test]
async fn step_budget_stops_a_model_that_keeps_calling_tools() {
    let looping: Vec<Vec<StreamEvent>> = (0..3)
        .map(|index| tool_call_events(&format!("call_{index}"), "echo", "{\"text\":\"x\"}"))
        .collect();
    let provider = Arc::new(ScriptedProvider::new(looping));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider, sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("loop"));

    let mut config = TurnConfig::new("test-model");
    config.max_steps = 2;
    let error = engine
        .run_turn("s1", "t1", &mut transcript, &config, CancelToken::new())
        .await
        .expect_err("the step budget must stop the loop");

    assert!(matches!(error, AgentError::StepLimit { limit: 2 }));
    assert!(sink.events().iter().any(|event| matches!(
        event,
        AgentEvent::Error { code, .. } if code == "STEP_LIMIT"
    )));
}

/// Provider that never delivers an event, so cancellation is the only exit.
struct HangingProvider {
    keep_alive: Mutex<Option<tokio::sync::mpsc::Sender<StreamEvent>>>,
}

impl Provider for HangingProvider {
    fn name(&self) -> &str {
        "hanging"
    }

    fn stream<'a>(
        &'a self,
        _request: agent_core::ChatRequest,
        _cancel: CancelToken,
    ) -> agent_core::provider::BoxFuture<'a, Result<ProviderStream>> {
        Box::pin(async move {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            *self.keep_alive.lock().unwrap() = Some(tx);
            Ok(ProviderStream::new(rx))
        })
    }
}

#[tokio::test]
async fn cancellation_interrupts_a_streaming_turn() {
    let provider = Arc::new(HangingProvider {
        keep_alive: Mutex::new(None),
    });
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider, sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("hang"));

    let cancel = CancelToken::new();
    let token = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        token.cancel();
    });

    let error = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            cancel,
        )
        .await
        .expect_err("cancellation must surface as an error");

    assert!(matches!(error, AgentError::Cancelled));
    assert!(sink.events().iter().any(|event| matches!(
        event,
        AgentEvent::Error { code, .. } if code == "TURN_CANCELLED"
    )));
    assert!(transcript
        .messages()
        .iter()
        .all(|message| message.role == Role::User));
}

struct RefusingProvider;

impl Provider for RefusingProvider {
    fn name(&self) -> &str {
        "refusing"
    }

    fn stream<'a>(
        &'a self,
        _request: agent_core::ChatRequest,
        _cancel: CancelToken,
    ) -> agent_core::provider::BoxFuture<'a, Result<ProviderStream>> {
        Box::pin(async move {
            // A 429 that names its own delay: the retry path is the thing under
            // test, so waiting out the backoff curve adds a minute of wall clock for
            // no extra coverage. The provider's own answer is honoured first.
            Err(AgentError::provider(
                agent_core::error::ProviderErrorKind::Retryable,
                "429 too many requests",
            )
            .with_retry_after(Some(1)))
        })
    }
}

#[tokio::test]
async fn provider_failure_is_reported_as_an_error_event() {
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(Arc::new(RefusingProvider), sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("go"));

    let error = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect_err("a provider failure must surface");
    assert!(error.is_retryable());
    assert!(sink.events().iter().any(|event| matches!(
        event,
        AgentEvent::Error { code, .. } if code == "PROVIDER_ERROR"
    )));
}

#[tokio::test]
async fn an_interrupted_transcript_is_repaired_before_the_next_request() {
    // A previous turn died after asking for a tool.
    let mut dead_assistant = Message::new(Role::Assistant);
    dead_assistant.push_tool_call(ToolCall {
        id: "call_orphan".into(),
        name: "echo".into(),
        arguments: serde_json::json!({"text": "x"}),
        raw_arguments: None,
    });
    let mut transcript = agent_core::session::Transcript::from_messages(vec![
        Message::user_text("first"),
        dead_assistant,
    ]);
    transcript.push(Message::user_text("try again"));

    let provider = Arc::new(ScriptedProvider::new(vec![answer_events("recovered")]));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink);
    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("the repaired turn must run");

    let sent = provider.requests()[0].messages.clone();
    let has_synthetic_result = sent.iter().any(|message| {
        message
            .tool_results()
            .iter()
            .any(|result| result.call_id == "call_orphan" && result.is_error)
    });
    assert!(has_synthetic_result, "a repair result must be sent");
    // And the pairing holds in the locally stored transcript too.
    let roles: Vec<Role> = transcript.messages().iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        vec![
            Role::User,
            Role::Assistant,
            Role::Tool,
            Role::User,
            Role::Assistant
        ]
    );
}

#[tokio::test]
async fn usage_from_every_step_is_reported() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        vec![
            StreamEvent::ToolCallStart {
                index: 0,
                id: "call_1".into(),
                name: "echo".into(),
            },
            StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "{\"text\":\"a\"}".into(),
            },
            StreamEvent::Usage(Usage {
                input_tokens: 10,
                output_tokens: 2,
                ..Usage::default()
            }),
            StreamEvent::Finish(StopReason::ToolUse),
        ],
        vec![
            StreamEvent::TextDelta("done".into()),
            StreamEvent::Usage(Usage {
                input_tokens: 15,
                output_tokens: 3,
                ..Usage::default()
            }),
            StreamEvent::Finish(StopReason::EndTurn),
        ],
    ]));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider, sink.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("go"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome.usage.input_tokens, 25);
    assert_eq!(outcome.usage.output_tokens, 5);
    assert!(sink.events().iter().any(|event| matches!(
        event,
        AgentEvent::Usage { usage } if usage.input_tokens == 25
    )));
    assert_eq!(
        transcript
            .messages()
            .last()
            .unwrap()
            .parts
            .iter()
            .filter(|part| matches!(part, ContentPart::Text { .. }))
            .count(),
        1
    );
}

/// A long session's old tool output is aged for the request, and only there.
///
/// This is the measured problem: on a 40-turn transcript tool output was 94.6% of
/// the request's tokens, almost none of it read again. The transcript must keep
/// every byte — export, re-read and later compaction all depend on it — while the
/// model is sent a head and a way to get the rest back.
#[tokio::test]
async fn old_tool_output_is_aged_for_the_request_and_kept_in_the_transcript() {
    use agent_core::context::ModelLimits;

    // The fixture is derived from the engine's own thresholds, not hard-coded: aim
    // between the aging threshold and the compaction trigger so this scenario
    // exercises aging instead of compaction, and keep doing that when the
    // threshold formula changes.
    let turns = 15usize;
    let policy = agent_core::aging::ToolResultAging::default();
    let context = agent_core::context::ContextLimits::for_model(ModelLimits {
        context_window: Some(60_000),
        max_tokens: Some(8_000),
    });
    let target = (context.trigger as f64 * (policy.trigger_share + 1.0) / 2.0) as u64;
    let per_result = (target as f64 * agent_core::context::ESTIMATED_TEXT_CHARS_PER_TOKEN
        / turns as f64) as usize;
    assert!(
        per_result > policy.head_chars + policy.tail_chars,
        "the filler has to be worth aging: {per_result}"
    );

    let mut transcript = agent_core::session::Transcript::new();
    for index in 0..turns {
        transcript.push(Message::user_text(format!("step {index}")));
        let mut call = Message::new(Role::Assistant);
        call.push_tool_call(agent_core::ToolCall {
            id: format!("call-{index}"),
            name: "Bash".into(),
            arguments: serde_json::json!({"command": "make"}),
            raw_arguments: None,
        });
        transcript.push(call);
        transcript.push(Message::tool_result(agent_core::ToolResult {
            call_id: format!("call-{index}"),
            name: "Bash".into(),
            content: "x".repeat(per_result),
            is_error: false,
            truncated: false,
        }));
    }
    let stored = transcript.messages().to_vec();

    let provider = Arc::new(ScriptedProvider::new(vec![answer_events("done")]));
    let sink = Arc::new(RecordingSink::new());
    let engine = engine(provider.clone(), sink.clone()).with_model_limits(ModelLimits {
        context_window: Some(60_000),
        max_tokens: Some(8_000),
    });

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("turn must succeed");

    let requests = provider.requests();
    let sent = &requests[0];
    let tool_rows: Vec<&str> = sent
        .messages
        .iter()
        .filter(|message| !message.tool_results().is_empty())
        .map(|message| message.tool_results()[0].content.as_str())
        .collect();
    assert_eq!(tool_rows.len(), 15, "every call keeps its answer");
    let aged = tool_rows
        .iter()
        .filter(|content| content.contains("not in this context"))
        .count();
    assert_eq!(aged, 12, "the newest three stay whole: {aged} aged");
    for recent in &tool_rows[12..] {
        assert_eq!(
            recent.chars().count(),
            per_result,
            "the working set is untouched"
        );
    }

    // The store is the record: nothing was dropped from it. The turn appends its
    // answer, so the stored prefix must be unchanged and nothing may be missing.
    assert!(
        transcript.messages().len() > stored.len(),
        "no compaction ran: {} stored, {} after",
        stored.len(),
        transcript.messages().len()
    );
    for (before, after) in stored.iter().zip(transcript.messages().iter()) {
        assert_eq!(before.tool_results().len(), after.tool_results().len());
        for (old, new) in before
            .tool_results()
            .iter()
            .zip(after.tool_results().iter())
        {
            assert_eq!(old.content, new.content, "the transcript keeps every byte");
        }
    }
}

// --- `agent.stop` against `agent.abort` --------------------------------------
//
// Both are addressed at a running turn and both share the same token, so the
// difference has to be observable rather than documented: the cases below hold
// one tool open on a gate only the test can open. A cancelled turn abandons that
// gate; a gracefully stopped turn waits for it, records the result, and ends
// without asking the model for another step.

/// Watches whether the tool's own future was abandoned before it answered.
///
/// `abort` drops the running future inside `ToolRegistry::dispatch`, which a
/// test reading only the transcript could not tell from a tool that answered
/// "cancelled" by itself.
struct CutOffWatch {
    completed: Arc<AtomicBool>,
    cut_off: Arc<AtomicBool>,
}

impl Drop for CutOffWatch {
    fn drop(&mut self) {
        if !self.completed.load(Ordering::SeqCst) {
            self.cut_off.store(true, Ordering::SeqCst);
        }
    }
}

/// A tool that reports when it has started and then waits for the test.
struct GatedTool {
    started: tokio::sync::mpsc::UnboundedSender<()>,
    release: Mutex<Option<tokio::sync::oneshot::Receiver<String>>>,
    cut_off: Arc<AtomicBool>,
    completed: Arc<AtomicBool>,
}

impl GatedTool {
    fn new(
        started: tokio::sync::mpsc::UnboundedSender<()>,
        release: tokio::sync::oneshot::Receiver<String>,
    ) -> Self {
        Self {
            started,
            release: Mutex::new(Some(release)),
            cut_off: Arc::new(AtomicBool::new(false)),
            completed: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Tool for GatedTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "gated",
            "Wait until the test lets go",
            serde_json::json!({"type": "object", "properties": {}}),
        )
    }

    fn call<'a>(
        &'a self,
        _call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, Result<String>> {
        let watch = CutOffWatch {
            completed: self.completed.clone(),
            cut_off: self.cut_off.clone(),
        };
        let release = self
            .release
            .lock()
            .expect("release slot poisoned")
            .take()
            .expect("one gated call per tool");
        let started = self.started.clone();
        Box::pin(async move {
            let watch = watch;
            let _ = started.send(());
            let text = release.await.unwrap_or_default();
            watch.completed.store(true, Ordering::SeqCst);
            Ok(text)
        })
    }
}

/// One running fixture: the engine, the provider (for its request log), the sink,
/// and the two ends of the gate the test holds the tool on.
struct GatedHarness {
    engine: TurnEngine,
    provider: Arc<ScriptedProvider>,
    sink: Arc<RecordingSink>,
    cut_off: Arc<AtomicBool>,
    started: tokio::sync::mpsc::UnboundedReceiver<()>,
    release: tokio::sync::oneshot::Sender<String>,
}

/// One model step that asks for the gated tool, then an answer that must stay
/// unrequested when the turn stops at the boundary.
fn gated_engine() -> GatedHarness {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call_events("call_1", "gated", "{}"),
        answer_events("this answer must never be requested"),
    ]));
    let (started_tx, started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let tool = GatedTool::new(started_tx, release_rx);
    let cut_off = tool.cut_off.clone();
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(tool));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider.clone(),
        Arc::new(registry),
        sink.clone() as Arc<dyn EventSink>,
    );
    GatedHarness {
        engine,
        provider,
        sink,
        cut_off,
        started: started_rx,
        release: release_tx,
    }
}

#[tokio::test]
async fn abort_cuts_the_running_tool_off_and_fails_the_turn() {
    let GatedHarness {
        engine,
        provider,
        sink,
        cut_off,
        mut started,
        release,
    } = gated_engine();
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("run the gated tool"));
    let cancel = CancelToken::new();
    let token = cancel.clone();

    let turn = tokio::spawn(async move {
        let outcome = engine
            .run_turn(
                "s1",
                "t1",
                &mut transcript,
                &TurnConfig::new("test-model"),
                cancel,
            )
            .await;
        (outcome, transcript)
    });

    // Only once the tool is actually running does the user's Stop land, so the
    // case cannot pass by cancelling before anything started.
    tokio::time::timeout(Duration::from_secs(5), started.recv())
        .await
        .expect("the tool must start")
        .expect("a start signal");
    token.cancel();

    let (outcome, transcript) = tokio::time::timeout(Duration::from_secs(5), turn)
        .await
        .expect("an aborted turn must not wait for the tool")
        .expect("the turn task must not panic");
    let error = outcome.expect_err("an aborted turn is an error, not a graceful stop");
    assert!(matches!(error, AgentError::Cancelled), "got: {error:?}");

    // The tool never answered: its future was dropped while it waited.
    assert!(
        cut_off.load(Ordering::SeqCst),
        "abort abandons the running tool"
    );
    // Its call still owes the model a result, and that result says so.
    let tool_result = &transcript.messages()[2].tool_results()[0];
    assert!(tool_result.is_error);
    assert_eq!(tool_result.content, "cancelled while running");
    // And no further request was issued.
    assert_eq!(provider.requests().len(), 1);
    assert!(sink.events().iter().any(|event| matches!(
        event,
        AgentEvent::Error { code, .. } if code == "TURN_CANCELLED"
    )));
    drop(release);
}

#[tokio::test]
async fn a_graceful_stop_lets_the_tool_finish_and_ends_at_the_boundary() {
    let GatedHarness {
        engine,
        provider,
        sink,
        cut_off,
        mut started,
        release,
    } = gated_engine();
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("run the gated tool"));
    let cancel = CancelToken::new();
    let token = cancel.clone();

    let turn = tokio::spawn(async move {
        let outcome = engine
            .run_turn(
                "s1",
                "t1",
                &mut transcript,
                &TurnConfig::new("test-model"),
                cancel,
            )
            .await;
        (outcome, transcript)
    });

    tokio::time::timeout(Duration::from_secs(5), started.recv())
        .await
        .expect("the tool must start")
        .expect("a start signal");
    // The user stops while the tool runs; main's `agent.stop` sets exactly this.
    token.request_stop();
    // The work the user asked for finishes anyway, and its output is what the
    // transcript records.
    release.send("finished the build".to_string()).ok();

    let (outcome, transcript) = tokio::time::timeout(Duration::from_secs(5), turn)
        .await
        .expect("a stopped turn ends at the boundary")
        .expect("the turn task must not panic");
    let outcome = outcome.expect("a graceful stop is a finished turn, not a failure");

    assert!(outcome.graceful_stop, "the turn reports why it ended");
    assert_eq!(outcome.steps, 1, "one step, then the boundary");
    // Distinguishable from a completed answer: the last message asked for tools.
    assert_eq!(outcome.stop_reason, StopReason::ToolUse);
    // The whole point: the tool ran to completion instead of being cut off.
    assert!(
        !cut_off.load(Ordering::SeqCst),
        "a graceful stop must not abandon the running tool"
    );
    let tool_result = &transcript.messages()[2].tool_results()[0];
    assert!(!tool_result.is_error);
    assert_eq!(tool_result.content, "finished the build");
    // No second model request: the answer is still in the script.
    assert_eq!(
        provider.requests().len(),
        1,
        "a stopped turn issues no further request"
    );
    assert_eq!(provider.remaining(), 1, "the answer was never asked for");
    let roles: Vec<Role> = transcript.messages().iter().map(|m| m.role).collect();
    assert_eq!(roles, vec![Role::User, Role::Assistant, Role::Tool]);
    // The turn ends as a turn, not as an error.
    let events = sink.events();
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::TurnEnd)));
    assert!(events
        .iter()
        .any(|event| matches!(event, AgentEvent::AgentEnd { .. })));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, AgentEvent::Error { .. })),
        "nothing failed, so nothing is reported as an error"
    );
}
