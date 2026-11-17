//! The `memory` tool: structured retain and recall.
//!
//! Counterpart of `memory-agent-tool.ts` (ADR 0393). Memory is one structured
//! store (`memories` in host-core), not a document the agent edits. The model
//! retains a memory — title, body, kind, optional tags, a scope — and later
//! retrieves the relevant ones by query. Nothing here renders the store into the
//! system prompt: the prompt carries only what a per-turn recall finds relevant
//! ([`crate::memory_context`]), so the cost of remembering does not grow with the
//! store and capacity stops being a reason to delete a useful note.
//!
//! Every write is one host RPC (`memory.remember` / `memory.update` /
//! `memory.forget`) and every read is `memory.recall`, so the runtime, the
//! settings page and the background review share one implementation of dedupe,
//! supersession and scope filtering. What stays here is only what the store
//! cannot tell a model: which argument is missing, which memory an answer refers
//! to, and the one rule a search cannot express — a procedure belongs in a skill.
//!
//! A refused edit is reported as ordinary tool text, not a hard failure: the
//! model can fix its own argument and retry in the same turn.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::error::{AgentError, Result};
use crate::host_bridge::HostError;
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::redaction::scrub_secrets_in_batch;
use crate::skill_overlap::{procedure_needing_a_skill, SkillSummary};
use crate::skills::SkillCatalog;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Name of the tool the model calls.
pub const MEMORY_TOOL_NAME: &str = "memory";

/// Appended to a result whose content had a credential masked out of it.
const MEMORY_SCRUB_NOTE: &str = "\n\nA credential-shaped string in this content was replaced with ***REDACTED*** before saving: memory is recalled into later prompts.";

/// Characters of a recalled body shown per hit; the whole text is one `search` away.
const MAX_HIT_BODY_CHARS: usize = 400;

/// Hits `search` asks the host for when the model does not say.
const DEFAULT_SEARCH_LIMIT: u64 = 8;

/// Host-core caps recall here, so asking for more would be silently ignored.
const MAX_SEARCH_LIMIT: u64 = 50;

/// Most memories one `remember` call may carry in `items`.
///
/// A bulk import must not degenerate into one tool call — and therefore one full
/// re-sent context per memory: a measured 3,330-entry import ran 1,237 calls
/// inside a single turn, 87.8M prompt tokens. Batched, the same import is a few
/// dozen calls.
const MEMORY_BATCH_LIMIT: usize = 50;

/// Batch lines echoed back before the result is summarized instead.
const MEMORY_BATCH_LINES_SHOWN: usize = 12;

/// Memory kinds, in the order the refusal message lists them.
pub const MEMORY_KINDS: [&str; 5] = ["fact", "preference", "decision", "pitfall", "procedure"];
/// Memory scopes, in the order the refusal message lists them.
pub const MEMORY_SCOPES: [&str; 3] = ["global", "project", "session"];

const MEMORY_TOOL_DESCRIPTION: &str = "\
Store and recall durable memory: one structured list of memories that stays with you across sessions.

Memory holds what stays true after this conversation, one memory per thing learned: a preference the user stated, a decision and its reason, a pitfall you actually hit, a constraint of this repository or machine. Each memory has a short `title`, a `body`, a `kind`, optional `tags` and a `scope`. Nothing here enters your system prompt in full — the memories relevant to a turn are recalled alongside the user's message, so the store can grow without costing context and there is no size budget to manage.

Actions:
- `remember` stores one memory. Required: `title` (a few words naming what it is about) and `body` (the memory itself). Optional: `kind` — `fact` (default), `preference`, `decision`, `pitfall`; `tags`; `scope` — `global` (default, true everywhere), `project` (this project only), `session` (this conversation only); `pinned` (recalled every turn). Writing the same title and body again refreshes the existing memory instead of duplicating it.
- `remember` with `items` stores many memories in one call (at most 50). Use it whenever you have more than a couple to write — an import, a migration, a notes file: one call per memory is 50 provider requests, each re-sending the whole conversation.
- `update` changes a memory you already hold, by `id`: any of `title`, `body`, `tags`, `pinned`, `confidence`. Use it when the fact changed, rather than storing a contradicting second copy.
- `forget` deletes one memory by `id`. Use it for what turned out wrong, or that the user asked you to drop.
- `search` runs a keyword query over the store and returns the closest memories with their ids, best first. Search before `remember` when you may already know this, and before `update` or `forget` when you do not have the id. Query with the words the memory would contain, not with a question.

A procedure — two or more steps that will still be true next month — belongs in a skill, not here: write it with `skill_manage`. This tool refuses a body that reads like steps (`MEMORY_PROCEDURE_NEEDS_SKILL`) and names the skill to patch when one already covers it. Facts, preferences and one-line quirks are exactly what memory is for.

Record what you learned, not the task you ran: not progress, not file contents you can re-read, not secrets. Write in the language the user writes in — a memory is read back to them, and matched against their words, in a later session.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryKind {
    Fact,
    Preference,
    Decision,
    Pitfall,
    Procedure,
}

