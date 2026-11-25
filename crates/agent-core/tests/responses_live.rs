//! Live check for the Responses wire. **Ignored by default** — it spends real
//! tokens on a real model.
//!
//! ```text
//! python crates/agent-core/tests/support/responses_relay.py --port 28799
//! cargo test -p agent-core --test responses_live -- --ignored --nocapture
//! ```
//!
//! `RESPONSES_LIVE_BASE_URL` (default `http://127.0.0.1:28799/v1`) must point at
//! something that speaks the Responses wire and returns streaming text, streamed
//! tool-call arguments and usage. The local gateway on `:28787` answers
//! `/v1/responses` but cannot do those three for a streaming request (its handler
//! parses the upstream SSE as JSON, so the text is empty and tool calls are never
//! mapped), so the check runs against `tests/support/responses_relay.py`, which
//! fronts the same gateway's Chat Completions endpoint with a strict Responses
//! envelope. The model, the tool decision and the token counts are real; see that
//! script's header for what is and is not proven.
//!
//! `RESPONSES_LIVE_MODEL` (default `wk-deepseek-v4.1-flash-011`) names the model —
//! an explicit id, never the gateway's routing alias.

use std::time::{Duration, Instant};

use agent_core::cancel::CancelToken;
use agent_core::message::{Message, Role, StopReason, ToolResult};
use agent_core::provider::http::{HttpProvider, HttpProviderConfig};
use agent_core::provider::{ChatRequest, ResponseAssembler, StreamEvent};
use agent_core::tool::ToolSpec;
use agent_core::Provider;
use serde_json::json;

fn base_url() -> String {
    std::env::var("RESPONSES_LIVE_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:28799/v1".to_string())
}

fn model() -> String {
    std::env::var("RESPONSES_LIVE_MODEL")
        .unwrap_or_else(|_| "wk-deepseek-v4.1-flash-011".to_string())
}

fn provider() -> HttpProvider {
    HttpProvider::new(HttpProviderConfig::openai_responses(
        "responses-live",
        base_url(),
        "relay-key",
    ))
    .expect("client")
}

fn read_file_tool() -> ToolSpec {
    ToolSpec::new(
        "read_file",
        "Read a UTF-8 text file from disk and return its contents.",
        json!({
            "type": "object",
            "properties": {"path": {"type": "string", "description": "File path to read"}},
            "required": ["path"]
        }),
    )
}

/// The one tool this check exposes; it reads a file the test just wrote.
fn run_tool(name: &str, arguments: &serde_json::Value) -> ToolResult {
    match name {
        "read_file" => {
            let path = arguments
                .get("path")
                .and_then(|path| path.as_str())
                .unwrap_or("");
            match std::fs::read_to_string(path) {
                Ok(content) => ToolResult {
                    call_id: String::new(),
                    name: name.to_string(),
                    content: content.trim().to_string(),
                    is_error: false,
                    truncated: false,
                },
                Err(error) => ToolResult {
                    call_id: String::new(),
                    name: name.to_string(),
                    content: format!("cannot read {path}: {error}"),
                    is_error: true,
                    truncated: false,
                },
            }
        }
        other => ToolResult {
            call_id: String::new(),
            name: other.to_string(),
            content: format!("unknown tool {other}"),
            is_error: true,
            truncated: false,
        },
    }
}

