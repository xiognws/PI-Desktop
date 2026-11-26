//! The delegation gate: on a smart-mode turn routed to the orchestrating half,
//! the worker's tools are refused until a delegate has reported.
//!
//! Entered from `TurnEngine::run_turn`, the same door the sidecar uses, so the
//! ordering the model actually reads (assistant message, then one result per
//! call, in call order) is what these assertions cover.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use agent_core::provider::scripted::ScriptedProvider;
use agent_core::{
    AllowAll, CancelToken, EventSink, Message, RecordingSink, Result, StopReason, StreamEvent,
    Tool, ToolCall, ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine,
};
use serde_json::json;

/// A tool that counts how many times it actually ran, under whatever name the
/// turn would have called.
struct CountingTool {
    name: &'static str,
    runs: Arc<AtomicUsize>,
    fails: bool,
}

impl Tool for CountingTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            self.name,
            "counts its own runs",
            json!({"type": "object", "properties": {}}),
        )
    }

    fn call<'a>(
        &'a self,
        _call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            if self.fails {
                return Err(agent_core::AgentError::Invalid("worker is down".into()));
            }
            Ok(format!("{} ran", self.name))
        })
    }
}

struct Harness {
    engine: TurnEngine,
    sink: Arc<RecordingSink>,
    transcript: agent_core::session::Transcript,
    bash_runs: Arc<AtomicUsize>,
    task_runs: Arc<AtomicUsize>,
}

fn harness(scripted: Vec<Vec<StreamEvent>>, gate: bool) -> (Harness, TurnConfig) {
    let bash_runs = Arc::new(AtomicUsize::new(0));
    let task_runs = Arc::new(AtomicUsize::new(0));
    let todo_runs = Arc::new(AtomicUsize::new(0));
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(CountingTool {
        name: "Bash",
        runs: bash_runs.clone(),
        fails: false,
    }));
    registry.register(Arc::new(CountingTool {
        name: "Task",
        runs: task_runs.clone(),
        fails: false,
    }));
    registry.register(Arc::new(CountingTool {
        name: "TodoWrite",
        runs: todo_runs.clone(),
        fails: false,
    }));
    // The report verb: `Task` starts a worker, `TaskWait` is what brings its answer
    // back, and only the answer reopens the gate.
    registry.register(Arc::new(CountingTool {
        name: "TaskWait",
        runs: Arc::new(AtomicUsize::new(0)),
        fails: false,
    }));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        Arc::new(ScriptedProvider::new(scripted)),
        Arc::new(registry),
        sink.clone() as Arc<dyn EventSink>,
    );
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("carry on"));
    let mut config = TurnConfig::new("orchestrator-model");
    config.delegate_mechanical = gate;
    (
        Harness {
            engine,
            sink,
            transcript,
            bash_runs,
            task_runs,
        },
        config,
    )
}

fn call(name: &str, id: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ToolCallStart {
            index: 0,
            id: id.into(),
            name: name.into(),
        },
        StreamEvent::ToolCallDelta {
            index: 0,
            arguments_delta: "{}".into(),
        },
        StreamEvent::Finish(StopReason::ToolUse),
    ]
}

fn answer() -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta("done".into()),
        StreamEvent::Finish(StopReason::EndTurn),
    ]
}