impl MemoryKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Decision => "decision",
            Self::Pitfall => "pitfall",
            Self::Procedure => "procedure",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        MEMORY_KINDS
            .iter()
            .find(|kind| **kind == value)
            .map(|kind| match *kind {
                "preference" => Self::Preference,
                "decision" => Self::Decision,
                "pitfall" => Self::Pitfall,
                "procedure" => Self::Procedure,
                _ => Self::Fact,
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    Global,
    Project,
    Session,
}

impl MemoryScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
            Self::Session => "session",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "global" => Some(Self::Global),
            "project" => Some(Self::Project),
            "session" => Some(Self::Session),
            _ => None,
        }
    }
}

/// One memory as the host answers with it.
///
/// Every field is optional because the tool renders whatever the host sent
/// rather than trusting its own copy: a field added host-side then shows up in
/// the result without a runtime change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryRecord {
    pub id: Option<String>,
    pub scope: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub tags: Vec<String>,
    pub confidence: Option<f64>,
    pub pinned: Option<bool>,
}

impl MemoryRecord {
    pub fn from_value(value: Option<&Value>) -> Option<Self> {
        let value = value?.as_object()?;
        let string = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|text| !text.trim().is_empty())
        };
        let tags = value
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            id: string("id"),
            scope: string("scope"),
            kind: string("kind"),
            title: string("title"),
            body: string("body"),
            tags,
            confidence: value.get("confidence").and_then(Value::as_f64),
            pinned: value.get("pinned").and_then(Value::as_bool),
        })
    }
}

/// `[fact] Title (tags: a, b) — id m1`: one line that names the memory.
pub fn describe_memory(record: &MemoryRecord) -> String {
    let title = record
        .title
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("(untitled)");
    let mut line = match record.kind.as_deref().map(str::trim) {
        Some(kind) if !kind.is_empty() => format!("[{kind}] {title}"),
        _ => title.to_string(),
    };
    if !record.tags.is_empty() {
        line.push_str(&format!(" (tags: {})", record.tags.join(", ")));
    }
    if let Some(id) = record.id.as_deref() {
        line.push_str(&format!(" — id {id}"));
    }
    line
}

fn trim_body(body: Option<&str>) -> String {
    let value = body.unwrap_or("").trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().count() > MAX_HIT_BODY_CHARS {
        let kept: String = value.chars().take(MAX_HIT_BODY_CHARS).collect();
        format!("{kept}…")
    } else {
        value.to_string()
    }
}

fn trimmed_field(raw: &Map<String, Value>, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn string_array(
    raw: &Map<String, Value>,
    key: &str,
) -> std::result::Result<Option<Vec<String>>, ()> {
    let Some(value) = raw.get(key) else {
        return Ok(None);
    };
    let Some(items) = value.as_array() else {
        return Err(());
    };
    let mut out = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(());
        };
        if !text.trim().is_empty() {
            out.push(text.trim().to_string());
        }
    }
    Ok(Some(out))
}

/// The host surface the tool needs: one RPC call.
///
/// A trait rather than the concrete bridge so a test can record what the tool
/// sent without a socket, and so the tool cannot reach any other host method.
pub trait MemoryHost: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>>;
}

impl MemoryHost for crate::host_bridge::HostBridge {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
        Box::pin(async move { crate::host_bridge::HostBridge::call(self, method, params).await })
    }
}

/// The `memory` tool, bound to the session it writes for.
pub struct MemoryTool {
    host: Arc<dyn MemoryHost>,
    /// The open project, needed to store and find `project`-scoped memories.
    project_path: Option<String>,
    /// The catalogue the procedure gate consults, read at call time.
    skills: Arc<SkillCatalog>,
}

impl MemoryTool {
    pub fn new(
        host: Arc<dyn MemoryHost>,
        project_path: Option<String>,
        skills: Arc<SkillCatalog>,
    ) -> Self {
        Self {
            host,
            project_path,
            skills,
        }
    }

    fn summaries(&self) -> Vec<SkillSummary> {
        self.skills
            .snapshot()
            .into_iter()
            .map(|skill| SkillSummary {
                id: skill.id,
                name: Some(skill.name),
                description: skill.description,
                // The catalogue carries no bodies: the kernel would have to read
                // every document to fill them, and the gate does not need one to
                // decide. Only the "patch that skill" hint is weaker for a
                // procedure whose skill is described in another language.
                body: None,
            })
            .collect()
    }

