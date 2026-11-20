//! `asktool`: the model pauses a turn and asks the user a bounded question.
//!
//! Counterpart of `asktool` in `packages/shared/src/types/agent.ts` (spec
//! `17-asktool-questions.md`). It is available in Agent, Plan and Goal mode and
//! is *not* an authorization: it grants nothing, has no deadline, and its answers
//! are ordinary tool text.
//!
//! Two shapes have to stay stable because the renderer and main both depend on
//! them: the `asktool_request` event carrying the questions, and the
//! `asktool.resolve` call that answers them. The model-facing result is the one
//! the desktop has always produced — `question：answers` per question, separated
//! by `---` — because a transcript replayed from an older build must read the
//! same.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};
use crate::event::{AgentEvent, AgentEventEnvelope, EventSink};
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Name of the tool the model calls.
pub const ASK_TOOL_NAME: &str = "asktool";

/// Maximum length of one prompt, counted in Unicode code points.
pub const MAX_ASK_TOOL_QUESTION_CHARS: usize = 300;

/// Most questions one call may carry.
pub const MAX_ASK_QUESTIONS: usize = 20;

const ASK_TOOL_DESCRIPTION: &str = "Ask the user one or more questions. Keep each question to 300 characters or fewer. Use Markdown in question text and option labels when formatting helps (for example, emphasis, inline code, or lists); the desktop card renders it safely. Plain strings and existing { label, description? } options are accepted; descriptions remain plain text and answers return the selected source label. The card always provides a custom user-input option.";

/// One selectable answer: a label, optionally with supporting copy.
///
/// Serialized as a bare string when it has nothing to add, because that is the
/// shape the model sent and the shape the card has always rendered; an option
/// with copy becomes `{ label, description }`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

impl serde::Serialize for AskOption {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match &self.description {
            None => serializer.serialize_str(&self.label),
            Some(description) => {
                use serde::ser::SerializeStruct;
                let mut state = serializer.serialize_struct("AskOption", 2)?;
                state.serialize_field("label", &self.label)?;
                state.serialize_field("description", description)?;
                state.end()
            }
        }
    }
}

impl AskOption {
    /// Read a plain string or a `{ label, description? }` object.
    ///
    /// A malformed or empty option is dropped rather than repaired: a label the
    /// user cannot read is one they cannot choose.
    pub fn from_value(value: &Value) -> Option<Self> {
        if let Some(text) = value.as_str() {
            let label = text.trim();
            return (!label.is_empty()).then(|| Self {
                label: label.to_string(),
                description: None,
            });
        }
        let object = value.as_object()?;
        let label = object.get("label")?.as_str()?.trim();
        if label.is_empty() {
            return None;
        }
        let description = object
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        Some(Self {
            label: label.to_string(),
            description,
        })
    }
}

/// One question shown in the inline card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskQuestion {
    pub question: String,
    pub options: Vec<AskOption>,
    #[serde(rename = "multiSelect", skip_serializing_if = "std::ops::Not::not")]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub questions: Vec<AskQuestion>,
}

/// Answers as the runtime holds them: one entry per question, `None` meaning the
/// question was skipped or the whole prompt declined.
pub type AskAnswers = Vec<Option<Vec<String>>>;

/// Whether a prompt fits the per-question limit, counted in code points.
pub fn question_within_limit(question: &str) -> bool {
    question.chars().count() <= MAX_ASK_TOOL_QUESTION_CHARS
}

