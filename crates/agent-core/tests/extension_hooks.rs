//! Trusted-extension hooks over the host bridge.
//!
//! The kernel has no JavaScript runner. Every hook is a `host.proxy` round trip to
//! Electron main, which runs the same `TrustedExtensionRunner` the Node path uses
//! (`packages/agent-runtime/src/extensions/runner.ts`). These tests drive that
//! round trip with a recorded peer — a fake host that answers `describe`,
//! `hooks.emit` and `tools.execute` — and assert three things the E2E suite also
//! asserts, only against the kernel's own frames:
//!
//! 1. the events fire, in turn order, with the payload fields the Node contract
//!    names (so an extension written for one runtime works on the other);
//! 2. what a handler returns reaches the model: a chained `systemPrompt`, a
//!    blocked call, a replaced tool result;
//! 3. a handler that fails degrades to the unchanged value instead of failing the
//!    turn.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::rpc::{Request, RpcError};
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

mod common;

/// One hook event as the host received it.
#[derive(Debug, Clone)]
struct HookCall {
    event: String,
    payload: Value,
}

#[derive(Clone, Copy, PartialEq)]
enum Host {
    /// Answers every hook the way main answers it.
    Answering,
    /// Refuses every hook, the way a host whose runner threw would.
    Failing,
}

struct Peer {
    hooks: Arc<Mutex<Vec<HookCall>>>,
    described: Arc<Mutex<usize>>,
    tool_calls: Arc<Mutex<Vec<Value>>>,
    journal: Arc<Mutex<Vec<String>>>,
}

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let sidecar = Arc::new(Sidecar::with_default_gate(sink));
    (sidecar, lines)
}

