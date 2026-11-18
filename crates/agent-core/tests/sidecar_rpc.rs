//! Sidecar method surface: admission, session table, notifications.

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

/// A sidecar whose history answer this test supplies itself.
fn sidecar_manual() -> (Arc<Sidecar>, RecordingLines) {
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
    // `ok`/`runtimes` are the Node sidecar's fields: a caller written against
    // it must read the same answer from this kernel.
    assert_eq!(response["result"]["ok"], true);
    assert_eq!(response["result"]["runtimes"], 0);
    assert_eq!(response["result"]["runtime"], "rust");
    assert_eq!(response["result"]["providerConfigured"], false);
}

#[tokio::test]
async fn configure_records_host_metadata_and_accepts_no_provider() {
    let (sidecar, _) = sidecar();
    // Main's real payload: host identity, data dir, proxy settings.
    let response = call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "hostBinary": "pi-desktop-host-core.exe",
            "dataDir": "C:/data/pi",
            "networkProxy": {"mode": "system"},
        }),
    )
    .await;
    assert_eq!(response["result"]["ok"], true);
    assert_eq!(response["result"]["mode"], "host-proxy");
    assert_eq!(response["result"]["providerDeclared"], false);
    assert_eq!(response["result"]["tools"], 0);

    // A harness may still declare a provider here; that is a shortcut, not the
    // product path (a prompt carries its own).
    let response = call(&sidecar, 2, "sidecar.configure", scripted_configure()).await;
    assert_eq!(response["result"]["providerDeclared"], true);
    let health = call(&sidecar, 3, "sidecar.health", json!({})).await;
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
        if status["result"]["status"]["isRunning"] == false {
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
    // The renderer destructures `{ status }`; a flat answer reads as `undefined`.
    assert_eq!(status["result"]["status"]["sessionId"], "s1");
    assert_eq!(status["result"]["status"]["isRunning"], false);
    assert_eq!(status["result"]["status"]["pendingToolConfirmations"], 0);
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

#[tokio::test]
async fn a_manual_compaction_rewrites_the_session_the_next_prompt_reads() {
    let (sidecar, lines) = sidecar();
    // Two turns of text plus the summary the compaction will ask for.
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "text": "hello from the kernel", "turns": 3},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "remember: alpha is 1"}),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");

    let response = call(&sidecar, 3, "agent.compact", json!({"sessionId": "s1"})).await;
    assert_eq!(response["result"]["compacted"], true);
    assert_eq!(
        response["result"]["messageCount"], 1,
        "the checkpoint replaced the two rows"
    );

    let event_types: Vec<String> = lines
        .notifications("agent.event")
        .iter()
        .map(|params| params["event"]["type"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(event_types.iter().any(|kind| kind == "compaction_start"));
    assert!(event_types.iter().any(|kind| kind == "compaction_end"));

    // The next prompt reads the compacted transcript, not the old rows.
    let session = call(
        &sidecar,
        4,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let messages = session["result"]["messages"]
        .as_array()
        .expect("a message list");
    assert_eq!(messages.len(), 1);
    let text = messages[0]["parts"][0]["text"]
        .as_str()
        .expect("a text part");
    assert!(text.starts_with("[context checkpoint]"), "got: {text}");
    assert!(text.contains("hello from the kernel"));
}

#[tokio::test]
async fn a_skill_catalog_reaches_the_prompt_and_a_bare_skill_call_lists_it() {
    let (sidecar, lines) = sidecar();
    // The model asks for the library, then answers.
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "Skill", "arguments": {}}},
                {"text": "done"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    let long_description = "x".repeat(120);
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "prompt": "what can you do?",
            "pluginSkills": [
                {"id": "pi/release", "name": "Release", "description": "cut a release"},
                {"id": "aaa", "name": "Aaa", "description": long_description},
                {"id": "", "name": "no id"}
            ]
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");

    // The listing is answered by the kernel, so it lands in the transcript even
    // though main declared no `Skill` handler at all.
    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let raw = session["result"].to_string();
    assert!(
        raw.contains("- `pi/release` — Release: cut a release"),
        "the catalog entry is listed: {raw}"
    );
    assert!(
        raw.contains("- `aaa` — Aaa: "),
        "the description is shown: {raw}"
    );
    let aaa = raw.find("- `aaa`").expect("the aaa entry");
    let release = raw.find("- `pi/release`").expect("the release entry");
    assert!(aaa < release, "entries are sorted by id");
    assert!(
        !raw.contains("no id"),
        "an entry without an id is not in the catalog"
    );
}

#[tokio::test]
async fn without_a_catalog_the_skill_tool_is_not_offered() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "Skill", "arguments": {}}},
                {"text": "carried on"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "hi"}),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn reaches agent_end");
    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let raw = session["result"].to_string();
    assert!(
        raw.contains("no tool named `Skill` is registered"),
        "the tool is absent from the session: {raw}"
    );
}

