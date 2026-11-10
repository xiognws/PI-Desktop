//! Widget packages (D691).
//!
//! A widget package is a directory under `<data>/widgets/<dir>/` with a
//! `widget.json` manifest and an entry module. The user drops the folder in
//! themselves; the app never ships packages, never downloads them, and never
//! installs anything on the user's behalf.
//!
//! This module owns the host half:
//!
//! * discovery — scan one directory level, read each manifest, report a row even
//!   when the manifest is broken so the user can see what to fix;
//! * trust — hash the directory contents and remember the digest the user
//!   accepted. A package whose bytes changed keeps loading, but only with the
//!   sandbox floor until the new digest is acknowledged;
//! * the enabled set — persisted in `<data>/widgets/state.json`.
//!
//! Execution lives in the agent sidecar. Nothing here evaluates package code.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Manifest file name inside each package directory.
pub const MANIFEST_FILE: &str = "widget.json";
/// Directory, relative to the data directory, that holds the user's packages.
pub const PACKAGES_DIR: &str = "widgets";
/// Relative path of the persisted state inside the data directory.
const STATE_FILE: &str = "widgets/state.json";
/// Manifest schema this build understands.
const SCHEMA_VERSION: u32 = 1;
/// Runtime API this build understands.
const API_VERSION: u32 = 1;
/// Most packages one data directory may hold; the scan stops after this many.
pub const MAX_PACKAGES: usize = 64;
/// Files one package may contain. A package is code, not a media bundle.
const MAX_PACKAGE_FILES: usize = 512;
/// Total bytes one package may contain, before hashing stops reading.
const MAX_PACKAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Permissions in escalating order. The order is the manifest's canonical order
/// and the order the UI renders, so a package's spread never looks random.
pub const PERMISSIONS: [&str; 5] = ["read", "write", "net", "agent", "host"];
/// Permissions a package keeps when it is not trusted at its current digest.
const SANDBOX_PERMISSIONS: [&str; 2] = ["read", "write"];

/// Absolute directory holding the user's widget packages.
pub fn packages_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PACKAGES_DIR)
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STATE_FILE)
}

/// One action a package exposes to the client and to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WidgetAction {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<String>>,
}

/// One package as the widget page renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub dir_name: String,
    pub path: String,
    pub requested_permissions: Vec<String>,
    pub granted_permissions: Vec<String>,
    pub actions: Vec<WidgetAction>,
    pub enabled: bool,
    /// `untrusted` | `trusted` | `modified`
    pub trust: String,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WidgetManifest {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    api_version: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    actions: Vec<ManifestAction>,
}

