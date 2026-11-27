//! Cases: the rows the case list, detail drawer and panel all read.
//!
//! The wire format mirrors the Python service exactly (snake_case columns plus
//! the aliases `name`/`module`/`type` the Vue app uses), because the frontend was
//! written against that shape.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::project;
use crate::script_state;
use crate::state::AppState;

fn project_db(state: &AppState, project_id: &str) -> ApiResult<std::path::PathBuf> {
    let paths = state.paths();
    project::require_project(&paths.workspace, project_id)?;
    let db_path = paths.project_db(project_id)?;
    if !db_path.exists() {
        db::ensure_project_db(&paths.project_dir(project_id)?)?;
    }
    Ok(db_path)
}

/// Column aliases the frontend reads: `name` is the title, `module` the module id,
/// `type` the case type.
fn with_aliases(mut case: Value) -> Value {
    if let Value::Object(ref mut map) = case {
        let title = map.get("title").cloned().unwrap_or_else(|| Value::from(""));
        map.insert("name".to_string(), title);
        let module = map
            .get("module_id")
            .cloned()
            .unwrap_or_else(|| Value::from(""));
        map.insert("module".to_string(), module);
        let case_type = map
            .get("case_type")
            .cloned()
            .unwrap_or_else(|| Value::from("正向"));
        map.insert("type".to_string(), case_type);
        // `tags` is stored as a JSON string; the UI expects a real array.
        if let Some(Value::String(raw)) = map.get("tags").cloned() {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                map.insert("tags".to_string(), parsed);
            }
        }
    }
    case
}

/// `GET /api/projects/{id}/cases` — rows plus the counts the list header shows.
pub async fn list(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db(&state, &project_id)?;
    let conn = db::open(&db_path)?;

    let rows = db::query_rows(
        &conn,
        "SELECT * FROM test_cases ORDER BY created_at DESC",
        [],
    )?;

    // Which cases have a script that really asserts. Read separately because a
    // project database created by an early build may have no `scripts` table.
    let mut per_case: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Ok(script_rows) = db::query_rows(&conn, "SELECT case_id, filepath FROM scripts", []) {
        for row in script_rows {
            let case_ref = row
                .get("case_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if case_ref.is_empty() {
                continue;
            }
            let filepath = row.get("filepath").and_then(Value::as_str).unwrap_or("");
            let status = script_state::classify(&script_state::read_script_text(filepath));
            per_case
                .entry(case_ref)
                .or_default()
                .push(status.state.to_string());
        }
    }

    let mut cases = Vec::with_capacity(rows.len());
    let mut asserted = 0usize;
    let mut skeleton = 0usize;
    let mut no_script = 0usize;
    let mut by_exception_class: BTreeMap<String, i64> = BTreeMap::new();
    let mut exception_total = 0i64;

    for row in rows {
        let mut case = with_aliases(row);
        let case_id = case
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let states = per_case.get(&case_id);
        let merged = match states {
            Some(list) => script_state::merge(list.iter().map(String::as_str)),
            None => "none",
        };
        match merged {
            "asserted" => asserted += 1,
            "skeleton" => skeleton += 1,
            "none" => no_script += 1,
            _ => {}
        }
        if let Value::Object(ref mut map) = case {
            map.insert("script_state".to_string(), Value::from(merged));
            // Exception cases carry their failure mode in the evidence JSON;
            // the list groups by that class, so it is decoded here rather than
            // in each client.
            let exception_class = map
                .get("evidence")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .and_then(|parsed| parsed.get("exception_class").cloned())
                .and_then(|value| value.as_str().map(str::to_string));
            if let Some(class_id) = exception_class.filter(|value| !value.is_empty()) {
                *by_exception_class.entry(class_id.clone()).or_insert(0) += 1;
                map.insert("exception_class".to_string(), Value::from(class_id));
            }
            if map.get("case_type").and_then(Value::as_str) == Some("异常") {
                exception_total += 1;
            }
        }
        cases.push(case);
    }

    Ok(Json(json!({
        "cases": cases,
        "total": cases.len(),
        "asserted_total": asserted,
        "skeleton_total": skeleton,
        "no_script_total": no_script,
        "by_exception_class": by_exception_class,
        "exception_cases": by_exception_class.values().sum::<i64>(),
        "exception_total": exception_total,
    })))
}