#[tokio::test]
async fn every_agent_prompt_recalls_memory_and_the_opt_out_is_honoured() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "text": "answered", "turns": 3},
            "model": "scripted-model"
        }),
    )
    .await;

    // A plain prompt recalls: the Node sidecar does this for every Agent turn,
    // so a switch that only recalled when asked would quietly lose memory.
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "prompt": "how long is the build",
            "projectPath": "D:/repo"
        }),
    )
    .await;
    // The host never answers here, so recall times out and the turn proceeds.
    let host_call = lines
        .wait_for_host_call("memory.recall", Duration::from_secs(5))
        .await
        .expect("a recall call");
    assert_eq!(host_call["params"]["method"], "memory.recall");
    assert_eq!(host_call["params"]["params"]["projectPath"], "D:/repo");
    assert_eq!(host_call["params"]["params"]["sessionId"], "s1");
    assert_eq!(host_call["params"]["params"]["limit"], 5);
    lines
        .wait_for_event("agent_end", Duration::from_secs(15))
        .await
        .expect("the turn finishes without memory");

    // An explicit opt-out is honoured: some hosts keep memory off entirely.
    let before = lines.notifications("host.proxy").len();
    call(
        &sidecar,
        3,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t2",
            "prompt": "and the tests?",
            "memoryRecall": false
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(15))
        .await
        .expect("the second turn finishes");
    assert_eq!(
        lines.notifications("host.proxy").len(),
        before,
        "no recall when the host opts out"
    );
}

#[tokio::test]
async fn an_asktool_card_is_answered_through_the_rpc_and_lands_in_the_transcript() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "asktool", "arguments": {
                    "questions": [{"question": "Color?", "options": ["Blue", "Green"]}]
                }}},
                {"text": "thanks"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "pick one"}),
    )
    .await;

    let ask = lines
        .wait_for_event("asktool_request", Duration::from_secs(10))
        .await
        .expect("the card is emitted");
    let request_id = ask["event"]["request"]["requestId"]
        .as_str()
        .expect("a request id")
        .to_string();
    assert_eq!(ask["event"]["request"]["sessionId"], "s1");
    assert_eq!(
        ask["event"]["request"]["questions"][0]["options"][0],
        "Blue"
    );

    let resolved = call(
        &sidecar,
        3,
        "asktool.resolve",
        json!({"sessionId": "s1", "requestId": request_id, "answers": [["Green"]]}),
    )
    .await;
    assert_eq!(resolved["result"]["ok"], true);

    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn finishes after the answer");
    let session = call(
        &sidecar,
        4,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let raw = session["result"].to_string();
    assert!(
        raw.contains("Color?：Green"),
        "the answer reaches the transcript: {raw}"
    );
}

