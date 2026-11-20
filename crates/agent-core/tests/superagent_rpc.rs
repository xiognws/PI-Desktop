//! The Super-agent surface over the real RPC entry point.
//!
//! One router session receives environment events, decides what to do with them in
//! one batched model call, hands work to isolated workers, and reads their reports
//! back — all through the same JSON-RPC channel main already speaks.

use std::sync::Arc;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

mod common;

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    let sidecar = Arc::new(Sidecar::with_default_gate(sink));
    common::answer_empty_history(&sidecar, &lines);
    (sidecar, lines)
}

async fn call(sidecar: &Sidecar, id: i64, method: &str, params: Value) -> Value {
    let request = Request {
        jsonrpc: "2.0".into(),
        id: Some(json!(id)),
        method: method.into(),
        params,
    };
    let line = sidecar.handle(request).await.expect("a response line");
    serde_json::from_str(&line).expect("a JSON response")
}

fn trigger(id: &str, thread: &str, text: &str) -> Value {
    json!({
        "id": id,
        "source": {"kind": "chat", "channel": "feishu:dev"},
        "threadKey": thread,
        "summary": text,
        "actor": "xiongws",
        "addressedToAgent": true,
    })
}

/// A provider that answers one router decision.
fn decision_provider(decision: Value) -> Value {
    json!({
        "kind": "scripted",
        "text": serde_json::to_string(&json!({ "decisions": [decision] })).unwrap(),
    })
}

#[tokio::test]
async fn an_event_is_queued_and_a_decision_starts_a_worker_on_its_thread() {
    let (sidecar, _) = sidecar();
    let configured = call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "router-1", "maxWorkers": 2}),
    )
    .await;
    assert_eq!(configured["result"]["superagent"]["liveWorkers"], 0);

    let queued = call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "router-1", "trigger": trigger("m-1", "pr-12", "the build is red")}),
    )
    .await;
    assert_eq!(queued["result"]["outcome"]["route"], "queued");

    let pumped = call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "router-1",
            "driveWorkers": false,
            "provider": decision_provider(json!({
                "triggerIds": ["feishu:dev#m-1"],
                "action": "dispatch",
                "worker": {"name": "fix-ci", "mission": "make main green"},
                "reason": "nobody owns it",
            })),
        }),
    )
    .await;
    assert_eq!(pumped["result"]["batch"], 1);
    assert_eq!(pumped["result"]["dispatched"].as_array().unwrap().len(), 1);
    assert_eq!(pumped["result"]["dispatched"][0][1], "fix-ci");

    let status = call(
        &sidecar,
        4,
        "superagent.status",
        json!({"sessionId": "router-1"}),
    )
    .await;
    assert_eq!(status["result"]["superagent"]["liveWorkers"], 1);
    assert_eq!(
        status["result"]["superagent"]["workers"][0]["name"],
        "fix-ci"
    );
    assert_eq!(
        status["result"]["superagent"]["workers"][0]["status"],
        "running"
    );

    let threads = call(
        &sidecar,
        5,
        "superagent.threads",
        json!({"sessionId": "router-1"}),
    )
    .await;
    assert_eq!(threads["result"]["threads"][0]["key"], "pr-12");
    assert_eq!(threads["result"]["threads"][0]["worker"], "worker-1");
    assert_eq!(threads["result"]["threads"][0]["status"], "working");
}

#[tokio::test]
async fn a_second_event_on_an_owned_thread_skips_the_router() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-1", "pr-12", "first")}),
    )
    .await;
    call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "driveWorkers": false,
            "provider": decision_provider(json!({
                "triggerIds": ["feishu:dev#m-1"],
                "action": "dispatch",
                "worker": {"name": "fix-ci", "mission": "make it green"},
            })),
        }),
    )
    .await;

    let delivered = call(
        &sidecar,
        4,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-2", "pr-12", "review comment")}),
    )
    .await;
    assert_eq!(delivered["result"]["outcome"]["route"], "delivered");
    assert_eq!(delivered["result"]["outcome"]["workerId"], "worker-1");

    // Nothing reached the router queue, so the next pump decides nothing and makes
    // no provider request at all.
    let pumped = call(
        &sidecar,
        5,
        "superagent.pump",
        json!({"sessionId": "r", "driveWorkers": false, "provider": decision_provider(json!({"triggerIds": [], "action": "ignore"}))}),
    )
    .await;
    assert_eq!(pumped["result"]["batch"], 0);
}

