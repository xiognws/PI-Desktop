//! Turn and stream events.
//!
//! The vocabulary is the one the renderer already consumes (`AgentEvent` in
//! `packages/shared/src/types/agent.ts`). Phase 1 emits the subset the kernel
//! can produce on its own; permission, asktool, planning, compaction and
//! skill-review variants join when their subsystems migrate.
//!
//! Field names are `camelCase` so the sidecar RPC layer can forward an event
//! unchanged instead of translating a second time.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::message::{now_ms, Message, ToolResult, Usage};

/// The `result` object a `ToolEnd` frame carries.
///
/// `content`/`truncated` are what the model reads. `details` is the structured
/// half a client renders — the subagent topology reads a `Task` row's
/// `delegationId`/`status`, the background-job and review panels read their own
/// keys, and host-core only replaces a provisional `Task` row when its details
/// name the delegation and a terminal status. A tool that publishes nothing
/// leaves the row text-only, exactly as before.
pub fn tool_result_payload(
    result: &ToolResult,
    details: Option<serde_json::Value>,
) -> serde_json::Value {
    match details {
        Some(details) => serde_json::json!({
            "content": result.content,
            "truncated": result.truncated,
            "details": details,
        }),
        None => serde_json::json!({
            "content": result.content,
            "truncated": result.truncated,
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        #[serde(rename = "messageIds")]
        message_ids: Vec<String>,
    },
    TurnStart,
    Usage {
        usage: Usage,
    },
    TurnEnd,
    MessageStart {
        message: Message,
    },
    /// Append-only streaming frame: `deltaText`/`deltaThinking` are applied on
    /// top of the live row, and a snapshot replacement omits them.
    MessageUpdate {
        message: Message,
        #[serde(rename = "deltaText", skip_serializing_if = "Option::is_none")]
        delta_text: Option<String>,
        #[serde(rename = "deltaThinking", skip_serializing_if = "Option::is_none")]
        delta_thinking: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<String>,
    },
    MessageEnd {
        message: Message,
    },
    ToolStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "args")]
        arguments: serde_json::Value,
    },
    ToolEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        result: serde_json::Value,
        #[serde(rename = "isError", skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
    CompactionStart {
        reason: CompactionReason,
    },
    CompactionEnd {
        reason: CompactionReason,
        ok: bool,
        #[serde(rename = "tokensBefore", skip_serializing_if = "Option::is_none")]
        tokens_before: Option<u64>,
        #[serde(rename = "firstKeptMessageId", skip_serializing_if = "Option::is_none")]
        first_kept_message_id: Option<String>,
        #[serde(rename = "willRetry")]
        will_retry: bool,
        /// Present when the summary failed and a retained tail was installed.
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<CompactionFallback>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<CompactionFailure>,
    },
    /// A question the model asked; the renderer draws a card and answers it
    /// through `asktool.resolve`. The wire name is one word: the renderer's event
    /// union spells it `asktool_request`, not `ask_tool_request`.
    #[serde(rename = "asktool_request")]
    AskToolRequest {
        request: crate::ask::AskRequest,
    },
    /// A background skill review finished.
    ///
    /// The review's writes are ordinary `skill_manage` calls inside a forked
    /// run, so the transcript never shows them: this event carries the summary a
    /// person would otherwise never see. A write and a failure always report; a
    /// pass that looked and found nothing stays quiet unless the reader asked for
    /// quiet passes too.
    #[serde(rename = "skill_review")]
    SkillReview {
        outcome: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        actions: Vec<String>,
        /// The same writes as `actions`, structured as `{kind, subject, file}` so
        /// a client renders them in the user's language.
        #[serde(rename = "actionDetails", skip_serializing_if = "Vec::is_empty")]
        action_details: Vec<serde_json::Value>,
    },
    /// The session's run state changed.
    ///
    /// The payload is the same object `agent.getStatus` answers with, so a
    /// renderer can drive a busy indicator from the event stream instead of
    /// polling — and a client that only watches events still learns when a turn
    /// starts and ends.
    Status {
        status: serde_json::Value,
    },
    /// The session's plan/goal negotiation changed.
    ///
    /// Payload is `PlanningStateEvent` from
    /// `packages/shared/src/types/plans.ts` field for field: the tag plus flat
    /// optional fields, which is the shape
    /// `apps/desktop/src/stores/slices/events-slice.ts` already consumes. The
    /// kernel emits it when a turn starts in Plan mode, when `SubmitPlan` is
    /// accepted by the host, and when the session leaves the negotiation — the
    /// same three transitions the Node runtime's `setPlanningState` announces.
    #[serde(rename = "planning_state")]
    PlanningState {
        state: crate::plan::PlanningStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(rename = "proposalId", skip_serializing_if = "Option::is_none")]
        proposal_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        markdown: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        question: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        artifact: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<String>,
        #[serde(
            rename = "targetPermissionMode",
            skip_serializing_if = "Option::is_none"
        )]
        target_permission_mode: Option<String>,
        #[serde(rename = "executionId", skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
        #[serde(rename = "executionState", skip_serializing_if = "Option::is_none")]
        execution_state: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        proposal: Option<serde_json::Value>,
    },
    Error {
        code: String,
        message: String,
    },
}

