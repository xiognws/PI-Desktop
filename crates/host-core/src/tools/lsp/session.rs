//! LSP session: one server process per language, requests correlated by id.
//!
//! Stage 2 of ADR 0401. A language server is a long-lived child process that talks
//! JSON-RPC over its own stdin/stdout: requests go out with an incrementing id,
//! responses come back with the same id *and in no particular order* — a server may
//! answer request 7 before request 5, and may interleave notifications (diagnostics,
//! logs) between them. So correlation has to be by id, never by arrival order.
//!
//! The dispatcher is separated from the process so the part that can be wrong in
//! subtle ways is testable without spawning `rust-analyzer`: it takes a decoded
//! payload and reports what it was — a response for a waiting id, a notification, or
//! a response nobody is waiting for (which is normal: a timed-out request still gets
//! answered eventually and must not be mistaken for the next one).

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::framing;

/// What a decoded payload turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivered {
    /// A response for a request that is still waiting.
    Response { id: u64 },
    /// A response for an id nobody is waiting for: the request timed out, or the
    /// server answered a notification. Dropped on purpose.
    Orphan { id: u64 },
    /// A server-initiated message, kept per method (diagnostics arrive this way).
    Notification { method: String },
    /// A server-to-client request (e.g. `window/workDoneProgress/create`). Answered
    /// with null by the reader thread; recorded so a caller can see it happened.
    ServerRequest { id: u64, method: String },
    /// Not JSON-RPC at all. Kept as a string rather than dropped: a server that
    /// writes a banner to stdout is a real failure mode and must be visible.
    Unparsed,
}

/// Correlates responses with the requests waiting for them.
#[derive(Default)]
pub struct Dispatcher {
    next_id: u64,
    pending: HashMap<u64, Sender<String>>,
    notifications: HashMap<String, Vec<String>>,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            pending: HashMap::new(),
            notifications: HashMap::new(),
        }
    }

    /// Allocate an id and the channel its response will arrive on.
    pub fn begin(&mut self) -> (u64, Receiver<String>) {
        let id = self.next_id;
        self.next_id += 1;
        let (tx, rx) = mpsc::channel();
        self.pending.insert(id, tx);
        (id, rx)
    }

    /// Stop waiting for an id (the request timed out or the caller gave up).
    pub fn abandon(&mut self, id: u64) {
        self.pending.remove(&id);
    }

    /// Route one decoded payload.
    pub fn deliver(&mut self, payload: &str) -> Delivered {
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return Delivered::Unparsed;
        };
        let id = value.get("id").and_then(Value::as_u64);
        let method = value.get("method").and_then(Value::as_str);
        match (id, method) {
            // A response: an id and no method.
            (Some(id), None) => match self.pending.remove(&id) {
                Some(tx) => {
                    // The receiver may be gone if the caller timed out between the
                    // removal above and this send; that is not an error.
                    let _ = tx.send(payload.to_string());
                    Delivered::Response { id }
                }
                None => Delivered::Orphan { id },
            },
            // A server-initiated request: it has an id *and* a method, and expects
            // an answer. Recorded, answered by the reader loop.
            (Some(id), Some(method)) => Delivered::ServerRequest {
                id,
                method: method.to_string(),
            },
            (None, Some(method)) => {
                self.notifications
                    .entry(method.to_string())
                    .or_default()
                    .push(payload.to_string());
                Delivered::Notification {
                    method: method.to_string(),
                }
            }
            (None, None) => Delivered::Unparsed,
        }
    }

    /// The last notification received for a method, if any.
    pub fn last_notification(&self, method: &str) -> Option<&str> {
        self.notifications
            .get(method)
            .and_then(|list| list.last())
            .map(String::as_str)
    }

    /// How many responses arrived for ids nobody was waiting for.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

