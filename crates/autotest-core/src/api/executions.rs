//! Executions, plans, reports, requirements, project files and the environment
//! probe. Everything here reads rows another route wrote, so the shapes are the
//! ones the detail drawer, the report list and the settings page already parse.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::config;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::exec;
use crate::project;
use crate::state::AppState;

fn project_db_or_create(state: &AppState, project_id: &str) -> ApiResult<PathBuf> {
    let paths = state.paths();
    project::require_project(&paths.workspace, project_id)?;
    let db_path = paths.project_db(project_id)?;
    if !db_path.exists() {
        db::ensure_project_db(&paths.project_dir(project_id)?)?;
    }
    Ok(db_path)
}

/// `GET /api/projects/{id}/executions`
pub async fn list_executions(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db_or_create(&state, &project_id)?;
    let conn = db::open(&db_path)?;
    let executions = db::query_rows(
        &conn,
        "SELECT * FROM executions ORDER BY started_at DESC",
        [],
    )?;
    Ok(Json(json!({ "executions": executions })))
}

/// `GET /api/projects/{id}/executions/{execution_id}` — the run plus its event
/// stream, which is what the detail view replays.
pub async fn get_execution(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, execution_id)): UrlPath<(String, u32)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let payload = exec::execution_with_events(&db_path, execution_id)?
        .ok_or_else(|| ApiError::not_found("执行记录不存在"))?;
    Ok(Json(payload))
}

/// `GET /api/projects/{id}/executions/{execution_id}/events`
pub async fn list_events(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, execution_id)): UrlPath<(String, u32)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let events = exec::read_events(&db_path, execution_id)?;
    Ok(Json(
        json!({ "execution_id": execution_id, "events": events }),
    ))
}

/// `POST /api/projects/{id}/executions/{execution_id}/cancel`
pub async fn cancel_execution(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, execution_id)): UrlPath<(String, u32)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    project::require_project(&paths.workspace, &project_id)?;
    if !state.cancel_run(&project_id, execution_id) {
        return Err(ApiError::conflict("该执行已结束或未在运行"));
    }
    Ok(Json(
        json!({ "execution_id": execution_id, "status": "cancelling" }),
    ))
}

/// `GET /api/projects/{id}/plans`
pub async fn list_plans(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db_or_create(&state, &project_id)?;
    let conn = db::open(&db_path)?;
    let plans = db::query_rows(
        &conn,
        "SELECT * FROM test_plans ORDER BY created_at DESC",
        [],
    )?;
    Ok(Json(json!({ "plans": plans })))
}

/// `POST /api/projects/{id}/plans`
pub async fn create_plan(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db_or_create(&state, &project_id)?;
    let plan_id = format!("plan_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let conn = db::open(&db_path)?;
    conn.execute(
        "INSERT INTO test_plans (id, name, description, cron, case_count, status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            plan_id,
            body.get("name").and_then(Value::as_str).unwrap_or(""),
            body.get("description")
                .and_then(Value::as_str)
                .unwrap_or(""),
            body.get("cron").and_then(Value::as_str).unwrap_or(""),
            body.get("case_count").and_then(Value::as_i64).unwrap_or(0),
            body.get("status")
                .and_then(Value::as_str)
                .unwrap_or("enabled"),
        ],
    )?;
    let mut response = body;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(plan_id));
        map.insert("message".to_string(), Value::from("创建成功"));
    }
    Ok(Json(response))
}

/// `GET /api/projects/{id}/reports` — pipeline reports (`pipe_…`) and execution
/// reports share the table; the `kind` decides whether the body can be opened.
pub async fn list_reports(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let db_path = project_db_or_create(&state, &project_id)?;
    let conn = db::open(&db_path)?;
    let rows = db::query_rows(&conn, "SELECT * FROM reports ORDER BY created_at DESC", [])?;
    let mut reports = Vec::with_capacity(rows.len());
    for mut row in rows {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Value::Object(ref mut map) = row {
            map.insert(
                "kind".to_string(),
                Value::from(if id.starts_with("pipe_") {
                    "pipeline"
                } else {
                    "execution"
                }),
            );
        }
        reports.push(row);
    }
    Ok(Json(json!({ "reports": reports, "total": reports.len() })))
}

/// `GET /api/reports` — the platform-wide list, which has never had rows.
pub async fn list_reports_global() -> Json<Value> {
    Json(json!({ "reports": [] }))
}

/// `GET /api/projects/{id}/requirements`
pub async fn list_requirements(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    project::require_project(&paths.workspace, &project_id)?;
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Ok(Json(json!({ "requirements": [] })));
    }
    let conn = db::open(&db_path)?;
    let rows = db::query_rows(
        &conn,
        "SELECT id, filename, size, status, created_at FROM requirements ORDER BY created_at DESC",
        [],
    )?;
    Ok(Json(json!({ "requirements": rows })))
}