#[tokio::test]
async fn an_answer_that_does_not_fit_the_question_is_refused_and_the_card_stays() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "asktool", "arguments": {
                    "questions": [{"question": "Color?", "options": ["Blue", "Green"]}]
                }}},
                {"text": "thanks"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "pick one"}),
    )
    .await;
    let ask = lines
        .wait_for_event("asktool_request", Duration::from_secs(10))
        .await
        .expect("the card is emitted");
    let request_id = ask["event"]["request"]["requestId"]
        .as_str()
        .expect("a request id")
        .to_string();

    // Two answers for a single-choice question: rejected, and the card survives
    // so the user can answer it properly.
    let refused = call(
        &sidecar,
        3,
        "asktool.resolve",
        json!({"sessionId": "s1", "requestId": request_id.clone(), "answers": [["Blue", "Green"]]}),
    )
    .await;
    assert_eq!(
        refused["error"]["data"]["errorCode"],
        "ASKTOOL_INVALID_ARGUMENT"
    );
    assert!(refused["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .contains("accepts one answer"));

    let accepted = call(
        &sidecar,
        4,
        "asktool.resolve",
        json!({"sessionId": "s1", "requestId": request_id, "answers": [["Blue"]]}),
    )
    .await;
    assert_eq!(accepted["result"]["ok"], true);
    lines
        .wait_for_event("agent_end", Duration::from_secs(10))
        .await
        .expect("the turn finishes");
}

#[tokio::test]
async fn aborting_a_turn_settles_its_open_card_as_skipped() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "asktool", "arguments": {
                    "questions": [{"question": "Color?", "options": ["Blue"]}]
                }}},
                {"text": "thanks"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "pick one"}),
    )
    .await;
    let ask = lines
        .wait_for_event("asktool_request", Duration::from_secs(10))
        .await
        .expect("the card is emitted");
    let request_id = ask["event"]["request"]["requestId"]
        .as_str()
        .expect("a request id")
        .to_string();

    call(&sidecar, 3, "agent.abort", json!({"sessionId": "s1"})).await;

    // The card is gone, so a late answer is refused rather than swallowed.
    let late = call(
        &sidecar,
        4,
        "asktool.resolve",
        json!({"sessionId": "s1", "requestId": request_id, "answers": [["Blue"]]}),
    )
    .await;
    assert_eq!(late["error"]["data"]["errorCode"], "ASKTOOL_NOT_FOUND");
}

#[tokio::test]
async fn a_prompt_that_declares_subagents_offers_the_task_tools() {
    let (sidecar, lines) = sidecar();
    // Two Task calls in one turn: the first names a delegate that does not
    // exist (refused without starting anything), the second starts one.
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "Task", "arguments": {"agent": "nope", "task": "x"}}},
                {"toolCall": {"id": "call_2", "name": "Task", "arguments": {"agent": "explorer", "task": "find the parser"}}},
                {"text": "done"},
                {"text": "child one"},
                {"text": "child two"},
                {"text": "child three"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "prompt": "explore the repo",
            "subagents": [{
                "name": "explorer",
                "description": "Read-only search across the repository.",
                "prompt": "Search widely and report exact paths.",
                "tools": ["Read", "Grep"]
            }]
        }),
    )
    .await;
    lines
        .wait_for_event("agent_end", Duration::from_secs(15))
        .await
        .expect("the turn finishes");

    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "s1"}),
    )
    .await;
    let raw = session["result"].to_string();
    assert!(
        raw.contains("Unknown subagent \\\"nope\\\""),
        "the catalog is enforced: {raw}"
    );
    assert!(
        raw.contains("is working in the background"),
        "the delegate starts and Task returns immediately: {raw}"
    );
}

#[tokio::test]
async fn an_mcp_selection_that_cannot_be_honoured_refuses_the_prompt() {
    let (sidecar, _lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({"provider": {"kind": "scripted", "text": "answered"}, "model": "scripted-model"}),
    )
    .await;

    // The declared catalog holds one MCP tool from the `files` server.
    let declarations = json!([
        {"name": "mcp_files_read", "description": "read a file", "parameters": {"type": "object"}, "mcpServerId": "files"},
        {"name": "Read", "description": "read a file", "parameters": {"type": "object"}}
    ]);
    let refused = call(
        &sidecar,
        2,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1",
            "prompt": "read it",
            "tools": declarations,
            "mcpServerIds": ["nope"]
        }),
    )
    .await;
    assert_eq!(
        refused["error"]["data"]["errorCode"],
        "COMPOSER_MCP_UNAVAILABLE"
    );

    // A tool from a server that was not selected is refused too.
    let refused = call(
        &sidecar,
        3,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1b",
            "prompt": "read it",
            "tools": declarations,
            "mcpServerIds": ["files"],
            "mcpToolNames": ["mcp_git_status"]
        }),
    )
    .await;
    assert_eq!(
        refused["error"]["data"]["errorCode"],
        "COMPOSER_MCP_UNAVAILABLE"
    );

    // The same selection without the impossible name is accepted.
    let accepted = call(
        &sidecar,
        4,
        "agent.prompt",
        json!({
            "sessionId": "s1",
            "turnId": "t1c",
            "prompt": "read it",
            "tools": declarations,
            "mcpServerIds": ["files"],
            "mcpToolNames": ["mcp_files_read"]
        }),
    )
    .await;
    assert_eq!(accepted["result"]["accepted"], true);
}

