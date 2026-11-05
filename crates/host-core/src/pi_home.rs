//! One answer to "where does this product keep its files".
//!
//! The desktop app resolves the root at startup (a fixed folder on a data drive,
//! created when missing) and publishes it as `PI_HOME` before spawning this
//! process. A host started on its own — a test, a bare checkout — publishes
//! nothing and keeps the historical home-directory layout, so the same code
//! works in both worlds instead of hard-coding one of them.

use std::path::PathBuf;

/// The published root, when the app set one up.
pub fn published_home() -> Option<PathBuf> {
    match std::env::var("PI_HOME") {
        Ok(root) if !root.trim().is_empty() => Some(PathBuf::from(root.trim())),
        _ => None,
    }
}

/// Directory holding skills: `<PI_HOME>/agents`, else `~/.agents`.
pub fn agents_dir() -> Option<PathBuf> {
    match published_home() {
        Some(root) => Some(root.join("agents")),
        None => dirs::home_dir().map(|home| home.join(".agents")),
    }
}

/// Directory holding agent prompts: `<PI_HOME>/pi`, else `~/.pi`.
pub fn agent_pi_dir() -> Option<PathBuf> {
    match published_home() {
        Some(root) => Some(root.join("pi")),
        None => dirs::home_dir().map(|home| home.join(".pi")),
    }
}

/// Data directory: the published `PI_DESKTOP_DATA_DIR`, else `<PI_HOME>/data`,
/// else the historical `~/.pi-desktop`.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PI_DESKTOP_DATA_DIR").map(PathBuf::from) {
        return Some(dir);
    }
    if let Some(root) = published_home() {
        return Some(root.join("data"));
    }
    dirs::home_dir().map(|home| home.join(".pi-desktop"))
}