/// Errors a session call can return. Each one names what was being attempted: an
/// LSP failure with no method in it is unactionable.
#[derive(Debug)]
pub enum SessionError {
    Spawn(String),
    NotRunning,
    Timeout {
        method: String,
        waited: Duration,
    },
    /// The server answered with a JSON-RPC error object.
    Rpc {
        method: String,
        message: String,
    },
    /// The reader thread ended: the server exited or closed its stdout.
    Closed {
        method: String,
    },
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Spawn(detail) => {
                write!(f, "could not start the language server: {detail}")
            }
            SessionError::NotRunning => write!(f, "the language server is not running"),
            SessionError::Timeout { method, waited } => {
                write!(f, "{method} did not answer within {waited:?}")
            }
            SessionError::Rpc { method, message } => write!(f, "{method} failed: {message}"),
            SessionError::Closed { method } => {
                write!(f, "{method} was abandoned: the language server exited")
            }
        }
    }
}

impl std::error::Error for SessionError {}

/// How long each phase of the session may take. Separate values because they fail
/// for different reasons: an initialize that is slow means a server is indexing, a
/// request that is slow means the server is stuck.
#[derive(Debug, Clone, Copy)]
pub struct SessionTimeouts {
    pub initialize: Duration,
    pub request: Duration,
    pub shutdown: Duration,
}

impl Default for SessionTimeouts {
    fn default() -> Self {
        Self {
            // rust-analyzer on a large workspace indexes for a while before it
            // answers `initialize`; a shorter value would report "broken" for a
            // server that is working.
            initialize: Duration::from_secs(120),
            request: Duration::from_secs(30),
            shutdown: Duration::from_secs(5),
        }
    }
}

/// A running language server.
pub struct LspSession {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    dispatcher: Arc<Mutex<Dispatcher>>,
    reader: Option<JoinHandle<()>>,
    timeouts: SessionTimeouts,
    /// Set when the reader thread saw EOF or a write failed: every later request
    /// reports `Closed` instead of hanging until its timeout.
    closed: Arc<Mutex<Option<String>>>,
}

impl LspSession {
    /// Start a server and complete the `initialize` handshake.
    ///
    /// `root` is sent as the workspace folder, so the server indexes the project the
    /// session is working in rather than whatever directory the app was launched
    /// from.
    pub fn start(
        command: &str,
        args: &[String],
        root: &str,
        timeouts: SessionTimeouts,
    ) -> Result<Self, SessionError> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| SessionError::Spawn(format!("{command}: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::Spawn("the server has no stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SessionError::Spawn("the server has no stdout".to_string()))?;

        let dispatcher = Arc::new(Mutex::new(Dispatcher::new()));
        let closed = Arc::new(Mutex::new(None::<String>));
        let stdin = Arc::new(Mutex::new(stdin));

        let reader = {
            let dispatcher = Arc::clone(&dispatcher);
            let closed = Arc::clone(&closed);
            let stdin = Arc::clone(&stdin);
            thread::spawn(move || read_loop(stdout, dispatcher, closed, stdin))
        };

        let mut session = Self {
            child,
            stdin,
            dispatcher,
            reader: Some(reader),
            timeouts,
            closed,
        };
        let root_uri = path_to_uri(root);
        let params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "pi-workspace" },
            "rootUri": root_uri,
            "capabilities": {
                // Read-only client: it declares only what the three tools need, so a
                // capability mismatch shows up as a missing answer rather than as an
                // edit the agent never asked for.
                "textDocument": { "definition": {}, "references": {}, "publishDiagnostics": {} },
                "workspace": { "workspaceFolders": true }
            },
            "workspaceFolders": [ { "uri": root_uri, "name": "workspace" } ]
        });
        session.request_with("initialize", params, timeouts.initialize)?;
        // `initialized` is a notification, not a request: the server will not index
        // until it arrives.
        session.notify("initialized", json!({}))?;
        Ok(session)
    }

    /// Send a request and wait for its response.
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, SessionError> {
        self.request_with(method, params, self.timeouts.request)
    }

    fn request_with(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, SessionError> {
        if let Some(reason) = self.closed.lock().ok().and_then(|guard| guard.clone()) {
            return Err(SessionError::Closed {
                method: format!("{method} ({reason})"),
            });
        }
        let (id, rx) = {
            let mut dispatcher = self
                .dispatcher
                .lock()
                .map_err(|_| SessionError::NotRunning)?;
            dispatcher.begin()
        };
        let payload = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(error) = self.send_payload(&payload.to_string()) {
            self.abandon(id);
            return Err(error);
        }
        // One wait, not a loop: the id is resolved exactly once, and a response that
        // arrives after the timeout is dropped by the dispatcher as an orphan rather
        // than being picked up by the next request.
        match rx.recv_timeout(timeout) {
            Ok(payload) => parse_response(method, &payload),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                self.abandon(id);
                if matches!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected)) {
                    return Err(SessionError::Closed {
                        method: method.to_string(),
                    });
                }
                Err(SessionError::Timeout {
                    method: method.to_string(),
                    waited: timeout,
                })
            }
        }
    }

    /// Send a notification (no id, no response expected).
    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), SessionError> {
        let payload = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.send_payload(&payload.to_string())
    }

    /// The last `textDocument/publishDiagnostics` payload the server sent.
    pub fn last_diagnostics(&self) -> Option<String> {
        let guard = self.dispatcher.lock().ok()?;
        guard
            .last_notification("textDocument/publishDiagnostics")
            .map(str::to_string)
    }

    /// Shut the server down deterministically.
    ///
    /// `shutdown` then `exit`, then wait — and kill only if it does not go. Dropping
    /// the reader thread before the child exits would leave the pipe open, which is
    /// how a language server turns into a process nobody can find again.
    pub fn shutdown(mut self) {
        let _ = self.request_with("shutdown", Value::Null, self.timeouts.shutdown);
        let _ = self.notify("exit", Value::Null);
        let deadline = Instant::now() + self.timeouts.shutdown;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }

    fn abandon(&mut self, id: u64) {
        if let Ok(mut dispatcher) = self.dispatcher.lock() {
            dispatcher.abandon(id);
        }
    }

    fn send_payload(&mut self, payload: &str) -> Result<(), SessionError> {
        let mut stdin = self.stdin.lock().map_err(|_| SessionError::NotRunning)?;
        let framed = framing::encode(payload);
        stdin.write_all(&framed).map_err(|error| {
            if let Ok(mut closed) = self.closed.lock() {
                *closed = Some(format!("write failed: {error}"));
            }
            SessionError::Closed {
                method: "write".to_string(),
            }
        })?;
        stdin.flush().map_err(|error| SessionError::Closed {
            method: format!("flush ({error})"),
        })
    }
}