/// Validate and normalize the tool's arguments.
///
/// `None` means the call is malformed and no card may be created: the model gets
/// its own argument back to fix, instead of a user staring at a broken question.
pub fn normalize_questions(params: &Value) -> Option<Vec<AskQuestion>> {
    let raw_questions = params.get("questions")?.as_array()?;
    if raw_questions.is_empty() || raw_questions.len() > MAX_ASK_QUESTIONS {
        return None;
    }
    let mut questions: Vec<AskQuestion> = Vec::new();
    for raw in raw_questions {
        let question = raw.get("question")?.as_str()?.trim().to_string();
        if question.is_empty() || !question_within_limit(&question) {
            return None;
        }
        let mut options: Vec<AskOption> = Vec::new();
        if let Some(raw_options) = raw.get("options").and_then(Value::as_array) {
            for raw_option in raw_options {
                let Some(option) = AskOption::from_value(raw_option) else {
                    continue;
                };
                // Two options with one label are indistinguishable once chosen.
                if options.iter().any(|seen| seen.label == option.label) {
                    continue;
                }
                options.push(option);
            }
        }
        if options.is_empty() {
            return None;
        }
        questions.push(AskQuestion {
            question,
            options,
            multi_select: raw.get("multiSelect").and_then(Value::as_bool) == Some(true),
        });
    }
    if questions.is_empty() {
        return None;
    }
    Some(questions)
}

/// Stable model-facing serialization of one answer set.
pub fn format_output(questions: &[AskQuestion], answers: &AskAnswers) -> String {
    questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let answer = answers
                .get(index)
                .and_then(|answer| answer.as_ref())
                .map(|values| values.join("、"))
                .unwrap_or_default();
            format!("{}：{}", question.question, answer)
        })
        .collect::<Vec<_>>()
        .join("\n---\n")
}

/// What went wrong when an answer arrived, in the wire's vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskResolveError {
    /// No pending card with that id, or it belongs to another session.
    NotFound(String),
    /// The answer does not fit the questions it answers.
    InvalidArgument(String),
}

impl AskResolveError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "ASKTOOL_NOT_FOUND",
            Self::InvalidArgument(_) => "ASKTOOL_INVALID_ARGUMENT",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(message) | Self::InvalidArgument(message) => message,
        }
    }
}

struct PendingAsk {
    request_id: String,
    session_id: String,
    questions: Vec<AskQuestion>,
    tx: oneshot::Sender<AskAnswers>,
}

/// The cards this process is waiting on.
///
/// One broker per sidecar, not per session: `asktool.resolve` arrives against a
/// session id and has to find the card even after the turn that created it has
/// moved on to its next step.
pub struct AskBroker {
    sink: std::sync::Arc<dyn EventSink>,
    pending: Mutex<HashMap<String, PendingAsk>>,
}

impl AskBroker {
    pub fn new(sink: std::sync::Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Number of cards waiting for an answer; used by tests and diagnostics.
    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .map(|pending| pending.len())
            .unwrap_or(0)
    }

