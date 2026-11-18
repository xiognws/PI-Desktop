//! Shared test support.
//!
//! The kernel asks the host for a session's history before a turn, exactly as
//! the Node sidecar does, so a test that never answers that call stalls on a
//! host that does not exist. This stands in for Electron main: it answers
//! `session.get` with an empty session, which is what a brand-new conversation
//! looks like. Tests that want to control the answer spawn no responder and
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
                if frame
                    .pointer("/params/method")
                    .and_then(|value| value.as_str())
                    != Some("session.get")
                {
                    continue;
                }
                let Some(id) = frame["id"].as_str().map(str::to_string) else {
                    continue;
                };
                if !handled.insert(id.clone()) {
                    continue;
                }
                sidecar
                    .bridge()
                    .complete(&id, Ok(json!({ "session": { "messages": [] } })));
            }
            drop(sidecar);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
}
