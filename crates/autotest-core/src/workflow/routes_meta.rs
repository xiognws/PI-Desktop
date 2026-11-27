//! Project meta: the DUT contract, the prompt catalog, the human-decision inbox,
//! the run list, and knowledge search.
//!
//! These routes answer "what is this project wired to" and "what is waiting for a
//! human", which is the part of the workflow the panel drives directly.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

use super::routes::{envelope, field_array, field_strings, field_text, Ctx};
use super::{dut_contract, knowledge_bridge, prompts, store};

/// `GET /dut-contract`
///
/// With no contract the answer is an empty `entries` list: it means only skeletons
/// can be generated, because assertion generation needs the interface.
pub async fn get_dut_contract(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    let contract = dut_contract::load(&conn, &project_id)?;
    let entries: Vec<Value> = contract
        .entries
        .iter()
        .map(|(_, entry)| {
            json!({
                "function_point": entry.function_point,
                "factory": entry.factory,
                "arrange": entry.arrange,
                "observe": entry.observe,
                "expect": entry.expect,
                "tolerance": entry.tolerance,
            })
        })
        .collect();
    let total = entries.len();
    Ok(Json(envelope(
        format!("{total} 个功能点已接入被测件"),
        json!({
            "driver": contract.driver,
            "imports": contract.imports,
            "entries": entries,
            "total": total,
        }),
        "",
        "run",
    )))
}

