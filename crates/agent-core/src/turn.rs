//! The turn loop.
//!
//! Upstream counterpart: `agent/conversation_loop.py` plus `turn_context.py`.
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

use crate::budget::{BudgetDecision as RunBudgetDecision, BudgetMeter, RunBudget};
use crate::cancel::CancelToken;
use crate::compaction::{
    build_summary_request, checkpoint_message, chunk_summary_input, plan_compaction,
    reduce_summary_input, retained_tail_fallback, CompactionMode, SummaryInput,
    COMPACTION_SUMMARY_MAX_RETRIES, COMPACTION_SUMMARY_RETRY_BASE_MS, RETAINED_TAIL_NOTICE,
};
use crate::context::{estimate_context_tokens, BudgetDecision, ContextLimits, ModelLimits};
use crate::delegate::{pending_delegations, DelegationRegistry};
use crate::error::{AgentError, Result};
use crate::event::{
    AgentEvent, AgentEventEnvelope, CompactionFailure, CompactionFallback, CompactionReason,
    EventSink,
};
use crate::message::{ContentPart, Message, Role, StopReason, ToolCall, ToolResult, Usage};
use crate::provider::{
    CacheRetention, ChatRequest, Provider, ResponseAssembler, StreamEvent, ThinkingLevel,
};
use crate::session::Transcript;
use crate::tool::{ToolContext, ToolRegistry};
use crate::verify::{CompletionPolicy, CompletionTracker, GateVerdict, VERIFICATION_NUDGE};

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
    /// Retry a transient provider failure without a budget.
    ///
    /// A session that opts in keeps waiting through an outage instead of ending
    /// the turn; the default is bounded, because a turn that never gives up is
    /// indistinguishable from a hung app.
    pub infinite_provider_retry: bool,
    /// Whether the main-line request asks the provider to cache its prefix.
    pub cache: CacheRetention,
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
            infinite_provider_retry: false,
            cache: CacheRetention::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnOutcome {
    /// Messages this turn added to the transcript, in order.
    pub message_ids: Vec<String>,
    pub usage: Usage,
    pub steps: usize,
    /// Tool calls this turn executed. The background skill review is gated on
    /// this: a turn that only talked taught nothing worth a completion.
    pub tool_calls: usize,
    pub stop_reason: StopReason,
    /// The turn ended at a boundary the user asked for (`agent.stop`), not
    /// because the model finished. `stop_reason` still reports what the last
    /// assistant message said — usually `ToolUse` — so this flag is what tells a
    /// graceful stop apart from a completed answer, and from a failed turn
    /// (`Err`), which is what `agent.abort` produces.
    pub graceful_stop: bool,
}

/// Where a running turn looks for messages the user sent while it was working.
/// The sidecar owns the queue; the loop only drains it, which keeps the loop
/// free of RPC concerns and testable with a plain vector.
pub use crate::steering::SteeringSource;

/// The ambient state one turn runs under: what to ask the provider for and how
/// the caller stops it. They travel together through compaction, which needs
/// both and nothing else from the turn.
pub struct TurnRun<'a> {
    pub config: &'a TurnConfig,
    pub cancel: &'a CancelToken,
}

