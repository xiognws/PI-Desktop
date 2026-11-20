//! `delivery.*` over the real RPC entry point.
//!
//! The kernel keeps the bookkeeping of outbound sends — what was meant to go out, how
//! many times it was tried, which ones are beyond saving — and the host does the
//! sending. Every case passes an explicit `nowMs` so the assertions are about the
//! queue's arithmetic, not about the wall clock.

use std::sync::Arc;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

mod common;

const T0: i64 = 1_794_960_000_000;
const MINUTE: i64 = 60_000;

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

#[tokio::test]
async fn an_item_is_queued_once_per_idempotency_key() {
    let (sidecar, _) = sidecar();
    let first = call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({
            "id": "report:t1",
            "target": "feishu:dev",
            "kind": "report",
            "payload": "the build is green",
            "nowMs": T0,
        }),
    )
    .await;
    assert_eq!(first["result"]["outcome"]["outcome"], "queued");
    assert_eq!(first["result"]["stats"]["pending"], 1);

    // The host retried the same turn: one delivery, not two.
    let second = call(
        &sidecar,
        2,
        "delivery.enqueue",
        json!({
            "id": "report:t1",
            "target": "feishu:dev",
            "kind": "report",
            "payload": "the build is green",
            "nowMs": T0 + 1,
        }),
    )
    .await;
    assert_eq!(second["result"]["outcome"]["outcome"], "duplicate");
    assert_eq!(second["result"]["stats"]["total"], 1);

    let listed = call(&sidecar, 3, "delivery.list", json!({"nowMs": T0})).await;
    assert_eq!(listed["result"]["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(
        listed["result"]["deliveries"][0]["payload"],
        "the build is green"
    );
}

#[tokio::test]
async fn a_claim_hands_out_the_item_and_a_completion_closes_it() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"id": "d1", "target": "ui", "payload": "hi", "nowMs": T0}),
    )
    .await;

    let claimed = call(
        &sidecar,
        2,
        "delivery.claim",
        json!({"nowMs": T0, "limit": 5}),
    )
    .await;
    let items = claimed["result"]["claimed"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["attempts"], 1);
    assert_eq!(items[0]["state"]["state"], "inFlight");
    // Nothing else may take it before the deadline (the default is one minute).
    let again = call(
        &sidecar,
        3,
        "delivery.claim",
        json!({"nowMs": T0 + MINUTE / 2}),
    )
    .await;
    assert!(again["result"]["claimed"].as_array().unwrap().is_empty());

    let done = call(
        &sidecar,
        4,
        "delivery.complete",
        json!({"id": "d1", "nowMs": T0 + MINUTE}),
    )
    .await;
    assert_eq!(done["result"]["delivery"]["state"]["state"], "delivered");
    assert_eq!(done["result"]["stats"]["delivered"], 1);
}

#[tokio::test]
async fn an_attempt_nobody_answered_is_claimed_again_after_its_deadline() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"id": "d1", "target": "ui", "payload": "hi", "nowMs": T0}),
    )
    .await;
    call(&sidecar, 2, "delivery.claim", json!({"nowMs": T0})).await;
    // The host went away without answering: the item comes back, with attempt 2.
    let again = call(
        &sidecar,
        3,
        "delivery.claim",
        json!({"nowMs": T0 + 2 * MINUTE}),
    )
    .await;
    let items = again["result"]["claimed"].as_array().unwrap();
    assert_eq!(items.len(), 1, "at least once, not at most once");
    assert_eq!(items[0]["attempts"], 2);
}

