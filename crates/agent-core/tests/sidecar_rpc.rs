//! Sidecar method surface: admission, session table, notifications.

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

fn scripted_configure() -> Value {
    json!({
        "provider": {"kind": "scripted", "text": "hello from the kernel", "turns": 2},
        "model": "scripted-model",
        "system": "be brief"
    })
}

#[tokio::test]
async fn health_reports_the_rust_runtime() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "sidecar.health", json!({})).await;
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["status"], "ok");
    assert_eq!(response["result"]["runtime"], "rust");
    assert_eq!(response["result"]["sessions"], 0);
    assert_eq!(response["result"]["providerConfigured"], false);
}

#[tokio::test]
async fn configure_alone_is_enough_to_report_a_provider() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "sidecar.configure", scripted_configure()).await;
    assert_eq!(response["result"]["model"], "scripted-model");
    let health = call(&sidecar, 2, "sidecar.health", json!({})).await;
    assert_eq!(health["result"]["providerConfigured"], true);
}

#[tokio::test]
async fn a_prompt_runs_a_turn_and_streams_agent_events() {
    let (sidecar, lines) = sidecar();
    call(&sidecar, 1, "sidecar.configure", scripted_configure()).await;

    let response = call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "hi"}),
    )
    .await;
    assert_eq!(response["result"]["sessionId"], "s1");
    assert_eq!(response["result"]["turnId"], "t1");

    let last = lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");
    assert_eq!(last["sessionId"], "s1");
    assert_eq!(last["turnId"], "t1");

    let events: Vec<String> = lines
        .notifications("agent.event")
        .iter()
        .map(|params| params["event"]["type"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        events.contains(&"turn_start".to_string()),
        "events: {events:?}"
    );
    assert!(
        events.contains(&"message_end".to_string()),
        "events: {events:?}"
    );

    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2, "user row plus assistant row");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["stop_reason"], "end_turn");
}

#[tokio::test]
async fn the_same_session_answers_a_second_prompt_after_the_first_ends() {
    let (sidecar, lines) = sidecar();
    call(&sidecar, 1, "sidecar.configure", scripted_configure()).await;

    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "one"}),
    )
    .await;
    lines
        .wait_for("agent.event", Duration::from_secs(10))
        .await
        .expect("first turn starts");

    // Wait for the session to be idle again before the second prompt.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(&sidecar, 3, "agent.getStatus", json!({"sessionId": "s1"})).await;
        if status["result"]["isRunning"] == false {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "turn never idled");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let second = call(
        &sidecar,
        4,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t2", "prompt": "two"}),
    )
    .await;
    assert!(second.get("error").is_none(), "got: {second}");
    assert_eq!(second["result"]["turnId"], "t2");
}

#[tokio::test]
async fn prompt_before_configure_is_refused_with_a_stable_code() {
    let (sidecar, _) = sidecar();
    let response = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({"sessionId": "s1", "prompt": "hi"}),
    )
    .await;
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(
        response["error"]["data"]["errorCode"],
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn an_unknown_method_is_method_not_found() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "agent.nope", json!({})).await;
    assert_eq!(response["error"]["code"], -32601);
    assert!(response["error"]["message"]
        .as_str()
        .unwrap()
        .contains("agent.nope"));
}

#[tokio::test]
async fn a_missing_session_id_is_invalid_params() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "agent.prompt", json!({"prompt": "hi"})).await;
    assert_eq!(response["error"]["code"], -32602);
}

#[tokio::test]
async fn abort_on_an_unknown_session_is_a_no_op() {
    let (sidecar, _) = sidecar();
    let response = call(&sidecar, 1, "agent.abort", json!({"sessionId": "ghost"})).await;
    assert_eq!(response["result"]["aborted"], false);
}

#[tokio::test]
async fn status_and_dispose_track_the_session_table() {
    let (sidecar, _) = sidecar();
    call(&sidecar, 1, "sidecar.configure", scripted_configure()).await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "prompt": "hi"}),
    )
    .await;

    let disposal = call(
        &sidecar,
        3,
        "agent.disposeSession",
        json!({"sessionId": "s1"}),
    )
    .await;
    assert_eq!(disposal["result"]["disposed"], true);

    let status = call(&sidecar, 4, "agent.getStatus", json!({"sessionId": "s1"})).await;
    assert_eq!(status["result"]["exists"], false);
    assert_eq!(status["result"]["messageCount"], 0);
}

#[tokio::test]
async fn a_notification_gets_no_answer() {
    let (sidecar, _) = sidecar();
    let request = Request {
        jsonrpc: "2.0".into(),
        id: None,
        method: "sidecar.health".into(),
        params: json!({}),
    };
    assert!(sidecar.handle(request).await.is_none());
}