    /// Retain: validate, gate, mask, then one host call.
    async fn remember(&self, raw: &Map<String, Value>, session_id: &str) -> Result<String> {
        let Some(title) = trimmed_field(raw, "title") else {
            return Err(AgentError::Refused(
                "title is required for remember: a few words naming the thing this memory is about."
                    .into(),
            ));
        };
        let Some(body) = trimmed_field(raw, "body") else {
            return Err(AgentError::Refused(
                "body is required for remember: the fact, preference, decision or pitfall itself."
                    .into(),
            ));
        };
        let kind = match raw.get("kind") {
            None => MemoryKind::Fact,
            Some(value) => value.as_str().and_then(MemoryKind::parse).ok_or_else(|| {
                AgentError::Refused(format!("kind must be one of {}.", MEMORY_KINDS.join(", ")))
            })?,
        };
        let scope = match raw.get("scope") {
            None => MemoryScope::Global,
            Some(value) => value.as_str().and_then(MemoryScope::parse).ok_or_else(|| {
                AgentError::Refused(format!(
                    "scope must be one of {}.",
                    MEMORY_SCOPES.join(", ")
                ))
            })?,
        };
        // A scope names a column the host validates: a project memory without a
        // project path is refused host-side, and saying so here turns a failed
        // call into a fix.
        if scope == MemoryScope::Project && self.project_path.is_none() {
            return Err(AgentError::Refused(
                "scope `project` needs an open project, and this session has none. Use `global` for what is true anywhere, or `session` for this conversation only."
                    .into(),
            ));
        }
        if scope == MemoryScope::Session && session_id.is_empty() {
            return Err(AgentError::Refused(
                "scope `session` needs a conversation id, which this session does not have. Use `global` instead."
                    .into(),
            ));
        }
        let tags = string_array(raw, "tags")
            .map_err(|_| AgentError::Refused("tags must be an array of strings.".into()))?
            .unwrap_or_default();
        if let Some(pinned) = raw.get("pinned") {
            if !pinned.is_boolean() {
                return Err(AgentError::Refused("pinned must be true or false.".into()));
            }
        }
        // One lesson, one place. A procedure belongs in a skill *whether or not*
        // one exists yet, and the check is the shape of the sentence — steps or a
        // fact. A fact that merely mentions the same subsystem is what memory is
        // for and stays accepted.
        if let Some((_, skill_id)) =
            procedure_needing_a_skill(std::slice::from_ref(&body), &[], &self.summaries())
        {
            let where_to = match skill_id.as_deref() {
                Some(id) => format!("skill `{id}` covers this class of task"),
                None => "it belongs in a skill".to_string(),
            };
            return Err(AgentError::Refused(format!(
                "Not saved: this is a procedure (steps), not a fact — {where_to}. Write it with `skill_manage` (action `create`, or `patch` the skill above and add a `references/` file), and keep memory for facts, preferences and one-line quirks. If what you actually learned is a single fact, state the fact alone and it will be stored."
            )));
        }
        // Memory is recalled into later prompts, so credential-shaped text is
        // masked on the way in. The batch runs over every field at once because a
        // token stated once with its label is often repeated bare beside it.
        let mut fields = vec![title.clone(), body.clone()];
        fields.extend(tags.iter().cloned());
        let scrubbed = scrub_secrets_in_batch(&fields);
        let masked = scrubbed != fields;
        let safe_title = scrubbed[0].clone();
        let safe_body = scrubbed[1].clone();
        let safe_tags: Vec<String> = scrubbed[2..].to_vec();

        let mut params = Map::new();
        params.insert("scope".into(), json!(scope.as_str()));
        params.insert("kind".into(), json!(kind.as_str()));
        params.insert("title".into(), json!(safe_title));
        params.insert("body".into(), json!(safe_body));
        if !safe_tags.is_empty() {
            params.insert("tags".into(), json!(safe_tags));
        }
        if let Some(pinned) = raw.get("pinned").and_then(Value::as_bool) {
            params.insert("pinned".into(), json!(pinned));
        }
        // Global memory must not carry either column; the host refuses it if it does.
        if scope == MemoryScope::Project {
            if let Some(path) = &self.project_path {
                params.insert("projectPath".into(), json!(path));
            }
        }
        if scope == MemoryScope::Session {
            params.insert("sessionId".into(), json!(session_id));
        }

        let reply = self
            .call_host("memory.remember", Value::Object(params))
            .await
            .map_err(|message| AgentError::Refused(format!("Memory was not saved: {message}")))?;
        let deduped = reply
            .get("deduped")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let record = MemoryRecord::from_value(reply.get("memory")).unwrap_or_default();
        let line = if deduped {
            format!("Already stored — refreshed {}.", describe_memory(&record))
        } else {
            format!(
                "Saved {} (scope {}).",
                describe_memory(&record),
                scope.as_str()
            )
        };
        Ok(if masked {
            format!("{line}{MEMORY_SCRUB_NOTE}")
        } else {
            line
        })
    }