impl AgentEvent {
    /// A planning-state transition that carries nothing but the state.
    ///
    /// `planning` is a Plan turn starting; `inactive` is any turn that is not
    /// negotiating a contract, including the Agent turn an approved plan runs as.
    pub fn planning(state: crate::plan::PlanningStatus, kind: Option<&str>) -> Self {
        Self::PlanningState {
            state,
            kind: kind.map(str::to_string),
            proposal_id: None,
            title: None,
            markdown: None,
            question: None,
            artifact: None,
            version: None,
            plan: None,
            action: None,
            target_permission_mode: None,
            execution_id: None,
            execution_state: None,
            proposal: None,
        }
    }

    /// The transition an accepted submission produces: the whole proposal, so a
    /// renderer that only watches events can open the review.
    pub fn plan_submitted(submitted: &crate::plan::SubmittedPlan) -> Self {
        let from_proposal = |key: &str| {
            submitted
                .proposal
                .as_ref()
                .and_then(|proposal| proposal.get(key))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        Self::PlanningState {
            state: crate::plan::PlanningStatus::AwaitingApproval,
            kind: Some(submitted.kind.clone()),
            proposal_id: Some(submitted.proposal_id.clone()),
            title: Some(submitted.title.clone()),
            markdown: Some(submitted.markdown.clone()),
            question: Some(submitted.question.clone()),
            artifact: submitted.artifact.clone(),
            version: submitted.version,
            plan: Some(submitted.markdown.clone()),
            action: None,
            target_permission_mode: from_proposal("targetPermissionMode"),
            execution_id: from_proposal("executionId"),
            execution_state: from_proposal("executionState"),
            proposal: submitted.proposal.clone(),
        }
    }
}

/// Why compaction ran. Wire names match `ContextCompactionReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    Manual,
    Threshold,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionFallback {
    RetainedTail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEnvelope {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Set on events a subagent produced, naming the `Task` call that owns it.
    #[serde(rename = "parentToolCallId", skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    /// Set on events a subagent produced: the definition's name.
    #[serde(rename = "agentName", skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub ts: i64,
    pub event: AgentEvent,
}

impl AgentEventEnvelope {
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        event: AgentEvent,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: Some(turn_id.into()),
            parent_tool_call_id: None,
            agent_name: None,
            ts: now_ms(),
            event,
        }
    }

    /// Attribute this event to the delegate that produced it.
    pub fn with_delegate(mut self, parent_tool_call_id: &str, agent_name: &str) -> Self {
        self.parent_tool_call_id = Some(parent_tool_call_id.to_string());
        self.agent_name = Some(agent_name.to_string());
        self
    }
}

/// Where the kernel publishes events. The sidecar implements this over its
/// JSON-RPC notification channel; tests implement it over a vector.
pub trait EventSink: Send + Sync {
    fn emit(&self, envelope: AgentEventEnvelope);
}

impl EventSink for tokio::sync::mpsc::UnboundedSender<AgentEventEnvelope> {
    fn emit(&self, envelope: AgentEventEnvelope) {
        // A closed receiver means the consumer went away; the turn will notice
        // through cancellation, so dropping the event here is correct.
        let _ = self.send(envelope);
    }
}

/// Test/self-check sink that keeps every event in order.
#[derive(Debug, Default, Clone)]
pub struct RecordingSink {
    events: Arc<Mutex<Vec<AgentEventEnvelope>>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> Vec<AgentEventEnvelope> {
        self.events.lock().expect("event log poisoned").clone()
    }

