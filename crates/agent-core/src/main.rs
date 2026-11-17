//! `pi-desktop-agent-core` — the Rust agent kernel executable.
//!
//! Phase 1 has no RPC transport yet; the binary exists so the kernel can be
//! exercised as a real process:
//!
//! ```text
//! pi-desktop-agent-core --version     print the crate version
//! pi-desktop-agent-core self-check    run a scripted turn and print its events
//! ```
//!
//! The sidecar phase replaces `self-check` with the NDJSON JSON-RPC loop, and
//! the checked-in self-check stays as the smoke test the packaging step runs
//! after a build.

use std::process::ExitCode;
use std::sync::Arc;

use agent_core::provider::scripted::ScriptedProvider;
use agent_core::{
    AgentEvent, AllowAll, CancelToken, ContentPart, EventSink, Message, RecordingSink, Result,
    Role, StopReason, Tool, ToolCall, ToolContext, ToolRegistry, ToolSpec, TurnConfig, TurnEngine,
};
use serde_json::Value;

/// A tool with no side effects, so the self-check proves the tool path without
/// touching the filesystem.
struct EchoTool;

impl Tool for EchoTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "echo",
            "Echo the `text` argument back to the model",
            serde_json::json!({
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let text = call
                .arguments
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("<missing text>");
            Ok(format!("echo: {text}"))
        })
    }
}

fn scripted_two_step_turn() -> ScriptedProvider {
    ScriptedProvider::new(vec![
        // Step 1: the model asks for the tool.
        vec![
            agent_core::StreamEvent::ToolCallStart {
                index: 0,
                id: "call_echo".into(),
                name: "echo".into(),
            },
            agent_core::StreamEvent::ToolCallDelta {
                index: 0,
                arguments_delta: "{\"text\":\"hi\"}".into(),
            },
            agent_core::StreamEvent::Usage(agent_core::Usage {
                input_tokens: 21,
                output_tokens: 4,
                ..agent_core::Usage::default()
            }),
            agent_core::StreamEvent::Finish(StopReason::ToolUse),
        ],
        // Step 2: the model answers using the result.
        vec![
            agent_core::StreamEvent::ThinkingDelta("the tool answered".into()),
            agent_core::StreamEvent::TextDelta("echo: hi".into()),
            agent_core::StreamEvent::Usage(agent_core::Usage {
                input_tokens: 30,
                output_tokens: 5,
                ..agent_core::Usage::default()
            }),
            agent_core::StreamEvent::Finish(StopReason::EndTurn),
        ],
    ])
}

async fn run_self_check() -> bool {
    let provider = Arc::new(scripted_two_step_turn());
    let mut registry = ToolRegistry::new(Arc::new(AllowAll));
    registry.register(Arc::new(EchoTool));
    let tools = Arc::new(registry);
    let sink = Arc::new(RecordingSink::new());
    let engine = TurnEngine::new(provider.clone(), tools, sink.clone() as Arc<dyn EventSink>);

    let mut transcript = agent_core::session::Transcript::new();
    transcript.push(Message::user_text("say hi through the tool"));

    let outcome = match engine
        .run_turn(
            "self-check-session",
            "self-check-turn",
            &mut transcript,
            &TurnConfig::new("scripted-model"),
            CancelToken::new(),
        )
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            eprintln!("self-check failed: {error}");
            return false;
        }
    };

    for envelope in sink.snapshot() {
        match serde_json::to_string(&envelope) {
            Ok(line) => println!("{line}"),
            Err(error) => {
                eprintln!("could not serialize an event: {error}");
                return false;
            }
        }
    }

    let assistant = transcript
        .messages()
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant)
        .map(|message| {
            message
                .parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>()
        })
        .unwrap_or_default();

    let tool_results = transcript
        .messages()
        .iter()
        .filter_map(|message| message.tool_results().first().cloned())
        .count();

    let checks = [
        ("two provider requests", provider.requests().len() == 2),
        ("one tool result recorded", tool_results == 1),
        (
            "assistant answer is the tool output",
            assistant == "echo: hi",
        ),
        (
            "turn ended on end_turn",
            outcome.stop_reason == StopReason::EndTurn,
        ),
        ("usage accumulated", outcome.usage.input_tokens == 51),
        (
            "events include the tool path",
            sink.snapshot()
                .iter()
                .any(|envelope| matches!(envelope.event, AgentEvent::ToolStart { .. })),
        ),
    ];

    let mut ok = true;
    for (name, passed) in checks {
        println!(
            "self-check: {} {name}",
            if passed { "PASS" } else { "FAIL" }
        );
        ok &= passed;
    }
    println!(
        "self-check: {} messages, {} steps, {} input tokens, {} output tokens",
        transcript.len(),
        outcome.steps,
        outcome.usage.input_tokens,
        outcome.usage.output_tokens
    );
    ok
}

fn usage() {
    println!("pi-desktop-agent-core {}", agent_core::VERSION);
    println!("usage:");
    println!("  pi-desktop-agent-core --version     print the crate version");
    println!("  pi-desktop-agent-core self-check    run a scripted turn and print its events");
    println!("  pi-desktop-agent-core serve         serve NDJSON JSON-RPC on stdio");
}

/// The protocol loop Electron main uses: one JSON value per line in, one out,
/// `agent.event` notifications interleaved with responses.
async fn serve() -> ExitCode {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (writer_tx, mut writer_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = writer_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    // Phase 2 ships no tools: filesystem/shell tools arrive with the host-core
    // bridge, and an empty registry keeps declarations honest meanwhile.
    let registry = ToolRegistry::new(Arc::new(AllowAll));
    let sink: Arc<dyn agent_core::sidecar::LineSink> = Arc::new(writer_tx.clone());
    let sidecar = Arc::new(agent_core::sidecar::Sidecar::new(sink, Arc::new(registry)));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => match agent_core::rpc::parse_line(&line) {
                agent_core::rpc::Incoming::Empty => {}
                agent_core::rpc::Incoming::Invalid { error, id } => {
                    let _ = writer_tx.send(agent_core::rpc::error_response(
                        id.unwrap_or(Value::Null),
                        error,
                    ));
                }
                agent_core::rpc::Incoming::Request(request) => {
                    if let Some(answer) = sidecar.handle(request).await {
                        let _ = writer_tx.send(answer);
                    }
                }
            },
            // The peer closed stdin: shut down like a well-behaved child.
            Ok(None) => break,
            Err(error) => {
                eprintln!("stdin read failed: {error}");
                return ExitCode::FAILURE;
            }
        }
    }

    drop(sidecar);
    drop(writer_tx);
    let _ = writer.await;
    ExitCode::SUCCESS
}

#[tokio::main]
async fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--version") | Some("version") => {
            println!("pi-desktop-agent-core {}", agent_core::VERSION);
            ExitCode::SUCCESS
        }
        Some("self-check") => {
            if run_self_check().await {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Some("serve") => serve().await,
        _ => {
            usage();
            ExitCode::from(2)
        }
    }
}
