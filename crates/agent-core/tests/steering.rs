//! Steering and session bookkeeping.
//!
//! A steer is a message the user sends while a turn is already working. The
//! contract that matters: it must reach the model on the turn's next step (not
//! after the turn ends), it must keep its own row in the transcript, and it
//! must be refused when it is addressed at a turn that no longer exists.

use std::sync::Arc;
use std::time::Duration;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

mod common;

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let sidecar = Arc::new(Sidecar::with_default_gate(sink));
    // Stand in for Electron main: a test that ignored the history request would
    // stall on a host that does not exist.
    common::answer_empty_history(&sidecar, &lines);
    (sidecar, lines)
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

/// A turn that calls a host tool first, so the test has a window in which the
/// turn is provably still running.
fn slow_turn_prompt(session_id: &str, turn_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "turnId": turn_id,
        "content": "run the tool",
        "userMessageId": "user-row-1",
        "provider": {
            "kind": "scripted",
            "script": [
                {"toolCall": {"id": "call_1", "name": "Bash", "arguments": {"command": "sleep 1"}}},
                {"text": "finished"}
            ]
        },
        "tools": [{
            "name": "Bash",
            "description": "Run a shell command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
        }]
    })
}

#[tokio::test]
async fn a_steer_reaches_the_next_step_of_the_running_turn() {
    let (sidecar, lines) = sidecar();
    let accepted = call(&sidecar, 1, "agent.prompt", slow_turn_prompt("s1", "t1")).await;
    assert_eq!(accepted["result"]["accepted"], true);
    assert_eq!(accepted["result"]["turnId"], "t1");

    // The turn is parked on the host call: steer now.
    let host_call = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the turn asked the host for the tool");

    let context = call(
        &sidecar,
        2,
        "agent.steeringContext",
        json!({"sessionId": "s1", "expectedTurnId": "t1"}),
    )
    .await;
    assert_eq!(context["result"]["steering"], true);
    assert_eq!(context["result"]["turnId"], "t1");

    let steered = call(
        &sidecar,
        3,
        "agent.steer",
        json!({
            "sessionId": "s1",
            "expectedTurnId": "t1",
            "content": "also check the logs",
            "messageId": "steer-row-1"
        }),
    )
    .await;
    assert_eq!(steered["result"]["accepted"], true);
    assert_eq!(steered["result"]["turnId"], "t1");

    // Queued, not consumed yet.
    let context = call(
        &sidecar,
        4,
        "agent.steeringContext",
        json!({"sessionId": "s1", "expectedTurnId": "t1"}),
    )
    .await;
    assert_eq!(
        context["result"]["pending"],
        json!(["also check the logs"]),
        "a queued steer is reported to a reconnecting renderer"
    );

    // Answer the tool call; the turn proceeds to its second step.
    sidecar.bridge().complete(
        host_call["id"].as_str().unwrap(),
        Ok(json!({"ok": true, "content": "slept"})),
    );
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn ends");

    // The steered text is in the transcript, in order, with the id main sent.
    let session = call(
        &sidecar,
        5,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().unwrap();
    let roles: Vec<&str> = messages
        .iter()
        .map(|message| message["role"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        roles,
        vec!["user", "assistant", "tool", "user", "assistant"],
        "steer lands after the tool result and before the final answer"
    );
    assert_eq!(messages[0]["id"], "user-row-1", "the prompt kept main's id");
    assert_eq!(messages[3]["id"], "steer-row-1", "the steer kept main's id");
    assert_eq!(messages[3]["parts"][0]["text"], "also check the logs");
    assert_eq!(messages[4]["parts"][0]["text"], "finished");

    // And it was consumed: nothing is still queued after the turn.
    let context = call(
        &sidecar,
        6,
        "agent.steeringContext",
        json!({"sessionId": "s1"}),
    )
    .await;
    assert_eq!(context["result"]["pending"], json!([]));
    assert_eq!(context["result"]["steering"], false);
}

#[tokio::test]
async fn a_steer_addressed_at_a_stale_turn_is_refused() {
    let (sidecar, lines) = sidecar();
    call(&sidecar, 1, "agent.prompt", slow_turn_prompt("s1", "t1")).await;
    lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the turn is running");

    let response = call(
        &sidecar,
        2,
        "agent.steer",
        json!({"sessionId": "s1", "expectedTurnId": "t0", "content": "too late"}),
    )
    .await;
    assert_eq!(response["error"]["data"]["errorCode"], "TURN_NOT_FOUND");
}

#[tokio::test]
async fn a_steer_with_no_running_turn_is_refused() {
    let (sidecar, _) = sidecar();
    let response = call(
        &sidecar,
        1,
        "agent.steer",
        json!({"sessionId": "s1", "content": "hello"}),
    )
    .await;
    assert_eq!(response["error"]["data"]["errorCode"], "TURN_NOT_FOUND");

    let context = call(
        &sidecar,
        2,
        "agent.steeringContext",
        json!({"sessionId": "s1"}),
    )
    .await;
    assert!(context["result"]["turnId"].is_null());
    assert_eq!(context["result"]["pending"], json!([]));
}

#[tokio::test]
async fn a_prompt_takes_its_provider_from_the_request() {
    let (sidecar, lines) = sidecar();
    // No `sidecar.configure` at all: main always stamps the provider.
    let response = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "content": "hello",
            "provider": {"kind": "scripted", "text": "hi from the prompt's provider"},
            "modelId": "scripted-model"
        }),
    )
    .await;
    assert_eq!(response["result"]["accepted"], true);
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn runs without a configured provider");

    let session = call(
        &sidecar,
        2,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().unwrap();
    assert_eq!(
        messages.last().unwrap()["parts"][0]["text"],
        "hi from the prompt's provider"
    );
}

