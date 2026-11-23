//! `SessionSearch`: the model searching its own history, end to end.
//!
//! The two halves this covers are exactly the two the feature needed: the
//! declaration is the kernel's (a catalog the model can see and activate), and
//! the search is host-core's (over `tools.execute`, the same round trip every
//! other built-in takes). The recorded peer stands in for Electron main, so the
//! test reads the frame the host would actually receive.

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

fn names(lines: Option<&Value>) -> Vec<String> {
    lines
        .and_then(Value::as_array)
        .map(|lines| {
            lines
                .iter()
                .filter_map(|line| line["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Configures a session whose scripted model activates the tool, calls it, and
/// then answers with what it read.
async fn configure(sidecar: &Sidecar) -> Value {
    call(
        sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {
                "kind": "scripted",
                "script": [
                    {"toolCall": {"id": "call_1", "name": "ToolSearch",
                        "arguments": {"query": "SessionSearch"}}},
                    {"toolCall": {"id": "call_2", "name": "SessionSearch",
                        "arguments": {"query": "retry budget", "limit": 5}}},
                    {"text": "Last week we set it to five."}
                ]
            },
            "model": "scripted-model"
        }),
    )
    .await
}

/// The catalogue offers it, the model has to activate it, and the call reaches
/// the host with the reference agent's argument names.
#[tokio::test]
async fn the_model_searches_its_own_history_through_the_host() {
    let (sidecar, lines) = sidecar();
    configure(&sidecar).await;

    // The catalogue: on demand in Agent mode, never declared up front. Priced by
    // the same report the renderer reads, so this is the set a request would
    // actually carry.
    let report = call(
        &sidecar,
        2,
        "agent.tokenReport",
        json!({"sessionId": "s0", "mode": "agent"}),
    )
    .await;
    let report = &report["result"];
    let on_demand = names(report.get("onDemand"));
    let declared = names(report.get("tools"));
    println!("on demand: {on_demand:?}");
    assert!(
        on_demand.contains(&"SessionSearch".to_string()),
        "the catalog must list it: {on_demand:?}"
    );
    assert!(
        !declared.contains(&"SessionSearch".to_string()),
        "an on-demand tool must not be declared before activation: {declared:?}"
    );

    call(
        &sidecar,
        3,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "what did we decide about the retry budget?"}),
    )
    .await;

    // The frame main would receive: the host's tool name, the model's arguments.
    let request = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the tool call reaches the host");
    assert_eq!(request["params"]["method"], "tools.execute");
    let params = &request["params"]["params"];
    assert_eq!(params["toolName"], "SessionSearch");
    assert_eq!(params["args"]["query"], "retry budget");
    assert_eq!(params["args"]["limit"], 5);
    assert_eq!(params["sessionId"], "s1");
    let call_id = request["id"].as_str().expect("a call id").to_string();

    // Answer like main does: the shape `tools/session_search_tool.rs` returns.
    sidecar.bridge().complete(
        &call_id,
        Ok(json!({
            "ok": true,
            "content": {
                "query": "retry budget",
                "results": [{
                    "sessionId": "s-old",
                    "title": "Retry policy",
                    "matchType": "message",
                    "messageId": "m12",
                    "role": "user",
                    "snippet": "We settled it: the retry budget is five.",
                    "createdAt": "2026-11-01T09:00:00.000Z"
                }],
                "sessionCount": 1,
                "nextOffset": null
            }
        })),
    );

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn finishes once the host answers");

    // The model read the hit, and the transcript kept what it read.
    let session = call(
        &sidecar,
        4,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().expect("messages");
    // Two tool rows now: the activation and the search. The search is the last.
    let tool_row = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .expect("a tool row");
    let content = tool_row["parts"][0]["content"].to_string();
    assert!(
        content.contains("s-old") && content.contains("matchType"),
        "the result must reach the transcript: {content}"
    );
    assert_eq!(tool_row["parts"][0]["is_error"], false);
    let answer = messages.last().expect("the answer");
    assert_eq!(answer["parts"][0]["text"], "Last week we set it to five.");
}

/// A call the model never activated is refused in the kernel, and the refusal
/// names the call to make — the host never sees it.
#[tokio::test]
async fn an_unactivated_history_call_is_refused_before_the_host() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {
                "kind": "scripted",
                "script": [
                    {"toolCall": {"id": "call_1", "name": "SessionSearch",
                        "arguments": {"query": "retry budget"}}},
                    {"text": "I cannot look that up."}
                ]
            },
            "model": "scripted-model"
        }),
    )
    .await;

    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "what did we decide?"}),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn finishes");

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
    assert_eq!(tool_row["parts"][0]["is_error"], true);
    assert!(
        tool_row["parts"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("ToolSearch"),
        "the refusal names the call to make: {}",
        tool_row["parts"][0]["content"]
    );
    // Nothing reached the host: a refusal is not a tool call.
    assert!(lines
        .wait_for_host_call("tools.execute", Duration::from_millis(300))
        .await
        .is_none());
}
