//! A real end-to-end Super-agent run against a live provider.
//!
//! Two real model calls, in the two roles the supervisor has:
//!
//! 1. **the router** decides one batch of environment events (JSON, no tools);
//! 2. **the worker** it started does the work in an isolated session and reports
//!    to the router's inbox.
//!
//! Everything else — the trigger pipe, the program filter, dispatch, the report
//! path, the recall chain — is the kernel's own code, unchanged.
//!
//! ```text
//! SUPERAGENT_LIVE_BASE_URL=http://127.0.0.1:28787/v1 \
//! SUPERAGENT_LIVE_MODEL=wk-deepseek-v4.1-flash-011 \
//! SUPERAGENT_LIVE_API_KEY=... \
//!   cargo run --example superagent_live --offline
//! ```
//!
//! The defaults point at the local gateway, which needs no credential. Nothing
//! here writes anywhere: no store, no host calls, no files.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use agent_core::message::ToolCall;
use agent_core::provider::http::{HttpProvider, HttpProviderConfig};
use agent_core::super_agent::{
    RoutePolicy, Source, SourceKind, SuperAgent, SuperAgentConfig, ThreadKey, Trigger, TurnRouter,
    TurnWorker,
};
use agent_core::tool::{Tool, ToolContext, ToolRegistry, ToolSpec};
use agent_core::turn::TurnConfig;
use agent_core::{AllowAll, CancelToken, EventSink, RecordingSink};

/// The event's payload: a review comment asking something that can actually be
/// checked against the file it names. The worker reads the file and answers with a
/// citation; the router never sees the comment itself.
const REQUEST_BODY: &str = "\
Two things I need before I approve this:

1. `RepeatGuard` — does it evict oldest-first, and what is the hard ceiling on
   entries? Cite the code, not the doc comment.
2. Which tools does the policy cover by default, and why is `Bash` deliberately
   not one of them?

Answer with line-referenced facts. If the file does not answer something, say so
instead of guessing.";

/// The host's `Read` tool, stood up locally: in the real desktop the same call
/// travels over the host bridge, and the kernel sees only "a tool result".
///
/// The path is confined to this crate so the example cannot wander.
struct ReadTool {
    root: PathBuf,
}

impl Tool for ReadTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            "Read",
            "Read a file.",
            serde_json::json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> agent_core::provider::BoxFuture<'a, agent_core::Result<String>> {
        Box::pin(async move {
            let raw = call
                .arguments
                .get("path")
                .and_then(|value| value.as_str())
                .ok_or_else(|| {
                    agent_core::error::AgentError::Refused("`path` is required".into())
                })?;
            let path = self.root.join(raw);
            let canonical_root = self
                .root
                .canonicalize()
                .unwrap_or_else(|_| self.root.clone());
            let canonical =
                path.canonicalize()
                    .map_err(|error| agent_core::error::AgentError::Tool {
                        tool: "Read".into(),
                        message: format!("{raw}: {error}"),
                    })?;
            if !canonical.starts_with(canonical_root) {
                return Err(agent_core::error::AgentError::Refused(format!(
                    "`{raw}` is outside the workspace"
                )));
            }
            std::fs::read_to_string(&canonical).map_err(|error| {
                agent_core::error::AgentError::Tool {
                    tool: "Read".into(),
                    message: format!("{raw}: {error}"),
                }
            })
        })
    }
}

struct Metrics {
    label: &'static str,
    started: Instant,
    input_tokens: u64,
    output_tokens: u64,
    steps: u32,
    tool_calls: u32,
}

impl Metrics {
    fn new(label: &'static str) -> Self {
        Self {
            label,
            started: Instant::now(),
            input_tokens: 0,
            output_tokens: 0,
            steps: 0,
            tool_calls: 0,
        }
    }