#[derive(Debug, Default, Deserialize)]
struct ManifestAction {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    params: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct WidgetState {
    #[serde(default)]
    disabled: BTreeSet<String>,
    /// Digest the user accepted per package id.
    #[serde(default)]
    trusted: BTreeMap<String, String>,
}

fn read_state(data_dir: &Path) -> Result<WidgetState> {
    let path = state_path(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WidgetState::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn write_state(data_dir: &Path, state: &WidgetState) -> Result<()> {
    let path = state_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(state)?;
    // Write-then-rename: a crash mid-write must not leave an unparsable state
    // file behind, because that would take the whole widget page down.
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, text).with_context(|| format!("write {}", staged.display()))?;
    std::fs::rename(&staged, &path).with_context(|| format!("replace {}", path.display()))
}

/// Narrow a raw permission list to the ones this build implements, in the
/// canonical order, without duplicates.
fn normalize_permissions(raw: &[String]) -> Vec<String> {
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for entry in raw {
        let value = entry.trim().to_ascii_lowercase();
        if PERMISSIONS.contains(&value.as_str()) {
            wanted.insert(value);
        }
    }
    PERMISSIONS
        .iter()
        .filter(|permission| wanted.contains(**permission))
        .map(|permission| permission.to_string())
        .collect()
}

/// The permissions a package keeps when its digest is not trusted.
fn sandbox_permissions(requested: &[String]) -> Vec<String> {
    requested
        .iter()
        .filter(|permission| SANDBOX_PERMISSIONS.contains(&permission.as_str()))
        .cloned()
        .collect()
}

/// SHA-256 over the package directory: relative path, size and bytes of every
/// regular file, in sorted order. Names are part of the digest because renaming
/// a file can change what the entry module imports.
fn digest_dir(root: &Path) -> Result<(String, usize, u64)> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut total: u64 = 0;
    collect_files(root, &mut files, &mut total)?;
    files.sort();
    let mut hasher = Sha256::new();
    for file in &files {
        let relative = file
            .strip_prefix(root)
            .unwrap_or(file)
            .to_string_lossy()
            .replace('\\', "/");
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        let bytes = std::fs::read(file).with_context(|| format!("read {}", file.display()))?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok((hex::encode(hasher.finalize()), files.len(), total))
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>, total: &mut u64) -> Result<()> {
    let entries = std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("read {}", dir.display()))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .with_context(|| format!("stat {}", path.display()))?;
        if metadata.is_dir() {
            // Hidden directories are tool leftovers (`.git`, `.cache`); a package
            // is what the user sees in the folder, not its VCS metadata.
            let hidden = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with('.'))
                .unwrap_or(false);
            if hidden {
                continue;
            }
            collect_files(&path, out, total)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        *total += metadata.len();
        out.push(path);
        anyhow::ensure!(
            out.len() <= MAX_PACKAGE_FILES,
            "package has more than {MAX_PACKAGE_FILES} files"
        );
        anyhow::ensure!(
            *total <= MAX_PACKAGE_BYTES,
            "package is larger than {MAX_PACKAGE_BYTES} bytes"
        );
    }
    Ok(())
}

fn broken_row(dir_name: &str, path: &Path, message: String) -> WidgetSummary {
    WidgetSummary {
        id: dir_name.to_string(),
        name: dir_name.to_string(),
        version: String::new(),
        description: String::new(),
        author: None,
        dir_name: dir_name.to_string(),
        path: path.to_string_lossy().to_string(),
        requested_permissions: Vec::new(),
        granted_permissions: Vec::new(),
        actions: Vec::new(),
        enabled: true,
        trust: "untrusted".to_string(),
        digest: String::new(),
        error: Some(message),
    }
}

fn read_package(dir: &Path, dir_name: &str, state: &WidgetState) -> WidgetSummary {
    let manifest_path = dir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(error) => {
            return broken_row(
                dir_name,
                dir,
                format!("{}: {error}", manifest_path.display()),
            )
        }
    };
    let manifest: WidgetManifest = match serde_json::from_str(&text) {
        Ok(manifest) => manifest,
        Err(error) => return broken_row(dir_name, dir, format!("{MANIFEST_FILE}: {error}")),
    };
    if manifest.schema_version != SCHEMA_VERSION {
        return broken_row(
            dir_name,
            dir,
            format!(
                "{MANIFEST_FILE}: unsupported schemaVersion {} (this build reads {SCHEMA_VERSION})",
                manifest.schema_version
            ),
        );
    }
    if manifest.api_version != API_VERSION {
        return broken_row(
            dir_name,
            dir,
            format!(
                "{MANIFEST_FILE}: unsupported apiVersion {} (this build runs {API_VERSION})",
                manifest.api_version
            ),
        );
    }
    let id = if manifest.id.trim().is_empty() {
        dir_name.to_string()
    } else {
        manifest.id.trim().to_string()
    };
    let name = if manifest.name.trim().is_empty() {
        id.clone()
    } else {
        manifest.name.trim().to_string()
    };
    let digest = match digest_dir(dir) {
        Ok((digest, _files, _bytes)) => digest,
        Err(error) => return broken_row(dir_name, dir, format!("digest: {error}")),
    };
    let requested = normalize_permissions(&manifest.permissions);
    let trust = match state.trusted.get(&id) {
        None => "untrusted",
        Some(expected) if *expected == digest => "trusted",
        Some(_) => "modified",
    };
    let granted = if trust == "trusted" {
        requested.clone()
    } else {
        sandbox_permissions(&requested)
    };
    let enabled = !state.disabled.contains(&id);
    WidgetSummary {
        id,
        name,
        version: manifest.version.trim().to_string(),
        description: manifest.description.trim().to_string(),
        author: manifest
            .author
            .filter(|author| !author.trim().is_empty())
            .map(|author| author.trim().to_string()),
        dir_name: dir_name.to_string(),
        path: dir.to_string_lossy().to_string(),
        requested_permissions: requested,
        granted_permissions: granted,
        actions: manifest
            .actions
            .into_iter()
            .filter(|action| !action.name.trim().is_empty())
            .map(|action| WidgetAction {
                name: action.name.trim().to_string(),
                description: action.description.trim().to_string(),
                params: action
                    .params
                    .map(|params| {
                        params
                            .into_iter()
                            .map(|param| param.trim().to_string())
                            .filter(|param| !param.is_empty())
                            .collect::<Vec<String>>()
                    })
                    .filter(|params: &Vec<String>| !params.is_empty()),
            })
            .collect(),
        enabled,
        trust: trust.to_string(),
        digest,
        error: None,
    }
}

