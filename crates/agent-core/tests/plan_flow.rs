//! The plan lane end to end: a Plan turn submits a plan, and an approved plan
//! becomes one ordinary Agent turn.
//!
//! These are the three surfaces main calls that the kernel used to leave to the
//! Node sidecar: `SubmitPlan` as a tool the model can actually call,
//! `planning_state` as an event the renderer draws, and
//! `agent.executeApprovedPlan` as the entry point main refuses to start a run
//! without (`apps/desktop/electron/main/runtime/plans.ts`: "approved plan
//! execution was not accepted").

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    (Arc::new(Sidecar::with_default_gate(sink)), lines)
}

async fn call(sidecar: &Sidecar, id: i64, method: &str, params: Value) -> Value {
    let request = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(id)),
        method: method.into(),
        params,
    };
    let line = sidecar.handle(request).await.expect("a response line");
    serde_json::from_str(&line).expect("a JSON response")
}

/// The answer host-core's `TodoWrite` body gives (`crates/host-core/src/rpc/todos.rs`
/// `success`): one line of text, the committed revision, the counts, the warnings.
fn todo_receipt() -> Value {
    json!({
        "ok": true,
        "content": {
            "text": "Checklist updated: 0/1 completed; current: read the failing test",
            "revision": 3,
            "summary": {"completed": 0, "total": 1, "inProgress": 1, "cancelled": 0},
            "warnings": []
        }
    })
}

/// Stand in for Electron main: history is empty, the submission is accepted,
/// recall finds nothing.
fn answer_host(sidecar: &Arc<Sidecar>, lines: &RecordingLines, submitted: Value) {
    let weak = Arc::downgrade(sidecar);
    let lines = lines.clone();
    tokio::spawn(async move {
        let mut handled: HashSet<String> = HashSet::new();
        loop {
            let Some(sidecar) = weak.upgrade() else {
                return;
            };
            for frame in lines.host_calls() {
                let method = frame
                    .pointer("/params/method")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let answer = match method {
                    "session.get" => json!({ "session": { "messages": [] } }),
                    "session.appendMessage" => json!({ "ok": true }),
                    "memory.recall" => json!({ "memories": [] }),
                    "plans.submit" => submitted.clone(),
                    "tools.execute" => match frame
                        .pointer("/params/params/toolName")
                        .and_then(Value::as_str)
                    {
                        Some("TodoWrite") => todo_receipt(),
                        _ => json!({ "ok": true, "content": "tool output" }),
                    },
                    _ => continue,
                };
                let Some(id) = frame["id"].as_str().map(str::to_string) else {
                    continue;
                };
                if !handled.insert(id.clone()) {
                    continue;
                }
                sidecar.bridge().complete(&id, Ok(answer));
            }
            drop(sidecar);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
}

/// The answer host-core's `plans.submit` gives, trimmed to what the runtime reads.
fn pending_proposal() -> Value {
    json!({
        "status": "pending",
        "proposal": {
            "id": "proposal-1",
            "sessionId": "s1",
            "turnId": "t1",
            "toolCallId": "call_1",
            "kind": "plan",
            "title": "Fix the parser",
            "markdown": "# Plan\n1. read the failing test\n2. fix the parser",
            "question": "Run this plan?",
            "artifact": {
                "relativePath": ".pi/plan/proposal-1.md",
                "sha256": "abc123",
                "sizeBytes": 42
            },
            "version": 1,
            "status": "pending",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "plan": "# Plan\n1. read the failing test\n2. fix the parser"
        }
    })
}

fn plan_execution() -> Value {
    json!({
        "id": "execution-1",
        "proposalId": "proposal-1",
        "sessionId": "s1",
        "kind": "plan",
        "plan": "# Plan\n1. read the failing test\n2. fix the parser",
        "title": "Fix the parser",
        "question": "Run this plan?",
        "artifact": {
            "relativePath": ".pi/plan/proposal-1.md",
            "sha256": "abc123",
            "sizeBytes": 42
        },
        "targetPermissionMode": "ask",
        "state": "queued"
    })
}

/// A provider the kernel can drive without a network: the tool call, then a
/// closing sentence.
fn scripted(call_name: Option<&str>) -> Value {
    let mut script = Vec::new();
    if let Some(name) = call_name {
        script.push(json!({
            "toolCall": {
                "id": "call_1",
                "name": name,
                "arguments": {
                    "title": "Fix the parser",
                    "markdown": "# Plan\n1. read the failing test\n2. fix the parser",
                    "question": "Run this plan?"
                }
            }
        }));
    }
    script.push(json!({ "text": "done" }));
    json!({ "kind": "scripted", "script": script })
}

/// A turn that keeps a checklist: one `TodoWrite` call, then a closing sentence.
fn scripted_todo() -> Value {
    json!({ "kind": "scripted", "script": [
        {"toolCall": {
            "id": "todo_1",
            "name": "TodoWrite",
            "arguments": {"todos": [
                {"content": "read the failing test", "status": "in_progress"},
                {"content": "fix the parser", "status": "pending"}
            ]}
        }},
        {"text": "done"}
    ]})
}

fn planning_states(lines: &RecordingLines) -> Vec<Value> {
    lines
        .notifications("agent.event")
        .into_iter()
        .filter(|params| params["event"]["type"] == "planning_state")
        .map(|params| params["event"].clone())
        .collect()
}

async fn wait_for_idle(sidecar: &Sidecar, session_id: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(sidecar, 99, "agent.getStatus", json!({ "sessionId": session_id })).await;
        if status["result"]["status"]["isRunning"] == false {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "the turn never idled");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_plan_turn_can_submit_its_plan_and_the_host_opens_the_approval() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    let response = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "plan this change",
            "mode": "plan",
            "provider": scripted(Some("SubmitPlan"))
        }),
    )
    .await;
    assert!(response.get("error").is_none(), "got: {response}");

    let submit = lines
        .wait_for_host_call("plans.submit", Duration::from_secs(10))
        .await
        .expect("the tool forwards the submission to the host");
    // The host call is the Node runtime's, field for field.
    let params = &submit["params"]["params"];
    assert_eq!(params["sessionId"], "s1");
    assert_eq!(params["turnId"], "t1");
    assert_eq!(params["toolCallId"], "call_1");
    assert_eq!(params["kind"], "plan");
    assert_eq!(params["title"], "Fix the parser");
    assert_eq!(params["question"], "Run this plan?");

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the plan turn ends");

    // `planning` when the turn starts, `awaiting_approval` once the host accepts.
    let states = planning_states(&lines);
    let awaiting = states
        .iter()
        .find(|event| event["state"] == "awaiting_approval")
        .unwrap_or_else(|| panic!("no awaiting_approval event: {states:?}"));
    assert_eq!(awaiting["kind"], "plan");
    assert_eq!(awaiting["proposalId"], "proposal-1");
    assert_eq!(awaiting["title"], "Fix the parser");
    assert_eq!(awaiting["artifact"]["relativePath"], ".pi/plan/proposal-1.md");
    assert_eq!(awaiting["version"], 1);
    assert!(
        states.iter().any(|event| event["state"] == "planning"
            && event["kind"] == "plan"),
        "a plan turn announces it is planning: {states:?}"
    );

    // The kernel keeps what is pending, so a later client can see the approval
    // without re-reading the transcript.
    let plan = call(&sidecar, 2, "agent.plan", json!({ "sessionId": "s1" })).await;
    assert_eq!(plan["result"]["plan"]["planning"], "awaiting_approval");
    assert_eq!(plan["result"]["plan"]["submitted"]["proposalId"], "proposal-1");
}

