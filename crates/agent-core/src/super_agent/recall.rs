//! Inline & spill, with chain-of-recall.
//!
//! Two halves of one idea: what the model is likely to need now goes into the
//! request, and everything else stays outside it behind an id the model can ask
//! for. A CI log, a long Pull Request discussion and a finished worker's report
//! all cost the same when they are spilled — nothing, until something recalls
//! them.
//!
//! Recall follows references rather than a search index: a trigger points at its
//! thread, the thread at its worker, the worker at its report. That chain is what
//! lets a long-running instance find last week's task from one id in the current
//! prompt, without a vector store and without a full-text index of everything it
//! has ever seen.

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};

/// Recent triggers of a thread that are inlined rather than referenced.
pub const INLINE_TRIGGER_COUNT: usize = 8;

/// Character budget of one inline block. Character counts, not bytes: the same
/// budget in Chinese is a third of the text.
pub const INLINE_CHAR_BUDGET: usize = 4_000;

/// How far a recall chain may walk. A cycle in the references would otherwise
/// loop forever, and four hops already spans trigger → thread → worker → report
/// → the trigger that started the report.
pub const RECALL_CHAIN_DEPTH: usize = 4;

/// Nodes the spill store keeps. Old material is dropped oldest-first: it is a
/// cache in front of the host's durable record, not the record itself.
pub const SPILL_CAPACITY: usize = 512;

/// What a recalled node is. The prefix of its id names the kind, so an id in a
/// prompt is also a statement about what it points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Trigger,
    Thread,
    Worker,
    Report,
}

impl NodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Trigger => "trigger",
            Self::Thread => "thread",
            Self::Worker => "worker",
            Self::Report => "report",
        }
    }

    /// The id prefix, including the colon: `trigger:feishu:dev#m-1`.
    pub fn prefix(&self) -> String {
        format!("{}:", self.as_str())
    }

    pub fn all() -> [NodeKind; 4] {
        [Self::Trigger, Self::Thread, Self::Worker, Self::Report]
    }
}

/// One spilled node: a short title, the text, and the ids it points at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallNode {
    pub id: String,
    pub kind: NodeKind,
    pub title: String,
    pub text: String,
    /// Followed by [`RecallStore::chain`], in order. A report points at its
    /// worker, a worker at its thread, a thread at its triggers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
}

impl RecallNode {
    pub fn new(
        kind: NodeKind,
        key: impl AsRef<str>,
        title: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            id: format!("{}{}", kind.prefix(), key.as_ref()),
            kind,
            title: title.into(),
            text: text.into(),
            refs: Vec::new(),
        }
    }

    pub fn with_refs<I, S>(mut self, refs: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.refs = refs.into_iter().map(Into::into).collect();
        self
    }
}

/// Why a recall found nothing. Both variants carry enough to tell a model what to
/// do next, which is the only useful form of "not found".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecallMiss {
    /// The id was never stored here, or it was evicted.
    Unknown { id: String },
    /// The id has no prefix this store understands.
    Malformed { id: String },
}

impl std::fmt::Display for RecallMiss {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown { id } => write!(
                f,
                "nothing is stored under `{id}`: it may have been evicted, or it belongs to another thread. Retry with an id listed in the inline block."
            ),
            Self::Malformed { id } => write!(
                f,
                "`{id}` is not a recall id: use the form `trigger:<channel>#<id>`, `thread:<key>`, `worker:<id>` or `report:<worker id>`."
            ),
        }
    }
}

/// The node kind an id announces, if any.
pub fn kind_of(id: &str) -> Option<NodeKind> {
    NodeKind::all()
        .into_iter()
        .find(|kind| id.starts_with(&kind.prefix()))
}

/// The spill store plus the chain that walks it.
#[derive(Debug, Clone)]
pub struct RecallStore {
    nodes: HashMap<String, RecallNode>,
    order: VecDeque<String>,
    capacity: usize,
}

impl Default for RecallStore {
    fn default() -> Self {
        Self::new(SPILL_CAPACITY)
    }
}

