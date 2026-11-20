//! The tool-use and spend disciplines, exercised through the real turn entry point.
//!
//! Each test here is one practice a top-tier agent runtime has and a naive loop
//! does not: a spending ceiling that stops the turn, a warning that reaches the
//! model before the ceiling, a definition-of-done nudge, repeat suppression for an
//! identical read, and concurrent execution of a step's independent calls.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_core::budget::RunBudget;
use agent_core::provider::scripted::ScriptedProvider;
use agent_core::tool_use::RepeatPolicy;
use agent_core::verify::{CompletionPolicy, VERIFICATION_NUDGE};
use agent_core::{
    AllowAll, CancelToken, EventSink, Provider, RecordingSink, Result, Role, StopReason,
    StreamEvent, Tool, ToolCall, ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine,
    Usage,
};
use serde_json::Value;

/// A tool that counts its calls and can be made slow.
struct CountingTool {
    name: &'static str,
    calls: Arc<AtomicUsize>,
    delay: Duration,
}

impl Tool for CountingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            self.name,
            "A test tool.",
            serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            let path = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("file");
            Ok(format!("contents of {path}"))
        })
    }
}

fn registry(tools: Vec<Arc<dyn Tool>>) -> Arc<ToolRegistry> {
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    for tool in tools {
        registry.register(tool);
    }
    Arc::new(registry)
}

fn counting(name: &'static str, calls: &Arc<AtomicUsize>) -> Arc<dyn Tool> {
    Arc::new(CountingTool {
        name,
        calls: calls.clone(),
        delay: Duration::ZERO,
    })
}

fn answer(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta(text.into()),
        StreamEvent::Finish(StopReason::EndTurn),
    ]
}

fn answer_with_usage(text: &str, input: u64, output: u64) -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta(text.into()),
        StreamEvent::Usage(Usage {
            input_tokens: input,
            output_tokens: output,
            ..Usage::default()
        }),
        StreamEvent::Finish(StopReason::EndTurn),
    ]
}

fn tool_call(id: &str, name: &str, arguments: &str) -> Vec<StreamEvent> {
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

fn two_calls(first: (&str, &str, &str), second: (&str, &str, &str)) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ToolCallStart {
            index: 0,
            id: first.0.into(),
            name: first.1.into(),
        },
        StreamEvent::ToolCallDelta {
            index: 0,
            arguments_delta: first.2.into(),
        },
        StreamEvent::ToolCallStart {
            index: 1,
            id: second.0.into(),
            name: second.1.into(),
        },
        StreamEvent::ToolCallDelta {
            index: 1,
            arguments_delta: second.2.into(),
        },
        StreamEvent::Finish(StopReason::ToolUse),
    ]
}

async fn run(
    engine: TurnEngine,
    transcript: &mut agent_core::session::Transcript,
) -> Result<agent_core::TurnOutcome> {
    engine
        .run_turn(
            "s1",
            "t1",
            transcript,
            &TurnConfig::new("m"),
            CancelToken::new(),
        )
        .await
}

#[tokio::test]
async fn a_token_ceiling_stops_the_turn_with_a_code() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        answer_with_usage("first", 900, 100),
        answer("second"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![counting("Read", &calls)]),
        sink.clone() as Arc<dyn EventSink>,
    )
    .with_budget(RunBudget::tokens(500));
    let mut transcript = agent_core::session::Transcript::new();
    let error = run(engine, &mut transcript).await.unwrap_err();
    assert_eq!(error.code(), "BUDGET_EXHAUSTED", "{error}");
    assert!(error.to_string().contains("1000 of 500"), "{error}");
    let errors: Vec<String> = sink
        .events()
        .into_iter()
        .filter_map(|event| match event {
            agent_core::AgentEvent::Error { code, .. } => Some(code),
            _ => None,
        })
        .collect();
    assert_eq!(errors, vec!["BUDGET_EXHAUSTED"]);
}

#[tokio::test]
async fn the_warning_reaches_the_model_before_the_ceiling_does() {
    // The warning is issued at the *next* step, because that is the first moment
    // there is still work to wrap up: a one-step turn that answers immediately has
    // nothing to stop.
    let mut first = tool_call("call_1", "Read", "{\"path\":\"a.rs\"}");
    first.insert(
        2,
        StreamEvent::Usage(Usage {
            input_tokens: 850,
            output_tokens: 0,
            ..Usage::default()
        }),
    );
    let provider = Arc::new(ScriptedProvider::new(vec![first, answer("wrapping up")]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider.clone() as Arc<dyn Provider>,
        registry(vec![counting("Read", &calls)]),
        sink.clone() as Arc<dyn EventSink>,
    )
    .with_budget(RunBudget::tokens(1_000));
    let mut transcript = agent_core::session::Transcript::new();
    let outcome = run(engine, &mut transcript).await.unwrap();
    assert_eq!(outcome.steps, 2);
    let warning = transcript
        .messages()
        .iter()
        .find(|message| message.role == Role::User && message.text().contains("[run budget]"))
        .expect("the warning reached the model as a user row");
    assert!(warning.text().contains("do not start new work"));
}

#[tokio::test]
async fn an_edit_without_a_check_is_sent_back_once() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call("call_1", "Edit", "{\"path\":\"src/main.rs\"}"),
        answer("done!"),
        answer("done — cargo test passed"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider.clone() as Arc<dyn Provider>,
        registry(vec![counting("Edit", &calls)]),
        sink.clone() as Arc<dyn EventSink>,
    )
    .with_completion(CompletionPolicy::default());
    let mut transcript = agent_core::session::Transcript::new();
    let outcome = run(engine, &mut transcript).await.unwrap();
    assert_eq!(outcome.steps, 3, "the turn was reopened once");
    let nudge = transcript
        .messages()
        .iter()
        .find(|message| message.text().starts_with("Before you report this as done"));
    assert!(nudge.is_some(), "the verification nudge was delivered");
    assert_eq!(nudge.unwrap().text(), VERIFICATION_NUDGE);
    assert!(transcript
        .messages()
        .iter()
        .any(|message| message.text().contains("cargo test passed")));
}

