//! `agent.stop`: the graceful stop, end to end over the RPC surface.
//!
//! Reference: the Node sidecar answers `agent.stop` by calling
//! `runtime.requestGracefulStop()` and returning `{ requested }`
//! (`packages/agent-runtime/src/sidecar.ts`), and `requestGracefulStop` /
//! `finishTurn` in `runtime.ts` is what makes it graceful — the turn ends at the
//! next completed assistant boundary instead of cutting the tool in flight off.
//! `agent.abort` is the other half of that pair and stays the hard stop.
//!
//! These cases drive the loop through `agent.prompt` and hold one host tool open
//! on `tools.execute`, which is the same shape Electron main answers: the stop
//! arrives while a tool is running, so what a person's Stop does to that tool is
//! what is pinned here.

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

/// Stand in for Electron main: empty history, accepted journal writes, nothing
/// recalled — and `tools.execute` deliberately left unanswered, because the test
/// holds that call open to have a tool in flight when the stop arrives.
fn answer_host(sidecar: &Arc<Sidecar>, lines: &RecordingLines) {
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

/// One step that asks for a host tool, then an answer the model would only give
/// if the turn were allowed to continue.
fn prompt_params() -> Value {
    json!({
        "sessionId": "s1",
        "turnId": "t1",
        "content": "run the build",
        "tools": [{ "name": "probe", "description": "probe", "parameters": { "type": "object" } }],
        "provider": {
            "kind": "scripted",
            "script": [
                // The host tool is on demand now (the reference's "not core =>
                // deferred" rule applies to host declarations too), so the model
                // activates it first. Activation is a kernel tool: it costs a
                // step, not a host call.
                { "toolCall": { "id": "call_0", "name": "ToolSearch", "arguments": { "query": "probe" } } },
                { "toolCall": { "id": "call_1", "name": "probe", "arguments": {} } },
                { "text": "this answer must never be requested" }
            ]
        }
    })
}

fn event_types(lines: &RecordingLines) -> Vec<String> {
    lines
        .notifications("agent.event")
        .iter()
        .map(|params| {
            params["event"]["type"]
                .as_str()
                .unwrap_or("<none>")
                .to_string()
        })
        .collect()
}

fn tool_end(lines: &RecordingLines, call_id: &str) -> Value {
    lines
        .notifications("agent.event")
        .into_iter()
        .find(|params| {
            params["event"]["type"] == "tool_end"
                && params["event"]["toolCallId"].as_str() == Some(call_id)
        })
        .map(|params| params["event"].clone())
        .expect("the tool's result reaches the renderer")
}

fn answer_was_requested(lines: &RecordingLines) -> bool {
    lines.notifications("agent.event").iter().any(|params| {
        params["event"]["type"] == "message_end"
            && params
                .to_string()
                .contains("this answer must never be requested")
    })
}

/// Hand the held `tools.execute` back to the kernel.
async fn release_tool(sidecar: &Arc<Sidecar>, lines: &RecordingLines, content: &str) {
    let pending = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the scripted tool call reaches the host");
    let call_id = pending["id"]
        .as_str()
        .expect("a host call id")
        .to_string();
    sidecar
        .bridge()
        .complete(&call_id, Ok(json!({ "ok": true, "content": content })));
}

#[tokio::test]
async fn agent_stop_lets_the_tool_finish_and_ends_the_turn_at_the_boundary() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);

    let response = call(&sidecar, 1, "agent.prompt", prompt_params()).await;
    assert!(response.get("error").is_none(), "got: {response}");

    // The tool is running: the host has the call and has not answered it. This is
    // when the renderer's Stop — or an MCP client's `agent/stop` — lands.
    let held = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the scripted tool call reaches the host");
    assert_eq!(
        held.pointer("/params/method").and_then(Value::as_str),
        Some("tools.execute")
    );

    let stopped = call(
        &sidecar,
        2,
        "agent.stop",
        json!({ "sessionId": "s1", "turnId": "t1" }),
    )
    .await;
    // The Node sidecar's answer, field for field.
    assert_eq!(stopped["result"], json!({ "requested": true }));

    // The work finishes anyway: a graceful stop does not abort the host call.
    release_tool(&sidecar, &lines, "build finished").await;

    let end = lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");
    assert_eq!(end["turnId"], "t1");

    // The tool's own output is on the transcript, not a cancellation.
    let tool = tool_end(&lines, "call_1");
    assert_eq!(tool["result"]["content"], "build finished");
    assert_eq!(tool["isError"], Value::Null);

    // And the boundary is where the turn ended: nothing asked the model again.
    assert!(
        !answer_was_requested(&lines),
        "a stopped turn must not issue another request: {:?}",
        event_types(&lines)
    );
    let events = event_types(&lines);
    assert!(events.contains(&"turn_end".to_string()), "events: {events:?}");
    assert!(
        !events.contains(&"error".to_string()),
        "nothing failed, so no error is reported: {events:?}"
    );
}

#[tokio::test]
async fn a_stop_addressed_at_another_turn_changes_nothing() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);

    call(&sidecar, 1, "agent.prompt", prompt_params()).await;
    lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the scripted tool call reaches the host");

    // The renderer's Stop names a turn; a stop for a different one must not end
    // this one — the same identity gate `agent.abort` applies.
    let late = call(
        &sidecar,
        2,
        "agent.stop",
        json!({ "sessionId": "s1", "turnId": "t-other" }),
    )
    .await;
    assert_eq!(late["result"], json!({ "requested": false }));

    release_tool(&sidecar, &lines, "build finished").await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");

    // Untouched: the model was asked again and gave its answer.
    assert!(
        answer_was_requested(&lines),
        "an unfired stop leaves the turn running: {:?}",
        event_types(&lines)
    );
}

#[tokio::test]
async fn a_stop_for_a_session_with_no_running_turn_is_not_an_error() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);

    // Main and the MCP surface call this without knowing which process served
    // the turn, so the answer is a shape, never an error. The Node sidecar answers
    // `{ requested: false }` for an unknown session and for an idle runtime.
    let unknown = call(
        &sidecar,
        1,
        "agent.stop",
        json!({ "sessionId": "never-launched" }),
    )
    .await;
    assert_eq!(unknown["result"], json!({ "requested": false }));

    call(&sidecar, 2, "agent.prompt", prompt_params()).await;
    release_tool(&sidecar, &lines, "build finished").await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");

    // The turn is over, so there is no boundary left to stop at.
    let idle = call(
        &sidecar,
        3,
        "agent.stop",
        json!({ "sessionId": "s1", "turnId": "t1" }),
    )
    .await;
    assert_eq!(idle["result"], json!({ "requested": false }));
}
