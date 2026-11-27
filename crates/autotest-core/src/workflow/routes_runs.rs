//! Runs, bugs and the report.
//!
//! Dispatching a batch, folding the results into the ledger, turning failures into
//! bug tickets, and building the one deliverable a customer reads.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

use super::routes::{
    clip_chars, field_f64, field_strings, field_text, last_payload_or_empty, require_run,
    run_envelope, Ctx,
};
use super::{execution, store};

/// `POST /runs/{run_id}/execute`
///
/// Dispatch only: a background thread runs the batch and the caller polls the run
/// status, because a real pytest batch takes minutes.
pub async fn execute_run(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let timeout_s = field_f64(&body, "timeout_s", 60.0);
    let rows: Vec<Value>;
    let script_ids: Vec<String>;
    {
        let conn = ctx.conn()?;
        require_run(&conn, &run_id)?;
        let authored = last_payload_or_empty(&conn, &run_id, "autotest_script_author")?;
        let mut candidates: Vec<String> = if body
            .get("script_ids")
            .and_then(Value::as_array)
            .map(|list| !list.is_empty())
            .unwrap_or(false)
        {
            // Explicit ids: hand-added scripts, or re-running only the failures,
            // both come through this path.
            field_strings(&body, "script_ids")
        } else {
            authored
                .get("scripts")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|item| {
                            item.get("script_id")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                                .map(|value| value.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        candidates.retain(|item| !item.is_empty());
        if candidates.is_empty() {
            return Err(ApiError::conflict("还没有可执行的脚本，先调用 script-author"));
        }

        let placeholders = vec!["?"; candidates.len()].join(",");
        let sql = format!("SELECT * FROM scripts WHERE id IN ({placeholders})");
        rows = db::query_rows(&conn, &sql, rusqlite::params_from_iter(&candidates))?;
        store::append_step(
            &conn,
            &run_id,
            "autotest_run",
            "authored",
            "running",
            &format!("投递 {} 个脚本", rows.len()),
            Some(&json!({ "script_ids": candidates })),
        )?;
        // Re-running (after fixing a script) has to pull the run out of `done`
        // back to `running`, or the panel keeps showing a finished stage.
        store::touch_run(&conn, &run_id, None, Some("running"))?;
        script_ids = candidates;
    }

    let thread_state = Arc::clone(&state);
    let thread_project = project_id.clone();
    let thread_run = run_id.clone();
    let thread_dir = ctx.dir.clone();
    let thread_rows = rows.clone();
    std::thread::Builder::new()
        .name(format!("wf-run-{run_id}"))
        .spawn(move || {
            run_batch_thread(
                thread_state,
                thread_dir,
                thread_project,
                thread_run,
                thread_rows,
                timeout_s,
            )
        })
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let data = json!({
        "run_id": run_id,
        "status": "started",
        "script_total": rows.len(),
        "script_ids": script_ids.iter().take(10).cloned().collect::<Vec<_>>(),
    });
    Ok(Json(run_envelope(
        format!("已投递 {} 个脚本，轮询 run 状态获取结果", rows.len()),
        data,
        &run_id,
    )))
}

/// The background batch. It must open its own connection — the request thread's
/// connection is gone by the time the batch runs.
fn run_batch_thread(
    state: Arc<AppState>,
    project_dir: PathBuf,
    project_id: String,
    run_id: String,
    rows: Vec<Value>,
    timeout_s: f64,
) {
    let db_path = project_dir.join("data.db");
    let payload = match execution::run_scripts(&state, &db_path, &project_id, &rows, timeout_s) {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(run_id = %run_id, detail = %error.detail, "workflow run failed");
            return;
        }
    };
    let conn = match db::open(&db_path) {
        Ok(conn) => conn,
        Err(error) => {
            tracing::warn!(run_id = %run_id, detail = %error.detail, "workflow run db reopen failed");
            return;
        }
    };
    if let Err(error) = store::ensure_workflow_tables(&conn) {
        tracing::warn!(run_id = %run_id, detail = %error.detail, "workflow tables");
        return;
    }
    let stats = payload["stats"].clone();
    let fail = stats["fail"].as_i64().unwrap_or(0);
    let error_count = stats["error"].as_i64().unwrap_or(0);
    let step_status = if fail == 0 && error_count == 0 {
        "ok"
    } else {
        "warning"
    };
    let scripts = stats["scripts"].as_i64().unwrap_or(0);
    let total = stats["total"].as_i64().unwrap_or(0);
    let pass = stats["pass"].as_i64().unwrap_or(0);
    let skip = stats["skip"].as_i64().unwrap_or(0);
    // Close the `autotest_run` step recorded at dispatch time first, then record
    // the outcome separately: otherwise the step list keeps one entry "running"
    // forever and both the panel and a polling agent believe work is in flight.
    if let Err(error) = store::close_latest_step(
        &conn,
        &run_id,
        "autotest_run",
        step_status,
        Some(&format!("跑完 {scripts} 个脚本、{total} 条用例，通过 {pass}")),
    ) {
        tracing::warn!(run_id = %run_id, detail = %error.detail, "close step");
    }
    let result_summary = format!(
        "{pass}/{total_asserted} 通过（{skip} 条骨架跳过），失败 {fail}，异常 {error_count}",
        total_asserted = total - skip
    );
    if let Err(error) = store::append_step(
        &conn,
        &run_id,
        "autotest_run_result",
        "executed",
        step_status,
        &result_summary,
        Some(&payload),
    ) {
        tracing::warn!(run_id = %run_id, detail = %error.detail, "append result");
    }
    if let Err(error) = store::touch_run(&conn, &run_id, Some("executed"), None) {
        tracing::warn!(run_id = %run_id, detail = %error.detail, "touch run");
    }
}

/// `GET /bugs`
pub async fn project_bugs(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let status = query
        .get("status")
        .filter(|value| !value.is_empty())
        .cloned();
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(100);
    let conn = ctx.conn()?;
    let bugs = store::list_project_bugs(&conn, &project_id, status.as_deref(), limit)?;
    let summary = match &status {
        Some(value) => format!("{} 条缺陷单（{value}）", bugs.len()),
        None => format!("{} 条缺陷单", bugs.len()),
    };
    Ok(Json(json!({
        "ok": true,
        "summary": summary,
        "data": { "bugs": bugs, "total": bugs.len() },
    })))
}

/// `PATCH /bugs/{bug_id}` — project level, because a bug is one merged ticket
/// across runs.
pub async fn update_project_bug(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, bug_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let status = field_text(&body, "status");
    let conn = ctx.conn()?;
    if !store::bug_in_project(&conn, &bug_id, &project_id)? {
        return Err(ApiError::not_found(format!(
            "项目里没有这条缺陷单: {bug_id}"
        )));
    }
    store::update_bug_status(&conn, &bug_id, &status)?;
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{bug_id} → {status}"),
        "data": { "bug_id": bug_id, "status": status },
    })))
}