    /// Store many memories in one tool call: one provider request, N host writes.
    ///
    /// `remember` is reused per item, so an item's validation, procedure gate and
    /// credential masking are exactly the single-memory ones; only the result is
    /// composed here, and the echoed lines are capped so a 50-item import does not
    /// put 50 lines back into the context it was trying to save.
    async fn remember_batch(&self, raw: &Map<String, Value>, session_id: &str) -> Result<String> {
        let Some(items) = raw.get("items").and_then(Value::as_array) else {
            return Err(AgentError::Refused(
                "items must be a non-empty array: [{\"title\": ..., \"body\": ...}, ...].".into(),
            ));
        };
        if items.is_empty() {
            return Err(AgentError::Refused(
                "items must be a non-empty array: [{\"title\": ..., \"body\": ...}, ...].".into(),
            ));
        }
        if items.len() > MEMORY_BATCH_LIMIT {
            return Err(AgentError::Refused(format!(
                "items takes at most {MEMORY_BATCH_LIMIT} memories per call ({} given). Send the first {MEMORY_BATCH_LIMIT}, then the rest in another call.",
                items.len()
            )));
        }
        let mut saved: Vec<String> = Vec::new();
        let mut failed: Vec<String> = Vec::new();
        let mut masked = false;
        for (index, item) in items.iter().enumerate() {
            let position = index + 1;
            let Some(object) = item.as_object() else {
                failed.push(format!(
                    "#{position}: not an object with a title and a body"
                ));
                continue;
            };
            match self.remember(object, session_id).await {
                Ok(line) => {
                    masked |= line.contains(MEMORY_SCRUB_NOTE);
                    let line = line
                        .split(MEMORY_SCRUB_NOTE)
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    saved.push(line);
                }
                Err(error) => failed.push(format!("#{position}: {error}")),
            }
        }
        if saved.is_empty() {
            let mut lines = vec!["No memory was saved.".to_string(), String::new()];
            lines.extend(failed);
            return Err(AgentError::Refused(lines.join("\n")));
        }
        let mut lines = vec![if saved.len() == items.len() {
            format!("Saved {} memories.", saved.len())
        } else {
            format!("Saved {} of {} memories.", saved.len(), items.len())
        }];
        lines.push(String::new());
        lines.extend(saved.iter().take(MEMORY_BATCH_LINES_SHOWN).cloned());
        if saved.len() > MEMORY_BATCH_LINES_SHOWN {
            lines.push(format!(
                "(+{} more saved)",
                saved.len() - MEMORY_BATCH_LINES_SHOWN
            ));
        }
        if !failed.is_empty() {
            lines.push(String::new());
            lines.push("Not saved (fix and send again in the same batch):".to_string());
            lines.extend(failed);
        }
        let body = lines.join("\n");
        Ok(if masked {
            format!("{body}{MEMORY_SCRUB_NOTE}")
        } else {
            body
        })
    }

    /// Patch one memory: any subset of the editable fields, one host call.
    async fn update(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed_field(raw, "id") else {
            return Err(AgentError::Refused(
                "id is required for update: `search` first if you do not have it.".into(),
            ));
        };
        let title = trimmed_field(raw, "title");
        let body = trimmed_field(raw, "body");
        let tags = string_array(raw, "tags")
            .map_err(|_| AgentError::Refused("tags must be an array of strings.".into()))?;
        if let Some(pinned) = raw.get("pinned") {
            if !pinned.is_boolean() {
                return Err(AgentError::Refused("pinned must be true or false.".into()));
            }
        }
        let confidence = raw.get("confidence").and_then(Value::as_f64);
        if raw.get("confidence").is_some()
            && confidence.is_none_or(|value| !(0.0..=1.0).contains(&value))
        {
            return Err(AgentError::Refused(
                "confidence must be a number between 0 and 1.".into(),
            ));
        }

        let mut fields: BTreeMap<String, Value> = BTreeMap::new();
        if title.is_some() || body.is_some() {
            // Same masking as `remember`: a rewritten field must not become the
            // one place a credential survives.
            let pair = vec![
                title.clone().unwrap_or_default(),
                body.clone().unwrap_or_default(),
            ];
            let scrubbed = scrub_secrets_in_batch(&pair);
            if title.is_some() {
                fields.insert("title".into(), json!(scrubbed[0]));
            }
            if body.is_some() {
                fields.insert("body".into(), json!(scrubbed[1]));
            }
        }
        if let Some(tags) = tags {
            fields.insert("tags".into(), json!(tags));
        }
        if let Some(pinned) = raw.get("pinned").and_then(Value::as_bool) {
            fields.insert("pinned".into(), json!(pinned));
        }
        if let Some(confidence) = confidence {
            fields.insert("confidence".into(), json!(confidence));
        }
        if fields.is_empty() {
            return Err(AgentError::Refused(
                "nothing to update: pass at least one of title, body, tags, pinned, confidence."
                    .into(),
            ));
        }
        let mut params = Map::new();
        params.insert("id".into(), json!(id));
        for (key, value) in fields {
            params.insert(key, value);
        }
        let reply = match self.call_host("memory.update", Value::Object(params)).await {
            Ok(reply) => reply,
            Err(message) => {
                if message.to_lowercase().contains("not found") {
                    return Err(AgentError::Refused(format!(
                        "No memory with id {id}. Use `search` to find the id, or `remember` to store it again."
                    )));
                }
                return Err(AgentError::Refused(format!(
                    "Memory {id} was not updated: {message}"
                )));
            }
        };
        let record =
            MemoryRecord::from_value(reply.get("memory")).unwrap_or_else(|| MemoryRecord {
                id: Some(id.clone()),
                ..MemoryRecord::default()
            });
        Ok(format!("Updated {}.", describe_memory(&record)))
    }

