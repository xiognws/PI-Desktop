//! The workflow API: the agent-facing tools that turn a requirement into cases,
//! scripts and a report.
//!
//! Every route answers the same envelope — `{ok, summary, data, refs}` — because
//! the plugin's tools forward it straight to the model and never rebuild a
//! result shape themselves. The rules (stages, dedupe, ceilings) stay here, not
//! in the prompt.
//!
//! Ported from `services/autotest/src/autotest/workflow/`. Module layout mirrors
//! the Python package so a reader can diff the two side by side.

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub mod analysis;
pub mod assertion_gen;
pub mod bugs;
pub mod cases;
pub mod consistency;
pub mod dut_contract;
pub mod exception_matrix;
pub mod execution;
pub mod extract;
pub mod grounding;
pub mod hashes;
pub mod knowledge_bridge;
pub mod persist;
pub mod prd;
pub mod prompts;
pub mod pyrepr;
pub mod report;
pub mod review;
pub mod routes;
pub mod routes_author;
pub mod routes_design;
pub mod routes_meta;
pub mod routes_report;
pub mod routes_runs;
pub mod scripts;
pub mod store;
pub mod vacuity;

/// Mount under `/api/projects/{project_id}/workflow`.
///
/// The state is bound once, by the service router: a sub-router that applied it
/// itself could not be merged into its parent.
pub fn routes() -> Router<Arc<AppState>> {
    routes::build()
}