    fn report(&self) {
        println!(
            "[{}] {} ms · {} in / {} out tokens · {} step(s) · {} tool call(s)",
            self.label,
            self.started.elapsed().as_millis(),
            self.input_tokens,
            self.output_tokens,
            self.steps,
            self.tool_calls
        );
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = std::env::var("SUPERAGENT_LIVE_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:28787/v1".to_string());
    let model = std::env::var("SUPERAGENT_LIVE_MODEL")
        .unwrap_or_else(|_| "wk-deepseek-v4.1-flash-011".to_string());
    let api_key = std::env::var("SUPERAGENT_LIVE_API_KEY").unwrap_or_else(|_| "sk-wb-local".into());

    println!("provider: {base_url} · model: {model}");
    let provider: Arc<dyn agent_core::Provider> = Arc::new(HttpProvider::new(
        HttpProviderConfig::openai("live", &base_url, &api_key),
    )?);

    // 1. An environment event arrives. Addressed, so the program filter passes it.
    let agent = Arc::new(SuperAgent::new(
        SuperAgentConfig::new("router-live").with_policy(
            RoutePolicy::permissive()
                .with_autonomy(agent_core::super_agent::Autonomy::RuleAllowlist),
        ),
    ));
    let trigger = Trigger::from_source(
        Source::new(SourceKind::PullRequestReview, "github:acme/agent-core"),
        "github:acme/agent-core#pr-41",
        "review-comment-9f2",
        "reviewer asks about the repeat cache in src/tool_use.rs: eviction order, ceiling, and why Bash is excluded",
    )
    .with_actor("reviewer")
    .addressed()
    .with_body(REQUEST_BODY);
    let submitted = agent.submit(trigger);
    println!(
        "\n1. submit → {:?} ({})",
        submitted.route, submitted.trigger_id
    );

    // 2. The router decides the backlog: one real request, JSON answer.
    let batch = agent.take_batch().expect("a queued batch");
    println!(
        "2. router prompt: {} chars, {} event(s)",
        batch.prompt.chars().count(),
        batch.triggers.len()
    );
    let mut router_metrics = Metrics::new("router");
    let router = TurnRouter::new(provider.clone(), &model);
    let outcome = router
        .decide(&batch, &CancelToken::new())
        .await
        .map_err(|error| format!("router decision failed: {error}"))?;
    router_metrics.input_tokens = outcome.usage.input_tokens;
    router_metrics.output_tokens = outcome.usage.output_tokens;
    router_metrics.steps = 1;
    router_metrics.report();
    let decisions = outcome.decisions;
    for decision in &decisions {
        println!(
            "   decision: {:?} {:?} reason={:?}",
            decision.action, decision.trigger_ids, decision.reason
        );
    }
    let applied = agent.apply_decisions(&batch.triggers, &decisions);
    println!(
        "   applied: dispatched={:?} delivered={} ignored={} requeued={} undecided={}",
        applied.dispatched, applied.delivered, applied.ignored, applied.requeued, applied.undecided
    );
    if applied.dispatched.is_empty() {
        println!("\nthe router chose not to dispatch; nothing left to run");
        return Ok(());
    }
    let (worker_id, _worker_name) = applied.dispatched[0].clone();
    let thread_key = ThreadKey::new(batch.triggers[0].thread_key.as_str());
    let worker = agent.worker(&worker_id).expect("a worker record");
    println!(
        "   worker: {} ({}) on session {}",
        worker.name, worker_id, worker.session_id
    );

    // 3. The kernel claims the worker's turn itself: the host does not build the
    //    request, which is the difference between "drive the workers" and "hand the
    //    supervisor events and read reports". The claim carries the isolated session,
    //    the mission the router wrote, the inline thread context and the worker's own
    //    cancel token.
    let mut tools = ToolRegistry::new(Arc::new(AllowAll));
    // No `TodoWrite` here: the session checklist is host-core's now, and this demo
    // makes no host calls (see the module doc). A kernel-side list would be the
    // second owner the kernel no longer has.
    tools.register(Arc::new(ReadTool {
        root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }));
    let sink = Arc::new(RecordingSink::new());
    let turn_worker = TurnWorker::new(
        provider.clone(),
        Arc::new(tools),
        sink.clone() as Arc<dyn EventSink>,
        TurnConfig::new(&model),
    )
    // A real worker run knows its window: without it the loop never ages old tool
    // output and every step re-sends the whole file it read.
    .with_model_limits(agent_core::context::ModelLimits {
        context_window: Some(60_000),
        max_tokens: Some(8_000),
        ..Default::default()
    });
    let task = agent
        .claim_worker_turn(None)
        .expect("the dispatched worker has an event waiting");
    println!(
        "\n3. claimed worker turn: {} event(s), provisional={}, context {} chars",
        task.events,
        task.provisional,
        task.request
            .context
            .as_deref()
            .map(|context| context.chars().count())
            .unwrap_or(0)
    );
    let mut worker_metrics = Metrics::new("worker");
    let outcome = turn_worker.run(task.request).await;
    worker_metrics.input_tokens = outcome.usage.input_tokens;
    worker_metrics.output_tokens = outcome.usage.output_tokens;
    worker_metrics.steps = outcome.turns;
    worker_metrics.tool_calls = outcome.tool_calls;
    worker_metrics.report();
    println!("   status: {:?}", outcome.status);
    // What each tool actually handed the model, before any request-side ageing: a
    // report that says "every read is truncated" is only diagnosable with this.
    for (index, event) in sink.snapshot().iter().enumerate() {
        if let agent_core::AgentEvent::ToolEnd {
            tool_call_id,
            result,
            ..
        } = &event.event
        {
            let content = result
                .get("content")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            println!(
                "   tool[{index}] {tool_call_id}: {} chars, starts {:?}",
                content.chars().count(),
                content.chars().take(60).collect::<String>()
            );
        }
    }
    println!("   report:\n---\n{}\n---", outcome.report);

    // 4. The report goes to the router's inbox, and the chain can recall it.
    agent.finish_worker_turn(&worker_id, outcome.status, outcome.report.clone());
    let reports = agent.drain_reports();
    println!(
        "\n4. router inbox: {} report(s) from {:?}",
        reports.len(),
        reports
            .iter()
            .map(|report| report.worker_id.as_str())
            .collect::<Vec<_>>()
    );
    println!(
        "   thread {} is now {} (owner {})",
        thread_key,
        agent.threads()[0].status.as_str(),
        agent.threads()[0].worker.as_deref().unwrap_or("none")
    );
    let recalled = agent
        .recall(&format!("report:{worker_id}"))
        .map_err(|miss| format!("recall failed: {miss}"))?;
    println!(
        "   recall report:{worker_id} → {} chars, starts {:?}",
        recalled.chars().count(),
        recalled.chars().take(80).collect::<String>()
    );

    // A second event on the same thread skips the router entirely.
    let follow_up = agent.submit(
        Trigger::from_source(
            batch.triggers[0].source.clone(),
            thread_key.as_str(),
            "build-8842",
            "the same target failed again after the fix",
        )
        .addressed(),
    );
    println!("5. follow-up on the same thread → {:?}", follow_up.route);

    // 6. Spending, as the supervisor reports it.
    let status = agent.status();
    println!(
        "\n6. supervisor: pending={} threads={} liveWorkers={} reportsPending={}",
        status.pending, status.threads, status.live_workers, status.reports_pending
    );
    Ok(())
}