#[tokio::test]
async fn an_unaddressed_event_is_dropped_and_a_rule_can_record_it() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    let unaddressed = call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({
            "sessionId": "r",
            "trigger": {
                "id": "m-9",
                "source": {"kind": "chat", "channel": "feishu:dev"},
                "threadKey": "pr-3",
                "summary": "anyone around?",
            }
        }),
    )
    .await;
    assert_eq!(unaddressed["result"]["outcome"]["route"], "dropped");
    assert!(unaddressed["result"]["outcome"]["reason"]
        .as_str()
        .unwrap()
        .contains("nobody addressed"));

    call(
        &sidecar,
        3,
        "superagent.configure",
        json!({
            "sessionId": "r2",
            "policy": {"autonomy": "record_only", "rules": ["pr-*"]},
        }),
    )
    .await;
    let recorded = call(
        &sidecar,
        4,
        "superagent.trigger",
        json!({
            "sessionId": "r2",
            "trigger": {
                "id": "m-10",
                "source": {"kind": "chat", "channel": "feishu:dev"},
                "threadKey": "pr-4",
                "summary": "the pipeline is red again",
            }
        }),
    )
    .await;
    assert_eq!(recorded["result"]["outcome"]["route"], "recorded");
}

#[tokio::test]
async fn a_worker_report_lands_in_the_router_inbox_and_the_chain_recalls_it() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-1", "pr-12", "the build is red")}),
    )
    .await;
    call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "driveWorkers": false,
            "provider": decision_provider(json!({
                "triggerIds": ["feishu:dev#m-1"],
                "action": "dispatch",
                "worker": {"name": "fix-ci", "mission": "make it green"},
            })),
        }),
    )
    .await;

    let reported = call(
        &sidecar,
        4,
        "superagent.report",
        json!({
            "sessionId": "r",
            "workerId": "worker-1",
            "status": "settled",
            "text": "the flake was a stale fixture; fixed in tests/ci.rs:40",
        }),
    )
    .await;
    assert_eq!(reported["result"]["accepted"], true);
    assert_eq!(reported["result"]["reportsPending"], 1);
    assert!(reported["result"]["report"]["text"]
        .as_str()
        .unwrap()
        .contains("tests/ci.rs:40"));

    // The thread keeps its owner, so the next event on it continues in that worker.
    let threads = call(&sidecar, 5, "superagent.threads", json!({"sessionId": "r"})).await;
    assert_eq!(threads["result"]["threads"][0]["status"], "waiting");
    assert_eq!(threads["result"]["threads"][0]["worker"], "worker-1");

    let recalled = call(
        &sidecar,
        6,
        "superagent.recall",
        json!({"sessionId": "r", "id": "trigger:feishu:dev#m-1"}),
    )
    .await;
    assert!(recalled["result"]["recalled"]
        .as_str()
        .unwrap()
        .contains("the build is red"));
    let chained = call(
        &sidecar,
        7,
        "superagent.recall",
        json!({"sessionId": "r", "id": "report:worker-1"}),
    )
    .await;
    assert!(chained["result"]["recalled"]
        .as_str()
        .unwrap()
        .contains("tests/ci.rs:40"));

    let miss = call(
        &sidecar,
        8,
        "superagent.recall",
        json!({"sessionId": "r", "id": "trigger:nope"}),
    )
    .await;
    assert_eq!(miss["error"]["code"], -32000);
    assert_eq!(miss["error"]["data"]["errorCode"], "RECALL_MISS");
    assert!(miss["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Retry with an id"));
}

