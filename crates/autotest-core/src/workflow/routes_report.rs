//! `POST /runs/{run_id}/report`: failures → bug tickets, one Markdown deliverable,
//! one `reports` row and one knowledge-base archive entry.
//!
//! Split out of `routes_runs` because this is the only place that writes the
//! external artifact, and its rules (skip accounting, coverage section, archive
//! dedupe) are their own subject.

use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::Json;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

use super::routes::{clip_chars, last_payload_or_empty, require_run, run_envelope, Ctx};
use super::{analysis, consistency, execution, prompts, report as report_service, store};

/// `POST /runs/{run_id}/report`
pub async fn build_report(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    let run = require_run(&conn, &run_id)?;

    let explicit = body
        .get("execution_payload")
        .cloned()
        .unwrap_or(Value::Null);
    let payload = if explicit.as_object().map(|map| !map.is_empty()).unwrap_or(false) {
        explicit
    } else {
        store::last_payload(&conn, &run_id, "autotest_run_result")?.unwrap_or(Value::Null)
    };
    if payload.is_null() || payload.as_object().map(|map| map.is_empty()).unwrap_or(true) {
        return Err(ApiError::conflict("还没有执行结果，先调用 execute"));
    }

    let designed = last_payload_or_empty(&conn, &run_id, "autotest_case_design")?;
    let cases_total = designed
        .get("stats")
        .and_then(|stats| stats.get("total"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    // Failure → bug ticket: a deterministic mapping (failed case + the most recent
    // log analysis error type), no model involved.
    let failed_items = execution::failed_results(&payload);
    let log_analysis = last_payload_or_empty(&conn, &run_id, "autotest_log_analyze")?;
    let analysed_type = log_analysis
        .get("error")
        .and_then(|error| error.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    for item in &failed_items {
        let script_name = text_or(&item, "script_name", "script_id");
        if !script_name.is_empty() && store::bug_exists(&conn, &run_id, &script_name)? {
            continue;
        }
        let failure_text = item
            .get("failure")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let status = item.get("status").and_then(Value::as_str).unwrap_or("");
        let reason = failure_reason(&failure_text, &format!("状态 {status}"));
        let error_type = if analysed_type.is_empty() {
            analysis::guess_error_type(&failure_text)
        } else {
            analysed_type.clone()
        };
        let title = format!(
            "{} 失败：{reason}",
            if script_name.is_empty() {
                "未命名脚本"
            } else {
                &script_name
            }
        );
        store::create_bug(
            &conn,
            store::NewBug {
                run_id: &run_id,
                title: &title,
                script_name: &script_name,
                case_id: item.get("case_id").and_then(Value::as_str).unwrap_or(""),
                severity: if status == "error" { "blocker" } else { "major" },
                error_type: &error_type,
                summary: &reason,
                repro: &item
                    .get("execution_id")
                    .map(render_id)
                    .unwrap_or_default(),
            },
        )?;
    }
    let bugs = store::list_bugs(&conn, &run_id)?;

    // Passing case → auto-verify: a signature still sitting in open/fixed means
    // the defect is gone, so it moves to verified.
    let mut verified_bug_ids: Vec<String> = Vec::new();
    if let Some(results) = payload.get("results").and_then(Value::as_array) {
        for item in results {
            if item.get("status").and_then(Value::as_str) != Some("pass") {
                continue;
            }
            let signature = store::bug_signature(
                &text_or(item, "script_name", "script_id"),
                item.get("case_id").and_then(Value::as_str).unwrap_or(""),
            );
            if let Some(bug_id) = store::find_bug_by_signature(&conn, &signature)? {
                store::update_bug_status(&conn, &bug_id, "verified")?;
                store::record_occurrence(
                    &conn,
                    &bug_id,
                    &run_id,
                    &text_or(item, "script_name", "script_id"),
                    &item
                        .get("execution_id")
                        .map(render_id)
                        .unwrap_or_default(),
                )?;
                verified_bug_ids.push(bug_id);
            }
        }
    }

    // Exception coverage comes from case-design: which function points covered
    // which failure modes, and what is still missing evidence.
    let designed = last_payload_or_empty(&conn, &run_id, "autotest_case_design")?;
    let designed_stats = designed
        .get("stats")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let exception_coverage = designed_stats
        .get("exception_matrix")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let exception_gaps = designed_stats
        .get("exception_gaps")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let result = report_service::build_report(report_service::ReportInput {
        run_id: &run_id,
        module: run.get("module").and_then(Value::as_str).unwrap_or(""),
        payload: &payload,
        cases_total,
        requirement: run
            .get("requirement_ref")
            .and_then(Value::as_str)
            .unwrap_or(""),
        bugs: &bugs,
        exception_coverage: &exception_coverage,
        exception_gaps: &exception_gaps,
    });
    let reports_dir = ctx.reports_dir()?;
    let report_name = result["name"].as_str().unwrap_or("report.md");
    let report_path = reports_dir.join(report_name);
    std::fs::write(
        &report_path,
        result["markdown"].as_str().unwrap_or(""),
    )?;

    let counts = result["counts"].clone();
    let pass_rate = result["pass_rate"].as_str().unwrap_or("").to_string();
    let first_execution = payload
        .get("results")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(|item| item.get("execution_id"))
        .and_then(Value::as_i64);
    let report_judgement = consistency::check_report(
        result["markdown"].as_str().unwrap_or(""),
        &counts,
        &pass_rate,
        !(exception_coverage
            .as_object()
            .map(|map| map.is_empty())
            .unwrap_or(true)
            && exception_gaps
                .as_object()
                .map(|map| map.is_empty())
                .unwrap_or(true)),
    );
    let report_id = format!(
        "report_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    conn.execute(
        "INSERT INTO reports (id, name, total, passed, failed, pass_rate, execution_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            report_id,
            report_name,
            counts.get("total").and_then(Value::as_i64).unwrap_or(0),
            counts.get("passed").and_then(Value::as_i64).unwrap_or(0),
            counts.get("failed").and_then(Value::as_i64).unwrap_or(0)
                + counts.get("errored").and_then(Value::as_i64).unwrap_or(0),
            pass_rate,
            first_execution
        ],
    )?;
    let judgement_ok = report_judgement["ok"].as_bool().unwrap_or(false);
    let issues = report_judgement["issues"]
        .as_array()
        .map(|list| list.len())
        .unwrap_or(0);
    let mut step_summary = format!("通过率 {pass_rate}，报告 {report_name}");
    if !judgement_ok {
        step_summary.push_str(&format!("，报告不符合提示词规则 {issues} 处"));
    }
    store::append_step(
        &conn,
        &run_id,
        "autotest_report",
        "reported",
        if judgement_ok { "ok" } else { "warning" },
        &step_summary,
        Some(&json!({
            "report_id": report_id,
            "path": report_path.to_string_lossy(),
            "counts": counts,
            "consistency": report_judgement,
        })),
    )?;
    store::touch_run(&conn, &run_id, Some("reported"), Some("done"))?;

    // The last pipeline step: archive the report into the project knowledge base,
    // so a later project of the same kind can retrieve this round's conclusion.
    // `knowledge_records` is created by `ensure_workflow_tables`, so no knowledge
    // schema work is needed here — the docs table and the FTS index belong to the
    // knowledge routes.
    let archived: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM knowledge_records WHERE project_id = ?1 AND source_ref = ?2 \
             AND record_type = 'run-report' LIMIT 1",
            rusqlite::params![project_id, format!("run:{run_id}")],
            |row| row.get(0),
        )
        .ok();
    let archived_now = archived.is_none();
    if archived_now {
        store::save_knowledge(
            &conn,
            &project_id,
            "run-report",
            &format!("{run_id} 测试报告（通过率 {pass_rate}）"),
            &clip_chars(result["markdown"].as_str().unwrap_or(""), 20_000),
            run.get("module").and_then(Value::as_str).unwrap_or(""),
            &["report".to_string(), "workflow-run".to_string()],
            &format!("run:{run_id}"),
        )?;
    }
    store::append_step(
        &conn,
        &run_id,
        "autotest_report",
        "reported",
        "ok",
        if archived_now {
            "报告已归档到知识库"
        } else {
            "报告已归档过，跳过重复写入"
        },
        Some(&json!({ "knowledge_ref": format!("run:{run_id}") })),
    )?;

    let data = json!({
        "run_id": run_id,
        "report_id": report_id,
        "path": report_path.to_string_lossy(),
        "counts": result["counts"].clone(),
        "pass_rate": pass_rate,
        "bug_ids": bugs
            .iter()
            .filter_map(|bug| bug.get("id").cloned())
            .collect::<Vec<_>>(),
        "verified_bug_ids": verified_bug_ids,
        "preview": clip_chars(result["markdown"].as_str().unwrap_or(""), 400),
        "prompt": prompts::marker_or_error(&ctx.service_root(), "report"),
        "consistency": report_judgement,
    });
    Ok(Json(run_envelope(
        format!("报告已生成：通过率 {pass_rate}"),
        data,
        &run_id,
    )))
}

fn text_or(item: &Value, first: &str, second: &str) -> String {
    item.get(first)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| item.get(second).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn render_id(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Pick the line a human would quote from a failure block.
///
/// The first line of a pytest failure block is the `____ test_name ____`
/// decoration, so taking the first line makes the bug title a row of underscores.
/// The assertion line (`E   assert …`) wins, then an exception line, then the first
/// line with content.
fn failure_reason(text: &str, fallback: &str) -> String {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.trim_end_matches(['\r', ' ', '\t']))
        .collect();
    for line in lines.iter().rev() {
        // `^E\s+(.+)$` — an assertion line, whatever the indent convention.
        if let Some(rest) = line.strip_prefix('E') {
            let rest = rest.trim_start();
            if rest.len() < line.len() - 1 {
                let value = rest.trim();
                if !value.is_empty() {
                    return clip_chars(value, 200);
                }
            }
        }
    }
    for line in lines.iter().rev() {
        let trimmed = line.trim();
        if is_exception_line(trimmed) {
            return clip_chars(trimmed, 200);
        }
    }
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.chars().all(|ch| "_= ".contains(ch)) {
            continue;
        }
        return clip_chars(trimmed, 200);
    }
    fallback.to_string()
}

/// `^([A-Za-z_][\w.]*(?:Error|Exception))(?::\s*(.*))?$`
fn is_exception_line(line: &str) -> bool {
    let head: String = line
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '.')
        .collect();
    if head.is_empty() {
        return false;
    }
    if !(head.ends_with("Error") || head.ends_with("Exception")) {
        return false;
    }
    let rest = &line[head.len()..];
    if rest.is_empty() {
        return true;
    }
    rest.starts_with(':')
}
