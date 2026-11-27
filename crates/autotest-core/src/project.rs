//! Project directory rules.
//!
//! A project *is* its directory: `<workspace>/<project_id>/`, registered by
//! `project.json`. That makes the id a path segment, so it is validated before
//! it is ever joined onto a path — a request for `:projectId` or `../x` must be
//! a 404, never a directory the service creates.

use std::path::{Path, PathBuf};

use crate::error::ApiError;

/// Shape check only: the creation flow needs the path before `project.json`
/// exists, so existence is a separate question (`require_project`).
pub fn safe_project_dir(workspace: &Path, project_id: &str) -> Result<PathBuf, ApiError> {
    let bad = project_id.is_empty()
        || project_id == "."
        || project_id == ".."
        || project_id.contains('/')
        || project_id.contains('\\')
        || project_id.contains(':')
        || project_id.contains("..");
    if bad {
        return Err(ApiError::not_found(format!("项目不存在: {project_id}")));
    }
    Ok(workspace.join(project_id))
}

/// A project that must already exist: a directory under the workspace carrying
/// its `project.json` registry file.
pub fn require_project(workspace: &Path, project_id: &str) -> Result<PathBuf, ApiError> {
    let project_dir = safe_project_dir(workspace, project_id)?;
    if !project_dir.is_dir() || !project_dir.join("project.json").is_file() {
        return Err(ApiError::not_found(format!("项目不存在: {project_id}")));
    }
    Ok(project_dir)
}

pub fn project_config_path(project_dir: &Path) -> PathBuf {
    project_dir.join("project.json")
}
