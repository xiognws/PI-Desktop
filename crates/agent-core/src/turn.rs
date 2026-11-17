//! The turn loop.
//!
//! Hermes counterpart: `agent/conversation_loop.py` plus `turn_context.py`.
//! One *turn* is one user request; inside it the loop may take several *steps*,
//! each one provider request followed by the tool calls it asked for. The loop
//! ends when the model answers without calling a tool, when the step budget is
//! exhausted, or when the turn is cancelled.
//!
//! Responsibilities kept here on purpose:
//! * ordering of the events the renderer sees;
//! * transcript mutation (assistant message, then one result per call);
//! * pairing repair before every provider request;
//! * cancellation and the step budget.
//!
//! Responsibilities deliberately *not* here: retry/backoff policy, compaction,
//! prompt composition, subagents. Each arrives with its own subsystem so this
//! function stays readable.

use std::sync::Arc;

use crate::cancel::CancelToken;
use crate::error::{AgentError, Result};
use crate::event::{AgentEvent, AgentEventEnvelope, EventSink};
use crate::message::{ContentPart, Message, Role, StopReason, Usage};
use crate::provider::{ChatRequest, Provider, ResponseAssembler, StreamEvent, ThinkingLevel};
use crate::session::Transcript;
use crate::tool::{ToolContext, ToolRegistry};

#[derive(Debug, Clone)]
pub struct TurnConfig {
    pub model: String,
    pub system: Option<String>,
    /// Provider requests per turn. A tool-heavy turn needs a handful; the
    /// ceiling exists so a looping model cannot burn the budget forever.
    pub max_steps: usize,
    pub temperature: Option<f32>,
    pub max_output_tokens: Option<u32>,
    pub thinking: ThinkingLevel,
}