#[tokio::test]
async fn an_approved_plan_runs_as_one_agent_turn_with_the_snapshot_injected() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    let response = call(
        &sidecar,
        1,
        "agent.executeApprovedPlan",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "mode": "agent",
            // Main's real payload carries the session's provider and model.
            "provider": scripted(None),
            "execution": plan_execution()
        }),
    )
    .await;
    assert!(response.get("error").is_none(), "got: {response}");
    // Main refuses the run unless this is exactly `accepted: true`.
    assert_eq!(response["result"]["accepted"], true);
    assert_eq!(response["result"]["turnId"], "t1");

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the approved execution runs a turn");
    wait_for_idle(&sidecar, "s1").await;

    // The approved snapshot is this turn's user message: main sent no content,
    // so anything the model sees came from the instruction.
    let session = call(&sidecar, 2, "native.session.get", json!({ "sessionId": "s1" })).await;
    let messages = session["result"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "user row plus assistant row");
    assert_eq!(messages[0]["role"], "user");
    let injected = messages[0]["parts"][0]["text"].as_str().unwrap_or_default();
    assert!(
        injected.contains("<approved-plan-markdown>\n# Plan\n1. read the failing test\n2. fix the parser\n</approved-plan-markdown>"),
        "{injected}"
    );
    assert!(injected.contains(".pi/plan/proposal-1.md"), "{injected}");
    assert!(injected.contains("Approved plan title: Fix the parser"), "{injected}");
    assert_eq!(messages[1]["role"], "assistant");

    // An approved run is not a negotiation: nothing is awaiting approval.
    let states = planning_states(&lines);
    assert!(
        !states
            .iter()
            .any(|event| event["state"] == "awaiting_approval"),
        "{states:?}"
    );
}