fn read_loop(
    stdout: std::process::ChildStdout,
    dispatcher: Arc<Mutex<Dispatcher>>,
    closed: Arc<Mutex<Option<String>>>,
    stdin: Arc<Mutex<ChildStdin>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => {
                if let Ok(mut guard) = closed.lock() {
                    *guard = Some("server closed stdout".to_string());
                }
                return;
            }
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                // One read can carry several frames, and a frame can span reads.
                loop {
                    match framing::decode(&buffer) {
                        Ok((frame, consumed)) => {
                            buffer.drain(..consumed);
                            dispatch(&dispatcher, &stdin, &frame.payload);
                        }
                        Err(framing::FrameError::Incomplete)
                        | Err(framing::FrameError::ShortBody { .. }) => break,
                        Err(_) => {
                            // A frame that cannot be parsed never becomes valid by
                            // waiting for more bytes: drop what we have and keep the
                            // session alive, so one bad write does not kill a server
                            // that is otherwise fine.
                            buffer.clear();
                            break;
                        }
                    }
                }
            }
            Err(error) => {
                if let Ok(mut guard) = closed.lock() {
                    *guard = Some(format!("read failed: {error}"));
                }
                return;
            }
        }
    }
}

fn dispatch(dispatcher: &Arc<Mutex<Dispatcher>>, stdin: &Arc<Mutex<ChildStdin>>, payload: &str) {
    let delivered = dispatcher
        .lock()
        .map(|mut dispatcher| dispatcher.deliver(payload))
        .unwrap_or(Delivered::Unparsed);
    // A server-to-client request must be answered or the server waits on us forever.
    // `null` is the correct response for every one this client will ever receive,
    // because it declares no capability that would need otherwise.
    if let Delivered::ServerRequest { id, .. } = delivered {
        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
        if let Ok(mut stdin) = stdin.lock() {
            let _ = stdin.write_all(&framing::encode(&reply.to_string()));
            let _ = stdin.flush();
        }
    }
}

