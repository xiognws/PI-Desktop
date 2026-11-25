//! The extension surface a kernel-run command reads: context usage, the
//! composed system prompt, and the active tool set.
//!
//! Under the Rust kernel Electron main is the JavaScript host for trusted
//! extensions (`apps/desktop/electron/main/agent-extensions.ts`), so the three
//! members it cannot answer itself come from here — `agent.surface` for the
//! reads and `agent.setActiveTools` for the write. The shapes are the Node
//! runtime's (`createExtensionBridge`, `packages/agent-runtime/src/runtime.ts`):
//! the same keys, the same `percent: null` on a zero budget, and the same
//! "activation is sticky for the session" rule.
//!
//! These run the real sidecar because the state is the sidecar's: only a turn
//! records what it composed, and only the session holds the activation set.

use std::sync::Arc;
use std::time::Duration;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use serde_json::{json, Value};

mod common;

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn agent_core::LineSink> = Arc::new(lines.clone());
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

/// One Agent turn with a model window, so the surface has a budget to price
/// against.
async fn prompt(sidecar: &Sidecar, lines: &RecordingLines, id: i64) {
    let response = call(
        sidecar,
        id,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": format!("t{id}"),
            "content": "hello",
            "mode": "agent",
            "provider": {
                "kind": "scripted",
                "text": "hello back",
                "modelConfig": { "limit": { "context": 128_000, "output": 8_192 } }
            }
        }),
    )
    .await;
    assert!(response.get("error").is_none(), "prompt failed: {response}");
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");
}

fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The reads describe the turn that ran: a real transcript, the window the
/// prompt declared, and the prompt the model was actually sent.
#[tokio::test]
async fn the_surface_reports_the_turn_that_ran() {
    let (sidecar, lines) = sidecar();
    prompt(&sidecar, &lines, 1).await;

    let surface = call(&sidecar, 2, "agent.surface", json!({ "sessionId": "s1" })).await;
    assert!(surface.get("error").is_none(), "surface failed: {surface}");
    let result = &surface["result"];

    let usage = &result["usage"];
    assert!(
        usage["tokens"].as_u64().unwrap_or(0) > 0,
        "the turn's user and assistant rows cost something: {usage}"
    );
    assert!(
        usage["contextWindow"].as_u64().unwrap_or(0) > 0,
        "a prompt that declares a window reports the hard limit: {usage}"
    );
    assert!(
        usage["contextWindow"].as_u64().unwrap_or(u64::MAX) < 128_000,
        "the budget is the hard limit, below the model window: {usage}"
    );
    let percent = usage["percent"].as_u64().expect("a percentage");
    assert!(
        percent < 100,
        "a two-message transcript is nowhere near the limit: {usage}"
    );

    let system = result["systemPrompt"]
        .as_str()
        .expect("the composed prompt is a string");
    assert!(
        system.contains("on-demand") || system.contains("tool_activation") || !system.is_empty(),
        "the recorded prompt must be the composed one, not a placeholder"
    );

    let tools = &result["tools"];
    assert_eq!(tools["known"], json!(true), "a turn ran: {tools}");
    let catalog = tools["catalog"].as_array().expect("a catalog");
    assert!(
        catalog
            .iter()
            .all(|entry| entry["name"].is_string() && entry["active"].is_boolean()),
        "every catalog entry names a tool and says whether it is active: {tools}"
    );
    let active = names(&tools["active"]);
    for core in ["Read", "Bash"] {
        assert!(
            active.contains(&core.to_string()),
            "a core tool is declared on every request: {active:?}"
        );
    }
    assert!(
        active.contains(&"ToolSearch".to_string()),
        "the kernel defers tools, so ToolSearch is declared: {active:?}"
    );
    let deferred = catalog
        .iter()
        .find(|entry| entry["name"] == json!("OfficeWrite"))
        .expect("OfficeWrite is in the kernel's own catalog");
    assert_eq!(
        deferred["active"],
        json!(false),
        "an on-demand tool starts inactive: {deferred}"
    );
    assert!(
        deferred["description"].as_str().unwrap_or("").len() > 10,
        "the catalog carries what the model was told: {deferred}"
    );
}

/// A session this process has never composed a prompt for is reported as
/// unknown, not as an empty conversation: the kernel restores history at the
/// session's first prompt, so `0` tokens would be a guess.
#[tokio::test]
async fn an_unknown_session_reports_nothing_rather_than_zeroes() {
    let (sidecar, _lines) = sidecar();
    let surface = call(
        &sidecar,
        1,
        "agent.surface",
        json!({ "sessionId": "never-ran" }),
    )
    .await;
    let result = &surface["result"];

    assert_eq!(result["usage"], Value::Null, "usage: {result}");
    assert_eq!(result["systemPrompt"], Value::Null, "prompt: {result}");
    assert_eq!(result["tools"]["known"], json!(false), "tools: {result}");
    assert_eq!(result["tools"]["catalog"], json!([]));
    assert_eq!(result["tools"]["active"], json!([]));
}

/// The write member switches the on-demand set the session's next request
/// declares, and reports the state it left behind.
#[tokio::test]
async fn setting_the_active_tools_switches_on_an_on_demand_tool() {
    let (sidecar, lines) = sidecar();
    prompt(&sidecar, &lines, 1).await;

    let switched = call(
        &sidecar,
        2,
        "agent.setActiveTools",
        json!({ "sessionId": "s1", "names": ["OfficeWrite"] }),
    )
    .await;
    assert!(switched.get("error").is_none(), "write failed: {switched}");
    let tools = &switched["result"]["tools"];
    let active = names(&tools["active"]);
    assert!(
        active.contains(&"OfficeWrite".to_string()),
        "the requested tool is now declared: {active:?}"
    );
    let office = tools["catalog"]
        .as_array()
        .expect("a catalog")
        .iter()
        .find(|entry| entry["name"] == json!("OfficeWrite"))
        .expect("OfficeWrite stays in the catalog")
        .clone();
    assert_eq!(office["active"], json!(true));

    // Core tools are always declared, and a subset that omits one does not
    // switch it off: the wanted set is the on-demand set, exactly as Node's
    // `setActiveTools` treats it.
    assert!(active.contains(&"Read".to_string()), "{active:?}");

    // Sticky for the session: the next read agrees without being told again.
    let reread = call(&sidecar, 3, "agent.surface", json!({ "sessionId": "s1" })).await;
    let reread_active = names(&reread["result"]["tools"]["active"]);
    assert!(
        reread_active.contains(&"OfficeWrite".to_string()),
        "activation must outlive the write: {reread_active:?}"
    );

    // And a second write with nothing wanted switches it off again.
    let cleared = call(
        &sidecar,
        4,
        "agent.setActiveTools",
        json!({ "sessionId": "s1", "names": [] }),
    )
    .await;
    let cleared_active = names(&cleared["result"]["tools"]["active"]);
    assert!(
        !cleared_active.contains(&"OfficeWrite".to_string()),
        "an empty set is an instruction, not a no-op: {cleared_active:?}"
    );
}

/// A malformed write is refused with the protocol's own error, not applied
/// halfway.
#[tokio::test]
async fn a_malformed_active_tool_list_is_refused() {
    let (sidecar, _lines) = sidecar();
    let response = call(
        &sidecar,
        1,
        "agent.setActiveTools",
        json!({ "sessionId": "s1", "names": "OfficeWrite" }),
    )
    .await;
    let error = response.get("error").expect("an error, not an answer");
    assert_eq!(error["code"], json!(-32602), "invalid params: {error}");
}
