//! `schedule.*` over the real RPC entry point.
//!
//! The kernel owns *when*: a host asks for a job, asks which jobs are due, and runs
//! them itself. Every case here passes an explicit `nowMs`, so the assertions are
//! about the scheduler's arithmetic rather than about the wall clock.

use std::sync::Arc;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

mod common;

/// 2026-11-18T00:00:00Z, a Wednesday.
const MIDNIGHT: i64 = 1_794_960_000_000;
const HOUR_MS: i64 = 3_600_000;
const MINUTE_MS: i64 = 60_000;

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
async fn a_job_is_added_with_the_first_time_the_rule_says() {
    let (sidecar, _) = sidecar();
    let added = call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "standup",
            "prompt": "summarise yesterday's commits",
            "schedule": {"kind": "cron", "expr": "0 9 * * *", "tzOffsetMin": 0},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    let job = &added["result"]["job"];
    assert_eq!(job["name"], "standup");
    assert_eq!(job["prompt"], "summarise yesterday's commits");
    assert_eq!(job["enabled"], true);
    assert_eq!(
        job["nextRunAtMs"].as_i64(),
        Some(MIDNIGHT + 9 * HOUR_MS),
        "09:00 UTC the same day"
    );
    assert_eq!(
        added["result"]["nextWakeupAtMs"].as_i64(),
        Some(MIDNIGHT + 9 * HOUR_MS)
    );

    let listed = call(&sidecar, 2, "schedule.list", json!({"nowMs": MIDNIGHT})).await;
    assert_eq!(listed["result"]["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(listed["result"]["jobs"][0]["id"], job["id"]);
}

#[tokio::test]
async fn a_tick_reports_a_due_job_once_and_only_when_it_is_due() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "hourly",
            "prompt": "check the build",
            "schedule": {"kind": "every", "everyMs": HOUR_MS},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;

    let early = call(
        &sidecar,
        2,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + 30 * MINUTE_MS}),
    )
    .await;
    assert!(early["result"]["due"].as_array().unwrap().is_empty());

    let on_time = call(
        &sidecar,
        3,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + HOUR_MS}),
    )
    .await;
    let due = on_time["result"]["due"].as_array().unwrap();
    assert_eq!(due.len(), 1, "{due:?}");
    assert_eq!(due[0]["prompt"], "check the build");
    assert_eq!(due[0]["scheduledAtMs"].as_i64(), Some(MIDNIGHT + HOUR_MS));
    assert_eq!(due[0]["lateMs"].as_i64(), Some(0));

    // The same instant twice must not fire twice.
    let again = call(
        &sidecar,
        4,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + HOUR_MS}),
    )
    .await;
    assert!(again["result"]["due"].as_array().unwrap().is_empty());
    assert_eq!(
        again["result"]["nextWakeupAtMs"].as_i64(),
        Some(MIDNIGHT + 2 * HOUR_MS),
        "the next fire time advanced by the rule, not by the tick"
    );
}

#[tokio::test]
async fn a_late_tick_reports_the_job_once_with_its_lateness() {
    let (sidecar, _) = sidecar();
    call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "daily",
            "prompt": "report",
            "schedule": {"kind": "cron", "expr": "0 9 * * *", "tzOffsetMin": 0},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;

    // The host was asleep for a day and a half: one report, not 36.
    let late = call(
        &sidecar,
        2,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + 33 * HOUR_MS}),
    )
    .await;
    let due = late["result"]["due"].as_array().unwrap();
    assert_eq!(due.len(), 1, "{due:?}");
    assert_eq!(
        due[0]["scheduledAtMs"].as_i64(),
        Some(MIDNIGHT + 9 * HOUR_MS)
    );
    assert_eq!(due[0]["lateMs"].as_i64(), Some(24 * HOUR_MS));

    let jobs = call(&sidecar, 3, "schedule.list", json!({"nowMs": MIDNIGHT})).await;
    assert_eq!(jobs["result"]["jobs"][0]["lateRuns"], 1);
    assert_eq!(
        jobs["result"]["jobs"][0]["lastRunAtMs"].as_i64(),
        Some(MIDNIGHT + 9 * HOUR_MS),
        "the row records the scheduled time, not the tick time"
    );
}