pub struct TurnEngine {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    sink: Arc<dyn EventSink>,
    steering: Option<Arc<dyn SteeringSource>>,
    /// Context budget for the model this turn targets. Without it the loop
    /// never compacts: a caller that does not know the window cannot be told
    /// its request was too large.
    model_limits: Option<ModelLimits>,
    /// Durable memories relevant to this turn's prompt. Prepended to the user
    /// message while a request is built, never written into the transcript: the
    /// row the UI shows stays exactly what the user typed.
    memory_prefix: Option<String>,
    /// The session's delegations. When set, a delegate that is still working (or
    /// whose report nobody read yet) keeps the turn open until its report has
    /// been handed to the model.
    delegations: Option<Arc<DelegationRegistry>>,
    /// What this turn may spend. A `None` meter means the loop has no ceiling of
    /// its own and only the step budget applies.
    budget: Option<std::sync::Mutex<BudgetMeter>>,
    /// The definition-of-done gate: a turn that changed files without a check
    /// since is sent back once before it may report success.
    completion: Option<CompletionPolicy>,
    /// Repeat suppression: an identical read inside one turn reuses its earlier
    /// result instead of paying for it twice.
    repeats: Option<crate::tool_use::RepeatPolicy>,
    /// Run a step's independent calls concurrently. Off by default: a host that
    /// approves calls one by one wants them one at a time, and a log read in call
    /// order is easier to follow.
    parallel_tool_calls: bool,
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
            steering: None,
            model_limits: None,
            memory_prefix: None,
            delegations: None,
            budget: None,
            completion: None,
            repeats: None,
            parallel_tool_calls: false,
        }
    }

    /// Attach the queue a steer lands in. Without it the turn ignores steering
    /// entirely, which is what the self-check and the loop tests want.
    pub fn with_steering(mut self, source: Arc<dyn SteeringSource>) -> Self {
        self.steering = Some(source);
        self
    }

    /// Attach the model's context facts, which enables automatic compaction.
    pub fn with_model_limits(mut self, limits: ModelLimits) -> Self {
        self.model_limits = Some(limits);
        self
    }

    /// Attach the recalled memory block for this turn.
    pub fn with_memory_prefix(mut self, prefix: Option<String>) -> Self {
        self.memory_prefix = prefix;
        self
    }

    /// Attach the session's delegations, which lets a settled report resume the
    /// turn instead of waiting for the model to ask.
    pub fn with_delegations(mut self, delegations: Arc<DelegationRegistry>) -> Self {
        self.delegations = Some(delegations);
        self
    }

    /// Give this turn a spending ceiling. The warning at
    /// [`crate::budget::RunBudget::warn_at`] reaches the model as a steer, so it
    /// can wrap up instead of being cut off; the ceiling itself ends the turn.
    pub fn with_budget(mut self, budget: RunBudget) -> Self {
        self.budget = Some(std::sync::Mutex::new(BudgetMeter::new(budget)));
        self
    }

    /// Require a check after the last change before the turn may call itself done.
    pub fn with_completion(mut self, completion: CompletionPolicy) -> Self {
        self.completion = Some(completion);
        self
    }

    /// Reuse the earlier answer when the model repeats an identical read.
    pub fn with_repeat_suppression(mut self, policy: crate::tool_use::RepeatPolicy) -> Self {
        self.repeats = Some(policy);
        self
    }

    /// Run a step's independent calls concurrently.
    pub fn with_parallel_tool_calls(mut self, parallel: bool) -> Self {
        self.parallel_tool_calls = parallel;
        self
    }

    /// What the turn has spent so far, for a status panel.
    pub fn budget_summary(&self) -> Option<String> {
        self.budget
            .as_ref()
            .and_then(|meter| meter.lock().ok().map(|meter| meter.summary()))
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
        let mut tool_calls = 0usize;
        let mut added_ids: Vec<String> = Vec::new();
        let mut stop_reason: Option<StopReason> = None;
        let mut graceful_stop = false;
        let mut steps_taken = 0usize;
        // The definition-of-done tracker and the repeat cache live for exactly one
        // turn: both are about "what did this turn already do", and carrying either
        // across turns would be a cache with no expiry.
        let mut completion = self
            .completion
            .clone()
            .map(|policy| (policy, CompletionTracker::new()));
        let mut repeats = self.repeats.clone().map(crate::tool_use::RepeatGuard::new);

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

            // A steer the user sent while this turn was working becomes an
            // ordinary user row on the next step: the model sees it in the
            // request that follows, and the transcript keeps the order it was
            // typed in.
            if let Some(meter) = &self.budget {
                let decision = meter.lock().expect("budget meter poisoned").note_step();
                match decision {
                    RunBudgetDecision::Continue => {}
                    // The warning is a user row rather than a system note: it is
                    // in force for the rest of the turn, and a row is what the
                    // renderer already knows how to show.
                    RunBudgetDecision::Wrap { used, limit } => {
                        let message = Message::user_text(format!(
                            "[run budget] {used} of {limit} tokens used for this turn. Finish the current step and report; do not start new work."
                        ));
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageStart {
                                message: message.clone(),
                            },
                        );
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageEnd {
                                message: message.clone(),
                            },
                        );
                        added_ids.push(message.id.clone());
                        transcript.push(message);
                    }
                    RunBudgetDecision::Exhausted {
                        used,
                        limit,
                        reason,
                    } => {
                        let error = AgentError::Budget(format!(
                            "{used} of {limit} {} used",
                            reason.as_str()
                        ));
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
                self.emit_budget_status(session_id, turn_id, meter);
            }

            if let Some(steering) = &self.steering {
                for message in steering.drain() {
                    added_ids.push(message.id.clone());
                    transcript.push(message.clone());
                    self.emit(session_id, turn_id, AgentEvent::MessageEnd { message });
                }
            }

            // Compaction gate: a request at or above the hard boundary must not
            // be issued, and a session at the trigger compacts before it grows
            // further. Both run here, between steps, never on a background path.
            if let Some(model_limits) = self.model_limits {
                let limits = ContextLimits::for_model(model_limits);
                // Age first, then decide. A single oversized tool result is often the
                // whole overrun, and a summary cannot shrink it: the same bytes come
                // back on the next step and trigger another compaction, which is how a
                // turn ends up at `STEP_LIMIT` after five pointless summaries.
                let pre_aged = crate::aging::age_tool_results(
                    transcript.messages(),
                    Some(&limits),
                    crate::aging::ToolResultAging::default(),
                );
                let decision = limits.decide(estimate_context_tokens(&pre_aged.messages).tokens);
                if decision != BudgetDecision::Proceed {
                    let reason = match decision {
                        BudgetDecision::Overflow => CompactionReason::Overflow,
                        _ => CompactionReason::Threshold,
                    };
                    self.compact(
                        session_id,
                        turn_id,
                        transcript,
                        &limits,
                        reason,
                        TurnRun {
                            config,
                            cancel: &cancel,
                        },
                    )
                    .await?;
                }
            }

            let messages = match &self.memory_prefix {
                Some(prefix) => {
                    crate::memory_context::prepend_to_last_user(transcript.messages(), prefix)
                }
                None => transcript.messages().to_vec(),
            };
            // Old tool output is the bulk of a long session's history. It is aged
            // in the request only: the transcript keeps every byte, and a request
            // with room in the window is sent untouched so the cached prefix holds.
            let aging_limits = self.model_limits.map(ContextLimits::for_model);
            let aged = crate::aging::age_tool_results(
                &messages,
                aging_limits.as_ref(),
                crate::aging::ToolResultAging::default(),
            );
            if aged.changed() {
                tracing::debug!(
                    target: "agent_core::turn",
                    aged = aged.aged,
                    chars_elided = aged.chars_elided,
                    "aged old tool output for this request"
                );
            }
            let mut request = ChatRequest::new(&config.model, aged.messages);
            request.system = config.system.clone();
            request.tools = self.tools.specs();
            request.temperature = config.temperature;
            request.max_output_tokens = config.max_output_tokens;
            request.thinking = config.thinking;
            request.cache = config.cache;
            // A transient provider failure is not the end of the turn. Quota,
            // auth, a malformed request and a cancellation are terminal; a 502,
            // a dropped socket and a 429 are not, and re-sending the same request
            // is the whole recovery.
            let mut rate_limit_attempts: u32 = 0;
            let mut transient_attempts: u32 = 0;
            let assembled = loop {
                match self
                    .run_step(session_id, turn_id, request.clone(), &cancel)
                    .await
                {
                    Ok(assembled) => break assembled,
                    Err(error) => {
                        let Some(budget) = crate::retry::budget_for(&error) else {
                            self.emit(
                                session_id,
                                turn_id,
                                AgentEvent::Error {
                                    code: error.code().into(),
                                    message: error.to_string(),
                                },
                            );
                            return Err(error);
                        };
                        let used = match budget {
                            crate::retry::RetryBudget::RateLimit => &mut rate_limit_attempts,
                            crate::retry::RetryBudget::Transient => &mut transient_attempts,
                        };
                        if !config.infinite_provider_retry && *used >= budget.max_retries() {
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
                        *used += 1;
                        let retry_after = match &error {
                            AgentError::Provider { retry_after_ms, .. } => *retry_after_ms,
                            _ => None,
                        };
                        let wait = crate::retry::delay_ms(budget, *used, retry_after, jitter());
                        tracing::debug!(
                            target: "agent_core::turn",
                            attempt = *used,
                            budget = ?budget,
                            wait_ms = wait,
                            %error,
                            "retrying the provider request"
                        );
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => {
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
                            _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {}
                        }
                    }
                }
            };

            total_usage.merge(&assembled.usage);
            transcript.push(assembled.message.clone());
            added_ids.push(assembled.message.id.clone());
            // The ceiling is checked against what the provider *reported*, not an
            // estimate: the budget guards money, and money is billed by tokens.
            if let Some(meter) = &self.budget {
                let decision = meter
                    .lock()
                    .expect("budget meter poisoned")
                    .observe(&assembled.usage);
                if let RunBudgetDecision::Exhausted {
                    used,
                    limit,
                    reason,
                } = decision
                {
                    let error =
                        AgentError::Budget(format!("{used} of {limit} {} used", reason.as_str()));
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
                self.emit_budget_status(session_id, turn_id, meter);
            }

            let calls = assembled.message.tool_calls();
            if calls.is_empty() {
                // The model answered, but a delegate it started is still working
                // — or settled with a report nobody read. Keeping the turn open
                // is the difference between "the report arrives" and "the user
                // has to ask for it again" (ADR 0089 / D328).
                if self
                    .resume_after_delegations(
                        session_id,
                        turn_id,
                        transcript,
                        &cancel,
                        &mut added_ids,
                    )
                    .await?
                {
                    continue;
                }
                // Definition of done: a turn that changed files and has not run a
                // check since is sent back once. The gate fires at most once, so a
                // model that still refuses ends the turn instead of looping.
                if let Some((policy, tracker)) = completion.as_mut() {
                    if let GateVerdict::Nudge { reason } = tracker.verdict(policy) {
                        tracker.mark_nudged();
                        tracing::debug!(
                            target: "agent_core::turn",
                            %reason,
                            "sending the turn back for verification"
                        );
                        let message = Message::user_text(VERIFICATION_NUDGE);
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageStart {
                                message: message.clone(),
                            },
                        );
                        self.emit(
                            session_id,
                            turn_id,
                            AgentEvent::MessageEnd {
                                message: message.clone(),
                            },
                        );
                        added_ids.push(message.id.clone());
                        transcript.push(message);
                        continue;
                    }
                }
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

            let step_calls: Vec<ToolCall> = calls.into_iter().cloned().collect();
            for call in &step_calls {
                if let Some((policy, tracker)) = completion.as_mut() {
                    let policy = policy.clone();
                    tracker.record(&call.name, &call.arguments, &policy);
                }
                tool_calls += 1;
                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::ToolStart {
                        tool_call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        arguments: call.arguments.clone(),
                    },
                );
            }

            // The calls of one step were asked for together, so they run together
            // when the caller allowed it, and the results are recorded in call order
            // either way. A repeated read is answered from this turn's cache.
            let results = self
                .run_step_calls(session_id, turn_id, &step_calls, &cancel, repeats.as_mut())
                .await;

            for result in results {
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

            // `agent.stop` boundary: the assistant message that asked for these
            // calls is on the transcript and every call it asked for has its
            // result, so the step is finished — a boundary is exactly this point,
            // after the results and before the next request. Stopping here is what
            // makes the stop graceful: the tool that was already running ran to
            // completion (a cancel would have cut it off inside the registry), and
            // no further provider request is issued. The turn ends as an ordinary
            // turn with a distinguishable outcome rather than an error, because
            // nothing failed.
            if cancel.stop_requested() {
                tracing::debug!(
                    target: "agent_core::turn",
                    step,
                    tool_calls,
                    "stopping at the requested assistant boundary"
                );
                stop_reason = Some(assembled.stop_reason);
                graceful_stop = true;
                break;
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
            tool_calls,
            usage: total_usage,
            steps: steps_taken,
            stop_reason: stop_reason.unwrap_or(StopReason::EndTurn),
            graceful_stop,
        })
    }

    /// Publish the turn's spending through the `usage` event's sibling: the same
    /// `status` channel the session already uses, so a panel needs no new shape.
    fn emit_budget_status(
        &self,
        session_id: &str,
        turn_id: &str,
        meter: &std::sync::Mutex<BudgetMeter>,
    ) {
        let Ok(meter) = meter.lock() else {
            return;
        };
        self.emit(
            session_id,
            turn_id,
            AgentEvent::Status {
                status: serde_json::json!({
                    "sessionId": session_id,
                    "budget": {
                        "usedTokens": meter.used_tokens(),
                        "usedSteps": meter.used_steps(),
                        "maxTokens": meter.budget().max_tokens,
                        "maxSteps": meter.budget().max_steps,
                    },
                }),
            },
        );
    }

    /// Run one step's calls and return their results in call order.
    ///
    /// Two coordination rules live here: an identical read is answered from this
    /// turn's cache instead of being run again, and independent calls run
    /// concurrently when the caller allowed it. Either way the transcript gets one
    /// result per call in the order the model asked, because pairing is positional.
    async fn run_step_calls(
        &self,
        session_id: &str,
        turn_id: &str,
        calls: &[ToolCall],
        cancel: &CancelToken,
        mut repeats: Option<&mut crate::tool_use::RepeatGuard>,
    ) -> Vec<ToolResult> {
        let mut slots: Vec<Option<ToolResult>> = vec![None; calls.len()];
        let mut pending: Vec<(usize, ToolCall)> = Vec::new();

        for (index, call) in calls.iter().enumerate() {
            let cached = repeats
                .as_mut()
                .and_then(|guard| guard.previous(call).map(str::to_string));
            match cached {
                Some(content) => {
                    if let Some(guard) = repeats.as_mut() {
                        slots[index] = Some(guard.reuse(call, &content));
                    }
                }
                None => pending.push((index, call.clone())),
            }
        }

        if self.parallel_tool_calls && pending.len() > 1 {
            let mut set: tokio::task::JoinSet<(usize, ToolResult)> = tokio::task::JoinSet::new();
            for (index, call) in pending {
                let registry = self.tools.clone();
                let ctx = ToolContext {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    tool_call_id: call.id.clone(),
                    cancel: cancel.clone(),
                    steering: self.steering.clone(),
                };
                set.spawn(async move { (index, registry.call(&call, &ctx).await) });
            }
            while let Some(joined) = set.join_next().await {
                match joined {
                    Ok((index, result)) => slots[index] = Some(result),
                    Err(error) => tracing::debug!(
                        target: "agent_core::turn",
                        %error,
                        "a concurrent tool task ended abnormally"
                    ),
                }
            }
        } else {
            for (index, call) in pending {
                let ctx = ToolContext {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                    tool_call_id: call.id.clone(),
                    cancel: cancel.clone(),
                    steering: self.steering.clone(),
                };
                slots[index] = Some(self.tools.call(&call, &ctx).await);
            }
        }

        // A call whose task ended without a result still owes the model one: a
        // missing result breaks pairing, and a silent gap is worse than an error.
        let results: Vec<ToolResult> = calls
            .iter()
            .enumerate()
            .map(|(index, call)| match slots[index].take() {
                Some(result) => result,
                None => ToolResult {
                    call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: "the tool call produced no result (its task ended abnormally)".into(),
                    is_error: true,
                    truncated: false,
                },
            })
            .collect();

        if let Some(guard) = repeats.as_mut() {
            for (call, result) in calls.iter().zip(&results) {
                if !result.is_error {
                    guard.remember(call, &result.content);
                }
            }
        }
        results
    }

    /// Wait for this session's pending delegations and hand their reports to the
    /// model as one resumed user turn.
    ///
    /// Returns whether anything was delivered; `false` leaves the caller free to
    /// end the turn.
    async fn resume_after_delegations(
        &self,
        session_id: &str,
        turn_id: &str,
        transcript: &mut Transcript,
        cancel: &CancelToken,
        added_ids: &mut Vec<String>,
    ) -> Result<bool> {
        let Some(delegations) = &self.delegations else {
            return Ok(false);
        };
        let pending = pending_delegations(delegations);
        if pending.is_empty() {
            return Ok(false);
        }
        let running: Vec<String> = pending
            .iter()
            .filter(|view| !view.status.is_settled())
            .map(|view| view.delegation_id.clone())
            .collect();
        if !running.is_empty() {
            delegations.wait_until_settled(&running, cancel).await;
        }
        // A user Stop ends the turn; the delegates were cancelled with it.
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let after = pending_delegations(delegations);
        let settled: Vec<_> = after
            .iter()
            .filter(|view| view.status.is_settled() && view.report.is_some())
            .cloned()
            .collect();
        if settled.is_empty() {
            return Ok(false);
        }
        let still_running: Vec<_> = after
            .iter()
            .filter(|view| !view.status.is_settled())
            .cloned()
            .collect();
        let (text, delivered) = crate::delegate::format_resume_text(&settled, &still_running);
        // Marked before the request goes out: a report carried in this text must
        // never be delivered twice.
        delegations.mark_delivered(&delivered);
        let message = Message::user_text(text);
        self.emit(
            session_id,
            turn_id,
            AgentEvent::MessageStart {
                message: message.clone(),
            },
        );
        self.emit(
            session_id,
            turn_id,
            AgentEvent::MessageEnd {
                message: message.clone(),
            },
        );
        added_ids.push(message.id.clone());
        transcript.push(message);
        Ok(!delivered.is_empty())
    }

    /// Compact the transcript in place.
    ///
    /// Success installs the summary plus whatever the mode retains. A failed
    /// summary installs the retained-tail fallback instead — the turn continues,
    /// because a summary failure is not a reason to abandon the task — unless the
    /// context is *still* at the hard boundary afterwards, in which case the
    /// caller gets an error rather than a request the provider would reject.
    pub async fn compact(
        &self,
        session_id: &str,
        turn_id: &str,
        transcript: &mut Transcript,
        limits: &ContextLimits,
        reason: CompactionReason,
        run: TurnRun<'_>,
    ) -> Result<()> {
        self.emit(session_id, turn_id, AgentEvent::CompactionStart { reason });

        // Overflow happens mid-turn, so the current task's goal has to survive;
        // a threshold compaction at a turn boundary does not carry history.
        let mode = match reason {
            CompactionReason::Overflow => CompactionMode::ActiveTurn,
            _ => CompactionMode::CompletedTurn,
        };

        let tokens_before = estimate_context_tokens(transcript.messages()).tokens;
        let Some(plan) = plan_compaction(transcript.messages(), limits, mode) else {
            self.emit(
                session_id,
                turn_id,
                AgentEvent::CompactionEnd {
                    reason,
                    ok: false,
                    tokens_before: Some(tokens_before),
                    first_kept_message_id: None,
                    will_retry: false,
                    fallback: None,
                    error: Some(CompactionFailure {
                        code: "COMPACTION_NOTHING_TO_DO".into(),
                        message: "the transcript has no history to compact".into(),
                    }),
                },
            );
            return Ok(());
        };

        match self
            .run_summary(&plan.summary_input, limits, run.config, run.cancel)
            .await
        {
            Ok(summary) => {
                let mut messages = vec![checkpoint_message(&summary)];
                messages.extend(plan.retained.iter().cloned());
                let first_kept = messages.get(1).map(|message| message.id.clone());
                *transcript = Transcript::from_messages(messages);
                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::CompactionEnd {
                        reason,
                        ok: true,
                        tokens_before: Some(plan.tokens_before),
                        first_kept_message_id: first_kept,
                        will_retry: false,
                        fallback: None,
                        error: None,
                    },
                );
                Ok(())
            }
            Err(error) => {
                let tail = retained_tail_fallback(transcript.messages(), limits, mode);
                let mut messages = vec![Message::user_text(RETAINED_TAIL_NOTICE)];
                messages.extend(tail);
                let recovered = Transcript::from_messages(messages);
                let first_kept = recovered
                    .messages()
                    .get(1)
                    .map(|message| message.id.clone());
                let still_over = limits
                    .decide(estimate_context_tokens(recovered.messages()).tokens)
                    == BudgetDecision::Overflow;
                *transcript = recovered;

                self.emit(
                    session_id,
                    turn_id,
                    AgentEvent::CompactionEnd {
                        reason,
                        ok: false,
                        tokens_before: Some(tokens_before),
                        first_kept_message_id: first_kept,
                        // Only worth another attempt when the provider itself is
                        // the problem rather than the amount of context.
                        will_retry: !still_over,
                        fallback: Some(CompactionFallback::RetainedTail),
                        error: Some(CompactionFailure {
                            code: error.code().into(),
                            message: error.to_string(),
                        }),
                    },
                );

                if still_over {
                    let fatal = AgentError::Invalid(
                        "context is still above the hard limit after a retained-tail recovery"
                            .into(),
                    );
                    self.emit(
                        session_id,
                        turn_id,
                        AgentEvent::Error {
                            code: fatal.code().into(),
                            message: fatal.to_string(),
                        },
                    );
                    return Err(fatal);
                }
                Ok(())
            }
        }
    }

    /// Ask the provider for a summary: chunk first, reduce once if the chunks do
    /// not fit, and refuse rather than send a request that cannot succeed.
    async fn run_summary(
        &self,
        input: &SummaryInput,
        limits: &ContextLimits,
        config: &TurnConfig,
        cancel: &CancelToken,
    ) -> Result<String> {
        let chunks = chunk_summary_input(input, limits)
            .or_else(|| {
                reduce_summary_input(input)
                    .and_then(|reduced| chunk_summary_input(&reduced, limits))
            })
            .ok_or_else(|| {
                AgentError::Invalid("the summary input cannot be split into chunks that fit".into())
            })?;

        let mut parts = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            parts.push(self.summarize_once(chunk, config, cancel).await?);
        }
        let summary = parts.join("\n\n");
        if summary.trim().is_empty() {
            return Err(AgentError::Invalid(
                "the provider returned an empty summary".into(),
            ));
        }
        Ok(summary)
    }

    async fn summarize_once(
        &self,
        input: &SummaryInput,
        config: &TurnConfig,
        cancel: &CancelToken,
    ) -> Result<String> {
        let request = build_summary_request(input);
        let mut chat = ChatRequest::new(&config.model, vec![Message::user_text(request.user)]);
        chat.system = Some(request.system);
        // Nobody re-reads a summary request: caching it would pay the write
        // premium for a prefix that is never sent again.
        chat.cache = CacheRetention::None;

        let mut attempts = 0u32;
        loop {
            if cancel.is_cancelled() {
                return Err(AgentError::Cancelled);
            }
            let attempt: Result<String> = async {
                let mut stream = self.provider.stream(chat.clone(), cancel.clone()).await?;
                let mut assembler = ResponseAssembler::new();
                while let Some(event) = stream.next().await {
                    assembler.push(event)?;
                }
                Ok(assembler.finish()?.message.text())
            }
            .await;

            match attempt {
                Ok(text) if !text.trim().is_empty() => return Ok(text),
                Ok(_) => {
                    return Err(AgentError::Invalid(
                        "the provider returned an empty summary".into(),
                    ))
                }
                // Transient provider trouble is worth another request; quota,
                // auth and malformed requests are not.
                Err(error) if error.is_retryable() && attempts < COMPACTION_SUMMARY_MAX_RETRIES => {
                    attempts += 1;
                    let delay = std::time::Duration::from_millis(
                        COMPACTION_SUMMARY_RETRY_BASE_MS << (attempts - 1),
                    );
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                Err(error) => return Err(error),
            }
        }
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
        } else {
            // Nothing streamed, so the lazy `message_start` above never fired.
            // A message that only calls a tool is still a row the client has to
            // insert — the renderer creates it from this event, and without it
            // the tool call has no visible parent.
            self.emit(
                session_id,
                turn_id,
                AgentEvent::MessageStart {
                    message: assembled.message.clone(),
                },
            );
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

/// Jitter for the rate-limit curve, in `-1.0..=1.0`.
///
/// Wall-clock nanos rather than a random-number dependency: the point is only
/// that two clients retrying at the same moment do not do it in lockstep.
fn jitter() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or_default();
    (f64::from(nanos % 2_000) / 1_000.0) - 1.0
}