#[tokio::test]
#[ignore = "spends real tokens on a live Responses endpoint; run with --ignored"]
async fn a_tool_call_round_trips_over_the_responses_wire() {
    let dir = std::env::temp_dir().join("responses-live-check");
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let notes = dir.join("notes.txt");
    let secret = "the answer is 42";
    std::fs::write(&notes, format!("{secret}\n")).expect("write fixture");

    let provider = provider();

    // ---- turn 1: the model must decide to call the tool --------------------
    let mut request = ChatRequest::new(
        model(),
        vec![Message::user_text(format!(
            "Read the file {} with the read_file tool and report the single line it contains. \
             Do not guess.",
            notes.display()
        ))],
    );
    request.system = Some(
        "You are a tool-using agent. When asked to read a file, call the read_file tool."
            .to_string(),
    );
    request.tools = vec![read_file_tool()];

    println!("--- turn 1 request ---\n{:?}", request.messages[0].text());
    let mut stream = provider
        .stream(request.clone(), CancelToken::new())
        .await
        .expect("the endpoint accepts the request");
    let mut assembler = ResponseAssembler::new();
    while let Some(event) = stream.next().await {
        println!("turn1 event: {event:?}");
        assembler.push(event).expect("assembles");
    }
    let first = assembler.finish().expect("turn 1 finished");
    println!("--- turn 1 assembled ---\n{first:#?}");

    assert!(
        !(first.usage.input_tokens == 0 && first.usage.output_tokens == 0),
        "the endpoint must report usage, got {:?}",
        first.usage
    );
    let calls = first.message.tool_calls();
    assert_eq!(
        calls.len(),
        1,
        "the model must produce exactly one tool call, got {calls:?} (text {:?})",
        first.message.text()
    );
    assert_eq!(calls[0].name, "read_file");
    assert_eq!(first.stop_reason, StopReason::ToolUse);
    let arguments = calls[0].arguments.clone();
    println!("--- turn 1 tool call ---\n{} {}", calls[0].id, arguments);
    assert_eq!(
        arguments.get("path").and_then(|path| path.as_str()),
        Some(notes.to_str().unwrap()),
        "arguments must survive the delta assembly"
    );

    // ---- the tool really runs ---------------------------------------------
    let mut result = run_tool(&calls[0].name, &arguments);
    result.call_id = calls[0].id.clone();
    println!("--- tool result ---\n{result:?}");
    assert!(!result.is_error, "the tool itself must succeed");
    assert!(result.content.contains(secret), "tool read the fixture");

    // ---- turn 2: the result goes back and the model finishes -------------
    let mut assistant = Message::new(Role::Assistant);
    if !first.message.text().is_empty() {
        assistant.push_text(&first.message.text());
    }
    for call in first.message.tool_calls() {
        assistant.push_tool_call(call.clone());
    }
    let mut second = ChatRequest::new(
        model(),
        vec![
            request.messages[0].clone(),
            assistant,
            Message::tool_result(result),
        ],
    );
    second.system = request.system.clone();
    second.tools = vec![read_file_tool()];

    let mut stream = provider
        .stream(second, CancelToken::new())
        .await
        .expect("the second request is accepted");
    let mut assembler = ResponseAssembler::new();
    while let Some(event) = stream.next().await {
        println!("turn2 event: {event:?}");
        assembler.push(event).expect("assembles");
    }
    let last = assembler.finish().expect("turn 2 finished");
    println!("--- turn 2 assembled ---\n{last:#?}");

    assert_eq!(
        last.stop_reason,
        StopReason::EndTurn,
        "turn 2 must close the turn"
    );
    assert!(
        last.message.text().contains("42"),
        "the model must repeat what the tool returned, got {:?}",
        last.message.text()
    );
    assert!(last.usage.input_tokens > 0, "usage: {:?}", last.usage);
    assert!(last.usage.output_tokens > 0, "usage: {:?}", last.usage);
}

/// Abort, not just "the stream ended": cancelling mid-stream must end the stream
/// promptly and leave no finish frame — the assembler then reports
/// `IncompleteStream` rather than a fabricated success.
#[tokio::test]
#[ignore = "spends real tokens on a live Responses endpoint; run with --ignored"]
async fn cancelling_a_responses_stream_ends_it() {
    let provider = provider();
    let mut request = ChatRequest::new(
        model(),
        vec![Message::user_text(
            "Count slowly from 1 to 200, one number per line.".to_string(),
        )],
    );
    request.max_output_tokens = Some(400);

    let cancel = CancelToken::new();
    let mut stream = provider
        .stream(request, cancel.clone())
        .await
        .expect("the endpoint accepts the request");

    let mut seen = 0usize;
    let mut saw_finish = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        let Some(event) = stream.next().await else {
            break;
        };
        println!("cancel-check event: {event:?}");
        saw_finish |= matches!(event, StreamEvent::Finish(_));
        seen += 1;
        if seen == 1 {
            // Cancel as soon as anything arrives, then keep draining: the channel
            // must close, not hang until the provider finishes.
            cancel.cancel();
            let started = Instant::now();
            while stream.next().await.is_some() {}
            let waited = started.elapsed();
            println!("drain after cancel took {waited:?}");
            assert!(
                waited < Duration::from_secs(10),
                "cancel must not wait for the provider"
            );
            assert!(
                !saw_finish,
                "a cancelled turn must not report a finish reason"
            );
            return;
        }
    }
    panic!("the stream never produced an event");
}
