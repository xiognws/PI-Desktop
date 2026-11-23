//! Two-tier declarations, end to end: what a report prices, what a request
//! carries, and what happens to a call the model never activated.
//!
//! The report half runs the real sidecar (`agent.prompt` then
//! `agent.tokenReport`) because the bug it covers lived in the sidecar: the
//! report read the live tool registry, which holds whatever the *previous*
//! prompt installed.

use std::sync::Arc;
use std::time::Duration;

use agent_core::rpc::Request;
use agent_core::session::Transcript;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::tool_activation::{ToolActivation, ToolSearchTool, TOOL_SEARCH_NAME};
use agent_core::{
    AllowAll, CancelToken, EventSink, LineSink, Message, RecordingSink, StopReason, StreamEvent,
    Tool, ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine,
};
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

/// One prompt, run to completion, in `mode`.
async fn prompt(sidecar: &Sidecar, id: i64, mode: &str) {
    let response = call(
        sidecar,
        id,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": format!("t{id}"), "prompt": "hi", "mode": mode}),
    )
    .await;
    assert_eq!(response["result"]["sessionId"], "s1");
}

fn declared_names(report: &Value) -> Vec<String> {
    report["tools"]
        .as_array()
        .expect("tools lines")
        .iter()
        .filter_map(|line| line["name"].as_str().map(str::to_string))
        .collect()
}

fn tokens(report: &Value) -> u64 {
    report["groups"]["tools"].as_u64().unwrap_or(0)
}

/// The report answers "what would a prompt in this mode declare", not "what did
/// the last prompt install".
///
/// Before the fix both halves of this test failed: the Agent report priced the
/// Plan set and the Plan report priced the Agent set, and each showed the other
/// mode's tools.
#[tokio::test]
async fn a_report_prices_the_mode_it_was_asked_about() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "text": "hello from the kernel", "turns": 4},
            "model": "scripted-model",
            "system": "be brief"
        }),
    )
    .await;

    prompt(&sidecar, 2, "agent").await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");

    let agent = call(
        &sidecar,
        3,
        "agent.tokenReport",
        json!({"sessionId": "s1", "mode": "agent"}),
    )
    .await;
    let plan = call(
        &sidecar,
        4,
        "agent.tokenReport",
        json!({"sessionId": "s1", "mode": "plan"}),
    )
    .await;

    let agent_tools = declared_names(&agent["result"]);
    let plan_tools = declared_names(&plan["result"]);
    println!(
        "agent report: {} tools, {} tokens, declarations {:?}, onDemand {} tools / {} tokens",
        agent_tools.len(),
        tokens(&agent["result"]),
        agent["result"]["declarations"],
        plan["result"]["declarations"]["onDemand"],
        plan["result"]["onDemand"]
            .as_array()
            .map(|lines| lines.iter().filter_map(|l| l["tokens"].as_u64()).sum::<u64>())
            .unwrap_or(0),
    );
    println!(
        "plan report: {} tools, {} tokens, declarations {:?}",
        plan_tools.len(),
        tokens(&plan["result"]),
        plan["result"]["declarations"],
    );
    for line in agent["result"]["system"].as_array().unwrap() {
        println!("  system {}: {} chars / {} tokens", line["name"], line["chars"], line["tokens"]);
    }
    for line in agent["result"]["tools"].as_array().unwrap() {
        println!("  declared {}: {} chars / {} tokens", line["name"], line["chars"], line["tokens"]);
    }
    for line in agent["result"]["onDemand"].as_array().unwrap() {
        println!("  on-demand {}: {} chars / {} tokens", line["name"], line["chars"], line["tokens"]);
    }
    for line in plan["result"]["system"].as_array().unwrap() {
        if line["name"] == "tool_activation" {
            println!(
                "plan on-demand section: {} chars / {} tokens",
                line["chars"], line["tokens"]
            );
        }
    }
    println!("agent declared: {agent_tools:?}");
    println!("plan declared: {plan_tools:?}");

    // Agent mode: the writers are core, and the tools with real nested schemas
    // are on demand rather than declared.
    for core in ["Read", "Glob", "Grep", "Write", "Edit", "Bash"] {
        assert!(agent_tools.contains(&core.to_string()), "agent: {core}");
    }
    for deferred in ["OfficeRead", "OfficeWrite", "ScheduledTaskCreate"] {
        assert!(
            !agent_tools.contains(&deferred.to_string()),
            "{deferred} must be on demand, not declared"
        );
    }

    // Plan mode after an Agent turn: no writer, whatever the previous turn sent.
    for writer in ["Write", "Edit", "ExecuteCode", "OfficeWrite", "AstEdit"] {
        assert!(
            !plan_tools.contains(&writer.to_string()),
            "plan report still declares {writer}: {plan_tools:?}"
        );
    }
    for reader in ["Read", "Glob", "Grep", "Bash", "BrowserPreview", "SubmitPlan"] {
        assert!(plan_tools.contains(&reader.to_string()), "plan: {reader}");
    }
    assert!(plan_tools.contains(&TOOL_SEARCH_NAME.to_string()));
    // Cheaper than declaring the whole catalog, which is the point.
    assert!(
        tokens(&plan["result"]) < tokens(&agent["result"]),
        "plan {} vs agent {}",
        tokens(&plan["result"]),
        tokens(&agent["result"])
    );

    // The reverse direction: an Agent report after a Plan turn still declares the
    // writers, and still not the deferred schemas.
    prompt(&sidecar, 5, "plan").await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the plan turn reaches agent_end");
    let after = call(
        &sidecar,
        6,
        "agent.tokenReport",
        json!({"sessionId": "s1", "mode": "agent"}),
    )
    .await;
    let after_tools = declared_names(&after["result"]);
    assert!(after_tools.contains(&"Write".to_string()), "{after_tools:?}");
    assert!(!after_tools.contains(&"OfficeWrite".to_string()));
    assert_eq!(
        after["result"]["declarations"]["declared"],
        json!(after_tools.len())
    );
}

