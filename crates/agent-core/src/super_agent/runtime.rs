//! Turning a decision into a turn.
//!
//! The supervisor decides; this module makes the two model calls it needs. Both
//! sit on the kernel's existing provider handle and turn engine, so a worker is a
//! real agent turn — transcript repair, tool execution, compaction, cancellation —
//! and not a second, thinner implementation of one.
//!
//! * [`TurnRouter`] asks for one batch decision: no tools, JSON answer, parsed by
//!   [`super::router::parse_router_decisions`].
//! * [`TurnWorker`] runs one worker turn in a transcript of its own, with the
//!   worker's own cancel token, and returns the final message as the report.

use std::sync::Arc;

use crate::cancel::CancelToken;
use crate::context::{ContextLimits, ModelLimits};
use crate::error::{AgentError, Result};
use crate::event::EventSink;
use crate::message::{Message, Usage};
use crate::provider::{CacheRetention, ChatRequest, Provider, ResponseAssembler};
use crate::session::Transcript;
use crate::tool::ToolRegistry;
use crate::turn::{assistant_text, TurnConfig, TurnEngine};

use super::router::parse_router_decisions;
use super::worker::{WorkerSpec, WorkerStatus};
use super::RouterBatch;

/// What a worker is told about its own place in the system.
///
/// Three rules earn their space: it does not talk to people (that is the router's
/// job), its last message *is* the report, and an unverified claim is worse than an
/// unfinished one.
pub fn compose_worker_system_prompt(spec: &WorkerSpec) -> String {
    let tools = match &spec.tools {
        Some(tools) if !tools.is_empty() => format!(
            "\nTools you may use: {}. A capability that is not on this list is not yours to reach.",
            tools.join(", ")
        ),
        _ => String::new(),
    };
    format!(
        "You are {}, a worker of one supervisor.\n\
Mission: {}\n\
Another session — the router — is the only one that talks to people. You report to it and never to a person.\n\
You own one thread. The events of that thread reach you directly; earlier context is inlined with them, and anything older can be recalled by id.\n\
Rules:\n\
- Your final message is the report the router reads: what you changed, what you verified, and what remains.\n\
- Never claim a result you did not verify. A failure reported as a failure is useful; a draft described as finished is not.\n\
- Stop by impact, not by effort: a local change goes as far as a reviewable result, a design decision stops with a clear question.{tools}"
        , spec.name, spec.mission, tools = tools
    )
}

/// What one batch decision cost and produced.
///
/// The usage is part of the answer rather than a side channel: a supervisor that
/// cannot price its own router request cannot enforce a budget on it.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutedDecisions {
    pub decisions: Vec<super::router::RouterDecision>,
    pub usage: Usage,
}

/// The router's decision path: one provider request per batch, no tools.
pub struct TurnRouter {
    provider: Arc<dyn Provider>,
    model: String,
}

impl TurnRouter {
    pub fn new(provider: Arc<dyn Provider>, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Ask for the batch decision and parse it. A refusal comes back as an
    /// [`AgentError::Refused`] carrying the sentence the model needs to answer
    /// again.
    pub async fn decide(
        &self,
        batch: &RouterBatch,
        cancel: &CancelToken,
    ) -> Result<RoutedDecisions> {
        let mut request =
            ChatRequest::new(&self.model, vec![Message::user_text(batch.prompt.clone())]);
        request.system = Some(batch.system.clone());
        request.tools = Vec::new();
        // A router prompt is never re-sent unchanged: caching it would pay the
        // write premium for a prefix that does not repeat.
        request.cache = CacheRetention::None;

        let mut stream = self.provider.stream(request, cancel.clone()).await?;
        let mut assembler = ResponseAssembler::new();
        while let Some(event) = stream.next().await {
            if cancel.is_cancelled() {
                return Err(AgentError::Cancelled);
            }
            assembler.push(event)?;
        }
        let assembled = assembler.finish()?;
        let decisions = parse_router_decisions(&assembled.message.text())?;
        Ok(RoutedDecisions {
            decisions,
            usage: assembled.usage,
        })
    }
}

/// One worker turn.
#[derive(Debug, Clone)]
pub struct WorkerRunRequest {
    /// The worker's own session. Isolated from the router's transcript, which is
    /// what keeps several tasks from interleaving their intermediate detail.
    pub session_id: String,
    pub worker_id: String,
    pub spec: WorkerSpec,
    /// The inline block for the thread: recent events, older ones named by id.
    pub context: Option<String>,
    /// The event that woke the worker: summary plus the body it can afford.
    pub event: String,
    pub cancel: CancelToken,
    /// Steps for this turn; `0` keeps the engine's default.
    pub max_steps: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkerOutcome {
    pub status: WorkerStatus,
    pub report: String,
    pub turns: u32,
    pub tool_calls: u32,
    pub usage: Usage,
}

impl WorkerOutcome {
    pub fn is_failure(&self) -> bool {
        self.status == WorkerStatus::Failed
    }
}

pub struct TurnWorker {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    sink: Arc<dyn EventSink>,
    config: TurnConfig,
    model_limits: Option<ModelLimits>,
    repeats: crate::tool_use::RepeatPolicy,
}

impl TurnWorker {
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        sink: Arc<dyn EventSink>,
        config: TurnConfig,
    ) -> Self {
        Self {
            provider,
            tools,
            sink,
            config,
            model_limits: None,
            repeats: crate::tool_use::RepeatPolicy::default(),
        }
    }