/// Every widget package in the data directory, ordered by display name.
///
/// A missing `widgets/` directory is the normal state of a fresh install
/// and reports an empty list rather than an error.
pub fn list(data_dir: &Path) -> Result<Vec<WidgetSummary>> {
    let state = read_state(data_dir)?;
    let root = packages_dir(data_dir);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("read {}", root.display())),
    };
    let mut packages: Vec<WidgetSummary> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for entry in entries {
        if packages.len() >= MAX_PACKAGES {
            break;
        }
        let entry = entry.with_context(|| format!("read {}", root.display()))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let mut package = read_package(&entry.path(), &dir_name, &state);
        // Two directories claiming one id would render as one row twice; keep
        // the first and let the second show as broken so the user can fix it.
        if !seen.insert(package.id.clone()) {
            package.error = Some(format!("duplicate id {}", package.id));
            package.enabled = false;
            package.granted_permissions = Vec::new();
        }
        packages.push(package);
    }
    packages.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(packages)
}

/// Enable or disable one package, then hand the fresh list back.
pub fn set_enabled(data_dir: &Path, id: &str, enabled: bool) -> Result<Vec<WidgetSummary>> {
    let id = id.trim();
    anyhow::ensure!(!id.is_empty(), "id is required");
    let mut state = read_state(data_dir)?;
    if enabled {
        state.disabled.remove(id);
    } else {
        state.disabled.insert(id.to_string());
    }
    write_state(data_dir, &state)?;
    list(data_dir)
}

/// Trust the package's current digest, or drop the trust record.
///
/// Trusting records the digest that is on disk now; the caller passes the digest
/// it displayed, so a package edited between the review and the click is not
/// silently trusted. A mismatch is an error rather than a quiet success.
pub fn set_trusted(
    data_dir: &Path,
    id: &str,
    digest: &str,
    trusted: bool,
) -> Result<Vec<WidgetSummary>> {
    let id = id.trim();
    anyhow::ensure!(!id.is_empty(), "id is required");
    let packages = list(data_dir)?;
    let Some(package) = packages.iter().find(|package| package.id == id) else {
        anyhow::bail!("unknown widget {id}");
    };
    if let Some(error) = package.error.clone() {
        anyhow::bail!("widget {id} cannot be read: {error}");
    }
    let mut state = read_state(data_dir)?;
    if trusted {
        let digest = digest.trim();
        anyhow::ensure!(!digest.is_empty(), "digest is required");
        anyhow::ensure!(
            digest == package.digest,
            "widget {id} changed on disk since it was reviewed"
        );
        state.trusted.insert(id.to_string(), digest.to_string());
    } else {
        state.trusted.remove(id);
    }
    write_state(data_dir, &state)?;
    list(data_dir)
}