/// Stand in for Electron main: answer the session's history, the journal write,
/// and the three extension methods.
fn peer(sidecar: &Arc<Sidecar>, lines: &RecordingLines, mode: Host) -> Peer {
    let peer = Peer {
        hooks: Arc::new(Mutex::new(Vec::new())),
        described: Arc::new(Mutex::new(0)),
        tool_calls: Arc::new(Mutex::new(Vec::new())),
        journal: Arc::new(Mutex::new(Vec::new())),
    };
    let weak = Arc::downgrade(sidecar);
    let lines = lines.clone();
    let hooks = peer.hooks.clone();
    let described = peer.described.clone();
    let tool_calls = peer.tool_calls.clone();
    let journal = peer.journal.clone();
    tokio::spawn(async move {
        let mut handled: HashSet<String> = HashSet::new();
        loop {
            let Some(sidecar) = weak.upgrade() else {
                return;
            };
            for frame in lines.host_calls() {
                let Some(id) = frame["id"].as_str().map(str::to_string) else {
                    continue;
                };
                if !handled.insert(id.clone()) {
                    continue;
                }
                let method = frame
                    .pointer("/params/method")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let params = frame
                    .pointer("/params/params")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let answer = match method {
                    "session.get" => Ok(json!({ "session": { "messages": [] } })),
                    "session.appendMessage" => {
                        // The system row keeps the prompt inside `modelSystem`, so
                        // the whole message is kept and searched as JSON.
                        if let Some(message) = params.get("message") {
                            journal.lock().expect("journal").push(message.to_string());
                        }
                        Ok(json!({ "ok": true }))
                    }
                    "extensions.session.describe" => {
                        *described.lock().expect("describe count") += 1;
                        Ok(json!({
                            "events": [
                                "before_agent_start",
                                "before_provider_headers",
                                "context",
                                "tool_call",
                                "tool_result",
                                "turn_start",
                                "turn_end",
                                "agent_end"
                            ],
                            "tools": [{
                                "name": "fx_add",
                                "description": "Adds two numbers",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "a": { "type": "number" },
                                        "b": { "type": "number" }
                                    }
                                }
                            }]
                        }))
                    }
                    "extensions.hooks.emit" => {
                        let event = params
                            .get("event")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                        hooks.lock().expect("hook log").push(HookCall {
                            event: event.clone(),
                            payload: payload.clone(),
                        });
                        if mode == Host::Failing {
                            Err(RpcError::app("EXTENSION_HOOK_FAILED", "the handler threw"))
                        } else {
                            Ok(answer_hook(&event, &payload))
                        }
                    }
                    "extensions.tools.execute" => {
                        tool_calls.lock().expect("tool calls").push(params.clone());
                        Ok(json!({ "ok": true, "content": "42" }))
                    }
                    "tools.execute" => Ok(json!({ "ok": true, "content": "tool output" })),
                    _ => continue,
                };
                // A method this peer does not answer stays pending, so the turn
                // stalls on exactly the call it is missing.
                sidecar.bridge().complete(&id, answer);
            }
            drop(sidecar);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    peer
}

/// The answers main gives for each hook, with the folds
/// `packages/agent-runtime/src/runtime.ts` applies.
fn answer_hook(event: &str, payload: &Value) -> Value {
    match event {
        "before_agent_start" => {
            let base = payload
                .get("systemPrompt")
                .and_then(Value::as_str)
                .unwrap_or("");
            json!({ "result": { "systemPrompt": format!("{base}\n\nE2E-MARKER-7f3") } })
        }
        "before_provider_headers" => {
            let mut headers = payload.get("headers").cloned().unwrap_or(json!({}));
            headers["x-e2e-ext"] = json!("yes");
            json!({ "result": { "headers": headers } })
        }
        "tool_call" => {
            if payload.get("toolName").and_then(Value::as_str) == Some("Bash") {
                json!({ "result": { "block": true, "reason": "E2E blocked bash" } })
            } else {
                json!({ "result": null })
            }
        }
        "tool_result" => {
            if payload.get("toolName").and_then(Value::as_str) == Some("fx_add") {
                json!({ "result": { "content": [{ "type": "text", "text": "42 (replaced)" }] } })
            } else {
                json!({ "result": null })
            }
        }
        "context" => json!({ "result": null }),
        _ => json!({ "result": null }),
    }
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

/// A scripted turn: activate `fx_add` through `ToolSearch`, call it, call
/// `Bash`, then answer. The same shape the E2E stub server produces.
fn script() -> Value {
    json!({
        "kind": "scripted",
        "script": [
            { "toolCall": { "id": "call_1", "name": "ToolSearch", "arguments": { "query": "fx_add" } } },
            { "toolCall": { "id": "call_2", "name": "fx_add", "arguments": { "a": 20, "b": 22 } } },
            { "toolCall": { "id": "call_3", "name": "Bash", "arguments": { "command": "echo hi" } } },
            { "text": "all done" }
        ]
    })
}

fn tool_rows(session: &Value) -> Vec<Value> {
    session["result"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["parts"][0].clone())
        .collect()
}

#[tokio::test]
async fn hooks_fire_in_turn_order_and_their_answers_reach_the_turn() {
    let (sidecar, lines) = sidecar();
    let peer = peer(&sidecar, &lines, Host::Answering);
    common::answer_empty_history(&sidecar, &lines);

    let prompted = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "please add 20 and 22",
            "provider": script(),
            "modelId": "scripted-model",
            "mode": "agent",
            // Main sends the trusted set it decided for this session's project; a
            // non-empty list is what makes the kernel ask for the hooks at all.
            "trustedExtensions": [{ "id": "e2e.fx", "entry": "src/fx.ts", "label": "E2E fx" }],
        }),
    )
    .await;
    assert!(
        prompted.get("error").is_none(),
        "the prompt was accepted: {prompted}"
    );

    lines
        .wait_for_event("agent_end", Duration::from_secs(20))
        .await
        .expect("the turn finishes");

    // One description per prompt: the events with handlers and the tool the
    // extension declared, both of which the kernel cannot work out itself.
    assert_eq!(*peer.described.lock().unwrap(), 1);

    let hooks = peer.hooks.lock().unwrap().clone();
    let events: Vec<&str> = hooks.iter().map(|hook| hook.event.as_str()).collect();
    let position = |name: &str| {
        events
            .iter()
            .position(|event| *event == name)
            .unwrap_or_else(|| panic!("`{name}` never fired; got {events:?}"))
    };
    // The chain the assertion in the E2E suite names: the prompt hook runs before
    // the first request, and the turn boundary wraps what the model asked for.
    assert!(
        position("before_agent_start") < position("turn_start"),
        "before_agent_start precedes the turn: {events:?}"
    );
    assert!(
        position("context") < position("tool_call"),
        "context is a request-time hook: {events:?}"
    );
    // A call that ran has both halves, in order. A call an extension blocked has
    // only `tool_call`: the handler decided its outcome, so there is no tool
    // result to offer `tool_result` (`afterToolCall` never runs for it either).
    for call_id in ["call_1", "call_2"] {
        let tool_call = hooks
            .iter()
            .position(|hook| {
                hook.event == "tool_call"
                    && hook.payload.get("toolCallId").and_then(Value::as_str) == Some(call_id)
            })
            .unwrap_or_else(|| panic!("tool_call for {call_id} fired: {events:?}"));
        let tool_result = hooks
            .iter()
            .position(|hook| {
                hook.event == "tool_result"
                    && hook.payload.get("toolCallId").and_then(Value::as_str) == Some(call_id)
            })
            .unwrap_or_else(|| panic!("tool_result for {call_id} fired: {events:?}"));
        assert!(
            tool_call < tool_result,
            "tool_call {call_id} precedes its result: {events:?}"
        );
    }
    assert!(events.contains(&"turn_end"), "turn_end fired: {events:?}");
    assert!(events.contains(&"agent_end"), "agent_end fired: {events:?}");
    assert!(
        events.contains(&"before_provider_headers"),
        "header hook fired: {events:?}"
    );

    // Payload shapes are the Node contract's, field for field
    // (`Runner.emitBeforeAgentStart` / `runtime.ts` emission sites).
    let agent_start = hooks
        .iter()
        .find(|hook| hook.event == "before_agent_start")
        .expect("a before_agent_start payload");
    assert_eq!(agent_start.payload["type"], "before_agent_start");
    assert_eq!(agent_start.payload["messageType"], "user");
    assert_eq!(agent_start.payload["prompt"], "please add 20 and 22");
    assert!(
        agent_start.payload["systemPrompt"]
            .as_str()
            .is_some_and(|prompt| !prompt.is_empty()),
        "the composed prompt travels with the hook: {}",
        agent_start.payload
    );
    assert_eq!(agent_start.payload["systemPromptOptions"], json!({}));

    let headers = hooks
        .iter()
        .find(|hook| hook.event == "before_provider_headers")
        .expect("a before_provider_headers payload");
    assert_eq!(headers.payload["type"], "before_provider_headers");
    assert!(headers.payload["headers"].is_object());

    let fx_call = hooks
        .iter()
        .find(|hook| {
            hook.event == "tool_call"
                && hook.payload.get("toolCallId").and_then(Value::as_str) == Some("call_2")
        })
        .expect("the fx_add tool_call payload");
    assert_eq!(fx_call.payload["type"], "tool_call");
    assert_eq!(fx_call.payload["toolName"], "fx_add");
    assert_eq!(fx_call.payload["input"], json!({ "a": 20, "b": 22 }));

    let fx_result = hooks
        .iter()
        .find(|hook| {
            hook.event == "tool_result"
                && hook.payload.get("toolCallId").and_then(Value::as_str) == Some("call_2")
        })
        .expect("the fx_add tool_result payload");
    assert_eq!(fx_result.payload["type"], "tool_result");
    assert_eq!(fx_result.payload["toolName"], "fx_add");
    // Content is pi's block list, and the flag is the tool's own outcome — the
    // replacement is applied after the handler answered.
    assert_eq!(
        fx_result.payload["content"],
        json!([{ "type": "text", "text": "42" }])
    );
    assert_eq!(fx_result.payload["isError"], false);
    assert_eq!(fx_result.payload["input"], json!({ "a": 20, "b": 22 }));

    // The declaration reached the kernel from `describe`, activation came from
    // `ToolSearch`, and the call went back to the extension through
    // `extensions.tools.execute` rather than to host-core.
    let tool_calls = peer.tool_calls.lock().unwrap().clone();
    assert_eq!(
        tool_calls.len(),
        1,
        "one extension tool call: {tool_calls:?}"
    );
    assert_eq!(tool_calls[0]["toolName"], "fx_add");
    assert_eq!(tool_calls[0]["toolCallId"], "call_2");
    assert_eq!(tool_calls[0]["turnId"], "t1");
    assert_eq!(tool_calls[0]["args"], json!({ "a": 20, "b": 22 }));

    // What the handlers returned is what the turn carries.
    let journal = peer.journal.lock().unwrap().clone();
    assert!(
        journal.iter().any(|row| row.contains("E2E-MARKER-7f3")),
        "the chained system prompt reached the turn: {journal:?}"
    );
    let session = call(
        &sidecar,
        2,
        "native.session.get",
        json!({ "sessionId": "s1" }),
    )
    .await;
    let rows = tool_rows(&session);
    let fx_add = rows
        .iter()
        .find(|row| row["name"] == "fx_add")
        .unwrap_or_else(|| panic!("an fx_add result: {rows:?}"));
    assert_eq!(
        fx_add["content"], "42 (replaced)",
        "the replacement reached the model"
    );
    assert_eq!(fx_add["is_error"], false);
    let bash = rows
        .iter()
        .find(|row| row["name"] == "Bash")
        .unwrap_or_else(|| panic!("a Bash result: {rows:?}"));
    assert_eq!(
        bash["content"], "E2E blocked bash",
        "the block reason is the result"
    );
    assert_eq!(bash["is_error"], true);
    let blocked_call = hooks
        .iter()
        .find(|hook| {
            hook.event == "tool_call"
                && hook.payload.get("toolCallId").and_then(Value::as_str) == Some("call_3")
        })
        .expect("the Bash tool_call payload");
    assert_eq!(blocked_call.payload["toolName"], "Bash");
    assert_eq!(
        blocked_call.payload["input"],
        json!({ "command": "echo hi" })
    );
    assert!(
        !hooks.iter().any(|hook| {
            hook.event == "tool_result"
                && hook.payload.get("toolCallId").and_then(Value::as_str) == Some("call_3")
        }),
        "a blocked call offers no tool_result: {events:?}"
    );
    // A blocked call never ran: `tools.execute` was never asked for it.
    assert!(
        !lines.host_calls().iter().any(|frame| frame
            .pointer("/params/params/toolName")
            .and_then(Value::as_str)
            == Some("Bash")),
        "a blocked call does not reach host-core"
    );
}

