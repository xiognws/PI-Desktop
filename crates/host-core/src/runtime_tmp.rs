//! Process-wide temporary files (AGENTS.md §8).
//!
//! Everything the running host writes for its own purposes — a curl download
//! scratch file, a request body handed to an external tool, an extracted
//! payload — lives under `<data_dir>/tmp`. The system temp directory belongs to
//! the user and to other programs: it is outside the folder this application
//! backs up, relocates and asks a user to inspect when something goes wrong, and
//! on Windows it collects files whose owner has long exited.
//!
//! The root is installed once per process by [`install_root`] (called from
//! `AppState::open`) and read back through [`scratch_path`]. Names carry the
//! pid and a counter, so concurrent writers never collide without each call
//! creating its own directory.

use crate::db::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Directory name under the data folder. Public so startup can create it and
/// the Electron side can agree on the same spelling.
pub(crate) const DIR_NAME: &str = "tmp";

/// `<data_dir>/tmp`, whether or not it exists yet.
pub(crate) fn root(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// Point this process at its data directory. First call wins; a second call
/// with the same directory is a no-op, which keeps tests and restarts simple.
pub(crate) fn install_root(data_dir: &Path) {
    let candidate = root(data_dir);
    let _ = std::fs::create_dir_all(&candidate);
    let _ = ROOT.set(candidate);
}

fn installed_root() -> Result<&'static Path> {
    ROOT.get()
        .map(PathBuf::as_path)
        .ok_or_else(|| anyhow!("runtime temp root is not initialised"))
}

/// Create and return `<data_dir>/tmp` for a caller that has the data directory.
pub(crate) fn ensure_root(data_dir: &Path) -> Result<PathBuf> {
    let dir = root(data_dir);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Unique scratch file inside the installed root: `<purpose>-<pid>-<seq><ext>`.
///
/// The file is not created; the caller writes, reads and removes it. `ext`
/// includes the dot (`".bin"`) or is empty.
pub(crate) fn scratch_path(purpose: &str, ext: &str) -> Result<PathBuf> {
    let root = installed_root()?;
    std::fs::create_dir_all(root)?;
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(root.join(format!("{purpose}-{}-{seq}{ext}", std::process::id())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_paths_live_under_the_data_directory_and_are_unique() {
        let dir = tempfile::tempdir().unwrap();
        install_root(dir.path());
        let first = scratch_path("download", ".bin").unwrap();
        let second = scratch_path("download", ".bin").unwrap();
        assert!(first.starts_with(dir.path().join(DIR_NAME)));
        assert_ne!(first, second);
        std::fs::write(&first, b"payload").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"payload");
    }

    #[test]
    fn the_root_is_created_on_demand() {
        let dir = tempfile::tempdir().unwrap();
        let created = ensure_root(dir.path()).unwrap();
        assert_eq!(created, dir.path().join(DIR_NAME));
        assert!(created.is_dir());
    }
}