#[tokio::test]
async fn stopping_a_worker_releases_the_thread_and_the_watchdog_sees_a_failed_one() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-1", "pr-12", "red")}),
    )
    .await;
    call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "driveWorkers": false,
            "provider": decision_provider(json!({
                "triggerIds": ["feishu:dev#m-1"],
                "action": "dispatch",
                "worker": {"name": "fix-ci", "mission": "make it green"},
            })),
        }),
    )
    .await;

    let stopped = call(
        &sidecar,
        4,
        "superagent.workerStop",
        json!({"sessionId": "r", "workerId": "worker-1"}),
    )
    .await;
    assert_eq!(stopped["result"]["stopped"], true);

    let threads = call(&sidecar, 5, "superagent.threads", json!({"sessionId": "r"})).await;
    assert_eq!(threads["result"]["threads"][0]["worker"], Value::Null);
    assert_eq!(threads["result"]["threads"][0]["status"], "open");

    // A failed worker, on a new thread, is what the watchdog exists to find.
    call(
        &sidecar,
        6,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-2", "pr-13", "also red")}),
    )
    .await;
    call(
        &sidecar,
        7,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "driveWorkers": false,
            "provider": decision_provider(json!({
                "triggerIds": ["feishu:dev#m-2"],
                "action": "dispatch",
                "worker": {"name": "fix-again", "mission": "make it green"},
            })),
        }),
    )
    .await;
    call(
        &sidecar,
        8,
        "superagent.report",
        json!({
            "sessionId": "r",
            "workerId": "worker-2",
            "status": "failed",
            "text": "the toolchain is missing",
        }),
    )
    .await;
    let watchdog = call(
        &sidecar,
        9,
        "superagent.watchdog",
        json!({"sessionId": "r"}),
    )
    .await;
    let interventions = watchdog["result"]["interventions"].as_array().unwrap();
    assert_eq!(interventions.len(), 1);
    assert_eq!(interventions[0]["kind"], "recover");
    assert_eq!(interventions[0]["workerId"], "worker-2");
    assert_eq!(interventions[0]["applied"], "reported_to_router");
}

#[tokio::test]
async fn a_background_run_starts_at_once_and_its_result_becomes_an_event() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    let started = call(
        &sidecar,
        2,
        "superagent.asyncStart",
        json!({
            "sessionId": "r",
            "threadKey": "pr-12",
            "label": "cargo test",
            "prompt": "run the suite and say what failed",
            "provider": {"kind": "scripted", "text": "the suite passed"},
        }),
    )
    .await;
    assert_eq!(started["result"]["task"]["label"], "cargo test");
    assert_eq!(started["result"]["task"]["threadKey"], "pr-12");

    // The result arrives as a trigger on the thread, so it lands in the router's
    // queue exactly like an environment event.
    let mut pending = 0;
    for _ in 0..200 {
        let listed = call(
            &sidecar,
            3,
            "superagent.asyncList",
            json!({"sessionId": "r"}),
        )
        .await;
        let tasks = listed["result"]["tasks"].as_array().unwrap();
        assert_eq!(
            tasks.len(),
            1,
            "the task is remembered while it runs and after"
        );
        if listed["result"]["running"] == 0 {
            let status = call(&sidecar, 4, "superagent.status", json!({"sessionId": "r"})).await;
            pending = status["result"]["superagent"]["pending"]
                .as_u64()
                .unwrap_or(0);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(pending, 1, "the background result is queued for a decision");
}

#[tokio::test]
async fn a_background_run_can_be_stopped_before_it_answers() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    // A provider with no scripted answer never completes, so the stop is the only
    // thing that ends the task.
    let started = call(
        &sidecar,
        2,
        "superagent.asyncStart",
        json!({
            "sessionId": "r",
            "threadKey": "pr-12",
            "label": "long job",
            "prompt": "wait forever",
            "provider": {"kind": "scripted", "script": []},
        }),
    )
    .await;
    let task_id = started["result"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let stopped = call(
        &sidecar,
        3,
        "superagent.asyncStop",
        json!({"sessionId": "r", "taskId": task_id}),
    )
    .await;
    assert_eq!(stopped["result"]["stopped"], true);
    let listed = call(
        &sidecar,
        4,
        "superagent.asyncList",
        json!({"sessionId": "r"}),
    )
    .await;
    assert_eq!(listed["result"]["tasks"][0]["status"], "stopped");
}

#[test]
fn the_repeat_policy_follows_the_host_tool_names() {
    use agent_core::tool::{AllowAll, Tool, ToolContext, ToolRegistry, ToolSpec};

    struct Named(&'static str);

    impl Tool for Named {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(self.0, "A tool.", json!({"type": "object"}))
        }

        fn call<'a>(
            &'a self,
            _call: &agent_core::ToolCall,
            _ctx: &'a ToolContext,
        ) -> agent_core::provider::BoxFuture<'a, agent_core::Result<String>> {
            Box::pin(async move { Ok(String::new()) })
        }
    }

    let bare = ToolRegistry::new(Arc::new(AllowAll));
    let default_policy = agent_core::sidecar::repeat_policy_for(&bare);
    assert!(default_policy.covers("Read"));

    let mut host = ToolRegistry::new(Arc::new(AllowAll));
    host.register(Arc::new(Named("read_file")));
    host.register(Arc::new(Named("grep")));
    host.register(Arc::new(Named("Bash")));
    let host_policy = agent_core::sidecar::repeat_policy_for(&host);
    // The host's own names, and only those: `Bash` is never reusable.
    assert_eq!(host_policy.tools, vec!["read_file", "grep"]);
    assert!(!host_policy.covers("Bash"));
    assert!(
        !host_policy.covers("Read"),
        "a name the host does not declare"
    );
}

