//! The shipped binary, answering a reverse host call over a real pipe.
//!
//! A request handler can ask the host something and wait for the answer, and that
//! answer arrives on the same stdin as the request. A read loop that dispatches
//! one request at a time cannot deliver it: the handler holds the loop, the
//! answer is never read, and every prompt that asks the host for anything — the
//! session's history, the journal write — waits out its timeout and then runs
//! without it. This test drives that round trip through the real binary, because
//! the unit tests call the handler directly and cannot see it.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn line(value: Value) -> String {
    format!("{value}\n")
}

#[test]
fn the_binary_answers_a_reverse_host_call_while_a_request_is_running() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nubo-proto"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the sidecar binary");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let (tx, rx) = mpsc::channel::<Value>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if tx.send(value).is_err() {
                return;
            }
        }
    });

    stdin
        .write_all(
            line(json!({
                "jsonrpc": "2.0", "id": 1, "method": "sidecar.configure",
                "params": {
                    // Enough replies for the summary request and the turn that
                    // follows it; the point of the test is the host round trip.
                    // A long summary is chunked, so the compaction alone can take
                    // several requests; the count here is headroom, not precision.
                    "provider": {"kind": "scripted", "script": [
                        {"text": "summary"} , {"text": "summary"} , {"text": "summary"} ,
                        {"text": "summary"} , {"text": "summary"} , {"text": "summary"} ,
                        {"text": "summary"} , {"text": "summary"} , {"text": "summary"} ,
                        {"text": "summary"} , {"text": "summary"} , {"text": "summary"} ,
                        {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                        {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                        {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                        {"text": "answered"}, {"text": "answered"}, {"text": "answered"}
                    ]},
                    "model": "scripted-model"
                }
            }))
            .as_bytes(),
        )
        .expect("configure");

    // A history that does not fit the window: the turn has to compact first, and
    // restoring it is what the host call below answers.
    let mut messages = Vec::new();
    for index in 0..24 {
        messages.push(json!({
            "id": format!("h-u{index}"), "role": "user",
            "content": format!("Question {index}: {}", "context ".repeat(60))
        }));
        messages.push(json!({
            "id": format!("h-a{index}"), "role": "assistant",
            "content": format!("Answer {index}: {}", "detail ".repeat(60))
        }));
    }

    stdin
        .write_all(
            line(json!({
                "jsonrpc": "2.0", "id": 2, "method": "agent.prompt",
                "params": {
                    "sessionId": "pipe-host", "turnId": "pipe-turn", "content": "continue",
                    // The prompt carries its own provider, and this is the one the
                    // summary request uses too.
                    "provider": {
                        "kind": "scripted",
                        "modelConfig": {"contextWindow": 8192, "maxTokens": 2048},
                        "script": [
                            {"text": "summary"}, {"text": "summary"}, {"text": "summary"},
                            {"text": "summary"}, {"text": "summary"}, {"text": "summary"},
                            {"text": "summary"}, {"text": "summary"}, {"text": "summary"},
                            {"text": "summary"}, {"text": "summary"}, {"text": "summary"},
                            {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                            {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                            {"text": "answered"}, {"text": "answered"}, {"text": "answered"},
                            {"text": "answered"}, {"text": "answered"}, {"text": "answered"}
                        ]
                    },
                    // The review is a second forked run; it would need its own
                    // replies and has nothing to do with this test's subject.
                    "skillReview": {"enabled": false}
                }
            }))
            .as_bytes(),
        )
        .expect("prompt");
    stdin.flush().expect("flush");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut saw_compaction = false;
    let mut saw_agent_end = false;
    let mut host_calls = Vec::new();
    while !(saw_compaction && saw_agent_end) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out; host calls: {host_calls:?}"
        );
        let frame = rx
            .recv_timeout(remaining)
            .expect("a frame before the timeout");
        if frame.get("method").and_then(Value::as_str) == Some("host.proxy") {
            let method = frame["params"]["method"].as_str().unwrap_or("").to_string();
            host_calls.push(method.clone());
            let result = if method == "session.get" {
                json!({ "session": { "messages": messages } })
            } else {
                json!({ "ok": true })
            };
            stdin
                .write_all(
                    line(json!({ "jsonrpc": "2.0", "id": frame["id"], "result": result }))
                        .as_bytes(),
                )
                .expect("answer the host call");
            stdin.flush().expect("flush the answer");
            continue;
        }
        if std::env::var("PROBE").is_ok() {
            println!(
                "frame: {}",
                serde_json::to_string(&frame)
                    .unwrap_or_default()
                    .chars()
                    .take(160)
                    .collect::<String>()
            );
        }
        let event = frame
            .get("params")
            .and_then(|params| params.get("event"))
            .cloned()
            .unwrap_or(Value::Null);
        match event.get("type").and_then(Value::as_str) {
            Some("compaction_start") => saw_compaction = true,
            Some("agent_end") => saw_agent_end = true,
            Some("error") => panic!("the turn failed: {event}"),
            _ => {}
        }
    }

    drop(stdin);
    let status = child.wait().expect("the child exits when stdin closes");
    assert!(status.success(), "exit status: {status:?}");
    assert!(
        host_calls.iter().any(|method| method == "session.get"),
        "the kernel asked the host for history: {host_calls:?}"
    );
}
