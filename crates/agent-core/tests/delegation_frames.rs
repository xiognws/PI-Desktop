//! The frames a delegation produces, as the app receives them.
//!
//! `Task` returns as soon as the delegate starts, so the row it leaves in the
//! transcript is only true if the settlement republishes it. These tests drive
//! the real turn loop with the real tools and assert the *serialized* envelopes:
//! the same tool call id twice — `running` first, terminal second — plus the
//! roster `TaskList`/`TaskWait` hand back, which is what the lifetime row reads.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_core::delegate::{
    DelegateOutcome, DelegateRunRequest, DelegateRunner, DelegationHub, DelegationRegistry,
    DelegationStatus, SubagentDefinition, TaskListTool, TaskTool, TaskWaitTool,
};
use agent_core::tool::ToolOutcome;
use agent_core::{
    AgentEvent, AllowAll, CancelToken, ChatRequest, EventSink, Message, Provider, ProviderStream,
    RecordingSink, Result, StopReason, StreamEvent, Tool, ToolCall, ToolContext, ToolRegistry,
    TurnConfig, TurnEngine,
};
use serde_json::{json, Value};

/// A provider that answers in the order the script lists its responses.
struct Scripted {
    responses: Mutex<std::collections::VecDeque<Vec<StreamEvent>>>,
    requests: Mutex<Vec<ChatRequest>>,
}

impl Scripted {
    fn new(responses: Vec<Vec<StreamEvent>>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        })
    }

    fn requests(&self) -> usize {
        self.requests.lock().expect("requests poisoned").len()
    }
}

impl Provider for Scripted {
    fn name(&self) -> &str {
        "scripted"
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
        let next = self
            .responses
            .lock()
            .expect("responses poisoned")
            .pop_front()
            .unwrap_or_default();
        Box::pin(async move { Ok(ProviderStream::from_events(next)) })
    }
}

fn task_call(id: &str, agent: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ToolCallStart {
            index: 0,
            id: id.into(),
            name: "Task".into(),
        },
        StreamEvent::ToolCallDelta {
            index: 0,
            arguments_delta: format!("{{\"agent\":\"{agent}\",\"task\":\"find the parser\"}}"),
        },
        StreamEvent::Finish(StopReason::ToolUse),
    ]
}

fn answer(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::TextDelta(text.into()),
        StreamEvent::Finish(StopReason::EndTurn),
    ]
}

struct InstantRunner;

impl DelegateRunner for InstantRunner {
    fn run<'a>(
        &'a self,
        _request: DelegateRunRequest,
    ) -> agent_core::provider::BoxFuture<'a, DelegateOutcome> {
        Box::pin(async move { DelegateOutcome::completed("found it at src/parser.rs:42") })
    }
}

fn definition() -> SubagentDefinition {
    SubagentDefinition {
        name: "explorer".into(),
        description: "Read-only search across the repository.".into(),
        prompt: String::new(),
        tools: vec![],
        can_mutate: false,
    }
}

fn context(name: &str, arguments: Value) -> (ToolCall, ToolContext) {
    let call = ToolCall {
        id: "call_probe".into(),
        name: name.into(),
        arguments,
        raw_arguments: None,
    };
    let ctx = ToolContext {
        session_id: "s1".into(),
        turn_id: "t1".into(),
        tool_call_id: "call_probe".into(),
        steering: None,
        cancel: CancelToken::new(),
    };
    (call, ctx)
}

/// Every `ToolEnd` frame published for one tool call id, as the wire JSON the
/// desktop process actually receives.
fn tool_end_frames(sink: &RecordingSink, tool_call_id: &str) -> Vec<Value> {
    sink.snapshot()
        .into_iter()
        .filter(|envelope| {
            matches!(
                &envelope.event,
                AgentEvent::ToolEnd { tool_call_id: id, .. } if id == tool_call_id
            )
        })
        .map(|envelope| serde_json::to_value(&envelope).expect("an envelope serializes"))
        .collect()
}