    /// Which tools a repeated call may reuse an answer from. A host whose tool
    /// names differ (`read_file`, `grep`) gets suppression only if it says so —
    /// [`crate::tool_use::RepeatPolicy::for_tools`] is the adapter.
    pub fn with_repeat_policy(mut self, policy: crate::tool_use::RepeatPolicy) -> Self {
        self.repeats = policy;
        self
    }

    /// Attach the model's context facts, which enables compaction inside a long
    /// worker turn instead of letting it grow past the window.
    pub fn with_model_limits(mut self, limits: ModelLimits) -> Self {
        self.model_limits = Some(limits);
        self
    }

    pub fn context_limits(&self) -> Option<ContextLimits> {
        self.model_limits.map(ContextLimits::for_model)
    }

    /// Run the worker turn and return what the router will read.
    ///
    /// A cancelled turn is `stopped`, a provider or tool-level failure is `failed`
    /// with the error in the report — the router needs the reason to decide
    /// between a retry and a different approach.
    pub async fn run(&self, request: WorkerRunRequest) -> WorkerOutcome {
        let user = match &request.context {
            Some(context) => format!("{context}\n\n## new event\n{}", request.event),
            None => request.event.clone(),
        };
        let mut transcript = Transcript::from_messages(vec![Message::user_text(user)]);

        let mut config = self.config.clone();
        config.system = Some(compose_worker_system_prompt(&request.spec));
        if request.max_steps > 0 {
            config.max_steps = request.max_steps;
        }

        let engine = TurnEngine::new(self.provider.clone(), self.tools.clone(), self.sink.clone());
        let engine = match self.model_limits {
            Some(limits) => engine.with_model_limits(limits),
            None => engine,
        };
        // A worker has no reason to read the same file twice in one turn: the second
        // read is a model that forgot it already has the answer, and paying for it
        // again is the fastest way to burn a worker's step budget.
        let engine = engine.with_repeat_suppression(self.repeats.clone());
        let turn_id = format!("{}-turn", request.worker_id);

        match engine
            .run_turn(
                &request.session_id,
                &turn_id,
                &mut transcript,
                &config,
                request.cancel.clone(),
            )
            .await
        {
            Ok(outcome) => {
                let report = assistant_text(&transcript).unwrap_or_else(|| {
                    "(the worker finished without a message, so there is nothing to report)".into()
                });
                WorkerOutcome {
                    status: WorkerStatus::Settled,
                    report,
                    turns: outcome.steps as u32,
                    tool_calls: outcome.tool_calls as u32,
                    usage: outcome.usage,
                }
            }
            Err(AgentError::Cancelled) => WorkerOutcome {
                status: WorkerStatus::Stopped,
                report: "stopped before it finished; nothing was verified".into(),
                turns: 0,
                tool_calls: 0,
                usage: Usage::default(),
            },
            Err(error) => WorkerOutcome {
                status: WorkerStatus::Failed,
                report: format!("{}: {error}", error.code()),
                turns: 0,
                tool_calls: 0,
                usage: Usage::default(),
            },
        }
    }
}

/// A background job that is one provider request.
///
/// This is the shape an asynchronous tool takes in this kernel: the model asks for
/// work it does not want to wait for (`start`, not `wait`), the call returns at
/// once, and the answer arrives later as a trigger on the same thread. No tools are
/// offered — a background run that could call tools would need its own approval
/// path, and that is a worker, not an async step.
pub struct PromptRunner {
    provider: Arc<dyn Provider>,
    model: String,
    system: Option<String>,
}

impl PromptRunner {
    pub fn new(provider: Arc<dyn Provider>, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            system: None,
        }
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }
}