struct Stub {
    spec: ToolSpec,
}

impl Tool for Stub {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn call<'a>(
        &'a self,
        call: &'a agent_core::ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, agent_core::Result<String>> {
        Box::pin(async move {
            let _ = call;
            Ok(format!("{} ran", self.spec.name))
        })
    }
}

fn stub(name: &str, description: &str) -> Arc<dyn Tool> {
    Arc::new(Stub {
        spec: ToolSpec::new(
            name,
            description,
            json!({"type": "object", "properties": {}}),
        ),
    })
}

fn tool_call(id: &str, name: &str, arguments: Value) -> Vec<StreamEvent> {
    vec![
        StreamEvent::ToolCallStart {
            index: 0,
            id: id.into(),
            name: name.into(),
        },
        StreamEvent::ToolCallDelta {
            index: 0,
            arguments_delta: arguments.to_string(),
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

/// A registry with two core tools and one on-demand tool, plus `ToolSearch`.
fn engine(provider: Arc<agent_core::provider::scripted::ScriptedProvider>) -> TurnEngine {
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    for tool in [
        stub("Read", "Read a file."),
        stub("Bash", "Run a shell command."),
        stub("OfficeRead", "Read an Office or PDF document."),
    ] {
        registry.register(tool);
    }
    let activation = Arc::new(ToolActivation::new(
        &agent_core::prompt::SessionMode::Agent,
        registry.specs(),
        ToolActivation::empty_active(),
    ));
    registry.register(Arc::new(ToolSearchTool::new(activation.clone())));
    let sink = Arc::new(RecordingSink::new());
    TurnEngine::new(provider, Arc::new(registry), sink as Arc<dyn EventSink>)
        .with_tool_activation(activation)
}

fn request_names(engine_requests: &[agent_core::ChatRequest]) -> Vec<Vec<String>> {
    engine_requests
        .iter()
        .map(|request| request.tools.iter().map(|spec| spec.name.clone()).collect())
        .collect()
}

/// Activation reaches the next request of the same turn, and only the next.
#[tokio::test]
async fn activating_a_tool_declares_it_on_the_next_request() {
    let provider = Arc::new(agent_core::provider::scripted::ScriptedProvider::new(vec![
        tool_call("c1", TOOL_SEARCH_NAME, json!({"query": "OfficeRead"})),
        answer("done"),
    ]));
    let engine = engine(provider.clone());
    let mut transcript = Transcript::new();
    transcript.push(Message::user_text("read the spreadsheet"));

    let outcome = engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("turn must succeed");
    assert_eq!(outcome.steps, 2);

    let requests = request_names(&provider.requests());
    println!("request tools: {requests:?}");
    assert_eq!(
        requests[0],
        vec![
            "Bash".to_string(),
            "Read".to_string(),
            TOOL_SEARCH_NAME.to_string()
        ],
        "the first request declares core plus ToolSearch, not the catalog"
    );
    assert!(
        requests[1].contains(&"OfficeRead".to_string()),
        "activation must reach the next request: {:?}",
        requests[1]
    );
    // The tool result the model reads says what happened.
    let result = &transcript.messages()[2].tool_results()[0];
    assert!(!result.is_error);
    assert!(result.content.contains("Activated on-demand tools: OfficeRead"));
}

/// A call to an on-demand tool that was never activated is refused, and the
/// refusal names the call to make. The tool itself never runs.
#[tokio::test]
async fn an_unactivated_on_demand_call_is_refused() {
    let provider = Arc::new(agent_core::provider::scripted::ScriptedProvider::new(vec![
        tool_call("c1", "OfficeRead", json!({"format": "xlsx", "path": "a.xlsx"})),
        answer("retrying"),
    ]));
    let engine = engine(provider.clone());
    let mut transcript = Transcript::new();
    transcript.push(Message::user_text("read the spreadsheet"));

    engine
        .run_turn(
            "s1",
            "t1",
            &mut transcript,
            &TurnConfig::new("test-model"),
            CancelToken::new(),
        )
        .await
        .expect("turn must succeed");

    let result = &transcript.messages()[2].tool_results()[0];
    assert!(result.is_error);
    assert_eq!(
        result.content,
        "Call ToolSearch to activate OfficeRead before using it. A tool declaration does not grant execution permission."
    );
    // The next request still does not declare it: a refusal is not activation.
    let requests = request_names(&provider.requests());
    assert!(!requests[1].contains(&"OfficeRead".to_string()));
}

/// A host-declared tool is on demand, not invisible.
///
/// The reference rule is "not core ⇒ deferred" over the whole catalog, so a
/// plugin's tool starts deferred. What must still work is the path from there:
/// `ToolSearch` finds it, activation declares it, and the next step's call
/// reaches the host. Before this, host declarations were kept outside both
/// lists — never declared, never searchable — and the model could not reach
/// them at all.
#[tokio::test]
async fn a_host_declared_tool_is_activated_by_tool_search_and_then_reaches_the_host() {
    let (sidecar, lines) = sidecar();
    let response = call(
        &sidecar,
        1,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "content": "add 20 and 22",
            "mode": "agent",
            "tools": [{
                "name": "fx_add",
                "description": "Add two numbers.",
                "parameters": { "type": "object", "properties": {} }
            }],
            "provider": {
                "kind": "scripted",
                "script": [
                    { "toolCall": { "id": "call_search", "name": "ToolSearch", "arguments": { "query": "fx_add" } } },
                    { "toolCall": { "id": "call_add", "name": "fx_add", "arguments": {} } },
                    { "text": "done" }
                ]
            }
        }),
    )
    .await;
    assert!(response.get("error").is_none(), "got: {response}");
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn ends");

    let events = lines.notifications("agent.event");
    let end_of = |id: &str| {
        events
            .iter()
            .find(|params| {
                params["event"]["type"] == "tool_end"
                    && params["event"]["toolCallId"].as_str() == Some(id)
            })
            .map(|params| params["event"].clone())
    };
    let search = end_of("call_search").expect("the ToolSearch call completes");
    let said = search["result"]["content"].as_str().unwrap_or("");
    assert!(
        said.contains("Activated on-demand tools: fx_add"),
        "ToolSearch did not find the host tool: {search}"
    );
    let added = end_of("call_add").expect("the host tool runs");
    assert_eq!(added["result"]["content"], "tool output");
    assert_eq!(added["isError"], Value::Null);
}