impl TurnConfig {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system: None,
            max_steps: 24,
            temperature: None,
            max_output_tokens: None,
            thinking: ThinkingLevel::Off,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnOutcome {
    /// Messages this turn added to the transcript, in order.
    pub message_ids: Vec<String>,
    pub usage: Usage,
    pub steps: usize,
    pub stop_reason: StopReason,
}

pub struct TurnEngine {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    sink: Arc<dyn EventSink>,
}

impl TurnEngine {
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            provider,
            tools,
            sink,
        }
    }

    fn emit(&self, session_id: &str, turn_id: &str, event: AgentEvent) {
        self.sink
            .emit(AgentEventEnvelope::new(session_id, turn_id, event));
    }

    pub async fn run_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        transcript: &mut Transcript,
        config: &TurnConfig,
        cancel: CancelToken,
    ) -> Result<TurnOutcome> {
        self.emit(session_id, turn_id, AgentEvent::AgentStart);

        let repaired = transcript.repair_tool_pairs();
        if repaired.repaired_anything() {
            tracing::debug!(
                target: "agent_core::turn",
                synthesized = repaired.synthesized_results,
                orphan = repaired.dropped_orphan_results,
                duplicate = repaired.dropped_duplicate_results,
                "repaired tool pairing before the request"
            );
        }

        self.emit(session_id, turn_id, AgentEvent::TurnStart);

        let mut total_usage = Usage::default();
        let mut added_ids: Vec<String> = Vec::new();
        let mut stop_reason: Option<StopReason> = None;
        let mut steps_taken = 0usize;

        for step in 0..config.max_steps {
            steps_taken += 1;
            if cancel.is_cancelled() {
                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::Error {
                        code: AgentError::Cancelled.code().into(),
                        message: AgentError::Cancelled.to_string(),
                    },
                );
                return Err(AgentError::Cancelled);
            }

            let mut request = ChatRequest::new(&config.model, transcript.messages().to_vec());
            request.system = config.system.clone();
            request.tools = self.tools.specs();
            request.temperature = config.temperature;
            request.max_output_tokens = config.max_output_tokens;
            request.thinking = config.thinking;

            let assembled = match self.run_step(session_id, turn_id, request, &cancel).await {
                Ok(assembled) => assembled,
                Err(error) => {
                    self.emit(
                        session_id,
                        turn_id,
                        AgentEvent::Error {
                            code: error.code().into(),
                            message: error.to_string(),
                        },
                    );
                    return Err(error);
                }
            };

            total_usage.merge(&assembled.usage);
            transcript.push(assembled.message.clone());
            added_ids.push(assembled.message.id.clone());

            let calls = assembled.message.tool_calls();
            if calls.is_empty() {
                stop_reason = Some(assembled.stop_reason);
                break;
            }

            self.emit(
                session_id,
                turn_id,
                AgentEvent::Usage {
                    usage: assembled.usage,
                },
            );

            for call in calls {
                let call = call.clone();
                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::ToolStart {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    },
                );

                let ctx = ToolContext {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    tool_call_id: call.id.clone(),
                    cancel: cancel.clone(),
                };
                let result = self.tools.call(&call, &ctx).await;

                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::ToolEnd {
                        tool_call_id: result.call_id.clone(),
                        result: serde_json::json!({
                            "content": result.content,
                            "truncated": result.truncated,
                        }),
                        is_error: result.is_error,
                    },
                );

                let message = Message::tool_result(result);
                added_ids.push(message.id.clone());
                transcript.push(message);
            }

            if step + 1 == config.max_steps {
                let error = AgentError::StepLimit {
                    limit: config.max_steps,
                };
                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::Error {
                        code: error.code().into(),
                        message: error.to_string(),
                    },
                );
                return Err(error);
            }
        }

        // A provider that answers with nothing at all is not a completed turn:
        // the silent-turn recovery of `agent/turn_recovery.py` replaces this
        // error once retry policies migrate.
        if added_ids.is_empty() {
            let error = AgentError::Invalid("provider returned no assistant message".into());
            self.emit(
                session_id,
                turn_id,
                AgentEvent::Error {
                    code: error.code().into(),
                    message: error.to_string(),
                },
            );
            return Err(error);
        }

        self.emit(
            session_id,
            turn_id,
            AgentEvent::Usage { usage: total_usage },
        );
        self.emit(session_id, turn_id, AgentEvent::TurnEnd);
        self.emit(
            session_id,
            turn_id,
            AgentEvent::AgentEnd {
                message_ids: added_ids.clone(),
            },
        );

        Ok(TurnOutcome {
            message_ids: added_ids,
            usage: total_usage,
            steps: steps_taken,
            stop_reason: stop_reason.unwrap_or(StopReason::EndTurn),
        })
    }

    /// One provider request: stream deltas to the renderer, then return the
    /// assembled assistant message.
    async fn run_step(
        &self,
        session_id: &str,
        turn_id: &str,
        request: ChatRequest,
        cancel: &CancelToken,
    ) -> Result<crate::provider::AssembledResponse> {
        let mut stream = self.provider.stream(request, cancel.clone()).await?;
        let mut assembler = ResponseAssembler::new();
        let mut live = Message::new(Role::Assistant);
        let mut started = false;

        loop {
            let next = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                event = stream.next() => event,
            };
            let Some(event) = next else {
                break;
            };

            match &event {
                StreamEvent::TextDelta(delta) => {
                    live.push_text(delta);
                    if !started {
                        started = true;
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageStart {
                                message: live.clone(),
                            },
                        );
                    }
                    self.emit(
                        session_id,
                        turn_id,
                        AgentEvent::MessageUpdate {
                            message: live.clone(),
                            delta_text: Some(delta.clone()),
                            delta_thinking: None,
                            stream: Some("delta".into()),
                        },
                    );
                }
                StreamEvent::ThinkingDelta(delta) => {
                    live.push_thinking(delta);
                    if !started {
                        started = true;
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageStart {
                                message: live.clone(),
                            },
                        );
                    }
                    self.emit(
                        session_id,
                        turn_id,
                        AgentEvent::MessageUpdate {
                            message: live.clone(),
                            delta_text: None,
                            delta_thinking: Some(delta.clone()),
                            stream: Some("delta".into()),
                        },
                    );
                }
                _ => {}
            }

            assembler.push(event)?;
        }

        let mut assembled = assembler.finish()?;
        // One row identity for the whole step: the streamed message and the
        // stored message must be the same id, or the renderer keeps a ghost.
        if started {
            assembled.message.id = live.id.clone();
        }
        self.emit(
            session_id,
            turn_id,
            AgentEvent::MessageEnd {
                message: assembled.message.clone(),
            },
        );
        Ok(assembled)
    }
}

/// Convenience accessor used by the self-check and by tests.
pub fn assistant_text(transcript: &Transcript) -> Option<String> {
    transcript
        .messages()
        .iter()
        .rev()
        .find(|message| message.role == Role::Assistant)
        .map(|message| {
            message
                .parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect()
        })
}
