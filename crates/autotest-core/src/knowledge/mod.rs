//! Knowledge base: import a document, split it into retrievable chunks, search
//! them back.
//!
//! Ported from `services/autotest/src/autotest/knowledge/`. The extraction step
//! is the part that must not lose fidelity: a spec that arrives as `.docx` or
//! `.pdf` has to yield the same text the Python extractor produced, because
//! every case's evidence is quoted from it.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod chunk;
pub mod extract;
pub mod inflate;
pub mod routes;
pub mod sha256;
pub mod store;
pub mod text;
pub mod zip;

#[cfg(test)]
pub mod office_fixtures;

/// Mount under `/api/projects/{project_id}/knowledge`.
pub fn routes() -> Router<Arc<AppState>> {
    routes::build()
}
