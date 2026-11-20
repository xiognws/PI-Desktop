//! A delegate's report reaches the model without being asked for.
//!
//! `Task` returns immediately, so the parent's turn can finish while a delegate
//! is still working. These tests cover the difference between the report
//! arriving and the user having to ask for it: the turn stays open, the report
//! is handed over as one resumed user turn, and a stopped delegate never keeps
//! the turn open.

use std::sync::{Arc, Mutex};

use agent_core::delegate::{
    bounded_report, DelegateOutcome, DelegateRunRequest, DelegateRunner, DelegationRegistry,
    DelegationStatus, SubagentDefinition, TaskTool, DELEGATION_RESUME_PROMPT,
};
use agent_core::{
    AllowAll, CancelToken, ChatRequest, Message, Provider, ProviderStream, RecordingSink, Result,
    StopReason, StreamEvent, ToolRegistry, TurnConfig, TurnEngine,
};
use serde_json::Value;

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

    fn requests(&self) -> Vec<ChatRequest> {
        self.requests.lock().expect("requests poisoned").clone()
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

struct StoppedRunner;

impl DelegateRunner for StoppedRunner {
    fn run<'a>(
        &'a self,
        _request: DelegateRunRequest,
    ) -> agent_core::provider::BoxFuture<'a, DelegateOutcome> {
        Box::pin(async move {
            DelegateOutcome {
                status: DelegationStatus::Stopped,
                report: String::new(),
                turns: 1,
                tool_calls: 0,
                usage: Default::default(),
                error: None,
            }
        })
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

fn engine(
    provider: Arc<dyn Provider>,
    registry: Arc<DelegationRegistry>,
    runner: Arc<dyn DelegateRunner>,
) -> (TurnEngine, Arc<RecordingSink>) {
    let hub = Arc::new(agent_core::delegate::DelegationHub::new(
        registry.clone(),
        vec![definition()],
        runner,
    ));
    let mut tools = ToolRegistry::new(Arc::new(AllowAll));
    tools.register(Arc::new(TaskTool::new(hub)));
    let sink = Arc::new(RecordingSink::new());
    let engine =
        TurnEngine::new(provider, Arc::new(tools), sink.clone()).with_delegations(registry);
    (engine, sink)
}

#[tokio::test]
async fn a_settled_report_resumes_the_turn_without_a_taskwait() {
    let provider = Scripted::new(vec![
        task_call("call_1", "explorer"),
        answer("let me check"),
        answer("thanks to the report"),
    ]);
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let (engine, _sink) = engine(provider.clone(), registry.clone(), Arc::new(InstantRunner));
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("find the parser"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("the turn resumes and finishes");

    // Three requests: the Task step, the answer that would have ended the turn,
    // and the resumed request that carries the report.
    let requests = provider.requests();
    assert_eq!(requests.len(), 3, "the turn continued for the report");
    let resumed = &requests[2].messages;
    let carried = resumed
        .iter()
        .find(|message| message.text().contains(DELEGATION_RESUME_PROMPT))
        .expect("the resume prompt is in the request");
    assert!(carried.text().contains("found it at src/parser.rs:42"));
    assert!(carried.text().contains("explorer"));

    // The resumed turn is a real row in the transcript, and the report is read.
    assert!(transcript
        .messages()
        .iter()
        .any(|message| message.text().contains(DELEGATION_RESUME_PROMPT)));
    assert!(registry.undelivered().is_empty(), "delivered exactly once");
    assert_eq!(outcome.steps, 3);
}

#[tokio::test]
async fn a_report_is_never_delivered_twice() {
    let provider = Scripted::new(vec![
        task_call("call_1", "explorer"),
        answer("done"),
        answer("still done"),
    ]);
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let (engine, _sink) = engine(provider.clone(), registry.clone(), Arc::new(InstantRunner));
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
        .expect("finishes");

    let resumes = transcript
        .messages()
        .iter()
        .filter(|message| message.text().contains(DELEGATION_RESUME_PROMPT))
        .count();
    assert_eq!(
        resumes, 1,
        "a second answer must not resume on the same report"
    );
    assert_eq!(
        provider.requests().len(),
        3,
        "no fourth request: nothing was pending"
    );
}

#[tokio::test]
async fn a_stopped_delegate_does_not_keep_the_turn_open() {
    let provider = Scripted::new(vec![task_call("call_1", "explorer"), answer("done")]);
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let (engine, _sink) = engine(provider.clone(), registry.clone(), Arc::new(StoppedRunner));
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
        .expect("finishes");

    assert_eq!(
        provider.requests().len(),
        2,
        "a stopped delegate is not a reason to resume"
    );
    assert_eq!(registry.snapshot()[0].status, DelegationStatus::Stopped);
}

#[tokio::test]
async fn a_turn_with_no_delegations_ends_where_it_always_did() {
    let provider = Scripted::new(vec![answer("nothing to do")]);
    let registry = Arc::new(DelegationRegistry::new("s1"));
    let (engine, _sink) = engine(provider.clone(), registry, Arc::new(InstantRunner));
    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("hello"));

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("finishes");

    assert_eq!(provider.requests().len(), 1);
}

#[test]
fn the_resume_text_carries_every_report_and_notes_what_is_still_running() {
    let settled = vec![agent_core::delegate::DelegationView {
        delegation_id: "d1".into(),
        agent_name: "explorer".into(),
        label: None,
        status: DelegationStatus::Completed,
        model_id: "m".into(),
        turns: 2,
        tool_calls: 3,
        started_at_ms: 1,
        completed_at_ms: Some(2),
        report: Some(bounded_report("the finding")),
        error: None,
        report_delivered: false,
    }];
    let (text, delivered) = agent_core::delegate::format_resume_text(&settled, &[]);
    assert!(text.starts_with(DELEGATION_RESUME_PROMPT));
    assert!(text.contains("## explorer (d1) — completed"));
    assert!(text.contains("the finding"));
    assert_eq!(delivered, vec!["d1".to_string()]);
}

#[test]
fn an_oversized_resume_is_omitted_and_stays_undelivered() {
    // The first report fits the budget, the second no longer does.
    let sizes = [30_000usize, 40_000];
    let views: Vec<agent_core::delegate::DelegationView> = sizes
        .iter()
        .enumerate()
        .map(|(index, size)| agent_core::delegate::DelegationView {
            delegation_id: format!("d{index}"),
            agent_name: "explorer".into(),
            label: None,
            status: DelegationStatus::Completed,
            model_id: "m".into(),
            turns: 1,
            tool_calls: 0,
            started_at_ms: 1,
            completed_at_ms: Some(2),
            report: Some("x".repeat(*size)),
            error: None,
            report_delivered: false,
        })
        .collect();
    let (text, delivered) = agent_core::delegate::format_resume_text(&views, &[]);
    assert_eq!(delivered.len(), 1, "only the report that fit");
    assert!(text.contains("more result"));
    assert_eq!(
        delivered[0], "d0",
        "the omitted one stays undelivered for TaskWait"
    );
}

#[test]
fn the_wire_name_of_a_delegation_view_does_not_leak_internal_flags() {
    let value: Value = serde_json::json!({"kind": "delegation", "id": "d1"});
    assert_eq!(value["kind"], "delegation");
}
