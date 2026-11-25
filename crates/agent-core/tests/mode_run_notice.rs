//! A staged mode run's turn, end to end: `agent.prompt` claims the run turn and
//! `agent.modeTurnNotice` answers for it.
//!
//! Everything here is an RPC a person's click reaches: main claims the run
//! before the prompt (`apps/desktop/electron/main/runtime/mode-runs.ts`), and
//! `agent.modeTurnNotice` arrives from `mode-services.ts` when the user pauses
//! (`closeout`) or removes (`release`) the run. The Node sidecar's answers are
//! the reference — `DesktopAgentRuntime.modeTurnNotice` in
//! `packages/agent-runtime/src/runtime.ts` — so what is pinned is the shape
//! (`{ applied: boolean }`, never an error for a late notice) and the two
//! identity gates: another turn, or another run, is not applied.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use agent_core::rpc::Request;
use agent_core::sidecar::{RecordingLines, Sidecar};
use agent_core::LineSink;
use serde_json::{json, Value};

fn sidecar() -> (Arc<Sidecar>, RecordingLines) {
    let lines = RecordingLines::new();
    let sink: Arc<dyn LineSink> = Arc::new(lines.clone());
    (Arc::new(Sidecar::with_default_gate(sink)), lines)
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

/// Stand in for Electron main: empty history, accepted journal writes, nothing
/// recalled. `tools.execute` is deliberately left unanswered by this loop, so the
/// turn stays in flight while the notices arrive — which is exactly when main
/// sends them. The test answers that call itself when it wants the turn to end.
fn answer_host(sidecar: &Arc<Sidecar>, lines: &RecordingLines) {
    let weak = Arc::downgrade(sidecar);
    let lines = lines.clone();
    tokio::spawn(async move {
        let mut handled: HashSet<String> = HashSet::new();
        loop {
            let Some(sidecar) = weak.upgrade() else {
                return;
            };
            for frame in lines.host_calls() {
                let method = frame
                    .pointer("/params/method")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                let answer = match method {
                    "session.get" => json!({ "session": { "messages": [] } }),
                    "session.appendMessage" => json!({ "ok": true }),
                    "memory.recall" => json!({ "memories": [] }),
                    _ => continue,
                };
                let Some(id) = frame["id"].as_str().map(str::to_string) else {
                    continue;
                };
                if !handled.insert(id.clone()) {
                    continue;
                }
                sidecar.bridge().complete(&id, Ok(answer));
            }
            drop(sidecar);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
}

/// The run context `mode-runs.ts` builds from a claimed run.
fn mode_turn(run_id: &str) -> Value {
    json!({
        "runId": run_id,
        "stageId": "implement",
        "origin": "user",
        "enteredStage": true,
        "input": "ship the parser fix",
        "artifactPaths": { "goal": ".pi/runs/run-1/goal.md" },
    })
}

/// A provider that asks for one host tool and then closes: the tool call is what
/// holds the turn open.
fn scripted() -> Value {
    json!({
        "kind": "scripted",
        "script": [
            // The host tool is on demand (not core ⇒ deferred), so the model
            // activates it before calling it.
            { "toolCall": { "id": "call_0", "name": "ToolSearch", "arguments": { "query": "mode_probe" } } },
            { "toolCall": { "id": "call_1", "name": "mode_probe", "arguments": {} } },
            { "text": "done" }
        ]
    })
}

/// A Goal-mode prompt that claims run `run_id` for turn `turn-1`.
fn prompt_params(run_id: &str) -> Value {
    json!({
        "sessionId": "s1",
        "turnId": "turn-1",
        "content": "continue the run",
        "mode": "goal",
        "modeTurn": mode_turn(run_id),
        "tools": [{ "name": "mode_probe", "description": "probe", "parameters": { "type": "object" } }],
        "provider": scripted(),
    })
}

async fn status(sidecar: &Sidecar, id: i64) -> Value {
    call(sidecar, id, "agent.getStatus", json!({ "sessionId": "s1" })).await["result"]["status"]
        .clone()
}

async fn notice(sidecar: &Sidecar, id: i64, params: Value) -> Value {
    call(sidecar, id, "agent.modeTurnNotice", params).await
}

async fn wait_for_idle(sidecar: &Sidecar, session_id: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let status = call(
            sidecar,
            98,
            "agent.getStatus",
            json!({ "sessionId": session_id }),
        )
        .await;
        if status["result"]["status"]["isRunning"] == false {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "the turn never idled");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_claimed_run_turn_is_what_main_s_pause_and_release_notices_apply_to() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);

    let response = call(&sidecar, 1, "agent.prompt", prompt_params("run-1")).await;
    assert!(response.get("error").is_none(), "got: {response}");

    // The claim is in the session's state before the turn does anything: a pause
    // click that lands during the first model request must already find it.
    let claimed = status(&sidecar, 2).await;
    assert_eq!(claimed["modeRun"]["turnId"], "turn-1");
    assert_eq!(claimed["modeRun"]["runId"], "run-1");
    assert_eq!(claimed["modeRun"]["stageId"], "implement");
    assert_eq!(claimed["modeRun"]["closingOut"], false);

    // A turn the kernel is not running, and a run this turn did not claim, are
    // both refused — the Node runtime's two identity checks.
    assert_eq!(
        notice(
            &sidecar,
            3,
            json!({ "sessionId": "s1", "turnId": "turn-2", "runId": "run-1", "action": "closeout" })
        )
        .await["result"]["applied"],
        false,
        "a notice for another turn is not applied"
    );
    assert_eq!(
        notice(
            &sidecar,
            4,
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-2", "action": "closeout" })
        )
        .await["result"]["applied"],
        false,
        "a notice for another run is not applied"
    );

    // The user paused the run: the turn wraps up instead of working on.
    let closeout = notice(
        &sidecar,
        5,
        json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "closeout" }),
    )
    .await;
    assert_eq!(closeout["result"], json!({ "applied": true }));
    assert_eq!(status(&sidecar, 6).await["modeRun"]["closingOut"], true);

    // `beginCloseout` refuses a second closeout of the same turn.
    let again = notice(
        &sidecar,
        7,
        json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "closeout" }),
    )
    .await;
    assert_eq!(again["result"], json!({ "applied": false }));

    // The run was removed: the turn finishes as an ordinary turn of the mode the
    // session returned to, so the run context leaves now.
    let release = notice(
        &sidecar,
        8,
        json!({
            "sessionId": "s1",
            "turnId": "turn-1",
            "runId": "run-1",
            "action": "release",
            "mode": "agent",
            "modeDefinition": { "id": "agent", "stages": [] }
        }),
    )
    .await;
    assert_eq!(release["result"], json!({ "applied": true }));
    let released = status(&sidecar, 9).await;
    assert!(
        released.get("modeRun").is_none(),
        "the run context leaves with the release: {released}"
    );
    // With no run turn left, a late pause notice has nothing to apply to.
    assert_eq!(
        notice(
            &sidecar,
            10,
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "closeout" })
        )
        .await["result"]["applied"],
        false
    );

    // Let the held tool call answer so the turn can finish, then check the gate
    // main relies on: after the turn ends, a notice is a notice too late.
    let pending = lines
        .wait_for_host_call("tools.execute", Duration::from_secs(10))
        .await
        .expect("the scripted tool call reaches the host");
    let call_id = pending["id"].as_str().expect("a host call id").to_string();
    sidecar
        .bridge()
        .complete(&call_id, Ok(json!({ "ok": true, "content": "probed" })));
    wait_for_idle(&sidecar, "s1").await;
    assert_eq!(
        notice(
            &sidecar,
            11,
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "closeout" })
        )
        .await["result"]["applied"],
        false,
        "a turn that already finished cannot be closed out"
    );
}

