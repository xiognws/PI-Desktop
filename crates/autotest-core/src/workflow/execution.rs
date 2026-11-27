//! Batched dispatch and result aggregation (reusing the executor, not building a
//! second process model).
//!
//! `exec::execute_script` already creates the `executions` row, writes the
//! RunEvent stream and writes the case status back. This layer only runs several
//! scripts in a row and folds the answers into one fixed shape, with stdout and
//! stderr trimmed to something that fits in a conversation.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::ApiResult;
use crate::exec;
use crate::state::AppState;

pub const MAX_TAIL_CHARS: usize = 2_000;
pub const MAX_RESULTS: usize = 200;

fn tail(text: &str) -> String {
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_TAIL_CHARS {
        return text.to_string();
    }
    format!("…{}", chars[chars.len() - MAX_TAIL_CHARS..].iter().collect::<String>())
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Run scripts one after another.
///
/// Serial on purpose: one batch shares a test environment, and running in
/// parallel lets one failure's现场 contaminate the next — which destroys exactly
/// the attribution the agent needs from the log.
pub fn run_scripts(
    state: &AppState,
    db_path: &Path,
    project_id: &str,
    scripts: &[Value],
    timeout_s: f64,
) -> ApiResult<Value> {
    let timeout = Duration::from_secs_f64(timeout_s.max(0.1));
    let mut results: Vec<Value> = Vec::new();
    let mut counts = [("pass", 0i64), ("fail", 0i64), ("error", 0i64), ("cancelled", 0i64)];
    let mut tests = [("pass", 0i64), ("fail", 0i64), ("skip", 0i64)];
    let mut started = 0.0f64;

    for script in scripts.iter().take(MAX_RESULTS) {
        let response = exec::execute_script(state, db_path, project_id, script, timeout)?;
        let raw_status = response
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("error")
            .to_string();
        // The Python executor never reported a `skip` run status: an all-skip
        // pytest run leaves the run at `pass` and the skip is visible in the
        // counts. Folding it the same way keeps the workflow summary identical.
        let status = if raw_status == "skip" {
            "pass".to_string()
        } else {
            raw_status
        };
        let bucket = if counts.iter().any(|entry| entry.0 == status) {
            status.clone()
        } else {
            "error".to_string()
        };
        for entry in counts.iter_mut() {
            if entry.0 == bucket {
                entry.1 += 1;
            }
        }

        let measured = response.get("counts").cloned().unwrap_or_else(|| json!({}));
        let measured_empty = measured.as_object().map(|map| map.is_empty()).unwrap_or(true);
        if !measured_empty {
            for key in ["pass", "fail", "skip"] {
                let value = measured.get(key).and_then(Value::as_i64).unwrap_or(0);
                for entry in tests.iter_mut() {
                    if entry.0 == key {
                        entry.1 += value;
                    }
                }
            }
        } else if status == "pass" {
            tests[0].1 += 1;
        } else if status == "fail" || status == "error" {
            tests[1].1 += 1;
        }

        let duration = response
            .get("duration_ms")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        started += duration;
        results.push(json!({
            "script_id": script.get("id").and_then(Value::as_str).unwrap_or(""),
            "script_name": script.get("name").and_then(Value::as_str).unwrap_or(""),
            "case_id": script.get("case_id").and_then(Value::as_str).unwrap_or(""),
            "execution_id": response.get("execution_id").cloned().unwrap_or(Value::Null),
            "status": status,
            "success": response.get("success").and_then(Value::as_bool).unwrap_or(false),
            "duration_ms": round1(duration),
            "failure": tail(response.get("failure").and_then(Value::as_str).unwrap_or("")),
            "stdout_tail": tail(response.get("stdout").and_then(Value::as_str).unwrap_or("")),
            "stderr_tail": tail(response.get("stderr").and_then(Value::as_str).unwrap_or("")),
        }));
    }

    let test_pass = tests[0].1;
    let test_fail = tests[1].1;
    let test_skip = tests[2].1;
    Ok(json!({
        "results": results,
        "stats": {
            // total / pass / fail count pytest cases; `scripts` keeps the script
            // count, so "36 cases" and "36 scripts" are never conflated.
            "total": test_pass + test_fail + test_skip,
            "pass": test_pass,
            "skip": test_skip,
            "fail": test_fail,
            "error": counts[2].1,
            "cancelled": counts[3].1,
            "scripts": results.len(),
            "duration_ms": round1(started),
        },
    }))
}

pub fn failed_results(payload: &Value) -> Vec<Value> {
    payload
        .get("results")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|item| item.get("status").and_then(Value::as_str) != Some("pass"))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}