#[tokio::test]
async fn a_one_shot_does_not_stay_enabled_after_it_fires() {
    let (sidecar, _) = sidecar();
    let added = call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "once",
            "prompt": "send the deck",
            "schedule": {"kind": "at", "atMs": MIDNIGHT + HOUR_MS},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    let job_id = added["result"]["job"]["id"].as_str().unwrap().to_string();

    let fired = call(
        &sidecar,
        2,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + HOUR_MS}),
    )
    .await;
    assert_eq!(fired["result"]["due"].as_array().unwrap().len(), 1);
    assert_eq!(
        fired["result"]["nextWakeupAtMs"],
        Value::Null,
        "nothing is left to wake for"
    );

    let jobs = call(&sidecar, 3, "schedule.list", json!({})).await;
    let job = jobs["result"]["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|job| job["id"] == job_id.as_str())
        .expect("the job is still listed, disabled");
    assert_eq!(job["enabled"], false);
}

#[tokio::test]
async fn a_disabled_job_is_not_due_and_enabling_it_recomputes_from_now() {
    let (sidecar, _) = sidecar();
    let added = call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "paused",
            "prompt": "nothing",
            "schedule": {"kind": "every", "everyMs": 5 * MINUTE_MS},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    let job_id = added["result"]["job"]["id"].as_str().unwrap().to_string();

    let off = call(
        &sidecar,
        2,
        "schedule.enable",
        json!({"jobId": job_id, "enabled": false, "nowMs": MIDNIGHT}),
    )
    .await;
    assert_eq!(off["result"]["job"]["enabled"], false);
    let skipped = call(
        &sidecar,
        3,
        "schedule.tick",
        json!({"nowMs": MIDNIGHT + HOUR_MS}),
    )
    .await;
    assert!(skipped["result"]["due"].as_array().unwrap().is_empty());

    let on = call(
        &sidecar,
        4,
        "schedule.enable",
        json!({"jobId": job_id, "enabled": true, "nowMs": MIDNIGHT + HOUR_MS}),
    )
    .await;
    assert_eq!(on["result"]["job"]["enabled"], true);
    assert_eq!(
        on["result"]["job"]["nextRunAtMs"].as_i64(),
        Some(MIDNIGHT + HOUR_MS + 5 * MINUTE_MS),
        "an hour of being off is not paid back in a burst"
    );
}

#[tokio::test]
async fn jobs_can_be_removed_and_the_health_report_tracks_the_wakeup() {
    let (sidecar, _) = sidecar();
    let health = call(&sidecar, 1, "sidecar.health", json!({})).await;
    assert_eq!(health["result"]["nextWakeupAtMs"], Value::Null);

    let added = call(
        &sidecar,
        2,
        "schedule.add",
        json!({
            "name": "later",
            "prompt": "x",
            "schedule": {"kind": "every", "everyMs": HOUR_MS},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    let job_id = added["result"]["job"]["id"].as_str().unwrap().to_string();

    let health = call(&sidecar, 3, "sidecar.health", json!({})).await;
    assert_eq!(
        health["result"]["nextWakeupAtMs"].as_i64(),
        Some(MIDNIGHT + HOUR_MS),
        "a host can set one timer from this"
    );

    let removed = call(&sidecar, 4, "schedule.remove", json!({"jobId": job_id})).await;
    assert_eq!(removed["result"]["removed"], true);
    let again = call(&sidecar, 5, "schedule.remove", json!({"jobId": job_id})).await;
    assert_eq!(again["result"]["removed"], false);
    let health = call(&sidecar, 6, "sidecar.health", json!({})).await;
    assert_eq!(health["result"]["nextWakeupAtMs"], Value::Null);
}

#[tokio::test]
async fn a_bad_expression_is_refused_with_the_reason() {
    let (sidecar, _) = sidecar();
    let refused = call(
        &sidecar,
        1,
        "schedule.add",
        json!({
            "name": "broken",
            "prompt": "x",
            "schedule": {"kind": "cron", "expr": "* * * *", "tzOffsetMin": 0},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    // A rule that can never fire is refused when it is added, not stored as a job
    // that silently never runs.
    assert!(refused["error"]["message"]
        .as_str()
        .unwrap()
        .contains("expected 5 fields"));

    let impossible = call(
        &sidecar,
        2,
        "schedule.add",
        json!({
            "name": "feb-31",
            "prompt": "x",
            "schedule": {"kind": "cron", "expr": "0 0 31 2 *", "tzOffsetMin": 0},
            "nowMs": MIDNIGHT,
        }),
    )
    .await;
    assert!(impossible["error"]["message"]
        .as_str()
        .unwrap()
        .contains("never fires on any date"));

    let missing = call(&sidecar, 3, "schedule.add", json!({"name": "no schedule"})).await;
    assert!(missing["error"]["message"]
        .as_str()
        .unwrap()
        .contains("`schedule` is required"));
}
