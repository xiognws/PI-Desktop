//! Checkpoints and rewind.
//!
//! Practice from the agents people actually leave running for hours (Claude
//! Code's checkpoints, Cursor's restore): a wrong turn is cheaper to undo than to
//! argue with. Two things make a checkpoint useful and both are cheap:
//!
//! * it is taken **automatically, at a boundary** — the start of a turn — so the
//!   person never has to have predicted the mistake;
//! * it is a snapshot of the transcript, so rewinding restores the exact
//!   conversation the model saw, tool pairs included.
//!
//! What this does *not* do is restore files: file state belongs to the host, and a
//! kernel that pretended to roll back a repository it never touched would be lying.
//! The checkpoint carries the tool calls, which is what a host needs to undo them.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::message::Message;
use crate::session::Transcript;

/// Checkpoints kept per session, newest last. A rewind target older than this is
/// gone, and the store says so rather than pretending.
pub const MAX_CHECKPOINTS: usize = 32;

/// One snapshot.
#[derive(Debug, Clone, PartialEq)]
pub struct Checkpoint {
    pub id: String,
    pub label: String,
    pub at_ms: i64,
    pub messages: Vec<Message>,
}

impl Checkpoint {
    /// The tool calls this span announced, which a host needs to undo their
    /// effects. Returned rather than the whole transcript so a caller reverting
    /// files does not have to read the conversation.
    pub fn tool_calls(&self) -> Vec<(String, String)> {
        self.messages
            .iter()
            .flat_map(|message| message.tool_calls())
            .map(|call| (call.name.clone(), call.id.clone()))
            .collect()
    }
}

/// What a panel lists: enough to choose a rewind target, nothing more.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointView {
    pub id: String,
    pub label: String,
    pub at_ms: i64,
    pub messages: usize,
}

#[derive(Debug, Clone)]
pub struct CheckpointStore {
    entries: VecDeque<Checkpoint>,
    capacity: usize,
    next_index: u32,
}

impl Default for CheckpointStore {
    fn default() -> Self {
        Self::new(MAX_CHECKPOINTS)
    }
}

impl CheckpointStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            capacity: capacity.max(1),
            next_index: 0,
        }
    }

    /// Snapshot the transcript under a label and return the checkpoint id.
    pub fn capture(&mut self, label: impl Into<String>, transcript: &Transcript) -> String {
        self.next_index += 1;
        let id = format!("ckpt-{}", self.next_index);
        self.entries.push_back(Checkpoint {
            id: id.clone(),
            label: label.into(),
            at_ms: crate::message::now_ms(),
            messages: transcript.messages().to_vec(),
        });
        while self.entries.len() > self.capacity {
            self.entries.pop_front();
        }
        id
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn latest(&self) -> Option<&Checkpoint> {
        self.entries.back()
    }

    pub fn get(&self, id: &str) -> Option<&Checkpoint> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    /// The transcript as it was at `id`, ready to install.
    ///
    /// `None` means the checkpoint is unknown *or* evicted; both are "you cannot
    /// go back that far", which is the only distinction a caller can act on.
    pub fn rewind(&self, id: &str) -> Option<Transcript> {
        self.get(id)
            .map(|entry| Transcript::from_messages(entry.messages.clone()))
    }

    pub fn list(&self) -> Vec<CheckpointView> {
        self.entries
            .iter()
            .map(|entry| CheckpointView {
                id: entry.id.clone(),
                label: entry.label.clone(),
                at_ms: entry.at_ms,
                messages: entry.messages.len(),
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{ToolCall, ToolResult};

    fn transcript(text: &str) -> Transcript {
        let mut assistant = Message::new(crate::message::Role::Assistant);
        assistant.push_tool_call(ToolCall {
            id: "call_1".into(),
            name: "Edit".into(),
            arguments: serde_json::json!({"path": "a.rs"}),
            raw_arguments: None,
        });
        Transcript::from_messages(vec![
            Message::user_text(text),
            assistant,
            Message::tool_result(ToolResult {
                call_id: "call_1".into(),
                name: "Edit".into(),
                content: "ok".into(),
                is_error: false,
                truncated: false,
            }),
        ])
    }

    #[test]
    fn a_rewind_restores_the_transcript_exactly() {
        let mut store = CheckpointStore::new(8);
        let first = store.capture("turn start", &transcript("first"));
        let second = store.capture("turn start", &transcript("second"));
        assert_eq!(first, "ckpt-1");
        assert_eq!(second, "ckpt-2");

        let restored = store.rewind(&first).unwrap();
        assert_eq!(restored.messages()[0].text(), "first");
        assert_eq!(restored.len(), 3, "the tool pair comes back with it");
        assert_eq!(
            store.rewind(&second).unwrap().messages()[0].text(),
            "second"
        );
    }

    #[test]
    fn an_evicted_or_unknown_checkpoint_cannot_be_rewound() {
        let mut store = CheckpointStore::new(2);
        let oldest = store.capture("a", &transcript("a"));
        store.capture("b", &transcript("b"));
        store.capture("c", &transcript("c"));
        assert!(store.rewind(&oldest).is_none(), "evicted");
        assert!(store.rewind("ckpt-999").is_none());
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn the_list_is_what_a_panel_draws() {
        let mut store = CheckpointStore::new(8);
        store.capture("turn start", &transcript("a"));
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "turn start");
        assert_eq!(list[0].messages, 3);
        assert_eq!(list[0].id, "ckpt-1");
        assert_eq!(store.latest().unwrap().id, "ckpt-1");
    }

    #[test]
    fn a_checkpoint_names_the_tool_calls_a_host_would_undo() {
        let mut store = CheckpointStore::new(8);
        let id = store.capture("turn start", &transcript("a"));
        let calls = store.get(&id).unwrap().tool_calls();
        assert_eq!(calls, vec![("Edit".to_string(), "call_1".to_string())]);
    }

    #[test]
    fn clearing_forgets_everything() {
        let mut store = CheckpointStore::new(8);
        store.capture("a", &transcript("a"));
        store.clear();
        assert!(store.is_empty());
        assert!(store.latest().is_none());
    }
}