/// `POST /bugs/status` — batch transition.
///
/// Handled per ticket with per-ticket reporting: one missing ticket or one illegal
/// status must not roll back the whole batch, or the user has to redo the ones that
/// already worked.
pub async fn update_project_bugs_batch(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let status = field_text(&body, "status");
    let ids: Vec<String> = field_strings(&body, "ids")
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if ids.is_empty() {
        return Err(ApiError::bad_request("ids 不能为空"));
    }
    if ids.len() > 200 {
        return Err(ApiError::bad_request("一次最多改 200 张缺陷单"));
    }

    let conn = ctx.conn()?;
    let mut updated: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for bug_id in &ids {
        if !store::bug_in_project(&conn, bug_id, &project_id)? {
            failed.push(json!({ "id": bug_id, "reason": "项目里没有这条缺陷单" }));
            continue;
        }
        match store::update_bug_status(&conn, bug_id, &status) {
            Ok(_) => updated.push(bug_id.clone()),
            Err(error) => failed.push(json!({ "id": bug_id, "reason": error.detail })),
        }
    }
    let mut summary = format!("{} 张缺陷单 → {status}", updated.len());
    if !failed.is_empty() {
        summary.push_str(&format!("，{} 张失败", failed.len()));
    }
    Ok(Json(json!({
        "ok": true,
        "summary": summary,
        "data": { "updated": updated, "failed": failed, "status": status },
    })))
}

/// `GET /runs/{run_id}/bugs`
pub async fn run_bugs(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    require_run(&conn, &run_id)?;
    let bugs = store::list_bugs(&conn, &run_id)?;
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{} 条缺陷单", bugs.len()),
        "data": { "bugs": bugs, "total": bugs.len() },
    })))
}

/// `PATCH /runs/{run_id}/bugs/{bug_id}`
pub async fn update_bug(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id, bug_id)): UrlPath<(String, String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let status = field_text(&body, "status");
    let conn = ctx.conn()?;
    require_run(&conn, &run_id)?;
    if !store::bug_visible_in_run(&conn, &bug_id, &run_id)? {
        return Err(ApiError::not_found(format!("这个运行里没有缺陷单: {bug_id}")));
    }
    store::update_bug_status(&conn, &bug_id, &status)?;
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{bug_id} → {status}"),
        "data": { "bug_id": bug_id, "status": status },
    })))
}

