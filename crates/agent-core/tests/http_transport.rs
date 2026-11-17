//! Transport tests against a real socket.
//!
//! A one-shot HTTP server on `127.0.0.1` replays a recorded provider response
//! in several `Transfer-Encoding: chunked` pieces, so the test covers the whole
//! path the sidecar will use — request build, auth header, status handling,
//! chunked read, SSE framing across chunk boundaries, decode, assembly — without
//! a credential, a network or a paid request.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

use agent_core::provider::http::{HttpProvider, HttpProviderConfig};
use agent_core::{AgentError, CancelToken, ChatRequest, Message, Provider, StopReason, ToolResult};

/// What the fixture server should answer.
struct Reply {
    status_line: &'static str,
    content_type: &'static str,
    /// Bodies of the chunked response, in order. Each piece is written as one
    /// HTTP chunk, which is how a real provider's frames arrive split.
    chunks: Vec<String>,
}

struct Fixture {
    base_url: String,
    received: Arc<Mutex<Vec<String>>>,
}

/// Serve exactly one request, then close.
fn serve(reply: Reply) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
    let port = listener.local_addr().unwrap().port();
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();

    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let request = read_request(&mut stream);
        sink.lock().unwrap().push(request);

        let mut head = format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            reply.status_line, reply.content_type
        );
        stream.write_all(head.as_bytes()).expect("write head");
        head.clear();

        for piece in reply.chunks {
            let frame = format!("{:x}\r\n{piece}\r\n", piece.len());
            stream.write_all(frame.as_bytes()).expect("write chunk");
            stream.flush().expect("flush chunk");
        }
        stream.write_all(b"0\r\n\r\n").expect("write terminator");
        stream.flush().ok();
    });

    Fixture {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        received,
    }
}