/// `GET /api/projects/{id}/requirements/{filename}/content` — the pipeline's
/// stage-1 input, so the agent never needs filesystem access to read it.
pub async fn requirement_content(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, filename)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_dir = paths.workspace.join(&project_id);
    if !project_dir.is_dir() {
        return Err(ApiError::not_found("项目不存在"));
    }
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename == "."
        || filename == ".."
    {
        return Err(ApiError::bad_request("文件名不合法"));
    }
    let specs_dir = project_dir.join("specs");
    let file_path = specs_dir.join(&filename);
    if !file_path.is_file() {
        return Err(ApiError::not_found("需求文件不存在"));
    }
    let text = std::fs::read(&file_path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|_| ApiError::not_found("需求文件不存在"))?;
    Ok(Json(json!({
        "filename": filename,
        "text": text,
        "chars": text.chars().count(),
    })))
}

/// `DELETE /api/projects/{id}/requirements/{filename}` — record and file. The
/// name must be a bare file name: requirements are flat inside `specs/`.
pub async fn delete_requirement(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, filename)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_dir = project::require_project(&paths.workspace, &project_id)?;
    let name = filename.trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(ApiError::bad_request("文件名不合法"));
    }
    let target = project_dir.join("specs").join(&name);

    let db_path = paths.project_db(&project_id)?;
    let mut removed_rows = 0usize;
    if db_path.exists() {
        let conn = db::open(&db_path)?;
        removed_rows = conn.execute("DELETE FROM requirements WHERE filename = ?1", [&name])?;
    }
    let file_removed = if target.is_file() {
        std::fs::remove_file(&target)?;
        true
    } else {
        false
    };
    if !file_removed && removed_rows == 0 {
        return Err(ApiError::not_found(format!("需求不存在: {name}")));
    }
    Ok(Json(json!({
        "filename": name,
        "file_removed": file_removed,
        "records_removed": removed_rows,
        "message": format!("已删除需求 {name}"),
    })))
}

/// `GET /api/projects/{id}/files?path=` — read a file the run produced
/// (screenshots, logs). The only rule that matters: the target must resolve
/// inside the project directory.
pub async fn read_file(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let paths = state.paths();
    project::require_project(&paths.workspace, &project_id)?;
    let project_dir = paths
        .workspace
        .join(&project_id)
        .canonicalize()
        .map_err(|_| ApiError::not_found("文件不存在"))?;

    let raw = query.get("path").cloned().unwrap_or_default();
    let requested = PathBuf::from(&raw);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        project_dir.join(requested)
    };
    let target = candidate
        .canonicalize()
        .map_err(|_| ApiError::not_found("文件不存在"))?;
    if !target.starts_with(&project_dir) || !target.is_file() {
        return Err(ApiError::not_found("文件不存在"));
    }

    let bytes = std::fs::read(&target)?;
    let guessed = mime_guess::from_path(&target).first_or_octet_stream();
    Ok((
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            guessed.essence_str().to_string(),
        )],
        bytes,
    )
        .into_response())
}

const ENV_TTL: Duration = Duration::from_secs(15);