#[tokio::test]
async fn a_notice_for_a_session_this_process_never_ran_is_not_an_error() {
    let (sidecar, _lines) = sidecar();
    // Main's pause path calls this without knowing which process served the
    // turn; the Node sidecar answers `{ applied: false }` and so does this one.
    let response = notice(
        &sidecar,
        1,
        json!({ "sessionId": "never-ran", "turnId": "turn-1", "runId": "run-1", "action": "closeout" }),
    )
    .await;
    assert!(response.get("error").is_none(), "got: {response}");
    assert_eq!(response["result"], json!({ "applied": false }));
}

#[tokio::test]
async fn a_run_claim_the_kernel_cannot_read_refuses_the_prompt() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);

    let mut missing_paths = prompt_params("run-1");
    missing_paths["modeTurn"] = json!({
        "runId": "run-1",
        "stageId": "implement",
        "origin": "user",
        "enteredStage": true,
        "input": "ship the parser fix",
    });
    let response = call(&sidecar, 1, "agent.prompt", missing_paths).await;
    assert_eq!(response["error"]["code"], -32602, "got: {response}");
    assert_eq!(response["error"]["data"]["errorCode"], "MODE_TURN_INVALID");
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .starts_with("invalid modeTurn:"),
        "got: {response}"
    );

    // A stage id no definition could declare, and an origin main never sends.
    for (field, value) in [
        ("stageId", json!("Implement Stage")),
        ("origin", json!("cron")),
    ] {
        let mut params = prompt_params("run-1");
        params["modeTurn"][field] = value;
        let response = call(&sidecar, 2, "agent.prompt", params).await;
        assert_eq!(
            response["error"]["data"]["errorCode"], "MODE_TURN_INVALID",
            "got: {response}"
        );
    }

    // Nothing started: a refused claim must not leave a turn behind.
    assert_eq!(status(&sidecar, 3).await["isRunning"], false);
}

#[tokio::test]
async fn a_malformed_notice_is_refused_by_name() {
    let (sidecar, lines) = sidecar();
    answer_host(&sidecar, &lines);
    let response = call(&sidecar, 1, "agent.prompt", prompt_params("run-1")).await;
    assert!(response.get("error").is_none(), "got: {response}");

    for (params, error_code) in [
        (
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "pause" }),
            "INVALID_ARGUMENT",
        ),
        (
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "", "action": "closeout" }),
            "INVALID_ARGUMENT",
        ),
        (
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "release", "mode": "Not A Mode" }),
            "MODE_INVALID",
        ),
    ] {
        let response = notice(&sidecar, 2, params.clone()).await;
        assert_eq!(response["error"]["code"], -32602, "got: {response}");
        assert_eq!(
            response["error"]["data"]["errorCode"], error_code,
            "for {params}"
        );
    }

    // The refused notices changed nothing: the run turn is still closeout-able.
    assert_eq!(
        notice(
            &sidecar,
            3,
            json!({ "sessionId": "s1", "turnId": "turn-1", "runId": "run-1", "action": "closeout" })
        )
        .await["result"],
        json!({ "applied": true })
    );
}