/// `GET /runs/{run_id}/report-content` — the markdown the report step recorded.
pub async fn report_content(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let payload;
    {
        let conn = ctx.conn()?;
        require_run(&conn, &run_id)?;
        payload = store::find_payload(&conn, &run_id, "autotest_report", "path")?
            .unwrap_or_else(|| json!({}));
    }
    let raw_path = payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if raw_path.is_empty() {
        return Err(ApiError::conflict("这次运行还没有生成报告"));
    }
    let reports_dir = ctx.reports_dir()?.canonicalize().unwrap_or_else(|_| ctx.dir.join("reports"));
    let target = PathBuf::from(&raw_path);
    let target = target.canonicalize().unwrap_or(target);
    if !target.starts_with(&reports_dir) || !target.is_file() {
        return Err(ApiError::not_found("报告文件不存在"));
    }
    let markdown = std::fs::read_to_string(&target).unwrap_or_default();
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let chars = markdown.chars().count();
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{name}（{chars} 字符）"),
        "data": {
            "name": name,
            "markdown": clip_chars(&markdown, 20_000),
            "chars": chars,
        },
    })))
}

/// `GET /runs/{run_id}/status` — the agent's summary view: steps, waits and
/// execution stats, without the big payloads.
pub async fn run_status(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let run;
    let executed;
    let bug_count;
    {
        let conn = ctx.conn()?;
        run = require_run(&conn, &run_id)?;
        executed = last_payload_or_empty(&conn, &run_id, "autotest_run_result")?;
        bug_count = store::list_bugs(&conn, &run_id)?.len();
    }

    let steps: Vec<Value> = run
        .get("steps")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|step| {
                    json!({
                        "seq": step.get("seq").cloned().unwrap_or(Value::Null),
                        "tool": step.get("tool").cloned().unwrap_or(Value::Null),
                        "stage": step.get("stage").cloned().unwrap_or(Value::Null),
                        "status": step.get("status").cloned().unwrap_or(Value::Null),
                        "summary": step.get("summary").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let pending: Vec<Value> = run
        .get("pending")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|item| {
                    json!({
                        "decision_id": item.get("id").cloned().unwrap_or(Value::Null),
                        "prompt": item.get("prompt").cloned().unwrap_or(Value::Null),
                        "options": item.get("options").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let stats = executed
        .get("stats")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let failures: Vec<Value> = execution::failed_results(&executed)
        .iter()
        .take(5)
        .map(|item| {
            json!({
                "script_name": item.get("script_name").cloned().unwrap_or(Value::Null),
                "status": item.get("status").cloned().unwrap_or(Value::Null),
                "failure": clip_chars(item.get("failure").and_then(Value::as_str).unwrap_or(""), 200),
            })
        })
        .collect();

    let stage = run.get("stage").cloned().unwrap_or(Value::Null);
    let status = run.get("status").cloned().unwrap_or(Value::Null);
    let data = json!({
        "run_id": run_id,
        "stage": stage,
        "status": status,
        "steps": steps,
        "pending": pending,
        "execution": assertion_counts(&stats),
        "failures": failures,
        "bugs": bug_count,
    });
    let mut summary = format!(
        "阶段 {} / 状态 {} / 步骤 {} 条",
        stage_text(&stage),
        stage_text(&status),
        steps.len()
    );
    if stats.as_object().map(|map| !map.is_empty()).unwrap_or(false) {
        summary.push_str(&format!(
            " / 通过 {}/{}",
            stats.get("pass").map(render).unwrap_or_else(|| "None".to_string()),
            stats.get("total").map(render).unwrap_or_else(|| "None".to_string())
        ));
    }
    Ok(Json(run_envelope(summary, data, &run_id)))
}

fn stage_text(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

/// Add the "real assertions / skeletons" split to the execution stats.
///
/// The existing convention is `total = pass + fail + skip` with `passed` counting
/// skips, so "34/34 passed" also holds when every script is a skeleton. The panel
/// and the report need to say "N of them actually ran an assertion", which needs
/// its own number.
fn assertion_counts(stats: &Value) -> Value {
    if stats.as_object().map(|map| map.is_empty()).unwrap_or(true) {
        return stats.clone();
    }
    let total = stats.get("total").and_then(Value::as_i64).unwrap_or(0);
    let skipped = stats.get("skip").and_then(Value::as_i64).unwrap_or(0);
    let mut enriched = match stats {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    enriched.insert("asserted_cases".to_string(), json!((total - skipped).max(0)));
    enriched.insert("skeleton_cases".to_string(), json!(skipped));
    Value::Object(enriched)
}