#[tokio::test]
async fn the_agent_can_write_its_own_skill_library() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "script": [
                {"toolCall": {"id": "call_1", "name": "skill_manage", "arguments": {"action": "create"}}},
                {"text": "noted"}
            ]},
            "model": "scripted-model"
        }),
    )
    .await;
    call(
        &sidecar,
        2,
        "agent.prompt",
        json!({"sessionId": "s1", "turnId": "t1", "prompt": "record this"}),
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
    let raw = session["result"].to_string();
    // The tool is registered in agent mode, and its refusals reach the model
    // without a host round trip.
    assert!(
        raw.contains("`name` is required to create"),
        "skill_manage is offered and refuses a nameless create: {raw}"
    );
}

/// A reopened session must arrive with its history.
///
/// Host-core owns persistence, so the kernel's transcript starts empty and the
/// model would otherwise see only the newest message. `agent.prompt` waits for
/// the host to answer `session.get` — exactly as the Node sidecar does — so the
/// prompt call is driven on a task while the host's answer is supplied here.
#[tokio::test]
async fn a_reopened_session_restores_its_history_before_the_turn() {
    let (sidecar, lines) = sidecar_manual();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "text": "noted", "turns": 2},
            "model": "scripted-model"
        }),
    )
    .await;

    let prompting = {
        let sidecar = sidecar.clone();
        tokio::spawn(async move {
            call(
                &sidecar,
                2,
                "agent.prompt",
                json!({"sessionId": "reopened", "turnId": "t1", "prompt": "and then?"}),
            )
            .await
        })
    };

    let restore = lines
        .wait_for_message("host.proxy", Duration::from_secs(10))
        .await
        .expect("the kernel asks for history");
    assert_eq!(restore["params"]["method"], "session.get");
    assert_eq!(restore["params"]["params"]["id"], "reopened");
    let call_id = restore["id"].as_str().expect("call id").to_string();
    sidecar.bridge().complete(
        &call_id,
        Ok(json!({
            "session": {
                "messages": [
                    {"id": "u1", "role": "user", "content": "build the thing"},
                    {"id": "a1", "role": "assistant", "content": "built it"},
                    {"id": "s1", "role": "system", "content": "", "modelSystem": {"version": 1, "messageJson": "{}"}}
                ]
            }
        })),
    );

    let response = prompting.await.expect("the prompt task finishes");
    assert_eq!(response["result"]["accepted"], true);
    lines
        .wait_for_event("agent_end", Duration::from_secs(15))
        .await
        .expect("the turn completes");

    let session = call(
        &sidecar,
        3,
        "native.session.get",
        json!({"sessionId": "reopened"}),
    )
    .await;
    let messages = session["result"]["messages"].as_array().expect("messages");
    assert_eq!(
        messages.len(),
        4,
        "two restored rows, the new prompt, the answer"
    );
    assert_eq!(messages[0]["id"], "u1");
    assert_eq!(messages[1]["id"], "a1");
    assert_eq!(messages[2]["role"], "user");
    assert_eq!(messages[3]["role"], "assistant");
}

/// A host that says the session does not exist must be believed.
#[tokio::test]
async fn prompting_a_deleted_session_is_refused_by_name() {
    let (sidecar, lines) = sidecar_manual();
    call(
        &sidecar,
        1,
        "sidecar.configure",
        json!({
            "provider": {"kind": "scripted", "text": "unused", "turns": 1},
            "model": "scripted-model"
        }),
    )
    .await;

    let prompting = {
        let sidecar = sidecar.clone();
        tokio::spawn(async move {
            call(
                &sidecar,
                2,
                "agent.prompt",
                json!({"sessionId": "deleted", "turnId": "t1", "prompt": "hello?"}),
            )
            .await
        })
    };

    let restore = lines
        .wait_for_message("host.proxy", Duration::from_secs(10))
        .await
        .expect("the kernel asks for history");
    let call_id = restore["id"].as_str().expect("call id").to_string();
    sidecar
        .bridge()
        .complete(&call_id, Ok(json!({ "session": null })));

    let response = prompting.await.expect("the prompt task finishes");
    assert_eq!(response["error"]["code"], -32000);
    assert_eq!(response["error"]["data"]["errorCode"], "SESSION_NOT_FOUND");
}