    /// Ask, and wait for the answer, the cancellation of the turn, or a crash of
    /// the asker. Never hangs past the turn: a stopped turn resolves every
    /// remaining question as skipped.
    async fn ask(&self, request: AskRequest, turn_id: &str, cancel: &CancelToken) -> AskAnswers {
        let skipped = request.questions.iter().map(|_| None).collect::<Vec<_>>();
        if cancel.is_cancelled() {
            return skipped;
        }
        let (tx, rx) = oneshot::channel();
        {
            let Ok(mut pending) = self.pending.lock() else {
                return skipped;
            };
            pending.insert(
                request.request_id.clone(),
                PendingAsk {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    questions: request.questions.clone(),
                    tx,
                },
            );
        }
        self.sink.emit(AgentEventEnvelope::new(
            request.session_id.clone(),
            turn_id.to_string(),
            AgentEvent::AskToolRequest {
                request: request.clone(),
            },
        ));
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // The card is gone even if the user was about to answer.
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&request.request_id);
                }
                skipped
            }
            answered = rx => answered.unwrap_or(skipped),
        }
    }

    /// Deliver an answer to one card.
    pub fn resolve(
        &self,
        session_id: &str,
        request_id: &str,
        answers: &Value,
    ) -> std::result::Result<(), AskResolveError> {
        let pending = {
            let Ok(mut pending) = self.pending.lock() else {
                return Err(AskResolveError::NotFound(
                    "the ask registry is unavailable".into(),
                ));
            };
            let Some(entry) = pending.get(request_id) else {
                return Err(AskResolveError::NotFound(
                    "asktool request is no longer pending".into(),
                ));
            };
            if entry.session_id != session_id {
                return Err(AskResolveError::NotFound("asktool session mismatch".into()));
            }
            pending.remove(request_id).expect("checked above")
        };
        let Some(raw_answers) = answers.as_array() else {
            // Put the card back: a malformed answer is not a decision.
            self.restore(pending);
            return Err(AskResolveError::InvalidArgument(
                "answers must be an array".into(),
            ));
        };
        if raw_answers.len() != pending.questions.len() {
            self.restore(pending);
            return Err(AskResolveError::InvalidArgument(
                "asktool answer count does not match questions".into(),
            ));
        }
        let mut parsed: AskAnswers = Vec::with_capacity(raw_answers.len());
        for (index, raw) in raw_answers.iter().enumerate() {
            if raw.is_null() {
                parsed.push(None);
                continue;
            }
            let Some(values) = raw.as_array() else {
                self.restore(pending);
                return Err(AskResolveError::InvalidArgument(format!(
                    "asktool answer {} must be an array or null",
                    index + 1
                )));
            };
            let mut selected: Vec<String> = Vec::new();
            for value in values {
                let Some(text) = value.as_str() else {
                    continue;
                };
                let text = text.trim();
                if !text.is_empty() && !selected.iter().any(|seen| seen == text) {
                    selected.push(text.to_string());
                }
            }
            if !pending.questions[index].multi_select && selected.len() > 1 {
                self.restore(pending);
                return Err(AskResolveError::InvalidArgument(format!(
                    "asktool question {} accepts one answer",
                    index + 1
                )));
            }
            parsed.push(Some(selected));
        }
        // The waiting turn is gone (cancelled or dropped); the answer has nowhere
        // to go, which is not the caller's fault.
        let _ = pending.tx.send(parsed);
        Ok(())
    }

    /// Put a card back after a malformed answer: a bad answer is not a decision.
    fn restore(&self, pending: PendingAsk) {
        if let Ok(mut registry) = self.pending.lock() {
            registry.insert(pending.request_id.clone(), pending);
        }
    }

    /// Resolve every card in `session_id` as skipped. Called when a turn stops:
    /// a card must never outlive the turn that asked.
    pub fn cancel_session(&self, session_id: &str) {
        let taken: Vec<(String, PendingAsk)> = {
            let Ok(mut pending) = self.pending.lock() else {
                return;
            };
            let ids: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id).map(|entry| (id, entry)))
                .collect()
        };
        for (_, entry) in taken {
            let skipped = entry.questions.iter().map(|_| None).collect();
            let _ = entry.tx.send(skipped);
        }
    }
}

/// The `asktool` tool.
pub struct AskTool {
    broker: std::sync::Arc<AskBroker>,
}

impl AskTool {
    pub fn new(broker: std::sync::Arc<AskBroker>) -> Self {
        Self { broker }
    }
}

