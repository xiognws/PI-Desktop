//! The design stages: requirement → cases → review → scripts.
//!
//! `prd-parse`, `case-design`, `case-review`, `log-analyze` and `script-author`
//! all follow the same shape: read the run, call the deterministic service, write
//! the ledger step, answer with the envelope. The Chinese summaries are contract
//! text — the panel and the fixtures compare them literally.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::error::{ApiError, ApiResult};
use crate::exec;
use crate::state::AppState;

use super::routes::{
    clip_chars, envelope, field_bool, field_opt, field_text, last_payload_or_empty, require_run,
    run_envelope, Ctx,
};
use super::{
    analysis, cases as case_service, consistency, exception_matrix, extract, grounding, persist,
    prd as prd_service, prompts, review as review_service, store,
};

/// `POST /prd-parse`
pub async fn prd_parse(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let mut text = field_text(&body, "text");
    if text.is_empty() {
        if let Some(reference) = field_opt(&body, "requirement_ref").filter(|item| !item.is_empty())
        {
            text = read_requirement_text(&ctx, &reference)?;
        }
    }
    if text.trim().is_empty() {
        return Err(ApiError::bad_request("text 与 requirement_ref 至少提供一个"));
    }

    let module = field_text(&body, "module");
    let result = prd_service::parse_prd(&text, &module);
    let function_points = result["function_points"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let fp_count = function_points.len();
    let risk_count = result["risks"]
        .as_array()
        .map(|list| list.len())
        .unwrap_or(0);

    let conn = ctx.conn()?;
    let run_id = match field_opt(&body, "run_id").filter(|item| !item.is_empty()) {
        Some(run_id) => run_id,
        None => store::create_run(
            &conn,
            &project_id,
            &module,
            &field_text(&body, "requirement_ref"),
            &field_text(&body, "session_id"),
        )?,
    };
    store::append_step(
        &conn,
        &run_id,
        "autotest_prd_parse",
        "parsed",
        "ok",
        &format!("解析出 {fp_count} 个功能点"),
        Some(&result),
    )?;
    store::touch_run(&conn, &run_id, Some("parsed"), None)?;
    let run = store::get_run(&conn, &run_id)?.unwrap_or_else(|| json!({}));

    let data = json!({
        "run_id": run_id,
        "function_points": function_points.iter().take(10).cloned().collect::<Vec<_>>(),
        "function_point_total": fp_count,
        "non_functional": take(result["non_functional"].clone(), 5),
        "dependencies": take(result["dependencies"].clone(), 5),
        "risks": take(result["risks"].clone(), 5),
        "stats": result["stats"].clone(),
        "stage": run.get("stage").cloned().unwrap_or(Value::Null),
        "prompt": prompts::marker_or_error(&ctx.service_root(), "prd-parse"),
    });
    Ok(Json(run_envelope(
        format!("解析出 {fp_count} 个功能点、{risk_count} 条风险"),
        data,
        &run_id,
    )))
}

fn take(value: Value, limit: usize) -> Value {
    match value {
        Value::Array(list) => Value::Array(list.into_iter().take(limit).collect()),
        other => other,
    }
}

/// `POST /case-design`
pub async fn case_design(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let run_id = field_text(&body, "run_id");
    let conn = ctx.conn()?;
    let run = require_run(&conn, &run_id)?;

    let mut prd_result = match body.get("prd_result") {
        Some(Value::Null) | None => Value::Null,
        Some(value) if value.as_object().map(|map| map.is_empty()).unwrap_or(false) => Value::Null,
        Some(value) => value.clone(),
    };
    if prd_result.is_null() {
        prd_result = last_payload_or_empty(&conn, &run_id, "autotest_prd_parse")?;
    }
    if prd_result.is_null() || prd_result.as_object().map(|map| map.is_empty()).unwrap_or(true) {
        return Err(ApiError::conflict("还没有 PRD 解析结果，先调用 prd-parse"));
    }

    // Find evidence for every function point first: a clause with numbers gives
    // concrete steps and thresholds; without one the case falls back to the
    // template and is marked ungrounded so the UI shows which ones are still bare.
    let function_points: Vec<Value> = prd_result
        .get("function_points")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let evidence = grounding::collect(&conn, &project_id, &function_points, 8);
    // "No evidence" has three causes and the UI can only tell the user what to
    // add if they stay apart.
    let reasons = grounding::diagnose(&conn, &project_id, &function_points, 8);

    let types = match body.get("types").and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    let template = {
        let value = field_text(&body, "template");
        if value.is_empty() {
            "standard".to_string()
        } else {
            value
        }
    };
    let result = case_service::design_cases(case_service::DesignInput {
        prd_result: &prd_result,
        types: &types,
        template: &template,
        evidence: &evidence,
        reasons: &reasons,
        skip_ungrounded: field_bool(&body, "skip_ungrounded", true),
        exception_budget: exception_matrix::DEFAULT_EXCEPTION_BUDGET,
    });
    let designed_cases = result["cases"].as_array().cloned().unwrap_or_default();

    // The prompt's hard rules become judgeable problems here; a failing rule is
    // not silently dropped — the verdict lands in the payload for the review
    // stage and the agent to see.
    let judgement = consistency::check_cases(&designed_cases);
    let module = run
        .get("module")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let case_ids = persist::persist_designed_cases(&conn, &module, &designed_cases)?;
    let titles: Vec<String> = case_ids.iter().map(|(title, _)| title.clone()).collect();
    // Empty shells from an earlier round that are skipped this time must leave
    // the library, or they keep looking like coverage for that function point.
    let removed = persist::drop_stale_ungrounded(&conn, &module, &titles)?;
    let superseded = persist::drop_superseded_generic_exception(&conn, &module, &titles)?;

    let mut result = result;
    result["stats"]["removed_stale"] = json!(removed);
    result["stats"]["removed_generic_exception"] = json!(superseded);
    let mut id_map = Map::new();
    for (title, case_id) in &case_ids {
        id_map.insert(title.clone(), json!(case_id));
    }
    result["case_ids"] = Value::Object(id_map);
    result["consistency"] = judgement.clone();
    result["prompt"] = prompts::marker_or_error(&ctx.service_root(), "case-design");

    let stats = result["stats"].clone();
    let total = stats["total"].as_i64().unwrap_or(0);
    let strong = stats["grounding"]["strong"].as_i64().unwrap_or(0);
    let weak = stats["grounding"]["weak"].as_i64().unwrap_or(0);
    let none = stats["grounding"]["none"].as_i64().unwrap_or(0);
    let skipped = stats["skipped"].as_i64().unwrap_or(0);
    let issues = judgement["issues"].as_array().map(|list| list.len()).unwrap_or(0);
    let judgement_ok = judgement["ok"].as_bool().unwrap_or(false);

    let mut step_summary = format!("生成 {total} 条用例（有依据 {strong} 条，仅条款 {weak} 条）");
    if skipped != 0 {
        step_summary.push_str(&format!("，跳过 {skipped} 条无依据用例待补资料"));
    }
    if !judgement_ok {
        step_summary.push_str(&format!("，不符合提示词规则 {issues} 处"));
    }
    store::append_step(
        &conn,
        &run_id,
        "autotest_case_design",
        "designed",
        if judgement_ok { "ok" } else { "warning" },
        &step_summary,
        Some(&result),
    )?;
    store::touch_run(&conn, &run_id, Some("designed"), None)?;
    let run = store::get_run(&conn, &run_id)?.unwrap_or_else(|| json!({}));

    let by_type_kinds = stats["by_type"].as_object().map(|map| map.len()).unwrap_or(0);
    let data = json!({
        "run_id": run_id,
        "case_total": total,
        "by_type": stats["by_type"].clone(),
        "grounding": stats["grounding"].clone(),
        "reasons": stats.get("reasons").cloned().unwrap_or_else(|| json!({})),
        "uncovered": stats.get("uncovered").cloned().unwrap_or_else(|| json!([])),
        "exception_matrix": stats.get("exception_matrix").cloned().unwrap_or_else(|| json!({})),
        "exception_gaps": stats.get("exception_gaps").cloned().unwrap_or_else(|| json!({})),
        "by_exception_class": stats.get("by_exception_class").cloned().unwrap_or_else(|| json!({})),
        "consistency": result["consistency"].clone(),
        "prompt": result["prompt"].clone(),
        "skipped": skipped,
        "removed_stale": removed,
        "preview": designed_cases.iter().take(5).cloned().collect::<Vec<_>>(),
        "stats": stats,
        "stage": run.get("stage").cloned().unwrap_or(Value::Null),
    });
    Ok(Json(run_envelope(
        format!(
            "生成 {total} 条用例（{by_type_kinds} 种类型），其中有知识库依据 {strong} 条、仅条款无参数 {weak} 条、无依据 {none} 条"
        ),
        data,
        &run_id,
    )))
}

/// `POST /case-review`
pub async fn case_review(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let run_id = field_text(&body, "run_id");
    let conn = ctx.conn()?;
    let run = require_run(&conn, &run_id)?;

    let cases = match body.get("cases").and_then(Value::as_array) {
        Some(list) => list.clone(),
        None => last_payload_or_empty(&conn, &run_id, "autotest_case_design")?
            .get("cases")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };
    let module = {
        let given = field_text(&body, "module");
        if given.is_empty() {
            run.get("module")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            given
        }
    };
    let result = review_service::review_cases(&cases, &module);
    let review_judgement = consistency::check_review(&result, &cases);
    let verdict = result["verdict"].as_str().unwrap_or("").to_string();
    let untestable = result["untestable"].as_array().map(|list| list.len()).unwrap_or(0);
    let duplicates = result["duplicates"].as_array().map(|list| list.len()).unwrap_or(0);
    let coverage_kinds = review_judgement["exception_coverage"]
        .as_object()
        .map(|map| map.len())
        .unwrap_or(0);
    let rule_issues = review_judgement["issues"]
        .as_array()
        .map(|list| list.len())
        .unwrap_or(0);
    let judgement_ok = review_judgement["ok"].as_bool().unwrap_or(false);

    let prompt = prompts::marker_or_error(&ctx.service_root(), "case-review");
    let payload = merge(
        &result,
        vec![
            ("prompt", prompt.clone()),
            ("consistency", review_judgement.clone()),
        ],
    );
    store::append_step(
        &conn,
        &run_id,
        "autotest_case_review",
        "reviewed",
        if verdict == "ok" && judgement_ok {
            "ok"
        } else {
            "warning"
        },
        &{
            let mut summary =
                format!("评审结论 {verdict}，不可测 {untestable} 条");
            if !judgement_ok {
                summary.push_str(&format!("，结论不符合提示词规则 {rule_issues} 处"));
            }
            summary
        },
        Some(&payload),
    )?;
    store::touch_run(&conn, &run_id, Some("reviewed"), None)?;

    // A rule failure has to appear in the summary: "verdict ok" alone reads as a
    // clean review while three exception cases may have no failure mode at all.
    let rule_note = if judgement_ok {
        String::new()
    } else {
        format!("、规则不通过 {rule_issues} 处")
    };
    let data = merge(
        &result,
        vec![
            ("run_id", json!(run_id)),
            ("prompt", prompt),
            ("consistency", review_judgement.clone()),
            (
                "exception_coverage",
                review_judgement
                    .get("exception_coverage")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ),
        ],
    );
    Ok(Json(run_envelope(
        format!(
            "评审结论 {verdict}：不可测 {untestable} 条、重复 {duplicates} 条、异常覆盖 {coverage_kinds} 类{rule_note}"
        ),
        data,
        &run_id,
    )))
}

fn merge(base: &Value, extra: Vec<(&str, Value)>) -> Value {
    let mut map = match base {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in extra {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// `POST /log-analyze`
pub async fn log_analyze(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let mut raw = field_text(&body, "raw_log");
    let execution_id = body.get("execution_id").and_then(Value::as_i64);
    if raw.trim().is_empty() {
        if let Some(id) = execution_id {
            raw = execution_events_text(&ctx, id)?;
        }
    }
    if raw.trim().is_empty() {
        return Err(ApiError::bad_request("raw_log 与 execution_id 至少提供一个"));
    }

    let result = analysis::analyze_log(&raw, &field_text(&body, "trace_id"), &field_text(&body, "module"));
    if let Some(run_id) = field_opt(&body, "run_id").filter(|item| !item.is_empty()) {
        let conn = ctx.conn()?;
        if store::get_run(&conn, &run_id)?.is_some() {
            let has_error = result
                .get("error")
                .map(|value| !value.is_null())
                .unwrap_or(false);
            store::append_step(
                &conn,
                &run_id,
                "autotest_log_analyze",
                "executed",
                if has_error { "warning" } else { "ok" },
                &clip_chars(result["summary"].as_str().unwrap_or(""), 120),
                Some(&result),
            )?;
            store::touch_run(&conn, &run_id, Some("executed"), None)?;
        }
    }

    let data = json!({
        "run_id": body.get("run_id").cloned().unwrap_or(Value::Null),
        "execution_id": execution_id.map(Value::from).unwrap_or(Value::Null),
        "summary": result["summary"].clone(),
        "error": result["error"].clone(),
        "suspects": result["suspects"].clone(),
        "suggestions": result["suggestions"].clone(),
        "stats": result["stats"].clone(),
        "prompt": prompts::marker_or_error(&ctx.service_root(), "log-analyze"),
    });
    Ok(Json(envelope(
        clip_chars(result["summary"].as_str().unwrap_or(""), 160),
        data,
        &field_text(&body, "run_id"),
        "run",
    )))
}

/// Flatten one execution's RunEvent stream into text, for a log analysis that was
/// not given a raw log.
fn execution_events_text(ctx: &Ctx, execution_id: i64) -> ApiResult<String> {
    let events = exec::read_events(&ctx.db_path(), execution_id.max(0) as u32)?;
    let mut lines: Vec<String> = Vec::new();
    for event in events {
        let mut matched = false;
        // The executor puts stdout/stderr in step_end's detail: that is the
        // failure scene.
        if let Some(detail) = event.get("detail").and_then(Value::as_object) {
            for key in ["stderr", "stdout"] {
                if let Some(value) = detail.get(key).and_then(Value::as_str) {
                    if !value.trim().is_empty() {
                        lines.push(value.to_string());
                        matched = true;
                        break;
                    }
                }
            }
        }
        if matched {
            continue;
        }
        for key in ["line", "message", "text", "output"] {
            if let Some(value) = event.get(key).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    lines.push(value.to_string());
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            lines.push(event.to_string());
        }
    }
    Ok(lines.join("\n"))
}

/// Candidates for one requirement document: the requirements table first, then
/// `specs/` and `requirements/` inside the project.
fn read_requirement_text(ctx: &Ctx, reference: &str) -> ApiResult<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let db_path = ctx.db_path();
    if db_path.exists() {
        if let Ok(conn) = crate::db::open(&db_path) {
            let row = crate::db::query_one(
                &conn,
                "SELECT filepath FROM requirements WHERE filename = ?1 OR id = ?1",
                [reference],
            )?;
            if let Some(path) = row
                .and_then(|row| row.get("filepath").and_then(Value::as_str).map(|item| item.to_string()))
                .filter(|item| !item.is_empty())
            {
                candidates.push(PathBuf::from(path));
            }
        }
    }
    for folder in ["specs", "requirements"] {
        candidates.push(ctx.dir.join(folder).join(reference));
    }
    for candidate in candidates {
        if candidate.is_file() {
            let filename = candidate
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| reference.to_string());
            return extract::extract_text(&candidate, &filename, &ctx.service_root());
        }
    }
    Err(ApiError::not_found(format!("需求文档不存在: {reference}")))
}