#[tokio::test]
async fn an_approved_execution_for_another_session_is_refused() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    let mut execution = plan_execution();
    execution["sessionId"] = json!("another-session");
    let response = call(
        &sidecar,
        1,
        "agent.executeApprovedPlan",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "provider": scripted(None),
            "execution": execution
        }),
    )
    .await;
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(
        response["error"]["data"]["errorCode"],
        "PLAN_EXECUTION_NOT_FOUND"
    );
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("another session"));
}

#[tokio::test]
async fn an_approved_execution_without_a_descriptor_or_a_turn_is_refused() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    let missing = call(
        &sidecar,
        1,
        "agent.executeApprovedPlan",
        json!({ "sessionId": "s1", "turnId": "t1", "provider": scripted(None) }),
    )
    .await;
    assert_eq!(
        missing["error"]["data"]["errorCode"],
        "PLAN_EXECUTION_NOT_FOUND"
    );

    // Without a durable turn id there is no row for the run to belong to.
    let no_turn = call(
        &sidecar,
        2,
        "agent.executeApprovedPlan",
        json!({
            "sessionId": "s1",
            "provider": scripted(None),
            "execution": plan_execution()
        }),
    )
    .await;
    assert_eq!(
        no_turn["error"]["data"]["errorCode"],
        "PLAN_EXECUTION_NOT_FOUND"
    );

    // A descriptor with no plan text cannot become an instruction.
    let mut empty = plan_execution();
    empty["plan"] = json!("   ");
    let no_plan = call(
        &sidecar,
        3,
        "agent.executeApprovedPlan",
        json!({
            "sessionId": "s1",
            "turnId": "t2",
            "provider": scripted(None),
            "execution": empty
        }),
    )
    .await;
    assert_eq!(
        no_plan["error"]["data"]["errorCode"],
        "PLAN_EXECUTION_NOT_FOUND"
    );
}

#[tokio::test]
async fn an_agent_turn_relays_the_session_checklist_to_the_host() {
    // The checklist the user sees is host-core's, so this is the whole chain that
    // makes the panel move: the model calls `TodoWrite`, the kernel forwards
    // `tools.execute` with the caller's identity, its arguments untouched and Agent
    // mode, and the host's own answer comes back as the tool result.
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    let response = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "track the work",
            "mode": "agent",
            "provider": scripted_todo()
        }),
    )
    .await;
    assert!(response.get("error").is_none(), "got: {response}");

    let frame = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the checklist call reaches the host");
    let params = &frame["params"]["params"];
    assert_eq!(params["toolName"], "TodoWrite");
    assert_eq!(params["sessionId"], "s1");
    assert_eq!(params["turnId"], "t1");
    assert_eq!(params["toolCallId"], "todo_1");
    assert_eq!(params["mode"], "agent");
    // Nothing the host must own travels from the kernel as a decision.
    assert_eq!(params["args"]["todos"][0]["content"], "read the failing test");
    assert_eq!(params["args"]["todos"][1]["status"], "pending");

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn ends");

    // The host's normalization answer is what the model reads back.
    let session = call(
        &sidecar,
        2,
        "native.session.get",
        json!({ "sessionId": "s1" }),
    )
    .await;
    let transcript = session["result"].to_string();
    assert!(
        transcript.contains("Checklist updated: 0/1 completed"),
        "the model sees the host's answer: {transcript}"
    );

    // And its receipt is what `agent.plan` reports — the kernel keeps no second list.
    let plan = call(&sidecar, 3, "agent.plan", json!({ "sessionId": "s1" })).await;
    assert_eq!(plan["result"]["plan"]["summary"], "0/1 done");
    assert_eq!(plan["result"]["plan"]["todos"]["revision"], 3);
    assert!(
        plan["result"]["plan"].get("steps").is_none(),
        "the kernel holds no checklist rows: {plan}"
    );
}

#[tokio::test]
async fn a_plan_turn_is_not_offered_the_session_checklist() {
    // host-core refuses a write from a Plan session (`todos.rs`
    // `TodoSessionNotAgent`) and the Node runtime does not declare the tool there
    // (`mode-tool-access.ts` `RETAINED_MODE_TOOLS`), so the kernel must not offer
    // it either: a tool whose only answer is a refusal is noise in the request.
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines, pending_proposal());

    call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "plan this change",
            "mode": "plan",
            "provider": scripted_todo()
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the plan turn ends");

    assert!(
        !lines.host_calls().iter().any(|frame| {
            frame
                .pointer("/params/params/toolName")
                .and_then(Value::as_str)
                == Some("TodoWrite")
        }),
        "a Plan turn never relays a checklist write"
    );
    let session = call(
        &sidecar,
        2,
        "native.session.get",
        json!({ "sessionId": "s1" }),
    )
    .await;
    let transcript = session["result"].to_string();
    assert!(
        transcript.contains("no tool named `TodoWrite` is registered"),
        "{transcript}"
    );
}