    /// Forget one memory by id, and say plainly when nothing was there.
    async fn forget(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed_field(raw, "id") else {
            return Err(AgentError::Refused(
                "id is required for forget: `search` first if you do not have it.".into(),
            ));
        };
        let reply = self
            .call_host("memory.forget", json!({ "id": id }))
            .await
            .map_err(|message| {
                AgentError::Refused(format!("Memory {id} was not removed: {message}"))
            })?;
        let removed = reply.get("removed").and_then(Value::as_i64).unwrap_or(0);
        if removed == 0 {
            return Ok(format!(
                "No memory with id {id} was stored, so nothing was removed."
            ));
        }
        Ok(format!("Forgot memory {id}."))
    }

    /// Retrieve: the host ranks, this side only renders.
    async fn search(&self, raw: &Map<String, Value>, session_id: &str) -> Result<String> {
        let Some(query) = trimmed_field(raw, "query") else {
            return Err(AgentError::Refused(
                "query is required for search: the words the memory would contain.".into(),
            ));
        };
        let requested = raw
            .get("limit")
            .and_then(Value::as_f64)
            .map(|value| value.floor() as i64)
            .unwrap_or(DEFAULT_SEARCH_LIMIT as i64);
        let limit = requested.clamp(1, MAX_SEARCH_LIMIT as i64);
        let mut params = Map::new();
        params.insert("query".into(), json!(query));
        params.insert("limit".into(), json!(limit));
        // Narrowing is the host's: a project's memories are visible only with the
        // project path, its session's only with the session id (and global ones
        // always).
        if let Some(path) = &self.project_path {
            params.insert("projectPath".into(), json!(path));
        }
        if !session_id.is_empty() {
            params.insert("sessionId".into(), json!(session_id));
        }
        let reply = self
            .call_host("memory.recall", Value::Object(params))
            .await
            .map_err(|message| {
                AgentError::Refused(format!("Memory could not be searched: {message}"))
            })?;
        // Host order is the ranking; re-sorting here would throw the ranking away.
        let mut lines: Vec<String> = Vec::new();
        let mut count = 0;
        for hit in reply
            .get("memories")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(record) = MemoryRecord::from_value(hit.get("memory")) else {
                continue;
            };
            if record.title.is_none() && record.body.as_deref().unwrap_or("").trim().is_empty() {
                continue;
            }
            count += 1;
            let score = hit
                .get("score")
                .and_then(Value::as_f64)
                .map(|score| format!(" (score {score:.3})"))
                .unwrap_or_default();
            lines.push(format!("{count}. {}{score}", describe_memory(&record)));
            let body = trim_body(record.body.as_deref());
            if !body.is_empty() {
                lines.push(format!("   {body}"));
            }
        }
        if count == 0 {
            return Ok(format!(
                "No memory matched '{query}'. Try the words the memory would contain, or `remember` it if you have not stored it yet."
            ));
        }
        let plural = if count == 1 { "y" } else { "ies" };
        let mut out = vec![format!(
            "{count} memor{plural} matched '{query}', best first:"
        )];
        out.push(String::new());
        out.extend(lines);
        out.push(String::new());
        out.push("`update` and `forget` take one of these ids.".to_string());
        Ok(out.join("\n"))
    }

    /// One host call, with the host's own words on failure — `String(error)` on a
    /// transport is noise to a model.
    async fn call_host(&self, method: &str, params: Value) -> std::result::Result<Value, String> {
        self.host
            .call(method, params)
            .await
            .map_err(|error: HostError| error.to_string())
    }
}

