//! `POST /script-author`: cases → pytest files on disk + rows in `scripts`.
//!
//! Split out of `routes_design` because it carries the contract-driven assertion
//! generation, the "never overwrite a hand-filled script" rule and the vacuity
//! probe — three behaviours that deserve their own file.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as UrlPath, State};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::config;
use crate::error::{ApiError, ApiResult};
use crate::script_state;
use crate::state::AppState;

use super::routes::{
    field_bool, field_text, last_payload_or_empty, require_run, run_envelope, Ctx,
};
use super::{
    assertion_gen, consistency, dut_contract, prompts, scripts as script_service, store, vacuity,
};

/// The interpreter used for the vacuity probe and for container documents.
fn python_executable(service_root: &PathBuf) -> PathBuf {
    if let Ok(explicit) = std::env::var("AUTOTEST_PYTHON") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    config::python_executable(service_root).unwrap_or_else(|| PathBuf::from("python"))
}

/// `POST /script-author` — cases → pytest skeletons, plus the scripts table row
/// and the file on disk.
///
/// The executor reads the scripts table (`filepath` points at a real file), so
/// the row has to land before a run can be dispatched.
pub async fn script_author(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let run_id = field_text(&body, "run_id");
    let conn = ctx.conn()?;
    require_run(&conn, &run_id)?;

    let designed = last_payload_or_empty(&conn, &run_id, "autotest_case_design")?;
    let cases = match body.get("cases").and_then(Value::as_array) {
        Some(list) => list.clone(),
        None => designed
            .get("cases")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };
    if cases.is_empty() {
        return Err(ApiError::conflict("还没有用例，先调用 case-design"));
    }
    // case-design returns "title → case id" after persisting: the script's case_id
    // should point at the real case, and older data (case_id holds a title) keeps
    // working through the title fallback.
    let case_ids: BTreeMap<String, String> = designed
        .get("case_ids")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let scripts_dir = ctx.scripts_dir()?;
    // With a DUT contract the assertions can be generated; cases without one stay
    // skeletons and are reported as "missing an interface".
    let contract = dut_contract::load(&conn, &project_id)?;
    let mut assertions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut contract_notes: Vec<Value> = Vec::new();
    for case in &cases {
        let function_point = case
            .get("function_point")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let title = case
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(entry) = contract.resolve(&function_point) else {
            contract_notes.push(json!({
                "title": title,
                "function_point": function_point,
                "reason": "missing_contract",
            }));
            continue;
        };
        // Exception cases use the negative polarity: feed an out-of-range value and
        // assert the DUT rejects it. Without a `raises` contract nothing is
        // generated, rather than a fake assertion.
        let polarity = if case.get("case_type").and_then(Value::as_str) == Some("异常") {
            Some("negative")
        } else {
            None
        };
        match assertion_gen::generate(case, entry, &contract.driver, &contract.imports, polarity) {
            Ok(generated) => {
                assertions.insert(title, generated.body);
            }
            Err(problem) => contract_notes.push(json!({
                "title": title,
                "function_point": function_point,
                "reason": problem.0,
            })),
        }
    }

    let sdk = {
        let value = field_text(&body, "sdk");
        if value.is_empty() {
            "pytest".to_string()
        } else {
            value
        }
    };
    let authored = script_service::author_scripts(&cases, &sdk, &assertions)
        .map_err(ApiError::internal)?;
    let mut asserted_by_type: Vec<(String, i64)> = Vec::new();
    for case in &cases {
        let title = case.get("title").and_then(Value::as_str).unwrap_or("");
        if assertions.contains_key(title) {
            let key = case
                .get("case_type")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("功能")
                .to_string();
            if let Some(entry) = asserted_by_type.iter_mut().find(|entry| entry.0 == key) {
                entry.1 += 1;
            } else {
                asserted_by_type.push((key, 1));
            }
        }
    }
    // Only "missing contract" is counted here — a contract that exists but whose
    // clause has no number is a different problem, and mixing them inflates the
    // number the summary reports.
    let missing_notes: Vec<Value> = contract_notes
        .iter()
        .filter(|note| note.get("reason").and_then(Value::as_str) == Some("missing_contract"))
        .cloned()
        .collect();
    let mut missing_points: Vec<String> = missing_notes
        .iter()
        .filter_map(|note| note.get("function_point").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .collect();
    missing_points.sort();
    missing_points.dedup();
    let no_number_notes: Vec<Value> = contract_notes
        .iter()
        .filter(|note| {
            note.get("reason")
                .and_then(Value::as_str)
                .map(|reason| reason.starts_with("用例没有条款数值"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    // Script rules have to be judgeable too: a skeleton written as `assert True`
    // or one that forgets to skip runs green the moment the executor collects it.
    let authored_scripts = authored["scripts"].as_array().cloned().unwrap_or_default();
    let script_judgement = consistency::check_scripts(&authored_scripts);

    let overwrite = field_bool(&body, "overwrite", false);
    let mut created: Vec<Value> = Vec::new();
    let mut preserved: Vec<String> = Vec::new();
    for item in &authored_scripts {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let filepath = scripts_dir.join(name);
        // A script that already carries assertions is not overwritten by a
        // skeleton: re-generating cases would throw away days of hand-filling, and
        // "regenerate" is one click in the pipeline.
        let mut keep_file = false;
        if !overwrite && filepath.is_file() {
            let current =
                script_state::classify(&script_state::read_script_text(&filepath.to_string_lossy()));
            keep_file = current.state == "asserted";
        }
        if keep_file {
            // The file stays, but the association is refreshed: case ids change
            // when cases are re-designed and a stale case_id makes a good script an
            // orphan.
            preserved.push(name.to_string());
        } else {
            let content = item.get("content").and_then(Value::as_str).unwrap_or("");
            std::fs::write(&filepath, content)?;
        }
        let title = item
            .get("case_ref")
            .and_then(|reference| reference.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let case_ref = case_ids.get(title).cloned().unwrap_or_else(|| title.to_string());
        let language = item.get("language").and_then(Value::as_str).unwrap_or("python");
        // Upsert by file name rather than inserting again: regenerating one case's
        // script used to leave a second row with the same name, inflating the
        // script count and doubling the assertion coverage.
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM scripts WHERE name = ?1 LIMIT 1",
                [name],
                |row| row.get(0),
            )
            .ok();
        let script_id = match existing {
            Some(script_id) => {
                conn.execute(
                    "UPDATE scripts SET case_id = ?1, language = ?2, status = '就绪', filepath = ?3, \
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?4",
                    rusqlite::params![
                        case_ref,
                        language,
                        filepath.to_string_lossy(),
                        script_id
                    ],
                )?;
                script_id
            }
            None => {
                let script_id = format!(
                    "script_{}",
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                conn.execute(
                    "INSERT INTO scripts (id, case_id, name, language, status, filepath) \
                     VALUES (?1, ?2, ?3, ?4, '就绪', ?5)",
                    rusqlite::params![
                        script_id,
                        case_ref,
                        name,
                        language,
                        filepath.to_string_lossy()
                    ],
                )?;
                script_id
            }
        };
        created.push(json!({
            "script_id": script_id,
            "name": name,
            "filepath": filepath.to_string_lossy(),
            "case_type": item
                .get("case_ref")
                .and_then(|reference| reference.get("case_type"))
                .cloned()
                .unwrap_or(Value::Null),
            "preserved": keep_file,
        }));
    }

    let vacuity_report = if field_bool(&body, "check_vacuity", true) && !assertions.is_empty() {
        let cases_vec = cases.clone();
        vacuity::check(
            &scripts_dir,
            &cases_vec,
            &contract,
            &sdk,
            &python_executable(&ctx.service_root()),
            Duration::from_secs(240),
        )
    } else {
        json!({ "checked": 0, "vacuous": [], "skipped": [], "errors": [] })
    };
    let vacuous_count = vacuity_report["vacuous"]
        .as_array()
        .map(|list| list.len())
        .unwrap_or(0);
    let judgement_ok = script_judgement["ok"].as_bool().unwrap_or(false);
    let script_issues = script_judgement["issues"]
        .as_array()
        .map(|list| list.len())
        .unwrap_or(0);
    let exceptional_asserted = asserted_by_type
        .iter()
        .find(|entry| entry.0 == "异常")
        .map(|entry| entry.1)
        .unwrap_or(0);

    let mut step_summary = format!("生成 {} 个脚本", created.len());
    if !assertions.is_empty() {
        step_summary.push_str(&format!("（其中 {} 个带契约断言", assertions.len()));
        if exceptional_asserted != 0 {
            step_summary.push_str(&format!("，异常 {exceptional_asserted} 条"));
        }
        step_summary.push('）');
    }
    if !missing_points.is_empty() {
        step_summary.push_str(&format!(
            "，{} 个功能点还缺被测件契约（{} 条用例只能是骨架）",
            missing_points.len(),
            missing_notes.len()
        ));
    }
    if !no_number_notes.is_empty() {
        step_summary.push_str(&format!(
            "，另有 {} 条用例的条款里没有数值，断言无从生成",
            no_number_notes.len()
        ));
    }
    if !preserved.is_empty() {
        step_summary.push_str(&format!("，保留 {} 个已补断言的脚本", preserved.len()));
    }
    if vacuous_count != 0 {
        step_summary.push_str(&format!("，变异抽查发现 {vacuous_count} 条空断言"));
    }
    if !judgement_ok {
        step_summary.push_str(&format!("，不符合提示词规则 {script_issues} 处"));
    }

    let prompt = prompts::marker_or_error(&ctx.service_root(), "script-author");
    store::append_step(
        &conn,
        &run_id,
        "autotest_script_author",
        "authored",
        if judgement_ok && vacuous_count == 0 {
            "ok"
        } else {
            "warning"
        },
        &step_summary,
        Some(&json!({
            "scripts": created,
            "stats": authored["stats"].clone(),
            "preserved": preserved,
            "contract_missing_total": missing_notes.len(),
            "contract_missing_points": missing_points,
            "prompt": prompt,
            "consistency": script_judgement,
            "vacuity": vacuity_report,
        })),
    )?;
    store::touch_run(&conn, &run_id, Some("authored"), None)?;

    let mut asserted_map = Map::new();
    for (key, value) in &asserted_by_type {
        asserted_map.insert(key.clone(), json!(value));
    }
    let skeleton_remaining = created.len() as i64
        - assertions.len() as i64
        - preserved.len() as i64;
    let data = json!({
        "run_id": run_id,
        "script_total": created.len(),
        "scripts": created.iter().take(10).cloned().collect::<Vec<_>>(),
        "stats": authored["stats"].clone(),
        "preserved": preserved,
        "preserved_total": preserved.len(),
        "asserted_generated": assertions.len(),
        "asserted_by_type": Value::Object(asserted_map),
        "skeleton_remaining": skeleton_remaining,
        "contract_notes": contract_notes.iter().take(20).cloned().collect::<Vec<_>>(),
        "contract_missing_cases": missing_notes.len(),
        "contract_missing_points": missing_points,
        "notes_without_numbers": no_number_notes.len(),
        "vacuity": vacuity_report,
        "prompt": prompt,
        "consistency": script_judgement,
    });

    let mut summary = format!("生成 {} 个 pytest 骨架，已落 scripts 表", created.len());
    if !preserved.is_empty() {
        summary.push_str(&format!(
            "；保留 {} 个已补断言的脚本（要重出请传 overwrite=true）",
            preserved.len()
        ));
    }
    if !missing_points.is_empty() {
        // A skeleton that cannot be filled in is stuck here: the summary has to say
        // "missing a DUT contract", not "generated".
        summary.push_str(&format!(
            "；{} 个功能点还缺被测件契约（{} 条用例只能是骨架）",
            missing_points.len(),
            missing_notes.len()
        ));
    }
    if !no_number_notes.is_empty() {
        summary.push_str(&format!(
            "；另有 {} 条用例的条款里没有数值，断言无从生成",
            no_number_notes.len()
        ));
    }
    Ok(Json(run_envelope(summary, data, &run_id)))
}
