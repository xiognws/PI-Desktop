//! Service-level endpoints: health, the runtime summary, platform info, the
//! settings write and the "restart the backend" button.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::config::{self, APP_VERSION, MCP_HARDWARE_SERVERS, PLATFORM_STAGES};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// FastAPI answered a method that the path does not declare with 405 and no
/// body; the UI reads `{detail}` from every error, so unknown methods answer the
/// same JSON 404 as unknown paths.
pub async fn not_found() -> crate::error::ApiError {
    crate::error::ApiError::not_found("接口不存在")
}

/// `GET /api/health` — `codeStamp` lets the host tell a freshly built backend
/// from an orphan process still holding the port.
pub async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": APP_VERSION,
        "codeStamp": std::env::var("AUTOTEST_CODE_STAMP").unwrap_or_default(),
        "pid": std::process::id(),
    }))
}

/// `GET /api/runtime?projectId=` — the token ledger for one project. Pipeline
/// progress lives in `workflow_runs`; the status bar must not keep a second
/// count that can drift from the database.
pub async fn runtime(
    State(state): State<Arc<AppState>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let project_id = query.get("projectId").cloned().unwrap_or_default();
    let mut payload = json!({ "version": APP_VERSION, "projectId": project_id });
    if project_id.is_empty() {
        return Ok(Json(payload));
    }
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Ok(Json(payload));
    }
    let conn = db::open(&db_path)?;
    let totals = conn
        .query_row(
            "SELECT COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0), COUNT(*) FROM agent_calls",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
        )
        .unwrap_or((0, 0, 0));
    payload["tokens"] = json!({ "in": totals.0, "out": totals.1, "calls": totals.2 });
    Ok(Json(payload))
}

/// `GET /api/platform` — how the platform itself is installed, which is what the
/// settings page renders (`/api/runtime` is per-project state instead).
pub async fn platform(State(state): State<Arc<AppState>>) -> Json<Value> {
    let paths = state.paths();
    let python = config::python_executable(&paths.service_root)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    Json(json!({
        "version": APP_VERSION,
        "healthy": true,
        "workspace": paths.workspace.to_string_lossy(),
        "python": python,
        "backend_port": paths.port,
        "agents": PLATFORM_STAGES
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect::<Vec<_>>(),
        "mcp_servers": MCP_HARDWARE_SERVERS
            .iter()
            .map(|(id, name, url)| json!({ "id": id, "name": name, "url": url, "enabled": false }))
            .collect::<Vec<_>>(),
    }))
}

/// `PUT /api/settings` — the workspace choice takes effect on the next start:
/// services hold the current path, and switching it live would split new
/// projects from running executions.
pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    if let Some(workspace) = body.get("workspace").and_then(Value::as_str) {
        let target = workspace.trim();
        if target.is_empty() {
            return Err(ApiError::bad_request("workspace 不能为空"));
        }
        *state.pending_workspace.lock().expect("pending workspace") = target.to_string();
    }
    let pending = state
        .pending_workspace
        .lock()
        .expect("pending workspace")
        .clone();
    config::write_platform_settings(&paths, &pending)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(json!({
        "workspace": paths.workspace.to_string_lossy(),
        "pendingWorkspace": pending,
    })))
}

/// `POST /api/backend/restart` — the offline banner's button. A listener on the
/// port means nothing to do; otherwise spawn a detached copy of this executable
/// on the same port.
pub async fn backend_restart(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    if port_open(paths.port) {
        return Ok(Json(
            json!({ "status": "already-running", "port": paths.port }),
        ));
    }
    let exe = std::env::current_exe()
        .map_err(|error| ApiError::internal(format!("拉起失败: {error}")))?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(paths.port.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console window, and the
        // new process outlives this one.
        command.creation_flags(0x00000008 | 0x00000200);
    }
    let child = command
        .spawn()
        .map_err(|error| ApiError::internal(format!("拉起失败: {error}")))?;
    Ok(Json(json!({
        "status": "spawning",
        "pid": child.id(),
        "port": paths.port,
    })))
}

fn port_open(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500)).is_ok()
}
