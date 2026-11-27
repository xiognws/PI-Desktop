//! Static delivery of the workbench UI.
//!
//! The Vue build is a history-mode SPA: an unknown *page* path must return
//! `index.html` so a refresh or a deep link works, while an unknown `/api` path
//! must stay a JSON 404 — otherwise the router would answer HTML to a fetch and
//! the caller would report a parse error instead of "not found".

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::state::AppState;

pub async fn serve(State(state): State<ArcState>, uri: Uri) -> Response {
    let paths = state.paths();
    let request_path = uri.path().to_string();

    if request_path.starts_with("/api") || request_path.starts_with("/ws") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "detail": "接口不存在" })),
        )
            .into_response();
    }

    let root = if paths.dist_dir().is_dir() {
        paths.dist_dir()
    } else {
        paths.shell_dir()
    };

    let relative = request_path.trim_start_matches('/');
    let candidate = if relative.is_empty() {
        root.join("index.html")
    } else {
        root.join(relative)
    };

    if let Some(file) = safe_file(&root, &candidate) {
        return file_response(&file);
    }
    // Page routes fall back to the SPA shell; asset lookups stay 404 so a missing
    // bundle shows up as a failure rather than a page of HTML in a script tag.
    let index = root.join("index.html");
    if looks_like_page_route(relative) && index.is_file() {
        return file_response(&index);
    }
    StatusCode::NOT_FOUND.into_response()
}

type ArcState = std::sync::Arc<AppState>;

fn looks_like_page_route(relative: &str) -> bool {
    // A last segment carrying a file extension is an asset request.
    match relative.rsplit('/').next() {
        Some(last) => !last.contains('.'),
        None => true,
    }
}

/// Resolve inside the root only: `..` in a request must not walk out of the
/// bundle.
fn safe_file(root: &Path, candidate: &PathBuf) -> Option<PathBuf> {
    let resolved = candidate.canonicalize().ok()?;
    let root = root.canonicalize().ok()?;
    if resolved.starts_with(&root) && resolved.is_file() {
        Some(resolved)
    } else {
        None
    }
}

fn file_response(path: &Path) -> Response {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let guessed = mime_guess::from_path(path).first_or_octet_stream();
    // The bundle's ES modules must be served as JavaScript: some Windows MIME
    // tables guess `text/plain` for `.js`, and a browser refuses the module.
    let content_type = match guessed.essence_str() {
        "text/javascript" => "application/javascript",
        other => other,
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type.to_string())],
        Body::from(bytes),
    )
        .into_response()
}