/// `GET /dut-contract/scaffold`
///
/// A fill-in-the-blanks contract for every function point that is not wired up
/// yet. 79 skeleton scripts could not be filled in because nobody wrote down "how
/// to drive it, where to read the verdict"; this hands that out per function point,
/// with the `raises` shape exception cases need already filled in.
pub async fn dut_contract_scaffold(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    let contract = dut_contract::load(&conn, &project_id)?;
    // One database per project, so the newest case-design output in this database
    // is this project's current design.
    let raw: Option<Option<String>> = conn
        .query_row(
            "SELECT payload_json FROM workflow_steps WHERE tool = 'autotest_case_design' \
             ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let designed = raw
        .flatten()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    let cases = designed
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut points: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for case in &cases {
        let name = case
            .get("function_point")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let case_type = case
            .get("case_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let entry = points.entry(name).or_default();
        if !entry.contains(&case_type) {
            entry.push(case_type);
        }
    }

    let names: Vec<String> = points.keys().cloned().collect();
    let have = contract.covered_names(&names);
    let missing: Vec<String> = names
        .iter()
        .filter(|name| !have.contains(name))
        .cloned()
        .collect();
    let entries: Vec<Value> = missing
        .iter()
        .map(|name| {
            let needs_raises = points
                .get(name)
                .map(|types| types.iter().any(|item| item == "异常"))
                .unwrap_or(false);
            json!({
                "function_point": name,
                "factory": "Dut()  # TODO: 换成真实被测件构造",
                "arrange": ["dut.setup()  # TODO: 驱动到该功能点"],
                "observe": "dut.observe()  # TODO: 判定读哪里",
                "expect": if needs_raises {
                    json!({ "kind": "raises", "value": "DutError" })
                } else {
                    json!({ "kind": "bool", "value": true })
                },
            })
        })
        .collect();
    let driver = if contract.driver.is_empty() {
        "_support/dut.py".to_string()
    } else {
        contract.driver.clone()
    };
    let imports = if contract.imports.is_empty() {
        vec!["Dut".to_string(), "DutError".to_string()]
    } else {
        contract.imports.clone()
    };
    Ok(Json(envelope(
        format!("{} 个功能点还缺被测件契约", missing.len()),
        json!({
            "driver": driver,
            "imports": imports,
            "entries": entries,
            "covered_total": have.len(),
            "missing_total": missing.len(),
        }),
        "",
        "scaffold",
    )))
}

/// `PUT /dut-contract` — a bad contract is a 400: refusing it is better than
/// generating a batch of fake assertions from it.
pub async fn put_dut_contract(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let payload = json!({
        "driver": field_text(&body, "driver"),
        "imports": field_strings(&body, "imports"),
        "entries": field_array(&body, "entries"),
    });
    let conn = ctx.conn()?;
    let contract = dut_contract::save(&conn, &project_id, &payload)?;
    Ok(Json(envelope(
        format!("契约已保存：{} 个功能点", contract.entries.len()),
        json!({ "total": contract.entries.len() }),
        "",
        "run",
    )))
}

/// `GET /prompts` — the fixed-prompt catalog: which version of each stage's rules
/// is currently in effect, and its body fingerprint.
pub async fn list_prompts(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let items = prompts::catalog(&ctx.service_root());
    Ok(Json(envelope(
        format!("{} 份固定提示词", items.len()),
        json!({ "prompts": items, "total": items.len() }),
        "",
        "run",
    )))
}

/// `POST /runs/{run_id}/pending`
pub async fn create_pending(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    super::routes::require_run(&conn, &run_id)?;
    let options = field_strings(&body, "options");
    let step_id = body.get("step_id").and_then(Value::as_i64);
    let decision_id = store::create_decision(
        &conn,
        &run_id,
        &field_text(&body, "prompt"),
        &options,
        step_id,
    )?;
    Ok(Json(envelope(
        "已进入待人工确认",
        json!({
            "run_id": run_id,
            "decision_id": decision_id,
            "status": "waiting_human",
        }),
        &run_id,
        "decision",
    )))
}

/// `POST /runs/{run_id}/pending/{decision_id}/decide`
pub async fn decide(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id, decision_id)): UrlPath<(String, String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    super::routes::require_run(&conn, &run_id)?;
    let answer = field_text(&body, "answer");
    let note = field_text(&body, "note");
    let result = store::decide(&conn, &decision_id, &answer, &note)?;
    let Some(result) = result else {
        return Err(ApiError::not_found(format!("决策不存在: {decision_id}")));
    };
    Ok(Json(envelope(
        format!("已记录确认: {answer}"),
        result,
        &run_id,
        "run",
    )))
}

/// `GET /runs`
pub async fn list_runs(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(20);
    let conn = ctx.conn()?;
    let runs = store::list_runs(&conn, &project_id, limit)?;
    Ok(Json(json!({ "ok": true, "data": { "runs": runs } })))
}

/// `GET /pending` — the project's whole approval inbox, oldest first.
pub async fn list_pending(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let requested = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(50);
    let limit = requested.clamp(1, 200);
    let conn = ctx.conn()?;
    let decisions = store::list_pending(&conn, &project_id, limit)?;
    // No single run to point at, so `refs` stays empty rather than naming an
    // arbitrary one.
    Ok(Json(json!({
        "ok": true,
        "summary": format!("{} 条待审批", decisions.len()),
        "data": { "decisions": decisions, "total": decisions.len() },
        "refs": [],
    })))
}

/// `GET /runs/{run_id}`
pub async fn get_run(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, run_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let conn = ctx.conn()?;
    let run = super::routes::require_run(&conn, &run_id)?;
    Ok(Json(json!({ "ok": true, "data": run })))
}

/// `GET /knowledge/search` — the panel's search box.
///
/// Works on the same `knowledge_records` table the knowledge routes fill, and
/// tolerates the table being empty: a project with no material answers with an
/// empty list, not an error.
pub async fn knowledge_search(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let ctx = Ctx::open(&state, &project_id)?;
    let q = query.get("q").cloned().unwrap_or_default();
    let module = query.get("module").cloned().unwrap_or_default();
    let tags = query.get("tags").cloned().unwrap_or_default();
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(20);
    let conn = ctx.conn()?;
    let records = knowledge_bridge::search_records(&conn, &project_id, &q, &module, &tags, limit)?;
    let total = records.len();
    Ok(Json(json!({
        "ok": true,
        "data": { "records": records, "total": total },
    })))
}