impl Tool for AskTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            ASK_TOOL_NAME,
            ASK_TOOL_DESCRIPTION,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_ASK_QUESTIONS,
                        "description": "Questions to ask, shown one at a time in a card.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": {
                                    "type": "string",
                                    "description": format!("The prompt text, Markdown allowed. At most {MAX_ASK_TOOL_QUESTION_CHARS} characters.")
                                },
                                "options": {
                                    "type": "array",
                                    "minItems": 1,
                                    "description": "Selectable answers; a string, or { label, description }.",
                                    "items": {
                                        "anyOf": [
                                            {"type": "string"},
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "label": {"type": "string"},
                                                    "description": {"type": "string"}
                                                },
                                                "required": ["label"],
                                                "additionalProperties": false
                                            }
                                        ]
                                    }
                                },
                                "multiSelect": {
                                    "type": "boolean",
                                    "description": "Allow more than one selected answer."
                                }
                            },
                            "required": ["question", "options"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["questions"],
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let Some(questions) = normalize_questions(&call.arguments) else {
                return Err(AgentError::Refused(format!(
                    "asktool needs a non-empty `questions` array (at most {MAX_ASK_QUESTIONS}), each with `question` ({MAX_ASK_TOOL_QUESTION_CHARS} characters or fewer), and at least one non-empty option."
                )));
            };
            let request = AskRequest {
                request_id: uuid::Uuid::new_v4().to_string(),
                session_id: ctx.session_id.clone(),
                tool_call_id: call.id.clone(),
                questions: questions.clone(),
            };
            let answers = self.broker.ask(request, &ctx.turn_id, &ctx.cancel).await;
            Ok(format_output(&questions, &answers))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::RecordingSink;
    use serde_json::json;
    use std::sync::Arc;

    fn context(cancel: CancelToken) -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            steering: None,
            cancel,
        }
    }

    fn tool() -> (AskTool, Arc<AskBroker>, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::new());
        let broker = Arc::new(AskBroker::new(sink.clone()));
        (AskTool::new(broker.clone()), broker, sink)
    }

    fn call(arguments: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: ASK_TOOL_NAME.into(),
            arguments,
            raw_arguments: None,
        }
    }

    #[test]
    fn a_plain_string_option_becomes_a_label() {
        let option = AskOption::from_value(&json!("  Blue  ")).expect("an option");
        assert_eq!(option.label, "Blue");
        assert_eq!(option.description, None);
    }

    #[test]
    fn an_object_option_keeps_its_description() {
        let option =
            AskOption::from_value(&json!({"label": "**Web**", "description": " in a browser "}))
                .expect("an option");
        assert_eq!(option.label, "**Web**");
        assert_eq!(option.description.as_deref(), Some("in a browser"));
    }

    #[test]
    fn a_malformed_option_is_dropped() {
        for value in [
            json!(""),
            json!("   "),
            json!({"description": "no label"}),
            json!(7),
        ] {
            assert!(AskOption::from_value(&value).is_none(), "{value}");
        }
    }

    #[test]
    fn questions_are_normalized_with_their_options() {
        let questions = normalize_questions(&json!({
            "questions": [
                {"question": " Preferred color? ", "options": ["Blue", "  Blue ", "", "Green"]},
                {"question": "Which platforms?", "options": [{"label": "Web", "description": "browser"}], "multiSelect": true}
            ]
        }))
        .expect("a valid request");
        assert_eq!(questions[0].question, "Preferred color?");
        assert_eq!(
            questions[0].options.len(),
            2,
            "the duplicate label is dropped"
        );
        assert!(!questions[0].multi_select);
        assert!(questions[1].multi_select);
    }

    #[test]
    fn an_over_long_question_is_refused_before_a_card_exists() {
        let at_limit = "q".repeat(MAX_ASK_TOOL_QUESTION_CHARS);
        let over = "q".repeat(MAX_ASK_TOOL_QUESTION_CHARS + 1);
        assert!(normalize_questions(
            &json!({"questions": [{"question": at_limit, "options": ["a"]}]})
        )
        .is_some());
        assert!(
            normalize_questions(&json!({"questions": [{"question": over, "options": ["a"]}]}))
                .is_none()
        );
    }

    #[test]
    fn the_limit_counts_code_points_not_bytes() {
        // A supplementary-plane character counts once, and costs four bytes.
        let emoji = "🧭".repeat(MAX_ASK_TOOL_QUESTION_CHARS);
        assert!(question_within_limit(&emoji));
        assert!(!question_within_limit(&format!("{emoji}🧭")));
    }

    #[test]
    fn a_request_needs_one_question_and_one_option() {
        assert!(normalize_questions(&json!({"questions": []})).is_none());
        assert!(
            normalize_questions(&json!({"questions": [{"question": "q", "options": []}]}))
                .is_none()
        );
        assert!(
            normalize_questions(&json!({"questions": [{"question": "q", "options": [""]}]}))
                .is_none()
        );
        assert!(normalize_questions(&json!({})).is_none());
        let many: Vec<Value> = (0..MAX_ASK_QUESTIONS + 1)
            .map(|index| json!({"question": format!("q{index}"), "options": ["a"]}))
            .collect();
        assert!(normalize_questions(&json!({"questions": many})).is_none());
    }

    #[test]
    fn the_answer_is_rendered_the_way_the_desktop_always_rendered_it() {
        let questions = normalize_questions(&json!({
            "questions": [
                {"question": "Color?", "options": ["Blue"]},
                {"question": "Platforms?", "options": ["Web", "Desktop"], "multiSelect": true},
                {"question": "Notes?", "options": ["a"]}
            ]
        }))
        .expect("valid");
        let answers: AskAnswers = vec![
            Some(vec!["Blue".into()]),
            Some(vec!["Web".into(), "Desktop".into()]),
            None,
        ];
        assert_eq!(
            format_output(&questions, &answers),
            "Color?：Blue\n---\nPlatforms?：Web、Desktop\n---\nNotes?："
        );
    }

    #[tokio::test]
    async fn asking_emits_the_card_and_waits_for_the_answer() {
        let (tool, broker, sink) = tool();
        let cancel = CancelToken::new();
        let asking = tokio::spawn({
            let cancel = cancel.clone();
            let call =
                call(json!({"questions": [{"question": "Color?", "options": ["Blue", "Green"]}]}));
            async move { tool.call(&call, &context(cancel)).await }
        });

        // The card is emitted before any answer can arrive.
        let mut request_id = None;
        for _ in 0..200 {
            let events = sink.events();
            if let Some(AgentEvent::AskToolRequest { request }) = events.first() {
                request_id = Some(request.request_id.clone());
                assert_eq!(request.session_id, "s1");
                assert_eq!(request.tool_call_id, "call_1");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let request_id = request_id.expect("an asktool_request event");

        broker
            .resolve("s1", &request_id, &json!([["Green"]]))
            .expect("an answer is accepted");
        let answer = asking.await.expect("the tool returns").expect("a result");
        assert_eq!(answer, "Color?：Green");
        assert_eq!(broker.pending_count(), 0);
    }

    #[tokio::test]
    async fn a_stopped_turn_resolves_the_card_as_skipped() {
        let (tool, broker, _sink) = tool();
        let cancel = CancelToken::new();
        let asking = tokio::spawn({
            let cancel = cancel.clone();
            let call = call(json!({"questions": [{"question": "Color?", "options": ["Blue"]}]}));
            async move { tool.call(&call, &context(cancel)).await }
        });
        for _ in 0..200 {
            if broker.pending_count() > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        cancel.cancel();
        let answer = asking.await.expect("the tool returns").expect("a result");
        assert_eq!(
            answer, "Color?：",
            "a skipped question answers with nothing"
        );
        assert_eq!(
            broker.pending_count(),
            0,
            "the card does not outlive the turn"
        );
    }

    #[tokio::test]
    async fn a_malformed_request_is_refused_without_a_card() {
        let (tool, broker, sink) = tool();
        let error = tool
            .call(
                &call(json!({"questions": []})),
                &context(CancelToken::new()),
            )
            .await
            .expect_err("refused");
        assert!(error.to_string().starts_with("asktool needs a non-empty"));
        assert!(sink.events().is_empty(), "no card for a malformed call");
        assert_eq!(broker.pending_count(), 0);
    }

    #[tokio::test]
    async fn an_answer_for_another_session_is_not_found() {
        let (tool, broker, _sink) = tool();
        let cancel = CancelToken::new();
        let asking = tokio::spawn({
            let cancel = cancel.clone();
            let call = call(json!({"questions": [{"question": "Color?", "options": ["Blue"]}]}));
            async move { tool.call(&call, &context(cancel)).await }
        });
        let mut request_id = String::new();
        for _ in 0..200 {
            if let Some(entry) = broker.pending.lock().unwrap().keys().next() {
                request_id = entry.clone();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let error = broker
            .resolve("other", &request_id, &json!([["Blue"]]))
            .expect_err("refused");
        assert_eq!(error.code(), "ASKTOOL_NOT_FOUND");
        assert_eq!(error.message(), "asktool session mismatch");
        broker
            .resolve("s1", &request_id, &json!([["Blue"]]))
            .expect("still pending");
        let answer = asking.await.expect("returns").expect("a result");
        assert_eq!(answer, "Color?：Blue");
    }

    #[tokio::test]
    async fn a_single_choice_question_rejects_two_answers_and_keeps_the_card() {
        let (tool, broker, _sink) = tool();
        let cancel = CancelToken::new();
        let asking = tokio::spawn({
            let cancel = cancel.clone();
            let call =
                call(json!({"questions": [{"question": "Color?", "options": ["Blue", "Green"]}]}));
            async move { tool.call(&call, &context(cancel)).await }
        });
        let mut request_id = String::new();
        for _ in 0..200 {
            if let Some(entry) = broker.pending.lock().unwrap().keys().next() {
                request_id = entry.clone();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let error = broker
            .resolve("s1", &request_id, &json!([["Blue", "Green"]]))
            .expect_err("refused");
        assert_eq!(error.code(), "ASKTOOL_INVALID_ARGUMENT");
        assert_eq!(error.message(), "asktool question 1 accepts one answer");
        assert_eq!(broker.pending_count(), 1, "a bad answer is not a decision");
        broker
            .resolve("s1", &request_id, &json!([["Blue", "Blue"]]))
            .expect("duplicates collapse to one answer");
        let answer = asking.await.expect("returns").expect("a result");
        assert_eq!(answer, "Color?：Blue");
    }

    #[tokio::test]
    async fn a_multi_select_question_accepts_several_answers() {
        let (tool, broker, _sink) = tool();
        let cancel = CancelToken::new();
        let asking = tokio::spawn({
            let cancel = cancel.clone();
            let call = call(
                json!({"questions": [{"question": "Platforms?", "options": ["Web", "Desktop"], "multiSelect": true}]}),
            );
            async move { tool.call(&call, &context(cancel)).await }
        });
        let mut request_id = String::new();
        for _ in 0..200 {
            if let Some(entry) = broker.pending.lock().unwrap().keys().next() {
                request_id = entry.clone();
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        broker
            .resolve("s1", &request_id, &json!([["Web", "Desktop"]]))
            .expect("both answers accepted");
        let answer = asking.await.expect("returns").expect("a result");
        assert_eq!(answer, "Platforms?：Web、Desktop");
    }

    #[test]
    fn an_unknown_request_is_not_found() {
        let (_tool, broker, _sink) = tool();
        let error = broker
            .resolve("s1", "nope", &json!([]))
            .expect_err("refused");
        assert_eq!(error.code(), "ASKTOOL_NOT_FOUND");
        assert_eq!(error.message(), "asktool request is no longer pending");
    }

    #[test]
    fn the_wire_shape_of_a_request_matches_the_renderer() {
        let request = AskRequest {
            request_id: "r1".into(),
            session_id: "s1".into(),
            tool_call_id: "c1".into(),
            questions: vec![AskQuestion {
                question: "Q?".into(),
                options: vec![AskOption {
                    label: "A".into(),
                    description: Some("d".into()),
                }],
                multi_select: true,
            }],
        };
        let value = serde_json::to_value(&request).expect("serializes");
        assert_eq!(value["requestId"], "r1");
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["toolCallId"], "c1");
        assert_eq!(value["questions"][0]["multiSelect"], true);
        assert_eq!(value["questions"][0]["options"][0]["description"], "d");

        let single = AskRequest {
            questions: vec![AskQuestion {
                question: "Q?".into(),
                options: vec![AskOption {
                    label: "A".into(),
                    description: None,
                }],
                multi_select: false,
            }],
            ..request
        };
        let value = serde_json::to_value(&single).expect("serializes");
        assert!(
            value["questions"][0].get("multiSelect").is_none(),
            "absent means single choice, which is what the renderer reads"
        );
        assert!(value["questions"][0]["options"][0]
            .get("description")
            .is_none());
    }
}