#[tokio::test]
async fn a_check_after_the_edit_needs_no_nudge() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call("call_1", "Edit", "{\"path\":\"src/main.rs\"}"),
        tool_call("call_2", "Bash", "{\"command\":\"cargo test\"}"),
        answer("verified"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![counting("Edit", &calls), counting("Bash", &calls)]),
        sink as Arc<dyn EventSink>,
    )
    .with_completion(CompletionPolicy::default());
    let mut transcript = agent_core::session::Transcript::new();
    let outcome = run(engine, &mut transcript).await.unwrap();
    assert_eq!(outcome.steps, 3);
    assert!(!transcript
        .messages()
        .iter()
        .any(|message| message.text().starts_with("Before you report this as done")));
}

#[tokio::test]
async fn an_identical_read_is_answered_from_the_turn_cache() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        tool_call("call_1", "Read", "{\"path\":\"a.rs\"}"),
        tool_call("call_2", "Read", "{\"path\":\"a.rs\"}"),
        answer("read it"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![counting("Read", &calls)]),
        sink as Arc<dyn EventSink>,
    )
    .with_repeat_suppression(RepeatPolicy::default());
    let mut transcript = agent_core::session::Transcript::new();
    let outcome = run(engine, &mut transcript).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the tool ran once");
    assert_eq!(outcome.tool_calls, 2, "both calls are recorded");
    let tool_results: Vec<String> = transcript
        .messages()
        .iter()
        .flat_map(|message| message.tool_results())
        .map(|result| result.content.clone())
        .collect();
    assert_eq!(tool_results.len(), 2);
    assert!(tool_results[1].contains("already ran earlier in this turn"));
    assert!(
        tool_results[1].ends_with("contents of a.rs"),
        "the tool's own text is unchanged after the notice: {}",
        tool_results[1]
    );
}

#[tokio::test]
async fn a_steps_independent_calls_run_concurrently_in_call_order() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        two_calls(
            ("call_1", "Read", "{\"path\":\"a.rs\"}"),
            ("call_2", "Read", "{\"path\":\"b.rs\"}"),
        ),
        answer("both read"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let slow = Arc::new(CountingTool {
        name: "Read",
        calls: calls.clone(),
        delay: Duration::from_millis(120),
    });
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![slow]),
        sink as Arc<dyn EventSink>,
    )
    .with_parallel_tool_calls(true);
    let mut transcript = agent_core::session::Transcript::new();
    let started = Instant::now();
    run(engine, &mut transcript).await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_millis(220),
        "two 120ms calls took {elapsed:?}: they did not run together"
    );
    let contents: Vec<String> = transcript
        .messages()
        .iter()
        .flat_map(|message| message.tool_results())
        .map(|result| result.content.clone())
        .collect();
    assert_eq!(
        contents,
        vec![
            "contents of a.rs".to_string(),
            "contents of b.rs".to_string()
        ],
        "the transcript keeps call order, not completion order"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_sequential_engine_is_the_default() {
    let provider = Arc::new(ScriptedProvider::new(vec![
        two_calls(
            ("call_1", "Read", "{\"path\":\"a.rs\"}"),
            ("call_2", "Read", "{\"path\":\"b.rs\"}"),
        ),
        answer("both read"),
    ]));
    let calls = Arc::new(AtomicUsize::new(0));
    let slow = Arc::new(CountingTool {
        name: "Read",
        calls: calls.clone(),
        delay: Duration::from_millis(80),
    });
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![slow]),
        sink as Arc<dyn EventSink>,
    );
    let mut transcript = agent_core::session::Transcript::new();
    let started = Instant::now();
    run(engine, &mut transcript).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(150),
        "without the opt-in the calls stay sequential"
    );
}

#[tokio::test]
async fn the_budget_is_reported_through_a_status_event() {
    let provider = Arc::new(ScriptedProvider::new(vec![answer_with_usage("hi", 10, 5)]));
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        provider as Arc<dyn Provider>,
        registry(vec![counting("Read", &calls)]),
        sink.clone() as Arc<dyn EventSink>,
    )
    .with_budget(RunBudget::tokens(1_000));
    let mut transcript = agent_core::session::Transcript::new();
    run(engine, &mut transcript).await.unwrap();
    let statuses: Vec<Value> = sink
        .snapshot()
        .into_iter()
        .filter_map(|envelope| match envelope.event {
            agent_core::AgentEvent::Status { status } => Some(status),
            _ => None,
        })
        .collect();
    assert!(!statuses.is_empty());
    assert_eq!(statuses.last().unwrap()["budget"]["usedTokens"], 15);
    assert_eq!(statuses.last().unwrap()["budget"]["maxTokens"], 1_000);
}