impl Tool for MemoryTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            MEMORY_TOOL_NAME,
            MEMORY_TOOL_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["remember", "update", "forget", "search"],
                        "description": "What to do with the store."
                    },
                    "title": {"type": "string", "description": "remember / update. A few words naming the thing this memory is about."},
                    "body": {"type": "string", "description": "remember / update. The memory itself: one fact, preference, decision or pitfall."},
                    "kind": {
                        "type": "string",
                        "enum": MEMORY_KINDS,
                        "description": "remember only. Defaults to `fact`."
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "remember / update. Short labels that make this memory findable later."
                    },
                    "scope": {
                        "type": "string",
                        "enum": MEMORY_SCOPES,
                        "description": "remember only. Defaults to `global`."
                    },
                    "pinned": {"type": "boolean", "description": "remember / update. Recalled on every turn; for standing instructions only."},
                    "confidence": {"type": "number", "description": "update only. 0..1, how sure this memory is; it is written as 0.7."},
                    "id": {"type": "string", "description": "update / forget. The id a `remember` or `search` result gave you."},
                    "query": {"type": "string", "description": "search. Words the memory would contain."},
                    "limit": {"type": "number", "description": "search. How many hits at most. Defaults to 8, capped at 50."},
                    "items": {
                        "type": "array",
                        "maxItems": MEMORY_BATCH_LIMIT,
                        "description": "remember only. Store many memories in one call (at most 50) instead of one call per memory — use this for imports and migrations.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "description": "A few words naming what this memory is about."},
                                "body": {"type": "string", "description": "The memory itself: one fact, preference, decision or pitfall."},
                                "kind": {"type": "string", "enum": MEMORY_KINDS, "description": "Defaults to `fact`."},
                                "tags": {"type": "array", "items": {"type": "string"}},
                                "scope": {"type": "string", "enum": MEMORY_SCOPES, "description": "Defaults to `global`."},
                                "pinned": {"type": "boolean", "description": "Recalled on every turn; standing instructions only."}
                            },
                            "additionalProperties": false,
                            "required": ["title", "body"]
                        }
                    }
                },
                "additionalProperties": false,
                "required": ["action"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let raw = call.arguments.as_object().cloned().unwrap_or_default();
            let action = raw.get("action").and_then(Value::as_str).unwrap_or("");
            match action {
                "remember" if raw.get("items").is_some() => {
                    self.remember_batch(&raw, &ctx.session_id).await
                }
                "remember" => self.remember(&raw, &ctx.session_id).await,
                "update" => self.update(&raw).await,
                "forget" => self.forget(&raw).await,
                "search" => self.search(&raw, &ctx.session_id).await,
                _ => Err(AgentError::Refused(
                    "action is required: `remember` to store one memory, `update` or `forget` by id, or `search` to find what is already stored.".into(),
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{SkillCatalog, SkillDef};
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeHost {
        calls: Mutex<Vec<(String, Value)>>,
        reply: Mutex<Value>,
        failure: Mutex<Option<String>>,
    }

    impl FakeHost {
        fn answering(reply: Value) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.reply.lock().unwrap() = reply;
            host
        }

        fn failing(message: &str) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.failure.lock().unwrap() = Some(message.to_string());
            host
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl MemoryHost for FakeHost {
        fn call<'a>(
            &'a self,
            method: &'a str,
            params: Value,
        ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let failure = self.failure.lock().unwrap().clone();
            let reply = self.reply.lock().unwrap().clone();
            Box::pin(async move {
                match failure {
                    Some(message) => Err(HostError::Rpc(crate::rpc::RpcError::app(
                        "MEMORY_ERROR",
                        message,
                    ))),
                    None => Ok(reply),
                }
            })
        }
    }

    fn memory_tool(host: Arc<dyn MemoryHost>, project: Option<&str>) -> MemoryTool {
        MemoryTool::new(
            host,
            project.map(str::to_string),
            Arc::new(SkillCatalog::new()),
        )
    }

    fn context() -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            cancel: crate::CancelToken::new(),
        }
    }

    async fn run(tool: &MemoryTool, action: Value) -> Result<String> {
        let call = ToolCall {
            id: "call_1".into(),
            name: MEMORY_TOOL_NAME.into(),
            arguments: action.clone(),
            raw_arguments: None,
        };
        tool.call(&call, &context()).await
    }

    fn refused(result: Result<String>) -> String {
        match result {
            Ok(text) => panic!("expected a refusal, got {text}"),
            Err(error) => error.to_string(),
        }
    }

    #[tokio::test]
    async fn remember_requires_a_title_and_a_body() {
        let host = FakeHost::answering(json!({}));
        let tool = memory_tool(host.clone(), None);
        let message = refused(run(&tool, json!({"action": "remember", "body": "b"})).await);
        assert!(message.starts_with("title is required for remember"));
        let message = refused(run(&tool, json!({"action": "remember", "title": "t"})).await);
        assert!(message.starts_with("body is required for remember"));
        assert!(host.calls().is_empty(), "nothing reached the host");
    }

    #[tokio::test]
    async fn remember_sends_one_host_call_and_reports_what_was_stored() {
        let host = FakeHost::answering(json!({
            "deduped": false,
            "memory": {"id": "m1", "title": "Build time", "body": "40s", "kind": "fact", "scope": "global", "tags": ["ci"]}
        }));
        let tool = memory_tool(host.clone(), Some("D:/repo"));
        let answer = run(
            &tool,
            json!({"action": "remember", "title": "Build time", "body": "40s", "tags": ["ci"]}),
        )
        .await
        .expect("stored");
        assert_eq!(
            answer,
            "Saved [fact] Build time (tags: ci) — id m1 (scope global)."
        );
        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "memory.remember");
        assert_eq!(calls[0].1["kind"], "fact", "kind defaults to fact");
        assert_eq!(calls[0].1["scope"], "global", "scope defaults to global");
        assert!(
            calls[0].1.get("projectPath").is_none(),
            "a global memory carries no project column"
        );
    }

    #[tokio::test]
    async fn a_duplicate_is_reported_as_a_refresh() {
        let host = FakeHost::answering(json!({
            "deduped": true,
            "memory": {"id": "m1", "title": "Build time", "kind": "fact"}
        }));
        let tool = memory_tool(host, None);
        let answer = run(
            &tool,
            json!({"action": "remember", "title": "Build time", "body": "40s"}),
        )
        .await
        .expect("stored");
        assert!(answer.starts_with("Already stored — refreshed"));
    }

    #[tokio::test]
    async fn a_project_scope_without_a_project_is_refused_with_a_fix() {
        let host = FakeHost::answering(json!({}));
        let tool = memory_tool(host, None);
        let message = refused(
            run(
                &tool,
                json!({"action": "remember", "title": "t", "body": "b", "scope": "project"}),
            )
            .await,
        );
        assert!(message.contains("scope `project` needs an open project"));
    }

    #[tokio::test]
    async fn the_scope_columns_travel_only_when_the_scope_needs_them() {
        let host = FakeHost::answering(json!({"memory": {"id": "m1", "title": "t"}}));
        let tool = memory_tool(host.clone(), Some("D:/repo"));
        run(
            &tool,
            json!({"action": "remember", "title": "t", "body": "b", "scope": "project"}),
        )
        .await
        .expect("stored");
        run(
            &tool,
            json!({"action": "remember", "title": "t", "body": "b", "scope": "session"}),
        )
        .await
        .expect("stored");
        let calls = host.calls();
        assert_eq!(calls[0].1["projectPath"], "D:/repo");
        assert_eq!(calls[1].1["sessionId"], "s1");
    }

    #[tokio::test]
    async fn a_procedure_is_refused_and_names_the_skill_to_patch() {
        let catalog = Arc::new(SkillCatalog::new());
        catalog.replace(vec![SkillDef::new(
            "pi/release",
            "Release",
            Some("cut a release tag and publish the notes".into()),
        )]);
        let host = FakeHost::answering(json!({}));
        let tool = MemoryTool::new(host.clone(), None, catalog);
        let message = refused(
            run(
                &tool,
                json!({
                    "action": "remember",
                    "title": "Release steps",
                    "body": "1. cut the release tag\n2. publish the release notes"
                }),
            )
            .await,
        );
        assert!(message.contains("this is a procedure"));
        assert!(message.contains("pi/release"), "names the skill: {message}");
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_fact_that_mentions_a_subsystem_is_still_stored() {
        let catalog = Arc::new(SkillCatalog::new());
        catalog.replace(vec![SkillDef::new(
            "pi/release",
            "Release",
            Some("cut a release tag and publish the notes".into()),
        )]);
        let host = FakeHost::answering(json!({"memory": {"id": "m1", "title": "TCP 22"}}));
        let tool = MemoryTool::new(host.clone(), None, catalog);
        run(
            &tool,
            json!({"action": "remember", "title": "TCP 22", "body": "the release machine blocks TCP 22"}),
        )
        .await
        .expect("a fact is stored");
        assert_eq!(host.calls().len(), 1);
    }

    #[tokio::test]
    async fn a_credential_is_masked_before_it_reaches_the_store() {
        // Assembled at runtime: a credential-shaped literal in this file would be
        // masked by the tooling before the test ever ran.
        let token = format!("{}{}", "sk-", "abcdefghijklmnop");
        let host = FakeHost::answering(json!({"memory": {"id": "m1", "title": "Key"}}));
        let tool = memory_tool(host.clone(), None);
        let answer = run(
            &tool,
            json!({
                "action": "remember",
                "title": "Key",
                "body": format!("the api key is {token} for staging")
            }),
        )
        .await
        .expect("stored");
        let sent = host.calls()[0].1["body"].as_str().unwrap().to_string();
        assert!(!sent.contains(&token), "the token never left the kernel");
        assert!(sent.contains("***REDACTED***"));
        assert!(answer.contains("was replaced with ***REDACTED***"));
    }

    #[tokio::test]
    async fn a_batch_reports_saved_and_failed_separately() {
        let host = FakeHost::answering(json!({"memory": {"id": "m1", "title": "ok"}}));
        let tool = memory_tool(host.clone(), None);
        let answer = run(
            &tool,
            json!({
                "action": "remember",
                "items": [
                    {"title": "one", "body": "first fact"},
                    {"title": "two", "body": "second fact"},
                    {"title": "three"}
                ]
            }),
        )
        .await
        .expect("the batch partly succeeds");
        assert!(answer.starts_with("Saved 2 of 3 memories."));
        assert!(answer.contains("Not saved (fix and send again in the same batch):"));
        assert!(answer.contains("#3:"), "the failing item is numbered");
        assert_eq!(host.calls().len(), 2, "one host write per good item");
    }

    #[tokio::test]
    async fn a_batch_over_the_cap_is_refused_with_the_split_instruction() {
        let host = FakeHost::answering(json!({}));
        let tool = memory_tool(host.clone(), None);
        let items: Vec<Value> = (0..51)
            .map(|index| json!({"title": format!("t{index}"), "body": "b"}))
            .collect();
        let message = refused(run(&tool, json!({"action": "remember", "items": items})).await);
        assert!(message.contains("at most 50 memories per call"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn update_requires_something_to_change_and_one_id() {
        let host = FakeHost::answering(json!({"memory": {"id": "m1", "title": "Build time"}}));
        let tool = memory_tool(host.clone(), None);
        let message = refused(run(&tool, json!({"action": "update", "title": "x"})).await);
        assert!(message.starts_with("id is required for update"));
        let message = refused(run(&tool, json!({"action": "update", "id": "m1"})).await);
        assert!(message.starts_with("nothing to update"));
        let answer = run(
            &tool,
            json!({"action": "update", "id": "m1", "confidence": 0.9}),
        )
        .await
        .expect("updated");
        assert!(answer.starts_with("Updated "));
        assert_eq!(host.calls()[0].1["confidence"], 0.9);
    }

    #[tokio::test]
    async fn an_unknown_id_is_reported_as_not_found_with_the_next_step() {
        let host = FakeHost::failing("memory not found: m9");
        let tool = memory_tool(host, None);
        let message =
            refused(run(&tool, json!({"action": "update", "id": "m9", "title": "x"})).await);
        assert!(message.contains("No memory with id m9"));
        assert!(message.contains("`search`"));
    }

    #[tokio::test]
    async fn forget_says_plainly_when_nothing_was_there() {
        let host = FakeHost::answering(json!({"removed": 0}));
        let tool = memory_tool(host, None);
        let answer = run(&tool, json!({"action": "forget", "id": "m1"}))
            .await
            .expect("answered");
        assert!(answer.contains("so nothing was removed"));

        let host = FakeHost::answering(json!({"removed": 3}));
        let tool = memory_tool(host, None);
        let answer = run(&tool, json!({"action": "forget", "id": "m1"}))
            .await
            .expect("answered");
        assert_eq!(answer, "Forgot memory m1.");
    }

    #[tokio::test]
    async fn search_renders_the_hosts_ranking_and_caps_a_long_body() {
        let long_body = "x".repeat(600);
        let host = FakeHost::answering(json!({
            "memories": [
                {"memory": {"id": "m1", "title": "First", "body": long_body, "kind": "fact"}, "score": -1.5},
                {"memory": {"id": "m2", "title": "Second", "body": "short", "kind": "pitfall"}, "score": -2.0}
            ]
        }));
        let tool = memory_tool(host.clone(), Some("D:/repo"));
        let answer = run(&tool, json!({"action": "search", "query": "build"}))
            .await
            .expect("answered");
        assert!(answer.starts_with("2 memories matched 'build', best first:"));
        let first = answer.find("1. [fact] First").expect("the first hit");
        let second = answer.find("2. [pitfall] Second").expect("the second hit");
        assert!(first < second, "the host's order is kept");
        assert!(answer.contains("(score -1.500)"));
        assert!(answer.contains('…'), "a long body is cut");
        assert!(answer
            .trim_end()
            .ends_with("`update` and `forget` take one of these ids."));
        let params = &host.calls()[0].1;
        assert_eq!(params["limit"], 8, "the default limit");
        assert_eq!(params["projectPath"], "D:/repo");
        assert_eq!(params["sessionId"], "s1");
    }

    #[tokio::test]
    async fn search_clamps_the_limit_and_reports_no_hits() {
        let host = FakeHost::answering(json!({"memories": []}));
        let tool = memory_tool(host.clone(), None);
        let answer = run(
            &tool,
            json!({"action": "search", "query": "nothing", "limit": 500}),
        )
        .await
        .expect("answered");
        assert!(answer.contains("No memory matched 'nothing'"));
        assert_eq!(
            host.calls()[0].1["limit"],
            50,
            "capped at the host's ceiling"
        );
    }

    #[tokio::test]
    async fn an_unknown_action_is_refused_with_the_four_choices() {
        let host = FakeHost::answering(json!({}));
        let tool = memory_tool(host, None);
        let message = refused(run(&tool, json!({})).await);
        assert!(message.starts_with("action is required"));
        assert!(message.contains("`remember`"));
        assert!(message.contains("`search`"));
    }

    #[test]
    fn the_spec_lets_the_model_omit_an_id_for_search() {
        let tool = MemoryTool::new(
            FakeHost::answering(json!({})),
            None,
            Arc::new(SkillCatalog::new()),
        );
        let spec = tool.spec();
        assert_eq!(spec.name, MEMORY_TOOL_NAME);
        let required: Vec<&str> = spec.parameters["required"]
            .as_array()
            .expect("a required list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(required, vec!["action"]);
        assert_eq!(
            spec.parameters["properties"]["items"]["maxItems"], 50,
            "the batch cap is declared, not just enforced"
        );
    }
}