/// The same lookup with a wait: a delegate settles on its own task, so the
/// second frame can land just after the turn returns.
fn wait_for_frames(sink: &RecordingSink, tool_call_id: &str, count: usize) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let frames = tool_end_frames(sink, tool_call_id);
        if frames.len() >= count || Instant::now() >= deadline {
            return frames;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// The `details` of a `ToolEnd` frame: what the renderer reads.
fn details_of(frame: &Value) -> &Value {
    frame
        .get("event")
        .and_then(|event| event.get("result"))
        .or_else(|| frame.get("result"))
        .and_then(|result| result.get("details"))
        .expect("the result carries details")
}

#[tokio::test]
async fn a_task_row_is_published_as_running_and_then_republished_as_settled() {
    let provider = Scripted::new(vec![
        task_call("call_1", "explorer"),
        answer("let me check"),
        answer("thanks"),
    ]);
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let sink = Arc::new(RecordingSink::new());
    // The hub publishes the settled row through the session sink: this is the
    // wiring `sidecar.rs` does in the app.
    let hub = Arc::new(
        DelegationHub::new(
            registry.clone(),
            vec![definition()],
            Arc::new(InstantRunner),
        )
        .with_sink(sink.clone() as Arc<dyn EventSink>),
    );
    let mut tools = ToolRegistry::new(Arc::new(AllowAll));
    tools.register(Arc::new(TaskTool::new(hub)));
    let engine = TurnEngine::new(provider.clone(), Arc::new(tools), sink.clone())
        .with_delegations(registry.clone());
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("find the parser"));

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("the turn finishes");

    let frames = wait_for_frames(&sink, "call_1", 2);
    assert_eq!(
        frames.len(),
        2,
        "the same Task call must be published twice: as started, then as settled"
    );

    // First frame: the delegation was started, not finished.
    let started = details_of(&frames[0]);
    assert_eq!(
        started["status"], "running",
        "a started delegate is running; a badge read as completed here is the bug"
    );
    assert_eq!(started["agent"], "explorer");
    let delegation_id = started["delegationId"]
        .as_str()
        .expect("the row names the delegation it started")
        .to_string();
    assert!(!delegation_id.is_empty());
    assert!(
        started["startedAt"].as_i64().unwrap_or_default() > 0,
        "the row carries the clock the card counts from"
    );
    assert!(
        started.get("completedAt").is_none(),
        "a running delegate has no completion time"
    );
    assert!(frames[0]["event"]["result"]["content"]
        .as_str()
        .unwrap_or_default()
        .contains("started"));
    // `isError` is omitted when false, which is the wire contract.
    assert!(frames[0]["event"].get("isError").is_none());
    assert_eq!(frames[0]["turnId"], "t1");
    assert_eq!(frames[0]["sessionId"], "s1");

    // Second frame: the same call, now terminal.
    let settled = details_of(&frames[1]);
    assert_eq!(
        settled["delegationId"].as_str(),
        Some(delegation_id.as_str()),
        "the republished row must be the same delegation"
    );
    assert_eq!(settled["status"], "completed");
    assert!(settled["completedAt"].as_i64().unwrap_or_default() > 0);
    assert!(frames[1]["event"].get("isError").is_none());
    assert_eq!(
        frames[1]["turnId"], "t1",
        "the settlement belongs to the turn that started the delegate"
    );
    assert!(frames[1]["event"]["result"]["content"]
        .as_str()
        .unwrap_or_default()
        .contains("settled"));

    // The registry agrees with what was published.
    let view = registry
        .view(&delegation_id)
        .expect("the delegation exists");
    assert_eq!(view.status, DelegationStatus::Completed);
    assert_eq!(provider.requests(), 3, "the report resumed the turn");
}

#[tokio::test]
async fn the_roster_tools_carry_the_status_table_the_lifetime_row_reads() {
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let hub = Arc::new(DelegationHub::new(
        registry.clone(),
        vec![definition()],
        Arc::new(InstantRunner),
    ));
    let (call, ctx) = context(
        "Task",
        json!({"agent": "explorer", "task": "find the parser"}),
    );
    let started: ToolOutcome = TaskTool::new(hub.clone())
        .call_with_details(&call, &ctx)
        .await
        .expect("the delegate starts");
    let started_details = started.details.as_ref().expect("Task carries details");
    assert_eq!(started_details["status"], "running");
    let delegation_id = started_details["delegationId"]
        .as_str()
        .expect("a delegation id")
        .to_string();

    let (call, ctx) = context("TaskWait", json!({"delegationIds": [delegation_id]}));
    let waited: ToolOutcome = TaskWaitTool::new(hub.clone())
        .call_with_details(&call, &ctx)
        .await
        .expect("the wait converges");
    let roster = waited.details.as_ref().expect("details")["delegations"]
        .as_array()
        .expect("the lifetime row is a table")
        .clone();
    assert_eq!(roster.len(), 1, "one delegation was started");
    assert_eq!(
        roster[0]["delegationId"].as_str(),
        Some(delegation_id.as_str())
    );
    assert_eq!(roster[0]["agent"], "explorer");
    assert_eq!(roster[0]["status"], "completed");
    assert!(roster[0]["startedAt"].as_i64().unwrap_or_default() > 0);
    assert!(roster[0]["completedAt"].as_i64().unwrap_or_default() > 0);
    assert!(roster[0].get("turns").is_some());

    let (call, ctx) = context("TaskList", json!({}));
    let listed: ToolOutcome = TaskListTool::new(hub)
        .call_with_details(&call, &ctx)
        .await
        .expect("the list answers");
    let listed_roster = listed.details.as_ref().expect("details")["delegations"]
        .as_array()
        .expect("a table")
        .clone();
    assert_eq!(listed_roster.len(), 1);
    assert_eq!(listed_roster[0]["status"], "completed");
}
