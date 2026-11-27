//! Projects: the workspace directory listing plus the registry file inside it.

use std::sync::Arc;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use chrono::Local;
use serde_json::{json, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::project;
use crate::state::AppState;

/// `GET /api/projects` — every directory under the workspace that carries a
/// `project.json`. The directory name is the id; the file holds everything else.
pub async fn list(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let mut projects = Vec::new();
    let entries = match std::fs::read_dir(&paths.workspace) {
        Ok(entries) => entries,
        // A workspace that does not exist yet is an empty list, not an error.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(json!({ "projects": projects })))
        }
        Err(error) => return Err(ApiError::from(error)),
    };
    let mut dirs: Vec<_> = entries.filter_map(Result::ok).collect();
    dirs.sort_by_key(|entry| entry.file_name());
    for entry in dirs {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let config_file = project::project_config_path(&dir);
        if !config_file.is_file() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&config_file) else {
            continue;
        };
        let Ok(mut config) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Value::Object(ref mut map) = config {
            map.insert(
                "id".to_string(),
                Value::from(entry.file_name().to_string_lossy().into_owned()),
            );
            projects.push(config.clone());
        }
    }
    Ok(Json(json!({ "projects": projects })))
}

/// `POST /api/projects` — create the directory tree, the database, the registry.
pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_id = format!("proj_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let project_dir = paths.workspace.join(&project_id);
    std::fs::create_dir_all(&project_dir)?;
    for sub in ["specs", "cases", "scripts", "executions", "reports"] {
        std::fs::create_dir_all(project_dir.join(sub))?;
    }
    db::ensure_project_db(&project_dir)?;

    let now = Local::now();
    let config = json!({
        "name": body.get("name").and_then(Value::as_str).unwrap_or(""),
        "description": body.get("description").and_then(Value::as_str).unwrap_or(""),
        "type": body.get("type").and_then(Value::as_str).unwrap_or("ECU"),
        "created_at": now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
        "case_count": 0,
        "execution_count": 0,
        "last_active": now.format("%Y-%m-%d").to_string(),
    });
    std::fs::write(
        project::project_config_path(&project_dir),
        serde_json::to_string_pretty(&config).unwrap_or_default(),
    )?;

    let mut response = config;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(project_id));
    }
    Ok(Json(response))
}

/// `PATCH /api/projects/{id}` — rename and describe. The id is the directory
/// name, so it is deliberately not editable: renaming would move the project and
/// invalidate every recorded path.
pub async fn patch(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_dir = project::require_project(&paths.workspace, &project_id)?;
    let config_file = project::project_config_path(&project_dir);
    let text = std::fs::read_to_string(&config_file)?;
    let mut config: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));

    if let Some(name) = body.get("name").and_then(Value::as_str) {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(ApiError::bad_request("项目名不能为空"));
        }
        config["name"] = Value::from(trimmed);
    }
    if let Some(description) = body.get("description").and_then(Value::as_str) {
        config["description"] = Value::from(description.trim());
    }
    config["last_active"] = Value::from(Local::now().format("%Y-%m-%d").to_string());

    std::fs::write(
        &config_file,
        serde_json::to_string_pretty(&config).unwrap_or_default(),
    )?;

    let mut response = config;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(project_id));
    }
    Ok(Json(response))
}

/// `DELETE /api/projects/{id}?confirm=<id>` — move the directory into the
/// workspace's `.trash` instead of deleting it. A project holds requirements,
/// cases, scripts and run artifacts; a mistaken delete must be recoverable.
pub async fn delete(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_dir = project::require_project(&paths.workspace, &project_id)?;
    let confirm = query
        .get("confirm")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if confirm != project_id {
        return Err(ApiError::bad_request(
            "删除需要二次确认：confirm 必须等于项目 id",
        ));
    }
    if state.is_project_running(&project_id) {
        return Err(ApiError::conflict("这个项目还有执行在跑，先取消或等它结束"));
    }

    let trash_dir = paths
        .workspace
        .parent()
        .map(|parent| parent.join(".trash"))
        .unwrap_or_else(|| paths.workspace.join(".trash"));
    std::fs::create_dir_all(&trash_dir)?;
    let target = trash_dir.join(format!(
        "{project_id}-{}",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    // Windows keeps a handle open on a file inside the directory while a run is
    // writing; report that instead of failing with a bare 500.
    std::fs::rename(&project_dir, &target)
        .map_err(|error| ApiError::conflict(format!("项目目录被占用，暂时无法移走：{error}")))?;

    Ok(Json(json!({
        "id": project_id,
        "trashed_to": target.to_string_lossy(),
        "message": format!("项目已移入回收目录，可从 {} 恢复", target.to_string_lossy()),
    })))
}

/// `GET /api/projects/{id}/case-stats` — counted from the project database.
/// `project.json` carries `case_count`/`execution_count` fields that nothing
/// updates, so reading them made the home page say "0 cases" forever.
pub async fn case_stats(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    project::require_project(&paths.workspace, &project_id)?;
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Ok(Json(json!({ "case_count": 0, "execution_count": 0 })));
    }
    let conn = db::open(&db_path)?;
    Ok(Json(json!({
        "case_count": db::count_or_zero(&conn, "SELECT COUNT(*) FROM test_cases"),
        "execution_count": db::count_or_zero(&conn, "SELECT COUNT(*) FROM executions"),
    })))
}