fn tool_results(transcript: &agent_core::session::Transcript) -> Vec<(String, String, bool)> {
    transcript
        .messages()
        .iter()
        .flat_map(|message| {
            message
                .tool_results()
                .into_iter()
                .map(|result| (result.name.clone(), result.content.clone(), result.is_error))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The whole point: the orchestrator reaching for `Bash` gets a refusal that
/// names the fix, and the tool never runs.
#[tokio::test]
async fn the_workers_tools_are_refused_until_a_report_arrives() {
    // `Task` only starts the worker; `TaskWait` is what brings a report back, so
    // the script waits for one before the gate is expected to open.
    let (mut h, config) = harness(
        vec![
            call("Bash", "c1"),
            call("Task", "c2"),
            call("TaskWait", "c3"),
            call("Bash", "c4"),
            answer(),
        ],
        true,
    );

    h.engine
        .run_turn("s1", "t1", &mut h.transcript, &config, CancelToken::new())
        .await
        .expect("the turn completes: refusals are answers, not failures");

    let results = tool_results(&h.transcript);
    assert_eq!(results.len(), 4, "one result per call, in call order");
    assert_eq!(results[0].0, "Bash");
    assert!(results[0].2, "the orchestrator's own Bash must be an error");
    assert!(
        results[0].1.contains("`Task`") && results[0].1.contains("worker half"),
        "the refusal has to say what to do instead: {}",
        results[0].1
    );
    assert_eq!(
        h.bash_runs.load(Ordering::SeqCst),
        1,
        "only the post-report call ran"
    );
    assert_eq!(
        h.task_runs.load(Ordering::SeqCst),
        1,
        "the delegation itself ran"
    );
    assert_eq!(results[1].0, "Task");
    assert!(!results[1].2);
    assert_eq!(results[2].0, "TaskWait");
    assert!(!results[2].2, "the wait itself is allowed");
    assert_eq!(results[3].0, "Bash");
    assert!(
        !results[3].2,
        "after a report the remainder is the orchestrator's"
    );
}

/// A delegation that failed is not a report: the gate stays shut.
#[tokio::test]
async fn a_failed_delegation_does_not_open_the_gate() {
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    let bash_runs = Arc::new(AtomicUsize::new(0));
    registry.register(Arc::new(CountingTool {
        name: "Bash",
        runs: bash_runs.clone(),
        fails: false,
    }));
    registry.register(Arc::new(CountingTool {
        name: "Task",
        runs: Arc::new(AtomicUsize::new(0)),
        fails: true,
    }));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        Arc::new(ScriptedProvider::new(vec![
            call("Task", "c1"),
            call("Bash", "c2"),
            answer(),
        ])),
        Arc::new(registry),
        sink as Arc<dyn EventSink>,
    );
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("carry on"));
    let mut config = TurnConfig::new("orchestrator-model");
    config.delegate_mechanical = true;

    engine
        .run_turn("s1", "t1", &mut transcript, &config, CancelToken::new())
        .await
        .expect("the turn still ends: a failed worker is not a failed turn");

    assert_eq!(bash_runs.load(Ordering::SeqCst), 0, "no report, no Bash");
    let results = tool_results(&transcript);
    assert!(results[1].2, "the second Bash call is refused as well");
}

/// Dispatching is not reporting: `Task` answers "started, working in the
/// background", so the gate stays shut until `TaskWait` brings a report back.
///
/// Measured on a real pairing before this rule: the orchestrator dispatched the
/// worker and then ran the same two Bash commands itself, 19k paid tokens for a
/// turn the split exists to keep cheap.
#[tokio::test]
async fn a_started_delegation_does_not_open_the_gate() {
    let bash_runs = Arc::new(AtomicUsize::new(0));
    let task_wait_runs = Arc::new(AtomicUsize::new(0));
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(CountingTool {
        name: "Bash",
        runs: bash_runs.clone(),
        fails: false,
    }));
    registry.register(Arc::new(CountingTool {
        name: "Task",
        runs: Arc::new(AtomicUsize::new(0)),
        fails: false,
    }));
    registry.register(Arc::new(CountingTool {
        name: "TaskWait",
        runs: task_wait_runs.clone(),
        fails: false,
    }));
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(
        Arc::new(ScriptedProvider::new(vec![
            call("Task", "c1"),
            call("Bash", "c2"),
            call("TaskWait", "c3"),
            call("Bash", "c4"),
            answer(),
        ])),
        Arc::new(registry),
        sink.clone() as Arc<dyn EventSink>,
    );
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("count the files"));
    let mut config = TurnConfig::new("orchestrator-model");
    config.delegate_mechanical = true;

    engine
        .run_turn("s1", "t1", &mut transcript, &config, CancelToken::new())
        .await
        .expect("the turn ends");

    let results = tool_results(&transcript);
    assert_eq!(results.len(), 4);
    assert!(!results[0].2, "the dispatch itself is allowed");
    assert!(results[1].2, "Bash before a report is refused");
    assert_eq!(bash_runs.load(Ordering::SeqCst), 1, "only the second Bash ran");
    assert_eq!(task_wait_runs.load(Ordering::SeqCst), 1);
    assert!(!results[3].2, "after the report the worker's tools reopen");
}

/// Planning stays with the orchestrator: a `TodoWrite` is not the worker's job.
#[tokio::test]
async fn planning_tools_stay_with_the_orchestrator() {
    let (mut h, config) = harness(vec![call("TodoWrite", "c1"), answer()], true);
    h.engine
        .run_turn("s1", "t1", &mut h.transcript, &config, CancelToken::new())
        .await
        .expect("turn completes");
    let results = tool_results(&h.transcript);
    assert_eq!(results.len(), 1);
    assert!(!results[0].2, "TodoWrite must not be refused");
}

/// A single-model session is untouched: nothing is refused when the launch did
/// not ask for the split.
#[tokio::test]
async fn without_the_split_nothing_is_refused() {
    let (mut h, config) = harness(vec![call("Bash", "c1"), answer()], false);
    h.engine
        .run_turn("s1", "t1", &mut h.transcript, &config, CancelToken::new())
        .await
        .expect("turn completes");
    assert_eq!(h.bash_runs.load(Ordering::SeqCst), 1);
    let results = tool_results(&h.transcript);
    assert!(!results[0].2);
}

/// The refusal is what the renderer shows too, so it must be an error event with
/// that text rather than a silent skip.
#[tokio::test]
async fn the_refusal_reaches_the_event_stream() {
    let (mut h, config) = harness(vec![call("Bash", "c1"), answer()], true);
    h.engine
        .run_turn("s1", "t1", &mut h.transcript, &config, CancelToken::new())
        .await
        .expect("turn completes");
    let refused = h.sink.events().iter().any(|event| {
        matches!(
            event,
            agent_core::AgentEvent::ToolEnd { is_error, result, .. }
                if *is_error && serde_json::to_string(result).unwrap_or_default().contains("worker half")
        )
    });
    assert!(refused, "the refusal must appear as a failed tool result");
}
