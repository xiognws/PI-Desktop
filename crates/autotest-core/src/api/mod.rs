//! Router assembly. One line per route, in the order the Python service
//! declared them, so a diff between the two implementations stays readable.

pub mod cases;
pub mod executions;
pub mod misc;
pub mod projects;
pub mod scripts;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method};
use axum::routing::{delete, get, patch, post, put};
use axum::Router;

use crate::state::AppState;
use crate::static_assets;

pub fn build(state: Arc<AppState>) -> Router {
    Router::new()
        // ---- service -------------------------------------------------------
        .route("/api/health", get(misc::health))
        .route("/api/runtime", get(misc::runtime))
        .route("/api/platform", get(misc::platform))
        .route(
            "/api/settings",
            put(misc::update_settings).get(misc::not_found),
        )
        .route("/api/backend/restart", post(misc::backend_restart))
        .route("/api/reports", get(executions::list_reports_global))
        // ---- projects ------------------------------------------------------
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/:project_id",
            patch(projects::patch).delete(projects::delete),
        )
        .route(
            "/api/projects/:project_id/case-stats",
            get(projects::case_stats),
        )
        // ---- cases ---------------------------------------------------------
        .route(
            "/api/projects/:project_id/cases",
            get(cases::list).post(cases::create),
        )
        .route(
            "/api/projects/:project_id/cases/:case_id",
            get(cases::get).put(cases::update).delete(cases::delete),
        )
        .route(
            "/api/projects/:project_id/cases/:case_id/status",
            post(cases::set_status),
        )
        .route(
            "/api/projects/:project_id/cases/:case_id/run",
            post(executions::run_case),
        )
        .route(
            "/api/projects/:project_id/cases/:case_id/executions",
            get(cases::history),
        )
        // ---- scripts -------------------------------------------------------
        .route(
            "/api/projects/:project_id/scripts",
            get(scripts::list).post(scripts::create),
        )
        .route(
            "/api/projects/:project_id/scripts/:script_id/content",
            get(scripts::content).put(scripts::save_content),
        )
        .route(
            "/api/projects/:project_id/scripts/:script_id/check",
            post(scripts::check),
        )
        .route(
            "/api/projects/:project_id/scripts/:script_id/gate",
            post(scripts::gate),
        )
        .route(
            "/api/projects/:project_id/scripts/:script_id/run",
            post(scripts::run),
        )
        // ---- executions, plans, reports ------------------------------------
        .route(
            "/api/projects/:project_id/executions",
            get(executions::list_executions),
        )
        .route(
            "/api/projects/:project_id/executions/:execution_id",
            get(executions::get_execution),
        )
        .route(
            "/api/projects/:project_id/executions/:execution_id/events",
            get(executions::list_events),
        )
        .route(
            "/api/projects/:project_id/executions/:execution_id/cancel",
            post(executions::cancel_execution),
        )
        .route(
            "/api/projects/:project_id/plans",
            get(executions::list_plans).post(executions::create_plan),
        )
        .route(
            "/api/projects/:project_id/reports",
            get(executions::list_reports),
        )
        // ---- requirements --------------------------------------------------
        .route(
            "/api/projects/:project_id/requirements",
            get(executions::list_requirements),
        )
        .route(
            "/api/projects/:project_id/requirements/upload",
            post(executions::upload_requirement),
        )
        .route(
            "/api/projects/:project_id/requirements/:filename",
            delete(executions::delete_requirement),
        )
        .route(
            "/api/projects/:project_id/requirements/:filename/content",
            get(executions::requirement_content),
        )
        // ---- files and environment ----------------------------------------
        .route(
            "/api/projects/:project_id/files",
            get(executions::read_file),
        )
        .route(
            "/api/projects/:project_id/env-status",
            get(executions::env_status),
        )
        .fallback(static_assets::serve)
        // Uploads carry requirement documents; the default 2 MB cap is too small
        // for a spec with embedded screenshots.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(axum::middleware::from_fn(cors))
        .with_state(state)
}

/// The embedder loads the UI with origin `null` (a sandboxed frame), so static
/// assets need a permissive CORS answer. The listener is loopback-only.
async fn cors(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let is_preflight = request.method() == Method::OPTIONS;
    let mut response = if is_preflight {
        axum::response::Response::new(axum::body::Body::empty())
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    response
}
