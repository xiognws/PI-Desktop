//! The shipped binary, driven over a real pipe.
//!
//! This is the contract Electron main will use: spawn
//! `nubo-proto serve`, write one JSON value per line, read one per
//! line back with `agent.event` notifications interleaved. Nothing is mocked —
//! the assertions are made about bytes that crossed a process boundary.

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
fn the_binary_speaks_the_sidecar_protocol_on_stdio() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nubo-proto"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the sidecar binary");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let requests = [
        line(json!({"jsonrpc": "2.0", "id": 1, "method": "sidecar.health", "params": {}})),
        line(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "sidecar.configure",
            "params": {
                "provider": {"kind": "scripted", "text": "piped hello"},
                "model": "scripted-model"
            }
        })),
        line(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "agent.prompt",
            "params": {"sessionId": "pipe-session", "turnId": "pipe-turn", "prompt": "hi"}
        })),
        // A malformed frame must be answered, not crash the process.
        "{not json\n".to_string(),
    ];
    for request in &requests {
        stdin.write_all(request.as_bytes()).expect("write request");
    }
    stdin.flush().expect("flush requests");

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut responses: Vec<Value> = Vec::new();
    let mut saw_agent_end = false;
    let mut asked_for_transcript = false;
    while !(saw_agent_end && responses.iter().any(|value| value["id"] == 4)) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out; saw: {}",
            serde_json::to_string_pretty(&responses).unwrap_or_default()
        );
        let raw = rx
            .recv_timeout(remaining)
            .expect("a line before the timeout");
        let value: Value = serde_json::from_str(&raw).expect("every output line is JSON");
        if std::env::var("PROBE").is_ok() {
            println!(
                "frame id={:?} method={:?} event={:?}",
                value.get("id"),
                value.get("method"),
                value.pointer("/params/event/type")
            );
        }
        // Stand in for Electron main. A turn asks the host for its history and
        // journals its prompt; without an answer those calls wait out their
        // timeout and the turn is slow, which would look like a protocol fault.
        if value.get("method").and_then(Value::as_str) == Some("host.proxy") {
            let method = value["params"]["method"].as_str().unwrap_or("");
            let result = if method == "session.get" {
                json!({ "session": { "messages": [] } })
            } else {
                json!({ "ok": true })
            };
            stdin
                .write_all(
                    line(json!({ "jsonrpc": "2.0", "id": value["id"], "result": result }))
                        .as_bytes(),
                )
                .expect("answer the host call");
            stdin.flush().expect("flush the answer");
            continue;
        }
        // A malformed input line is answered with a parse error carrying a null
        // id; it is a response like any other.
        if value.get("method").and_then(Value::as_str) == Some("agent.event")
            && value["params"]["event"]["type"] == "agent_end"
            && !asked_for_transcript
        {
            saw_agent_end = true;
            asked_for_transcript = true;
            // The transcript is complete only now; asking earlier races the turn.
            stdin
                .write_all(
                    line(
                        json!({"jsonrpc": "2.0", "id": 4, "method": "native.session.get",
                                "params": {"sessionId": "pipe-session"}}),
                    )
                    .as_bytes(),
                )
                .expect("ask for the transcript");
            stdin.flush().expect("flush the transcript request");
        }
        responses.push(value);
    }

    drop(stdin);
    let status = child.wait().expect("the child exits when stdin closes");
    assert!(status.success(), "exit status: {status:?}");

    let by_id = |id: i64| -> &Value {
        responses
            .iter()
            .find(|value| value["id"] == id)
            .unwrap_or_else(|| panic!("no response with id {id}: {responses:#?}"))
    };

    assert_eq!(by_id(1)["result"]["runtime"], "rust");
    assert_eq!(by_id(2)["result"]["providerDeclared"], true);
    assert_eq!(by_id(3)["result"]["accepted"], true);
    assert_eq!(by_id(3)["result"]["turnId"], "pipe-turn");

    // The malformed frame produced a parse error with a null id.
    let parse_error = responses
        .iter()
        .find(|value| value["error"]["code"] == -32700)
        .expect("a parse error for the malformed line");
    assert!(parse_error["id"].is_null());

    let messages = by_id(4)["result"]["messages"]
        .as_array()
        .expect("the transcript");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["parts"][0]["text"], "piped hello");
}
