//! `nubo-proto` — the Rust agent kernel executable.
//!
//! Phase 1 has no RPC transport yet; the binary exists so the kernel can be
//! exercised as a real process:
//!
//! ```text
//! nubo-proto --version     print the crate version
//! nubo-proto self-check    run a scripted turn and print its events
//! ```
//!
//! The sidecar phase replaces `self-check` with the NDJSON JSON-RPC loop, and
//! the checked-in self-check stays as the smoke test the packaging step runs
//! after a build.
//!
//! # Where the logs go
//!
//! **stdout is the protocol.** Every line on it is either a JSON-RPC response or
//! an `agent.event` notification, so nothing else may be written there — a stray
//! print would be parsed as a frame and corrupt the stream.
//!
//! Diagnostics therefore go to **stderr**, which Electron main captures and files
//! as `agent/runtime.log` (`child.process.stderr`). They are `tracing` events,
//! filtered by `RUST_LOG` and defaulting to `warn` for dependencies and `info` for
//! the kernel itself: a crash report needs the boot/shutdown/request lines without
//! a user having to reproduce with a special environment. Set
//! `RUST_LOG=agent_core=debug` (or `trace`) to see the loop in detail.
//!
//! A panic also survives into that log: the hook installed by
//! `install_panic_hook` records thread, file:line and message before the default
//! hook prints the backtrace, so "the sidecar just died" is attributable.

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
    println!("nubo-proto {}", agent_core::VERSION);
    println!("usage:");
    println!("  nubo-proto --version     print the crate version");
    println!("  nubo-proto self-check    run a scripted turn and print its events");
    println!("  nubo-proto serve         serve NDJSON JSON-RPC on stdio");
}

/// The protocol loop Electron main uses: one JSON value per line in, one out,
/// `agent.event` notifications interleaved with responses.
async fn serve() -> ExitCode {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    tracing::info!(target: "agent_core::sidecar", "serving NDJSON JSON-RPC on stdin");

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

    // Tools are host-declared: `sidecar.configure` installs the ones main
    // sends, and each call travels back through the bridge.
    let sink: Arc<dyn agent_core::sidecar::LineSink> = Arc::new(writer_tx.clone());
    let sidecar = Arc::new(agent_core::sidecar::Sidecar::with_default_gate(sink));

    // Requests are answered in the order they arrive — `sidecar.configure` must
    // land before the prompt that depends on it — but on their own task, so the
    // reader below is free to deliver the answer to a reverse host call while a
    // handler is still waiting for it. Reading and handling on one task
    // deadlocks any handler that asks the host something: the answer arrives on
    // this same stdin, behind the handler that is waiting for it.
    let (request_tx, mut request_rx) =
        tokio::sync::mpsc::unbounded_channel::<agent_core::rpc::Request>();
    let worker_writer = writer_tx.clone();
    let worker_sidecar = sidecar.clone();
    let worker = tokio::spawn(async move {
        while let Some(request) = request_rx.recv().await {
            if let Some(answer) = worker_sidecar.handle(request).await {
                let _ = worker_writer.send(answer);
            }
        }
        worker_sidecar.bridge().fail_all("peer closed stdin");
        drop(worker_writer);
    });

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
                // A reverse host call's answer goes straight to the bridge, so a
                // waiting handler is released even while another request runs.
                agent_core::rpc::Incoming::Response { id, outcome } => {
                    if let Some(id) = id.as_str() {
                        sidecar.bridge().complete(id, outcome);
                    }
                }
                agent_core::rpc::Incoming::Request(request) => {
                    let _ = request_tx.send(request);
                }
            },
            // The peer closed stdin: shut down like a well-behaved child, and
            // fail every host call still waiting before the process exits.
            Ok(None) => {
                tracing::info!(target: "agent_core::sidecar", "stdin closed by the host; shutting down");
                break;
            }
            Err(error) => {
                tracing::error!(target: "agent_core::sidecar", %error, "stdin read failed");
                sidecar.bridge().fail_all("stdin closed");
                return ExitCode::FAILURE;
            }
        }
    }

    // Closing the queue lets the worker finish what it already accepted, then it
    // fails every host call still waiting and drops its writer clone. The sink
    // inside this sidecar holds one too: without dropping it the writer task
    // never sees the channel close and the process outlives its stdin.
    drop(request_tx);
    let _ = worker.await;
    drop(sidecar);
    drop(writer_tx);
    let _ = writer.await;
    tracing::info!(target: "agent_core::sidecar", "shutdown complete");
    ExitCode::SUCCESS
}

/// Install the diagnostics subscriber: stderr, `RUST_LOG`, `warn` +
/// `agent_core=info` by default.
///
/// A second call is ignored rather than an error — the binary may install it from
/// more than one entry path, and `try_init` is the one that tolerates both.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,agent_core=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        // stdout belongs to the protocol; only stderr is ours.
        .with_writer(std::io::stderr)
        // One line per event: a support log is read with grep, and a multi-line
        // event breaks that.
        .with_ansi(false)
        .try_init();
}

/// Record a panic in the support log before the default hook prints it.
///
/// A kernel panic is the one failure a client reports as "the app closed": the
/// process dies without answering anything, and without this line the log ends
/// at the last request with no statement of why. The payload is the panic
/// message only — never the arguments of the request being handled.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "<unknown location>".to_string());
        let thread = std::thread::current();
        tracing::error!(
            target: "agent_core::panic",
            thread = thread.name().unwrap_or("<unnamed>"),
            location = %location,
            panic = %message,
            "agent kernel panicked"
        );
        default_hook(info);
    }));
}

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();
    install_panic_hook();
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "usage".to_string());
    tracing::info!(
        target: "agent_core::boot",
        mode = %mode,
        version = agent_core::VERSION,
        pid = std::process::id(),
        "agent kernel started"
    );
    match mode.as_str() {
        "--version" | "version" => {
            println!("nubo-proto {}", agent_core::VERSION);
            ExitCode::SUCCESS
        }
        "self-check" => {
            if run_self_check().await {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        "serve" => serve().await,
        _ => {
            usage();
            ExitCode::from(2)
        }
    }
}