/// `POST /api/projects/{id}/cases`
pub async fn create(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db(&state, &project_id)?;
    let conn = db::open(&db_path)?;
    let case_id = format!("case_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let tags = body
        .get("tags")
        .cloned()
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());

    conn.execute(
        "INSERT INTO test_cases (id, module_id, title, precondition, steps, expected, case_type, priority, status, tags, favorite, review_status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            case_id,
            text_field(&body, "module"),
            text_field(&body, "name"),
            text_field(&body, "precondition"),
            scalar_field(&body, "steps"),
            scalar_field(&body, "expected"),
            text_field_or(&body, "type", "正向"),
            text_field_or(&body, "priority", "中"),
            text_field_or(&body, "status", "未执行"),
            tags,
            body.get("favorite").and_then(Value::as_bool).unwrap_or(false),
            text_field_or(&body, "reviewStatus", "待评审"),
        ],
    )?;

    // The response echoes the request body, exactly as the Python route did.
    let mut response = body;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(case_id));
        map.insert("message".to_string(), Value::from("创建成功"));
    }
    Ok(Json(response))
}

/// `GET /api/projects/{id}/cases/{case_id}`
pub async fn get(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let case = db::query_one(&conn, "SELECT * FROM test_cases WHERE id = ?1", [&case_id])?
        .ok_or_else(|| ApiError::not_found("用例不存在"))?;
    Ok(Json(with_aliases(case)))
}

/// `PUT /api/projects/{id}/cases/{case_id}` — the editor's save.
pub async fn update(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let tags = body
        .get("tags")
        .cloned()
        .map(|value| serde_json::to_string(&value).unwrap_or_else(|_| "[]".into()))
        .unwrap_or_else(|| "[]".into());
    conn.execute(
        "UPDATE test_cases SET title = ?1, module_id = ?2, case_type = ?3, priority = ?4, \
         status = ?5, tags = ?6, favorite = ?7, updated_at = CURRENT_TIMESTAMP WHERE id = ?8",
        rusqlite::params![
            text_field(&body, "name"),
            text_field(&body, "module"),
            text_field_or(&body, "type", "正向"),
            text_field_or(&body, "priority", "中"),
            text_field_or(&body, "status", "未执行"),
            tags,
            body.get("favorite")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            case_id,
        ],
    )?;

    let mut response = body;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(case_id));
        map.insert("message".to_string(), Value::from("更新成功"));
    }
    Ok(Json(response))
}

/// `DELETE /api/projects/{id}/cases/{case_id}` — the scripts survive: they are
/// user assets that may already carry hand-written assertions, so the link is
/// cleared instead.
pub async fn delete(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    conn.execute("DELETE FROM test_cases WHERE id = ?1", [&case_id])?;
    conn.execute(
        "UPDATE scripts SET case_id = '' WHERE case_id = ?1",
        [&case_id],
    )?;
    Ok(Json(json!({ "id": case_id, "message": "删除成功" })))
}

/// `POST /api/projects/{id}/cases/{case_id}/status` — result write-back. The
/// full-row PUT is not reused here: it would blank the case's own fields.
pub async fn set_status(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let status = body
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if status.is_empty() {
        return Err(ApiError::bad_request("status is required"));
    }
    let conn = db::open(&db_path)?;
    let updated = conn.execute(
        "UPDATE test_cases SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        rusqlite::params![status, case_id],
    )?;
    if updated == 0 {
        return Err(ApiError::not_found("用例不存在"));
    }
    Ok(Json(json!({ "id": case_id, "status": status })))
}

/// `GET /api/projects/{id}/cases/{case_id}/executions`
pub async fn history(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    project::require_project(&paths.workspace, &project_id)?;
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        db::ensure_project_db(&paths.project_dir(&project_id)?)?;
    }
    let limit: i64 = query
        .get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let conn = db::open(&db_path)?;
    let history = db::query_rows(
        &conn,
        "SELECT ec.execution_id, ec.result, ec.duration_ms, ec.error_message, \
                e.name, e.status, e.started_at, e.finished_at \
         FROM execution_cases ec JOIN executions e ON e.id = ec.execution_id \
         WHERE ec.case_id = ?1 ORDER BY e.started_at DESC, ec.execution_id DESC LIMIT ?2",
        rusqlite::params![case_id, limit],
    )?;
    let total = db::count_or_zero(
        &conn,
        &format!(
            "SELECT COUNT(*) FROM execution_cases WHERE case_id = '{}'",
            case_id.replace('\'', "''")
        ),
    );
    let passed = db::count_or_zero(
        &conn,
        &format!(
            "SELECT COUNT(*) FROM execution_cases WHERE case_id = '{}' AND result = '通过'",
            case_id.replace('\'', "''")
        ),
    );
    Ok(Json(json!({
        "case_id": case_id,
        "total": total,
        "passed": passed,
        "history": history,
    })))
}

fn text_field(body: &Value, key: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn text_field_or(body: &Value, key: &str, fallback: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// `steps` and `expected` are free text in the UI but arrive as numbers or
/// arrays from agent-generated payloads; store the JSON rendering of whatever
/// came in rather than failing the write.
fn scalar_field(body: &Value, key: &str) -> String {
    match body.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

#[allow(dead_code)]
fn empty_map() -> Map<String, Value> {
    Map::new()
}