impl RecallStore {
    pub fn new(capacity: usize) -> Self {
        Self {
            nodes: HashMap::new(),
            order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Store a node, replacing an existing one under the same id. The oldest
    /// nodes are dropped when the store is full.
    pub fn insert(&mut self, node: RecallNode) {
        if self.nodes.insert(node.id.clone(), node.clone()).is_none() {
            self.order.push_back(node.id.clone());
        }
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.nodes.remove(&evicted);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&RecallNode> {
        self.nodes.get(id)
    }

    /// The id a trigger's spilled body lives under, so a prompt can name it.
    pub fn trigger_id(trigger_id: &str) -> String {
        format!("{}{trigger_id}", NodeKind::Trigger.prefix())
    }

    pub fn thread_id(thread_key: &str) -> String {
        format!("{}{thread_key}", NodeKind::Thread.prefix())
    }

    pub fn worker_id(worker_id: &str) -> String {
        format!("{}{worker_id}", NodeKind::Worker.prefix())
    }

    pub fn report_id(worker_id: &str) -> String {
        format!("{}{worker_id}", NodeKind::Report.prefix())
    }

    /// Render one node for the model: the title, the text, and where the chain
    /// goes next.
    pub fn recall(&self, id: &str) -> Result<String, RecallMiss> {
        if kind_of(id).is_none() {
            return Err(RecallMiss::Malformed { id: id.to_string() });
        }
        let Some(node) = self.nodes.get(id) else {
            return Err(RecallMiss::Unknown { id: id.to_string() });
        };
        let mut out = format!(
            "recalled {}: {}\n{}",
            node.kind.as_str(),
            node.title,
            node.text
        );
        let reachable: Vec<&String> = node
            .refs
            .iter()
            .filter(|ref_id| self.nodes.contains_key(*ref_id))
            .collect();
        if !reachable.is_empty() {
            out.push_str("\nrelated (recall by id): ");
            out.push_str(
                &reachable
                    .iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        Ok(out)
    }

    /// Walk the reference chain from `id`, breadth-first, up to
    /// [`RECALL_CHAIN_DEPTH`]. The node itself is not included.
    pub fn chain(&self, id: &str) -> Vec<RecallNode> {
        let mut found: Vec<RecallNode> = Vec::new();
        let mut seen: Vec<String> = vec![id.to_string()];
        let mut frontier: Vec<String> = match self.nodes.get(id) {
            Some(node) => node.refs.clone(),
            None => return found,
        };
        for _ in 0..RECALL_CHAIN_DEPTH {
            if frontier.is_empty() {
                break;
            }
            let mut next: Vec<String> = Vec::new();
            for ref_id in frontier {
                if seen.iter().any(|id| id == &ref_id) {
                    continue;
                }
                seen.push(ref_id.clone());
                if let Some(node) = self.nodes.get(&ref_id) {
                    found.push(node.clone());
                    next.extend(node.refs.iter().cloned());
                }
            }
            frontier = next;
        }
        found
    }
}

/// Inline the recent part of a thread, and name the older part by id.
///
/// The block is what a worker receives with a new event on a thread it already
/// owns: enough of the recent conversation to act, with everything older one
/// recall away, and never more than [`INLINE_CHAR_BUDGET`].
pub fn inline_thread_context(store: &RecallStore, thread: &super::trigger::Thread) -> String {
    let mut header = format!(
        "## thread {}\nsubject: {}\nstatus: {}\nowner: {}\n",
        thread.key,
        thread.subject,
        thread.status.as_str(),
        thread.worker.as_deref().unwrap_or("none")
    );
    let recent = thread.recent(INLINE_TRIGGER_COUNT);
    let older_count = thread.triggers.len().saturating_sub(recent.len());
    if older_count > 0 {
        let older: Vec<String> = thread
            .triggers
            .iter()
            .take(older_count)
            .map(|id| RecallStore::trigger_id(id))
            .collect();
        header.push_str(&format!(
            "{} older event(s), recall by id: {}\n",
            older_count,
            older.join(", ")
        ));
    }
    header.push_str("recent events:\n");
    let mut used = header.chars().count();
    let mut lines: Vec<String> = Vec::new();
    for id in recent {
        let rendered = match store.get(&RecallStore::trigger_id(id)) {
            Some(node) => format!("- {}\n  {}", node.title, first_line(&node.text)),
            None => format!("- {id} (not spilled here; ask the host for it)"),
        };
        let cost = rendered.chars().count();
        if used + cost > INLINE_CHAR_BUDGET {
            lines.push(format!(
                "- {} and everything before it is outside the budget: recall the ids above.",
                id
            ));
            break;
        }
        used += cost;
        lines.push(rendered);
    }
    header.push_str(&lines.join("\n"));
    header
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    super::trigger::truncate_chars(line, 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::super_agent::trigger::{Source, SourceKind, ThreadTable, Trigger};

    fn store() -> RecallStore {
        let mut store = RecallStore::new(16);
        store.insert(
            RecallNode::new(
                NodeKind::Trigger,
                "ci:main#7",
                "build failed on main",
                "log line 1\nlog line 2",
            )
            .with_refs([RecallStore::thread_id("ci:main")]),
        );
        store.insert(
            RecallNode::new(
                NodeKind::Thread,
                "ci:main",
                "main pipeline",
                "three red builds in a row",
            )
            .with_refs([RecallStore::worker_id("worker-1")]),
        );
        store.insert(
            RecallNode::new(
                NodeKind::Worker,
                "worker-1",
                "fix-ci",
                "mission: make main green",
            )
            .with_refs([RecallStore::report_id("worker-1")]),
        );
        store.insert(RecallNode::new(
            NodeKind::Report,
            "worker-1",
            "report",
            "the flake is in tests/ci.rs:40",
        ));
        store
    }

    #[test]
    fn ids_announce_their_kind() {
        assert_eq!(kind_of("trigger:x"), Some(NodeKind::Trigger));
        assert_eq!(kind_of("thread:x"), Some(NodeKind::Thread));
        assert_eq!(kind_of("worker:x"), Some(NodeKind::Worker));
        assert_eq!(kind_of("report:x"), Some(NodeKind::Report));
        assert_eq!(kind_of("whatever:x"), None);
        assert_eq!(RecallStore::trigger_id("a#1"), "trigger:a#1");
    }

    #[test]
    fn a_recall_returns_the_text_and_the_next_hops() {
        let text = store().recall("thread:ci:main").unwrap();
        assert!(text.contains("three red builds"));
        assert!(text.contains("worker:worker-1"), "{text}");
    }

    #[test]
    fn a_miss_tells_the_model_what_to_do_next() {
        let store = store();
        assert_eq!(
            store.recall("trigger:nope").unwrap_err(),
            RecallMiss::Unknown {
                id: "trigger:nope".into()
            }
        );
        assert!(store
            .recall("trigger:nope")
            .unwrap_err()
            .to_string()
            .contains("Retry with an id"));
        assert!(matches!(
            store.recall("nonsense").unwrap_err(),
            RecallMiss::Malformed { .. }
        ));
    }

    #[test]
    fn the_chain_walks_trigger_to_report_and_stops() {
        let store = store();
        let chain = store.chain("trigger:ci:main#7");
        let ids: Vec<&str> = chain.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["thread:ci:main", "worker:worker-1", "report:worker-1"]
        );
        assert!(store.chain("report:worker-1").is_empty());
    }

    #[test]
    fn an_evicted_node_no_longer_recalls() {
        let mut store = RecallStore::new(2);
        store.insert(RecallNode::new(NodeKind::Trigger, "a", "a", "first"));
        store.insert(RecallNode::new(NodeKind::Trigger, "b", "b", "second"));
        store.insert(RecallNode::new(NodeKind::Trigger, "c", "c", "third"));
        assert!(store.recall("trigger:a").is_err());
        assert!(store.recall("trigger:c").is_ok());
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn the_inline_block_keeps_recent_events_and_names_the_rest() {
        let mut store = RecallStore::new(64);
        let mut table = ThreadTable::new();
        for index in 0..(INLINE_TRIGGER_COUNT + 4) {
            let trigger = Trigger::from_source(
                Source::new(SourceKind::Chat, "feishu:dev"),
                "topic-1",
                format!("m-{index}"),
                format!("message {index}"),
            );
            store.insert(RecallNode::new(
                NodeKind::Trigger,
                format!("feishu:dev#m-{index}"),
                format!("message {index}"),
                "body",
            ));
            table.observe(&trigger);
        }
        let thread = table
            .get(&crate::super_agent::trigger::ThreadKey::new("topic-1"))
            .unwrap();
        let block = inline_thread_context(&store, thread);
        assert!(
            block.contains("4 older event(s), recall by id: trigger:feishu:dev#m-0"),
            "{block}"
        );
        assert!(block.contains("message 11"), "{block}");
        assert!(
            !block.contains("- message 0"),
            "the oldest events are referenced, not inlined:\n{block}"
        );
        assert!(block.chars().count() <= INLINE_CHAR_BUDGET + 200, "{block}");
    }

    #[test]
    fn the_inline_block_stops_at_its_budget() {
        let mut store = RecallStore::new(64);
        let mut table = ThreadTable::new();
        for index in 0..4 {
            let trigger = Trigger::from_source(
                Source::new(SourceKind::Chat, "feishu:dev"),
                "topic-1",
                format!("m-{index}"),
                format!("message {index}"),
            );
            store.insert(RecallNode::new(
                NodeKind::Trigger,
                format!("feishu:dev#m-{index}"),
                // A long title is what pushes the block past its budget: the body
                // itself is never inlined beyond one line.
                "边".repeat(3_000),
                "body",
            ));
            table.observe(&trigger);
        }
        let thread = table
            .get(&crate::super_agent::trigger::ThreadKey::new("topic-1"))
            .unwrap();
        let block = inline_thread_context(&store, thread);
        assert!(
            block.chars().count() <= INLINE_CHAR_BUDGET + 4_000,
            "budget overflowed: {} chars",
            block.chars().count()
        );
        assert!(block.contains("outside the budget"), "{block}");
    }
}