#[tokio::test]
async fn sessions_can_be_listed_forked_and_searched() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "content": "find the needle",
            "provider": {"kind": "scripted", "text": "the needle is here"}
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("first turn ends");

    let listed = call(&sidecar, 2, "native.session.list", json!({})).await;
    let sessions = listed["result"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], "s1");
    assert_eq!(sessions[0]["messageCount"], 2);
    assert_eq!(sessions[0]["title"], "find the needle");

    let search = call(
        &sidecar,
        3,
        "native.session.search",
        json!({"query": "NEEDLE"}),
    )
    .await;
    let results = search["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "both rows mention the needle");
    assert!(results.iter().all(|hit| hit["sessionId"] == "s1"));

    let forked = call(
        &sidecar,
        4,
        "native.session.fork",
        json!({"id": "s1", "targetId": "s1-fork"}),
    )
    .await;
    assert_eq!(forked["result"]["session"]["id"], "s1-fork");
    assert_eq!(forked["result"]["session"]["messageCount"], 2);

    let fork = call(
        &sidecar,
        5,
        "native.session.get",
        json!({"sessionId": "s1-fork"}),
    )
    .await;
    let fork_messages = fork["result"]["messages"].as_array().unwrap();
    assert_eq!(fork_messages.len(), 2);
    assert_eq!(fork_messages[0]["parts"][0]["text"], "find the needle");

    // The fork is independent: answering into it must not touch the source.
    call(
        &sidecar,
        6,
        "agent.prompt",
        json!({
            "sessionId": "s1-fork",
            "content": "continue here",
            "provider": {"kind": "scripted", "text": "forked answer"}
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the fork runs");
    let source = call(
        &sidecar,
        7,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    assert_eq!(source["result"]["messages"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn forking_an_unknown_session_is_a_named_error() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "native.session.fork", json!({"id": "ghost"})).await;
    assert_eq!(response["error"]["data"]["errorCode"], "SESSION_NOT_FOUND");
}