/// `GET /api/projects/{id}/env-status` — what the settings page shows. Probes are
/// cached for 15 s: three 1 s timeouts per request would otherwise stall the page.
pub async fn env_status(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    if let Some(cached) = state
        .env_cache
        .lock()
        .expect("env cache")
        .get(&project_id)
        .filter(|(stamp, _)| stamp.elapsed() < ENV_TTL)
        .map(|(_, value)| value.clone())
    {
        return Ok(Json(cached));
    }

    let paths = state.paths();
    let probe_project = project_id.clone();
    let probe_state = Arc::clone(&state);
    let result = tokio::task::spawn_blocking(move || {
        probe_env(&probe_state, &paths.workspace, &probe_project)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?;

    state
        .env_cache
        .lock()
        .expect("env cache")
        .insert(project_id, (Instant::now(), result.clone()));
    Ok(Json(result))
}

fn probe_env(state: &AppState, workspace: &Path, project_id: &str) -> Value {
    let entry = |label: &str, ok: bool| json!({ "ok": ok, "label": label });

    let db_exists = workspace.join(project_id).join("data.db").exists();
    let scripts_exist = workspace.join(project_id).join("scripts").exists();
    let python = config::python_executable(&state.paths().service_root);
    let langserver = which("basedpyright-langserver");

    let mut mcp = serde_json::Map::new();
    for (name, label, url) in config::MCP_HARDWARE_SERVERS {
        let ok = probe_http(url);
        mcp.insert(name.to_string(), json!({ "ok": ok, "label": label }));
    }

    json!({
        "api": entry("后端 API", true),
        "database": entry("数据库", db_exists),
        "python": entry("Python", python.is_some()),
        "scripts_dir": entry("脚本目录", scripts_exist),
        "basedpyright": entry("basedpyright", langserver),
        "mcp_can": mcp.get("mcp_can").cloned().unwrap_or(json!({"ok": false, "label": "MCP CAN"})),
        "mcp_hmi": mcp.get("mcp_hmi").cloned().unwrap_or(json!({"ok": false, "label": "MCP HMI"})),
        "mcp_logger": mcp.get("mcp_logger").cloned().unwrap_or(json!({"ok": false, "label": "MCP Logger"})),
    })
}

/// `POST /api/projects/{id}/cases/{case_id}/run` — a case owns no executable
/// content; its scripts do. Running here keeps one event stream, one result
/// write-back and one report vocabulary for both "run script" and "run case".
pub async fn run_case(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, case_id)): UrlPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM test_cases WHERE id = ?1",
            [&case_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Err(ApiError::not_found("用例不存在"));
    }
    let scripts = db::query_rows(
        &conn,
        "SELECT * FROM scripts WHERE case_id = ?1 ORDER BY created_at ASC",
        [&case_id],
    )?;
    drop(conn);
    if scripts.is_empty() {
        return Err(ApiError::conflict("该用例还没有关联脚本"));
    }

    let background = query
        .get("background")
        .map(|value| value == "true" || value == "1")
        .unwrap_or(false);

    let run_all = move |state: Arc<AppState>,
                        db_path: PathBuf,
                        project_id: String,
                        case_id: String,
                        scripts: Vec<Value>| {
        let mut runs = Vec::new();
        for script in &scripts {
            match exec::execute_script(
                &state,
                &db_path,
                &project_id,
                script,
                Duration::from_secs(300),
            ) {
                Ok(result) => runs.push(result),
                Err(error) => runs.push(json!({ "status": "error", "failure": error.detail })),
            }
        }
        let failed = runs.iter().any(|run| {
            !matches!(
                run.get("status").and_then(Value::as_str),
                Some("pass") | Some("skip")
            )
        });
        json!({
            "case_id": case_id,
            "status": if failed { "fail" } else { "pass" },
            "runs": runs,
        })
    };

    if background {
        let state_clone = Arc::clone(&state);
        let db_clone = db_path.clone();
        let project_clone = project_id.clone();
        let case_clone = case_id.clone();
        tokio::task::spawn_blocking(move || {
            run_all(state_clone, db_clone, project_clone, case_clone, scripts);
        });
        return Ok(Json(json!({
            "status": "started",
            "case_id": case_id,
        })));
    }

    let result =
        tokio::task::spawn_blocking(move || run_all(state, db_path, project_id, case_id, scripts))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(result))
}

/// `POST /api/projects/{id}/requirements/upload` — the file and its record. The
/// same file name replaces the previous row: the name is the identity, so a
/// re-upload must not leave two entries for one document.
pub async fn upload_requirement(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    mut multipart: axum::extract::Multipart,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let project_dir = paths.workspace.join(&project_id);
    if !project_dir.is_dir() {
        return Err(ApiError::not_found("项目不存在"));
    }
    let specs_dir = project_dir.join("specs");
    std::fs::create_dir_all(&specs_dir)?;

    let mut saved: Option<(String, usize)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| ApiError::bad_request(error.to_string()))?
    {
        let Some(filename) = field.file_name().map(str::to_string) else {
            continue;
        };
        let name = filename
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("upload.bin")
            .to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        std::fs::write(specs_dir.join(&name), &bytes)?;
        saved = Some((name, bytes.len()));
    }
    let Some((filename, size)) = saved else {
        return Err(ApiError::bad_request("缺少上传文件"));
    };

    let db_path = paths.project_db(&project_id)?;
    if db_path.exists() {
        let conn = db::open(&db_path)?;
        conn.execute("DELETE FROM requirements WHERE filename = ?1", [&filename])?;
        conn.execute(
            "INSERT INTO requirements (id, filename, filepath, size, status) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                format!("req_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
                filename,
                specs_dir.join(&filename).to_string_lossy(),
                size as i64,
                "已上传",
            ],
        )?;
    }

    Ok(Json(json!({
        "filename": filename,
        "size": size,
        "path": specs_dir.join(&filename).to_string_lossy(),
        "message": "上传成功",
    })))
}

fn which(program: &str) -> bool {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path_var).any(|dir| {
        let candidate = dir.join(program);
        candidate.is_file()
            || candidate.with_extension("exe").is_file()
            || candidate.with_extension("cmd").is_file()
    })
}

/// 1 s is enough: a hardware adapter that is not running is simply not running,
/// and the settings page must not render an error page for an absent rig.
fn probe_http(url: &str) -> bool {
    use std::io::{Read, Write};
    let without_scheme = url.trim_start_matches("http://");
    let Some((authority, path)) = without_scheme.split_once('/') else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(
        &match authority.parse() {
            Ok(addr) => addr,
            Err(_) => return false,
        },
        Duration::from_secs(1),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buffer = [0u8; 64];
    matches!(stream.read(&mut buffer), Ok(read) if read > 0)
}
