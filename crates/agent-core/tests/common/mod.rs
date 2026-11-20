//! Shared test support.
//!
//! The kernel talks to the host before a turn: it asks for the session's history
//! and journals the system prompt. A test that never answers stalls on a host
//! that does not exist, exactly as the Node sidecar would. This stands in for
//! Electron main: history comes back empty (a brand-new conversation) and an
//! append succeeds. Tests that want to control an answer spawn no responder and
//! complete the call themselves.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use agent_core::sidecar::{RecordingLines, Sidecar};
use serde_json::json;

/// Answer every `session.get` with an empty session, until the sidecar is gone.
pub fn answer_empty_history(sidecar: &Arc<Sidecar>, lines: &RecordingLines) {
    let weak = Arc::downgrade(sidecar);
    let lines = lines.clone();
    tokio::spawn(async move {
        let mut handled: HashSet<String> = HashSet::new();
        loop {
            let Some(sidecar) = weak.upgrade() else {
                return;
            };
            // Whole frames: the response is matched by the frame's id, which a
            // `notifications("host.proxy")` params object does not carry.
            for frame in lines.host_calls() {
                let method = frame
                    .pointer("/params/method")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let answer = match method {
                    "session.get" => json!({ "session": { "messages": [] } }),
                    "session.appendMessage" => json!({ "ok": true }),
                    "skills.create" => json!({ "ok": true }),
                    "skills.update" => json!({ "ok": true }),
                    "skills.writeFile" => json!({ "ok": true }),
                    "skills.removeFile" => json!({ "ok": true }),
                    "skills.remove" => json!({ "ok": true }),
                    "skills.read" => json!({ "body": "# skill" }),
                    "tools.execute" => json!({ "ok": true, "content": "tool output" }),
                    _ => continue,
                };
                let Some(id) = frame["id"].as_str().map(str::to_string) else {
                    continue;
                };
                if !handled.insert(id.clone()) {
                    continue;
                }
                sidecar.bridge().complete(&id, Ok(answer));
            }
            drop(sidecar);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
}