    pub fn events(&self) -> Vec<AgentEvent> {
        self.snapshot()
            .into_iter()
            .map(|envelope| envelope.event)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.events.lock().expect("event log poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl EventSink for RecordingSink {
    fn emit(&self, envelope: AgentEventEnvelope) {
        self.events
            .lock()
            .expect("event log poisoned")
            .push(envelope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_serializes_with_camel_case_contract() {
        let envelope = AgentEventEnvelope::new(
            "s1",
            "t1",
            AgentEvent::ToolStart {
                tool_call_id: "call_1".into(),
                tool_name: "read_file".into(),
                arguments: serde_json::json!({"path": "a.txt"}),
            },
        );
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["turnId"], "t1");
        assert_eq!(value["event"]["type"], "tool_start");
        assert_eq!(value["event"]["toolCallId"], "call_1");
        assert_eq!(value["event"]["toolName"], "read_file");
    }

    #[test]
    fn recording_sink_keeps_order() {
        let sink = RecordingSink::new();
        sink.emit(AgentEventEnvelope::new("s", "t", AgentEvent::TurnStart));
        sink.emit(AgentEventEnvelope::new("s", "t", AgentEvent::TurnEnd));
        let events = sink.events();
        assert_eq!(events, vec![AgentEvent::TurnStart, AgentEvent::TurnEnd]);
    }

    /// The wire shape the renderer reads (`PlanningStateEvent` in
    /// `packages/shared/src/types/plans.ts`, consumed by
    /// `apps/desktop/src/stores/slices/events-slice.ts`): the tag plus flat
    /// fields. A nested object or a renamed field is silently not drawn.
    #[test]
    fn planning_state_matches_the_shared_payload_field_for_field() {
        let submitted = crate::plan::SubmittedPlan {
            proposal_id: "proposal-1".into(),
            kind: "plan".into(),
            title: "Fix the parser".into(),
            markdown: "# Plan".into(),
            question: "Run it?".into(),
            artifact: Some(serde_json::json!({
                "relativePath": ".pi/plan/proposal-1.md",
                "sha256": "abc",
                "sizeBytes": 42
            })),
            version: Some(1),
            proposal: Some(serde_json::json!({
                "id": "proposal-1",
                "kind": "plan",
                "executionId": "execution-1",
                "executionState": "queued"
            })),
        };
        let value = serde_json::to_value(AgentEvent::plan_submitted(&submitted)).unwrap();
        assert_eq!(value["type"], "planning_state");
        assert_eq!(value["state"], "awaiting_approval");
        assert_eq!(value["kind"], "plan");
        assert_eq!(value["proposalId"], "proposal-1");
        assert_eq!(value["title"], "Fix the parser");
        assert_eq!(value["markdown"], "# Plan");
        assert_eq!(value["question"], "Run it?");
        assert_eq!(value["plan"], "# Plan");
        assert_eq!(value["artifact"]["relativePath"], ".pi/plan/proposal-1.md");
        assert_eq!(value["version"], 1);
        assert_eq!(value["executionId"], "execution-1");
        assert_eq!(value["executionState"], "queued");
        assert_eq!(value["proposal"]["id"], "proposal-1");
        assert!(
            value.get("action").is_none(),
            "an unset field is absent, not null: {value}"
        );

        // A transition with nothing else to say carries nothing else.
        let idle = serde_json::to_value(AgentEvent::planning(
            crate::plan::PlanningStatus::Inactive,
            None,
        ))
        .unwrap();
        assert_eq!(
            idle,
            serde_json::json!({"type": "planning_state", "state": "inactive"})
        );
        let planning = serde_json::to_value(AgentEvent::planning(
            crate::plan::PlanningStatus::Planning,
            Some("plan"),
        ))
        .unwrap();
        assert_eq!(
            planning,
            serde_json::json!({"type": "planning_state", "state": "planning", "kind": "plan"})
        );
    }

    /// The envelope forwards the event unchanged, so the adapter in main sees
    /// `event.state` where the renderer expects it.
    #[test]
    fn a_planning_transition_survives_the_envelope() {
        let envelope = AgentEventEnvelope::new(
            "s1",
            "t1",
            AgentEvent::planning(crate::plan::PlanningStatus::Planning, Some("plan")),
        );
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["turnId"], "t1");
        assert_eq!(value["event"]["type"], "planning_state");
        assert_eq!(value["event"]["state"], "planning");
    }
}