#[tokio::test]
async fn the_kernel_runs_the_worker_turn_and_only_the_report_comes_back() {
    let (sidecar, lines) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-1", "pr-12", "the build is red")}),
    )
    .await;

    // Two responses from one provider: the router's decision, then the worker's turn.
    let decision = json!({
        "decisions": [{
            "triggerIds": ["feishu:dev#m-1"],
            "action": "dispatch",
            "worker": {"name": "fix-ci", "mission": "make main green and report what you verified"},
        }]
    })
    .to_string();
    let pumped = call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "awaitWorkers": true,
            "provider": {
                "kind": "scripted",
                "script": [
                    {"text": decision},
                    {"text": "verified: the flake is a stale fixture, nothing else touched"},
                ],
            },
        }),
    )
    .await;
    assert_eq!(
        pumped["result"]["driving"], 1,
        "the kernel drives the worker itself"
    );
    assert_eq!(pumped["result"]["dispatched"][0][1], "fix-ci");
    assert_eq!(
        pumped["result"]["reports"], 1,
        "the report is waiting for the router"
    );

    let status = call(&sidecar, 4, "superagent.status", json!({"sessionId": "r"})).await;
    let worker = &status["result"]["superagent"]["workers"][0];
    assert_eq!(worker["name"], "fix-ci");
    assert_eq!(
        worker["status"], "waiting",
        "the turn finished and the worker is between tasks"
    );
    assert_eq!(worker["reportReady"], true);
    assert_eq!(status["result"]["superagent"]["reportsPending"], 1);

    // The worker's turn is a real kernel turn: its events carry the worker's own
    // isolated session id, which is what keeps it off the router's transcript.
    let worker_events: Vec<Value> = lines
        .notifications("agent.event")
        .into_iter()
        .filter(|params| params["sessionId"] == "r#worker-1")
        .collect();
    assert!(
        !worker_events.is_empty(),
        "the worker turn ran through the turn loop"
    );

    let recalled = call(
        &sidecar,
        5,
        "superagent.recall",
        json!({"sessionId": "r", "id": "report:worker-1"}),
    )
    .await;
    assert!(recalled["result"]["recalled"]
        .as_str()
        .unwrap()
        .contains("stale fixture"));
}

