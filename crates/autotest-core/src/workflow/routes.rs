//! Workflow HTTP routes — mounted at `/api/projects/{project_id}/workflow`.
//!
//! Every route answers the same envelope `{ok, summary, data, refs}`: the
//! plugin's tools forward it to the model verbatim and never rebuild a result
//! shape. The rules (stages, dedupe, ceilings) stay here rather than in a prompt.
//!
//! The handler bodies live in sibling modules grouped the way the Python router
//! grouped them: design stages, run/bug/report, and project meta.

use std::path::PathBuf;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::{get, patch, post, MethodRouter};
use axum::Json;
use axum::Router;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::project;
use crate::state::AppState;

use super::{routes_author, routes_design, routes_meta, routes_report, routes_runs, store};

pub fn build() -> Router<Arc<AppState>> {
    Router::new()
        // ---- design stages -------------------------------------------------
        .route(
            "/api/projects/:project_id/workflow/prd-parse",
            wf(post(routes_design::prd_parse)),
        )
        .route(
            "/api/projects/:project_id/workflow/case-design",
            wf(post(routes_design::case_design)),
        )
        .route(
            "/api/projects/:project_id/workflow/case-review",
            wf(post(routes_design::case_review)),
        )
        .route(
            "/api/projects/:project_id/workflow/log-analyze",
            wf(post(routes_design::log_analyze)),
        )
        .route(
            "/api/projects/:project_id/workflow/script-author",
            wf(post(routes_author::script_author)),
        )
        // ---- runs, bugs, report -------------------------------------------
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/execute",
            wf(post(routes_runs::execute_run)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/bugs",
            wf(get(routes_runs::run_bugs)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/bugs/:bug_id",
            wf(patch(routes_runs::update_bug)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/report-content",
            wf(get(routes_runs::report_content)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/status",
            wf(get(routes_runs::run_status)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/report",
            wf(post(routes_report::build_report)),
        )
        .route(
            "/api/projects/:project_id/workflow/bugs",
            wf(get(routes_runs::project_bugs)),
        )
        .route(
            "/api/projects/:project_id/workflow/bugs/status",
            wf(post(routes_runs::update_project_bugs_batch)),
        )
        .route(
            "/api/projects/:project_id/workflow/bugs/:bug_id",
            wf(patch(routes_runs::update_project_bug)),
        )
        // ---- project meta --------------------------------------------------
        .route(
            "/api/projects/:project_id/workflow/dut-contract",
            get(routes_meta::get_dut_contract).put(routes_meta::put_dut_contract),
        )
        .route(
            "/api/projects/:project_id/workflow/dut-contract/scaffold",
            wf(get(routes_meta::dut_contract_scaffold)),
        )
        .route(
            "/api/projects/:project_id/workflow/prompts",
            wf(get(routes_meta::list_prompts)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/pending",
            wf(post(routes_meta::create_pending)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id/pending/:decision_id/decide",
            wf(post(routes_meta::decide)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs",
            wf(get(routes_meta::list_runs)),
        )
        .route(
            "/api/projects/:project_id/workflow/pending",
            wf(get(routes_meta::list_pending)),
        )
        .route(
            "/api/projects/:project_id/workflow/runs/:run_id",
            wf(get(routes_meta::get_run)),
        )
        .route(
            "/api/projects/:project_id/workflow/knowledge/search",
            wf(get(routes_meta::knowledge_search)),
        )
}

/// FastAPI answered a request whose (path, method) pair did not exist with the SPA
/// catch-all's 404 `{"detail": "接口不存在"}`; axum would answer 405 because the path
/// exists with another method. The panel and the captured contract rely on the 404,
/// so every workflow route gets the same fallback.
async fn unknown_route() -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({ "detail": "接口不存在" })))
}

fn wf(router: MethodRouter<Arc<AppState>>) -> MethodRouter<Arc<AppState>> {
    router.fallback(unknown_route)
}

/// One request's project scope: the directory that *is* the project, its
/// database, and the service state a background thread may need.
pub(super) struct Ctx {
    pub state: Arc<AppState>,
    pub dir: PathBuf,
}

impl Ctx {
    /// Python's `_project_conn` started with `server.require_project(project_id)`:
    /// an unknown project is a 404 before any file is created.
    pub fn open(state: &Arc<AppState>, project_id: &str) -> ApiResult<Self> {
        let paths = state.paths();
        let dir = project::require_project(&paths.workspace, project_id)?;
        Ok(Self {
            state: Arc::clone(state),
            dir,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.dir.join("data.db")
    }

    /// Open the project database and bring the workflow tables up to date — the
    /// same two steps every Python route got from `_project_conn`.
    pub fn conn(&self) -> ApiResult<Connection> {
        let db_path = self.db_path();
        let conn = if db_path.exists() {
            db::open(&db_path)?
        } else {
            // A project that has never been touched has no database; creating it
            // with the full project schema is what `init_project_db` did.
            db::ensure_project_db(&self.dir)?
        };
        store::ensure_workflow_tables(&conn)?;
        Ok(conn)
    }

    pub fn service_root(&self) -> PathBuf {
        self.state.paths().service_root
    }

    pub fn scripts_dir(&self) -> ApiResult<PathBuf> {
        let dir = self.dir.join("scripts");
        std::fs::create_dir_all(&dir)?;
        Ok(dir.canonicalize().unwrap_or(dir))
    }

    pub fn reports_dir(&self) -> ApiResult<PathBuf> {
        let dir = self.dir.join("reports");
        std::fs::create_dir_all(&dir)?;
        Ok(dir.canonicalize().unwrap_or(dir))
    }
}

/// `{ok, summary, data, refs}` — the one shape every workflow route returns.
pub(super) fn envelope(summary: impl Into<String>, data: Value, run_id: &str, kind: &str) -> Value {
    json!({
        "ok": true,
        "summary": summary.into(),
        "data": data,
        "refs": [{ "kind": kind, "id": run_id }],
    })
}

pub(super) fn run_envelope(summary: impl Into<String>, data: Value, run_id: &str) -> Value {
    envelope(summary, data, run_id, "run")
}

pub(super) fn field_text(body: &Value, key: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `str | None` field: `None` when absent, null, or not a string.
pub(super) fn field_opt(body: &Value, key: &str) -> Option<String> {
    body.get(key)
        .and_then(Value::as_str)
        .map(|text| text.to_string())
}

pub(super) fn field_bool(body: &Value, key: &str, default: bool) -> bool {
    body.get(key).and_then(Value::as_bool).unwrap_or(default)
}

pub(super) fn field_f64(body: &Value, key: &str, default: f64) -> f64 {
    body.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

/// A list of strings; non-string entries are dropped rather than turning the
/// whole request into a deserialisation error.
pub(super) fn field_strings(body: &Value, key: &str) -> Vec<String> {
    body.get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(|text| text.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn field_array(body: &Value, key: &str) -> Vec<Value> {
    body.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `text[:n]` by characters, as Python slices strings.
pub(super) fn clip_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Load a run or answer 404 with the message the UI already shows.
pub(super) fn require_run(conn: &Connection, run_id: &str) -> ApiResult<Value> {
    match store::get_run(conn, run_id)? {
        Some(run) => Ok(run),
        None => Err(ApiError::not_found(format!("运行不存在: {run_id}"))),
    }
}

/// `store.last_payload(...) or {}` — the shape every stage reads from the ledger.
pub(super) fn last_payload_or_empty(
    conn: &Connection,
    run_id: &str,
    tool: &str,
) -> ApiResult<Value> {
    Ok(store::last_payload(conn, run_id, tool)?.unwrap_or_else(|| json!({})))
}