impl super::async_task::AsyncRunner for PromptRunner {
    fn run<'a>(
        &'a self,
        request: super::async_task::AsyncRequest,
    ) -> crate::provider::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let mut chat = ChatRequest::new(&self.model, vec![Message::user_text(request.prompt)]);
            chat.system = self.system.clone();
            chat.cache = CacheRetention::None;
            let mut stream = self.provider.stream(chat, CancelToken::new()).await?;
            let mut assembler = ResponseAssembler::new();
            while let Some(event) = stream.next().await {
                assembler.push(event)?;
            }
            let assembled = assembler.finish()?;
            let text = assembled.message.text();
            if text.trim().is_empty() {
                return Err(AgentError::Invalid(
                    "the background run returned nothing".into(),
                ));
            }
            Ok(text)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::ToolCall;
    use crate::provider::scripted::ScriptedProvider;
    use crate::provider::StreamEvent;
    use crate::tool::{AllowAll, Tool, ToolContext, ToolSpec};
    use crate::{RecordingSink, StopReason};
    use serde_json::Value;

    struct EchoTool;

    impl Tool for EchoTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new("echo", "Echo text", serde_json::json!({"type": "object"}))
        }

        fn call<'a>(
            &'a self,
            call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> crate::provider::BoxFuture<'a, Result<String>> {
            Box::pin(async move {
                Ok(format!(
                    "echo: {}",
                    call.arguments
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                ))
            })
        }
    }

    fn answer(text: &str) -> Vec<StreamEvent> {
        vec![
            StreamEvent::TextDelta(text.into()),
            StreamEvent::Finish(StopReason::EndTurn),
        ]
    }

    fn registry() -> Arc<ToolRegistry> {
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(EchoTool));
        Arc::new(registry)
    }

    fn worker(provider: Arc<dyn Provider>) -> TurnWorker {
        TurnWorker::new(
            provider,
            registry(),
            Arc::new(RecordingSink::new()),
            TurnConfig::new("test-model"),
        )
    }

    fn request() -> WorkerRunRequest {
        WorkerRunRequest {
            session_id: "router-1#worker-1".into(),
            worker_id: "worker-1".into(),
            spec: WorkerSpec::new("fix-ci", "make main green"),
            context: Some("## thread github:acme/web#pr-12\n2 older events".into()),
            event: "build failed on main".into(),
            cancel: CancelToken::new(),
            max_steps: 0,
        }
    }

    #[tokio::test]
    async fn a_worker_turn_answers_with_its_final_message_as_the_report() {
        let provider = Arc::new(ScriptedProvider::new(vec![answer(
            "fixed it: src/main.rs:12",
        )]));
        let outcome = worker(provider.clone()).run(request()).await;
        assert_eq!(outcome.status, WorkerStatus::Settled);
        assert!(outcome.report.contains("src/main.rs:12"));
        assert_eq!(outcome.turns, 1);

        let sent = provider.requests();
        assert_eq!(sent.len(), 1);
        let system = sent[0].system.clone().unwrap_or_default();
        assert!(system.contains("fix-ci"), "{system}");
        assert!(system.contains("never to a person"));
        let user = sent[0].messages[0].text();
        assert!(user.contains("## thread github:acme/web#pr-12"));
        assert!(user.contains("build failed on main"));
    }

    #[tokio::test]
    async fn a_worker_can_use_a_tool_and_still_reports_once() {
        let provider = Arc::new(ScriptedProvider::new(vec![
            vec![
                StreamEvent::ToolCallStart {
                    index: 0,
                    id: "call_1".into(),
                    name: "echo".into(),
                },
                StreamEvent::ToolCallDelta {
                    index: 0,
                    arguments_delta: "{\"text\":\"hi\"}".into(),
                },
                StreamEvent::Finish(StopReason::ToolUse),
            ],
            answer("the echo said hi"),
        ]));
        let outcome = worker(provider).run(request()).await;
        assert_eq!(outcome.status, WorkerStatus::Settled);
        assert_eq!(outcome.tool_calls, 1);
        assert_eq!(outcome.turns, 2);
    }

    #[tokio::test]
    async fn a_worker_does_not_pay_twice_for_the_same_read() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct CountingRead(Arc<AtomicUsize>);

        impl Tool for CountingRead {
            fn spec(&self) -> ToolSpec {
                ToolSpec::new(
                    "Read",
                    "Read a file.",
                    serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}}),
                )
            }

            fn call<'a>(
                &'a self,
                call: &'a ToolCall,
                _ctx: &'a ToolContext,
            ) -> crate::provider::BoxFuture<'a, Result<String>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    let path = call
                        .arguments
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("file");
                    Ok(format!("contents of {path}"))
                })
            }
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(ScriptedProvider::new(vec![
            vec![
                StreamEvent::ToolCallStart {
                    index: 0,
                    id: "call_1".into(),
                    name: "Read".into(),
                },
                StreamEvent::ToolCallDelta {
                    index: 0,
                    arguments_delta: "{\"path\":\"a.rs\"}".into(),
                },
                StreamEvent::Finish(StopReason::ToolUse),
            ],
            vec![
                StreamEvent::ToolCallStart {
                    index: 0,
                    id: "call_2".into(),
                    name: "Read".into(),
                },
                StreamEvent::ToolCallDelta {
                    index: 0,
                    arguments_delta: "{\"path\":\"a.rs\"}".into(),
                },
                StreamEvent::Finish(StopReason::ToolUse),
            ],
            answer("read it once"),
        ]));
        let mut registry = ToolRegistry::new(Arc::new(AllowAll));
        registry.register(Arc::new(CountingRead(calls.clone())));
        let worker = TurnWorker::new(
            provider,
            Arc::new(registry),
            Arc::new(RecordingSink::new()),
            TurnConfig::new("test-model"),
        );
        let outcome = worker.run(request()).await;
        assert_eq!(outcome.status, WorkerStatus::Settled);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the second read was reused"
        );
        assert_eq!(outcome.tool_calls, 2, "both calls are still recorded");
    }

    #[tokio::test]
    async fn a_cancelled_worker_is_stopped_rather_than_failed() {
        let provider = Arc::new(ScriptedProvider::new(vec![answer("never seen")]));
        let request = request();
        request.cancel.cancel();
        let outcome = worker(provider).run(request).await;
        assert_eq!(outcome.status, WorkerStatus::Stopped);
        assert!(outcome.report.contains("stopped"));
    }

    #[tokio::test]
    async fn a_provider_failure_becomes_a_failed_report_with_its_code() {
        let provider = Arc::new(ScriptedProvider::new(Vec::new()));
        let outcome = worker(provider).run(request()).await;
        assert_eq!(outcome.status, WorkerStatus::Failed);
        assert!(
            outcome.report.contains("PROVIDER_ERROR"),
            "{}",
            outcome.report
        );
    }

    #[tokio::test]
    async fn the_router_decision_is_parsed_from_the_model_answer() {
        let provider = Arc::new(ScriptedProvider::new(vec![answer(
            r#"{"decisions":[{"triggerIds":["feishu:dev#m-1"],"action":"dispatch","worker":{"name":"fix-ci","mission":"make it green"},"reason":"nobody owns it"}]}"#,
        )]));
        let router = TurnRouter::new(provider.clone(), "test-model");
        let batch = RouterBatch {
            triggers: Vec::new(),
            system: "router".into(),
            prompt: "decide these".into(),
        };
        let decisions = router.decide(&batch, &CancelToken::new()).await.unwrap();
        assert_eq!(decisions.decisions.len(), 1);
        assert_eq!(decisions.decisions[0].trigger_ids, vec!["feishu:dev#m-1"]);
        // The router request carries no tool declarations: the answer is text.
        assert!(provider.requests()[0].tools.is_empty());
        assert_eq!(provider.requests()[0].system.as_deref(), Some("router"));
    }

    #[tokio::test]
    async fn a_router_answer_that_cannot_be_applied_is_a_refusal() {
        let provider = Arc::new(ScriptedProvider::new(vec![answer("let us fix it")]));
        let router = TurnRouter::new(provider, "test-model");
        let batch = RouterBatch {
            triggers: Vec::new(),
            system: "router".into(),
            prompt: "decide these".into(),
        };
        let error = router
            .decide(&batch, &CancelToken::new())
            .await
            .unwrap_err();
        assert_eq!(error.code(), "TOOL_REFUSED");
        assert!(error.to_string().contains("JSON"));
    }
}