#[tokio::test]
async fn a_worker_turn_that_breaks_reports_a_failure_and_frees_the_thread() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "superagent.configure",
        json!({"sessionId": "r"}),
    )
    .await;
    call(
        &sidecar,
        2,
        "superagent.trigger",
        json!({"sessionId": "r", "trigger": trigger("m-1", "pr-12", "the build is red")}),
    )
    .await;
    // Only the decision is scripted: the worker's turn runs out of responses and has
    // to report a failure rather than invent an answer.
    let decision = json!({
        "decisions": [{
            "triggerIds": ["feishu:dev#m-1"],
            "action": "dispatch",
            "worker": {"name": "fix-ci", "mission": "make main green"},
        }]
    })
    .to_string();
    let pumped = call(
        &sidecar,
        3,
        "superagent.pump",
        json!({
            "sessionId": "r",
            "awaitWorkers": true,
            "provider": {"kind": "scripted", "script": [{"text": decision}]},
        }),
    )
    .await;
    assert_eq!(pumped["result"]["reports"], 1);

    let status = call(&sidecar, 4, "superagent.status", json!({"sessionId": "r"})).await;
    let worker = &status["result"]["superagent"]["workers"][0];
    assert_eq!(worker["status"], "failed");
    assert_eq!(
        status["result"]["superagent"]["liveWorkers"], 0,
        "a failed worker no longer counts as live"
    );
    let threads = call(&sidecar, 5, "superagent.threads", json!({"sessionId": "r"})).await;
    assert_eq!(
        threads["result"]["threads"][0]["worker"],
        Value::Null,
        "the thread is free for a fresh dispatch"
    );
    let recalled = call(
        &sidecar,
        6,
        "superagent.recall",
        json!({"sessionId": "r", "id": "report:worker-1"}),
    )
    .await;
    assert!(recalled["result"]["recalled"]
        .as_str()
        .unwrap()
        .contains("PROVIDER_ERROR"));
}

#[tokio::test]
async fn the_plan_and_the_rewind_points_are_reachable_over_rpc() {
    let (sidecar, lines) = sidecar();
    let empty = call(&sidecar, 1, "agent.plan", json!({"sessionId": "s1"})).await;
    assert_eq!(empty["result"]["plan"]["summary"], "no plan");

    let checkpoints = call(&sidecar, 2, "agent.checkpoints", json!({"sessionId": "s1"})).await;
    assert_eq!(
        checkpoints["result"]["checkpoints"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // A turn captures a checkpoint before its own user row.
    call(
        &sidecar,
        3,
        "sidecar.configure",
        json!({"provider": {"kind": "scripted", "text": "hi"}, "model": "m"}),
    )
    .await;
    call(
        &sidecar,
        4,
        "agent.prompt",
        json!({"sessionId": "s2", "turnId": "t1", "content": "hello", "mode": "agent"}),
    )
    .await;
    // Between turns is the only safe moment: the running loop still holds the
    // transcript it appends to.
    lines
        .wait_for_event("agent_end", std::time::Duration::from_secs(5))
        .await
        .expect("the turn ends");

    let listed = call(&sidecar, 5, "agent.checkpoints", json!({"sessionId": "s2"})).await;
    let list = listed["result"]["checkpoints"].as_array().unwrap();
    assert_eq!(list.len(), 1, "a turn is a rewind point");
    assert_eq!(list[0]["label"], "turn start");
    let id = list[0]["id"].as_str().unwrap().to_string();

    let rewound = call(
        &sidecar,
        6,
        "agent.rewind",
        json!({"sessionId": "s2", "checkpointId": id}),
    )
    .await;
    assert_eq!(rewound["result"]["rewound"], true);
    assert_eq!(
        rewound["result"]["messages"], 0,
        "the conversation before the turn"
    );

    let missing = call(
        &sidecar,
        7,
        "agent.rewind",
        json!({"sessionId": "s2", "checkpointId": "ckpt-99"}),
    )
    .await;
    assert_eq!(
        missing["error"]["data"]["errorCode"],
        "CHECKPOINT_NOT_FOUND"
    );
}