fn parse_response(method: &str, payload: &str) -> Result<Value, SessionError> {
    let value: Value = serde_json::from_str(payload).map_err(|error| SessionError::Rpc {
        method: method.to_string(),
        message: format!("the response was not JSON: {error}"),
    })?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Err(SessionError::Rpc {
            method: method.to_string(),
            message,
        });
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

/// Turn a filesystem path into a `file://` URI the protocol accepts.
///
/// Windows paths need the drive letter as the host segment (`file:///C:/x`) and
/// forward slashes; a path sent as-is is rejected by most servers, and the failure
/// looks like "no definition found" rather than "bad URI".
pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let encoded: String = trimmed
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            other => other.to_string(),
        })
        .collect();
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        format!("file:///{encoded}")
    } else {
        format!("file://{normalized}")
    }
}

#[cfg(test)]
mod tests {
    use super::{path_to_uri, Delivered, Dispatcher};

    fn response(id: u64) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{{"ok":true}}}}"#)
    }

    #[test]
    fn a_response_resolves_the_request_that_waits_for_it() {
        let mut dispatcher = Dispatcher::new();
        let (first, first_rx) = dispatcher.begin();
        let (second, second_rx) = dispatcher.begin();
        assert_ne!(first, second);

        // Out of order on purpose: servers answer in whatever order they finish.
        assert_eq!(
            dispatcher.deliver(&response(second)),
            Delivered::Response { id: second }
        );
        assert_eq!(
            dispatcher.deliver(&response(first)),
            Delivered::Response { id: first }
        );
        assert!(first_rx.try_recv().is_ok());
        assert!(second_rx.try_recv().is_ok());
    }

    #[test]
    fn a_response_for_an_abandoned_id_is_dropped_not_misrouted() {
        let mut dispatcher = Dispatcher::new();
        let (id, rx) = dispatcher.begin();
        dispatcher.abandon(id);
        assert_eq!(dispatcher.deliver(&response(id)), Delivered::Orphan { id });
        assert!(rx.try_recv().is_err());
        assert_eq!(dispatcher.pending_count(), 0);
    }

    #[test]
    fn a_notification_is_kept_by_method() {
        let mut dispatcher = Dispatcher::new();
        let diagnostics = r#"{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":"file:///a.rs","diagnostics":[]}}"#;
        assert_eq!(
            dispatcher.deliver(diagnostics),
            Delivered::Notification {
                method: "textDocument/publishDiagnostics".to_string()
            }
        );
        assert!(dispatcher
            .last_notification("textDocument/publishDiagnostics")
            .expect("kept")
            .contains("file:///a.rs"));
    }

    #[test]
    fn a_server_initiated_request_is_distinguished_from_a_response() {
        let mut dispatcher = Dispatcher::new();
        let request =
            r#"{"jsonrpc":"2.0","id":9,"method":"window/workDoneProgress/create","params":{}}"#;
        assert_eq!(
            dispatcher.deliver(request),
            Delivered::ServerRequest {
                id: 9,
                method: "window/workDoneProgress/create".to_string()
            }
        );
        // It must not be mistaken for a response to request 9.
        assert_eq!(dispatcher.pending_count(), 0);
    }

    #[test]
    fn a_non_json_payload_is_reported_rather_than_dropped() {
        let mut dispatcher = Dispatcher::new();
        assert_eq!(
            dispatcher.deliver("Starting rust-analyzer..."),
            Delivered::Unparsed
        );
    }

    #[test]
    fn windows_paths_become_file_uris() {
        assert_eq!(
            path_to_uri(r"D:\Code\PI-Desktop-main"),
            "file:///D:/Code/PI-Desktop-main"
        );
        assert_eq!(
            path_to_uri("/home/user/project"),
            "file:///home/user/project"
        );
    }

    #[test]
    fn a_space_in_a_path_is_percent_encoded() {
        // A project under "Program Files" is common on Windows and a raw space in a
        // URI is rejected by most servers.
        assert_eq!(
            path_to_uri(r"C:\Program Files\app"),
            "file:///C:/Program%20Files/app"
        );
    }
}