#[tokio::test]
async fn a_failing_hook_degrades_to_the_unchanged_value() {
    let (sidecar, lines) = sidecar();
    let peer = peer(&sidecar, &lines, Host::Failing);
    common::answer_empty_history(&sidecar, &lines);

    let prompted = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "please add 20 and 22",
            "provider": script(),
            "modelId": "scripted-model",
            "mode": "agent",
            // Main sends the trusted set it decided for this session's project; a
            // non-empty list is what makes the kernel ask for the hooks at all.
            "trustedExtensions": [{ "id": "e2e.fx", "entry": "src/fx.ts", "label": "E2E fx" }],
        }),
    )
    .await;
    assert!(
        prompted.get("error").is_none(),
        "the prompt was accepted: {prompted}"
    );

    // The turn still finishes: a hook is a diagnostic, never a failed turn
    // (`Runner.dispatch` on the Node side).
    lines
        .wait_for_event("agent_end", Duration::from_secs(20))
        .await
        .expect("a failing hook does not stall the turn");

    assert!(
        !peer.hooks.lock().unwrap().is_empty(),
        "the kernel asked the host and the host refused"
    );

    // Nothing the hosts refused changed the turn: no chain marker in the prompt,
    // Bash not blocked, and the tool's own answer kept.
    let journal = peer.journal.lock().unwrap().clone();
    assert!(
        !journal.iter().any(|row| row.contains("E2E-MARKER-7f3")),
        "a refused hook leaves the prompt alone: {journal:?}"
    );
    let session = call(
        &sidecar,
        2,
        "native.session.get",
        json!({ "sessionId": "s1" }),
    )
    .await;
    let rows = tool_rows(&session);
    let fx_add = rows
        .iter()
        .find(|row| row["name"] == "fx_add")
        .unwrap_or_else(|| panic!("an fx_add result: {rows:?}"));
    assert_eq!(
        fx_add["content"], "42",
        "an unapplied replacement keeps the tool's answer"
    );
    let bash = rows
        .iter()
        .find(|row| row["name"] == "Bash")
        .unwrap_or_else(|| panic!("a Bash result: {rows:?}"));
    assert_eq!(
        bash["content"], "tool output",
        "an unapplied block lets the call run through host-core"
    );
}