/// Absolute directory of one package, for "reveal in file manager".
pub fn package_dir(data_dir: &Path, id: &str) -> Result<PathBuf> {
    let id = id.trim();
    anyhow::ensure!(!id.is_empty(), "id is required");
    let packages = list(data_dir)?;
    let package = packages
        .iter()
        .find(|package| package.id == id)
        .ok_or_else(|| anyhow::anyhow!("unknown widget {id}"))?;
    Ok(PathBuf::from(&package.path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_package(root: &Path, dir: &str, manifest: &str, entry: &str) {
        let package = root.join(dir);
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join(MANIFEST_FILE), manifest).unwrap();
        std::fs::write(package.join("index.js"), entry).unwrap();
    }

    fn manifest(id: &str, permissions: &str) -> String {
        format!(
            r#"{{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "{id}",
  "name": "Tide probe",
  "version": "0.1.0",
  "permissions": [{permissions}],
  "actions": [{{ "name": "ping", "description": "Say hello" }}]
}}"#
        )
    }

    #[test]
    fn a_missing_directory_is_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn a_fresh_package_is_visible_but_untrusted_and_sandboxed() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            &manifest("local.tide", "\"read\", \"net\", \"host\""),
            "module.exports = () => ({});",
        );
        let packages = list(dir.path()).unwrap();
        assert_eq!(packages.len(), 1);
        let package = &packages[0];
        assert_eq!(package.id, "local.tide");
        assert_eq!(package.trust, "untrusted");
        assert_eq!(package.requested_permissions, vec!["read", "net", "host"]);
        assert_eq!(package.granted_permissions, vec!["read"]);
        assert!(package.enabled);
        assert_eq!(package.actions.len(), 1);
        assert!(!package.digest.is_empty());
    }

    #[test]
    fn trusting_a_digest_grants_every_requested_permission() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            &manifest("local.tide", "\"read\", \"agent\""),
            "module.exports = () => ({});",
        );
        let digest = list(dir.path()).unwrap()[0].digest.clone();
        let packages = set_trusted(dir.path(), "local.tide", &digest, true).unwrap();
        assert_eq!(packages[0].trust, "trusted");
        assert_eq!(packages[0].granted_permissions, vec!["read", "agent"]);
    }

    #[test]
    fn editing_a_trusted_package_downgrades_it_to_modified() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            &manifest("local.tide", "\"read\", \"host\""),
            "module.exports = () => ({});",
        );
        let digest = list(dir.path()).unwrap()[0].digest.clone();
        set_trusted(dir.path(), "local.tide", &digest, true).unwrap();
        std::fs::write(
            packages_dir(dir.path()).join("tide").join("index.js"),
            "module.exports = () => ({ value: 1 });",
        )
        .unwrap();
        let packages = list(dir.path()).unwrap();
        assert_eq!(packages[0].trust, "modified");
        assert_eq!(packages[0].granted_permissions, vec!["read"]);
    }

    #[test]
    fn trusting_a_stale_digest_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            &manifest("local.tide", "\"read\""),
            "module.exports = () => ({});",
        );
        let error = set_trusted(dir.path(), "local.tide", "deadbeef", true).unwrap_err();
        assert!(error.to_string().contains("changed on disk"));
    }

    #[test]
    fn disabling_a_package_is_persisted() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            &manifest("local.tide", "\"read\""),
            "module.exports = () => ({});",
        );
        let packages = set_enabled(dir.path(), "local.tide", false).unwrap();
        assert!(!packages[0].enabled);
        assert!(!list(dir.path()).unwrap()[0].enabled);
    }

    #[test]
    fn an_unknown_schema_still_reports_a_row() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "tide",
            r#"{ "schemaVersion": 99, "id": "local.tide" }"#,
            "",
        );
        let packages = list(dir.path()).unwrap();
        assert_eq!(packages.len(), 1);
        assert!(packages[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("schemaVersion"));
    }

    #[test]
    fn a_duplicate_id_reports_the_second_copy_as_broken() {
        let dir = tempfile::tempdir().unwrap();
        write_package(
            &packages_dir(dir.path()),
            "one",
            &manifest("local.tide", "\"read\""),
            "",
        );
        write_package(
            &packages_dir(dir.path()),
            "two",
            &manifest("local.tide", "\"read\""),
            "",
        );
        let packages = list(dir.path()).unwrap();
        assert_eq!(packages.len(), 2);
        let broken = packages
            .iter()
            .find(|package| package.error.is_some())
            .expect("one copy is reported broken");
        assert!(broken
            .error
            .as_deref()
            .unwrap_or("")
            .contains("duplicate id"));
    }
}
