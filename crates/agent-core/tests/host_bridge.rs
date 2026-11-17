//! Host bridge: a tool whose implementation lives in Electron main.
//!
//! The kernel owns the loop, the tool *declarations* come from the host, and
//! every call travels back over the same stdio channel as
//! `host.proxy` → `tools.execute`. These tests drive that round trip with a
//! recorded peer: the frame the kernel emits is inspected, the answer is fed
//! back, and the transcript is checked.

use std::sync::Arc;
use std::time::Duration;

use agent_core::host_bridge::HostBridge;
use agent_core::rpc::{Request, RpcError};
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

/// Configure a session whose scripted provider calls `Bash` and then answers.
async fn configure_with_host_tool(sidecar: &Sidecar) -> Value {
    call(
        sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {
                "kind": "scripted",
                "script": [
                    {"toolCall": {"id": "call_1", "name": "Bash", "arguments": {"command": "echo hi"}}},
                    {"text": "the host said hi"}
                ]
            },
            "model": "scripted-model",
            "tools": [{
                "name": "Bash",
                "description": "Run a shell command",
                "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
            }]
        }),
    )
    .await
}

#[tokio::test]
async fn a_tool_call_round_trips_through_the_host() {
    let (sidecar, lines) = sidecar();
    let configured = configure_with_host_tool(&sidecar).await;
    assert_eq!(configured["result"]["tools"], 1);

    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "run it"}),
    )
    .await;

    // The kernel asked the host to run the tool, stamped with the turn identity.
    let request = lines
        .wait_for_message("host.proxy", Duration::from_secs(10))
        .await
        .expect("the host call reaches the peer");
    assert_eq!(request["params"]["method"], "tools.execute");
    let params = &request["params"]["params"];
    assert_eq!(params["toolName"], "Bash");
    assert_eq!(params["args"]["command"], "echo hi");
    assert_eq!(params["sessionId"], "s1");
    assert_eq!(params["turnId"], "t1");
    assert_eq!(params["toolCallId"], "call_1");
    let call_id = request["id"].as_str().expect("a call id").to_string();

    // Answer like main does, then let the turn finish.
    sidecar
        .bridge()
        .complete(&call_id, Ok(json!({"ok": true, "content": "hi from host"})));

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn finishes once the host answers");

    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().expect("messages");
    let tool_row = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("a tool row");
    assert_eq!(tool_row["parts"][0]["type"], "tool_result");
    assert_eq!(tool_row["parts"][0]["content"], "hi from host");
    assert_eq!(tool_row["parts"][0]["is_error"], false);
    let answer = messages.last().expect("the answer");
    assert_eq!(answer["parts"][0]["text"], "the host said hi");
}

#[tokio::test]
async fn a_refused_call_becomes_an_error_result_and_the_turn_continues() {
    let (sidecar, lines) = sidecar();
    configure_with_host_tool(&sidecar).await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "run it"}),
    )
    .await;

    let request = lines
        .wait_for_message("host.proxy", Duration::from_secs(10))
        .await
        .expect("the host call reaches the peer");
    let call_id = request["id"].as_str().unwrap().to_string();
    sidecar.bridge().complete(
        &call_id,
        Err(RpcError::app("PERMISSION_DENIED", "the user declined")),
    );

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("a refused tool does not end the turn");

    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().unwrap();
    let tool_row = messages
        .iter()
        .find(|m| m["role"] == "tool")
        .expect("tool row");
    assert_eq!(tool_row["parts"][0]["is_error"], true);
    assert!(tool_row["parts"][0]["content"]
        .as_str()
        .unwrap()
        .contains("the user declined"));
    // The refusal did not end the turn: the script's second step still answered.
    let answer = messages.last().unwrap();
    assert_eq!(answer["role"], "assistant");
    assert_eq!(answer["parts"][0]["text"], "the host said hi");
}

#[tokio::test]
async fn an_unanswered_call_times_out_instead_of_hanging() {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let bridge = HostBridge::new(sink).with_timeout(Duration::from_millis(30));
    let error = bridge
        .call("tools.execute", json!({"toolName": "Bash"}))
        .await
        .expect_err("no answer must not be an answer");
    assert!(error.to_string().contains("timed out"), "got: {error}");
    assert_eq!(bridge.pending_count(), 0, "the pending call is cleaned up");
}

#[tokio::test]
async fn closing_the_channel_fails_every_waiter() {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let bridge = Arc::new(HostBridge::new(sink));

    let waiting = {
        let bridge = bridge.clone();
        tokio::spawn(async move { bridge.call("tools.execute", json!({})).await })
    };
    // Wait until the call is actually pending, without a fixed sleep.
    lines
        .wait_for_message("host.proxy", Duration::from_secs(5))
        .await
        .expect("the call was issued");

    bridge.fail_all("peer closed stdin");
    let outcome = waiting.await.expect("the task finishes");
    assert!(outcome.is_err(), "a closed channel must not resolve");
    assert!(bridge.is_closed());
}

#[tokio::test]
async fn responses_for_unknown_ids_are_ignored() {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let bridge = HostBridge::new(sink);
    // A late answer to a call that already timed out must not panic.
    bridge.complete("no-such-call", Ok(json!({"ok": true})));
    assert_eq!(bridge.pending_count(), 0);
}