#[tokio::test]
async fn a_failure_is_retried_after_a_backoff_and_then_dies() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"id": "d1", "target": "mail:oncall", "payload": "alert", "nowMs": T0}),
    )
    .await;

    call(&sidecar, 2, "delivery.claim", json!({"nowMs": T0})).await;
    let failed = call(
        &sidecar,
        3,
        "delivery.fail",
        json!({"id": "d1", "reason": "platform down", "nowMs": T0}),
    )
    .await;
    assert_eq!(failed["result"]["delivery"]["state"]["state"], "pending");
    let retry_at = failed["result"]["delivery"]["nextAttemptAtMs"]
        .as_i64()
        .expect("a retry time");
    assert!(retry_at > T0, "it waits before trying again");

    // Nothing is due before the backoff has passed.
    let early = call(
        &sidecar,
        4,
        "delivery.claim",
        json!({"nowMs": retry_at - 1}),
    )
    .await;
    assert!(early["result"]["claimed"].as_array().unwrap().is_empty());

    // Five attempts is the default policy: spend them and the item is dead.
    let mut now = retry_at;
    let mut state = String::new();
    for _ in 0..5 {
        call(&sidecar, 5, "delivery.claim", json!({"nowMs": now})).await;
        let failed = call(
            &sidecar,
            6,
            "delivery.fail",
            json!({"id": "d1", "reason": "still down", "nowMs": now}),
        )
        .await;
        state = failed["result"]["delivery"]["state"]["state"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let next = failed["result"]["delivery"]["nextAttemptAtMs"]
            .as_i64()
            .unwrap_or(now);
        if state == "dead" {
            break;
        }
        now = next.max(now) + 1;
    }
    assert_eq!(state, "dead", "the dead letter is the honest end state");
    let stats = call(&sidecar, 7, "delivery.stats", json!({"nowMs": now})).await;
    assert_eq!(stats["result"]["stats"]["dead"], 1);
    assert_eq!(stats["result"]["policy"]["maxAttempts"], 5);
}

#[tokio::test]
async fn a_dead_item_can_be_requeued_by_hand() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"id": "d1", "target": "ui", "payload": "x", "nowMs": T0}),
    )
    .await;
    // Force it into the dead letter with the smallest possible policy.
    let mut now = T0;
    for _ in 0..7 {
        call(&sidecar, 2, "delivery.claim", json!({"nowMs": now})).await;
        let failed = call(
            &sidecar,
            3,
            "delivery.fail",
            json!({"id": "d1", "reason": "nope", "nowMs": now}),
        )
        .await;
        let next = failed["result"]["delivery"]["nextAttemptAtMs"]
            .as_i64()
            .unwrap_or(now);
        if next == i64::MAX {
            break;
        }
        now = next.max(now) + 1;
    }

    let requeued = call(
        &sidecar,
        4,
        "delivery.requeue",
        json!({"id": "d1", "nowMs": T0 + 10 * MINUTE}),
    )
    .await;
    assert_eq!(requeued["result"]["delivery"]["attempts"], 0);
    assert_eq!(requeued["result"]["delivery"]["state"]["state"], "pending");
    let claimed = call(
        &sidecar,
        5,
        "delivery.claim",
        json!({"nowMs": T0 + 10 * MINUTE}),
    )
    .await;
    assert_eq!(claimed["result"]["claimed"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_delivered_item_is_purged_and_health_reports_the_counts() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"id": "d1", "target": "ui", "payload": "x", "nowMs": T0}),
    )
    .await;
    call(&sidecar, 2, "delivery.claim", json!({"nowMs": T0})).await;
    call(
        &sidecar,
        3,
        "delivery.complete",
        json!({"id": "d1", "nowMs": T0}),
    )
    .await;

    let health = call(&sidecar, 4, "sidecar.health", json!({})).await;
    assert_eq!(health["result"]["delivery"]["total"], 1);

    let purged = call(
        &sidecar,
        5,
        "delivery.purge",
        json!({"nowMs": T0 + 2 * MINUTE, "olderThanMs": MINUTE}),
    )
    .await;
    assert_eq!(purged["result"]["purged"], 1);
    assert_eq!(purged["result"]["stats"]["total"], 0);
}

#[tokio::test]
async fn an_enqueue_without_a_target_is_refused() {
    let (sidecar, _) = sidecar();
    let refused = call(
        &sidecar,
        1,
        "delivery.enqueue",
        json!({"payload": "x", "nowMs": T0}),
    )
    .await;
    assert!(refused["error"]["message"]
        .as_str()
        .unwrap()
        .contains("`target`"));
}