fn read_request(stream: &mut TcpStream) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).expect("read request");
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&buffer).to_string();
        if let Some(head_end) = text.find("\r\n\r\n") {
            let content_length = text
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            if buffer.len() >= head_end + 4 + content_length {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

fn sse(chunk: &str) -> String {
    format!("data: {chunk}\n\n")
}

#[tokio::test]
async fn openai_stream_is_read_from_a_real_socket() {
    // The response is split mid-frame on purpose: the first chunk ends inside
    // the JSON, which is what a provider does when its buffer fills.
    let fixture = serve(Reply {
        status_line: "200 OK",
        content_type: "text/event-stream",
        chunks: vec![
            sse(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#),
            sse(r#"{"choices":[{"delta":{"content":"lo"}}]}"#).to_string() + "data: {\"choices\":[{\"delta\":{},\"fi",
            "nish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n"
                .to_string(),
        ],
    });

    let provider = HttpProvider::new(HttpProviderConfig::openai(
        "fixture",
        fixture.base_url.clone(),
        "sk-test",
    ))
    .expect("client");

    let mut request = ChatRequest::new("gpt-test", vec![Message::user_text("hi")]);
    request.system = Some("be terse".into());

    let response = provider
        .stream(request, CancelToken::new())
        .await
        .expect("the request is accepted")
        .collect()
        .await
        .expect("the stream completes");

    assert_eq!(response.message.text(), "Hello");
    assert_eq!(response.stop_reason, StopReason::EndTurn);
    assert_eq!(response.usage.input_tokens, 7);
    assert_eq!(response.usage.output_tokens, 3);

    let sent = fixture.received.lock().unwrap()[0].clone();
    assert!(
        sent.starts_with("POST /v1/chat/completions "),
        "sent: {sent}"
    );
    assert!(
        sent.to_ascii_lowercase()
            .contains("authorization: bearer sk-test"),
        "the bearer header must reach the provider"
    );
    assert!(sent.contains("\"stream\":true"));
    assert!(sent.contains("\"content\":\"hi\""));
    assert!(sent.contains("\"system\""));
}

#[tokio::test]
async fn anthropic_stream_is_read_from_a_real_socket() {
    let fixture = serve(Reply {
        status_line: "200 OK",
        content_type: "text/event-stream",
        chunks: vec![
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n\n".to_string(),
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\"}}\n\n".to_string(),
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}}\n\n".to_string(),
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_string(),
        ],
    });

    let provider = HttpProvider::new(HttpProviderConfig::anthropic(
        "claude",
        fixture.base_url.clone(),
        "sk-ant-test",
    ))
    .expect("client");

    let mut request = ChatRequest::new(
        "claude-test",
        vec![
            Message::user_text("read a.txt"),
            assistant_with_call(),
            tool_result_message(),
        ],
    );
    request.system = Some("be careful".into());

    let response = provider
        .stream(request, CancelToken::new())
        .await
        .expect("accepted")
        .collect()
        .await
        .expect("stream completes");

    assert_eq!(response.stop_reason, StopReason::ToolUse);
    let call = &response.message.tool_calls()[0];
    assert_eq!(call.id, "toolu_1");
    assert_eq!(call.name, "read_file");
    assert_eq!(call.arguments, serde_json::json!({"path": "a.txt"}));

    let sent = fixture.received.lock().unwrap()[0].clone();
    assert!(sent.starts_with("POST /v1/messages "), "sent: {sent}");
    assert!(sent.to_ascii_lowercase().contains("x-api-key: sk-ant-test"));
    assert!(sent
        .to_ascii_lowercase()
        .contains("anthropic-version: 2023-06-01"));
    assert!(sent.contains("\"system\":\"be careful\""));
    assert!(sent.contains("\"tool_result\""));
}

#[tokio::test]
async fn a_rate_limited_response_is_a_retryable_error() {
    let fixture = serve(Reply {
        status_line: "429 Too Many Requests",
        content_type: "application/json",
        chunks: vec![r#"{"error":"slow down"}"#.to_string()],
    });

    let provider = HttpProvider::new(HttpProviderConfig::openai(
        "fixture",
        fixture.base_url.clone(),
        "sk-test",
    ))
    .expect("client");

    let error = provider
        .stream(
            ChatRequest::new("m", vec![Message::user_text("hi")]),
            CancelToken::new(),
        )
        .await
        .expect_err("a 429 must fail the request, not the stream");
    assert!(error.is_retryable(), "got: {error}");
    assert!(matches!(
        error,
        AgentError::Provider {
            status: Some(429),
            ..
        }
    ));
    assert!(error.to_string().contains("slow down"));
}

#[tokio::test]
async fn a_truncated_body_surfaces_as_an_incomplete_stream() {
    let fixture = serve(Reply {
        status_line: "200 OK",
        content_type: "text/event-stream",
        // One text frame, then the body ends with no finish reason.
        chunks: vec![sse(r#"{"choices":[{"delta":{"content":"par"}}]}"#)],
    });

    let provider = HttpProvider::new(HttpProviderConfig::openai(
        "fixture",
        fixture.base_url.clone(),
        "sk-test",
    ))
    .expect("client");

    let error = provider
        .stream(
            ChatRequest::new("m", vec![Message::user_text("hi")]),
            CancelToken::new(),
        )
        .await
        .expect("accepted")
        .collect()
        .await
        .expect_err("a body without a finish frame is not a completed response");
    assert!(matches!(error, AgentError::IncompleteStream));
}

fn assistant_with_call() -> Message {
    let mut assistant = Message::new(agent_core::Role::Assistant);
    assistant.push_tool_call(agent_core::ToolCall {
        id: "toolu_0".into(),
        name: "read_file".into(),
        arguments: serde_json::json!({"path": "b.txt"}),
        raw_arguments: None,
    });
    assistant
}

fn tool_result_message() -> Message {
    Message::tool_result(ToolResult {
        call_id: "toolu_0".into(),
        name: "read_file".into(),
        content: "previous body".into(),
        is_error: false,
        truncated: false,
    })
}
