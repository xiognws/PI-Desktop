//! Preinstalled plugins, and what the user did to them.
//!
//! An install image ships a set of plugins in `resources/plugins` (and any
//! directory the desktop shell names in `PI_DESKTOP_PREINSTALLED_DIRS`). Those
//! plugins are *preinstalled*, not fixed: the user may disable them, update
//! them from the marketplace, or remove them altogether. What the host owes
//! them is memory — of what was shipped, and of what the user decided — so
//! that an app update neither resurrects a plugin the user removed nor
//! silently discards a version they installed on purpose.
//!
//! Three states, one record per plugin id:
//!
//! * `untouched` — the row is rebuilt from the shipped manifest on every
//!   launch. An app update therefore refreshes it, which is how a shipped
//!   security fix reaches the user.
//! * `modified` — the user installed or updated that id themselves. Their copy
//!   survives launches, and only a *strictly newer* shipped version replaces
//!   it (ADR 0241).
//! * `removed` — the user uninstalled it. The tombstone is what stops the next
//!   launch from seeding it back; `restore_preinstalled` is how it comes back.
//!
//! Nothing here deletes files outside the data directory: a preinstalled
//! plugin's directory belongs to the installation, and an `external` plugin's
//! directory belongs to the user. Removing either is a registry decision.

use super::*;
use std::collections::{BTreeMap, BTreeSet};

/// File recording the user's decisions, beside `registry.json`.
pub(crate) const STATE_FILE: &str = "plugins/preinstalled-state.json";

const STATE_SCHEMA_VERSION: u32 = 1;

/// Environment variable naming one or more directories of preinstalled plugins.
///
/// A list rather than one path because a distribution may split its own set
/// from a vendored one; `std::env::split_paths` decides the separator.
pub(crate) const PREINSTALLED_DIRS_ENV: &str = "PI_DESKTOP_PREINSTALLED_DIRS";

/// The name this variable had while preinstalled plugins were called bundled.
/// Still read, so an older shell keeps working against this host.
pub(crate) const LEGACY_PREINSTALLED_DIR_ENV: &str = "PI_DESKTOP_BUILTIN_PLUGINS_DIR";

/// Environment variable naming directories of plugins the user pointed at.
///
/// These are the user's own directories — a checkout they are developing in, a
/// share they copied plugins onto — so the host reads them in place and never
/// copies or deletes anything in them.
pub(crate) const EXTRA_DIRS_ENV: &str = "PI_DESKTOP_EXTRA_PLUGIN_DIRS";

/// What the user did to one preinstalled plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PreinstalledState {
    /// Rebuild the row from the shipped manifest on every launch.
    #[default]
    Untouched,
    /// The user installed or updated this id themselves.
    Modified,
    /// The user uninstalled it; do not seed it back.
    Removed,
}

/// One plugin's record. `seeded_version` is the version the image shipped when
/// the record was last written, which is what makes "the image moved on" a
/// comparison instead of a guess.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreinstalledRecord {
    pub seeded_version: String,
    #[serde(default)]
    pub state: PreinstalledState,
}

/// `<data>/plugins/preinstalled-state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreinstalledStateFile {
    #[serde(default = "state_schema_version")]
    pub schema_version: u32,
    /// Version of the application build that last seeded anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeded_from: Option<String>,
    #[serde(default)]
    pub plugins: BTreeMap<String, PreinstalledRecord>,
}

fn state_schema_version() -> u32 {
    STATE_SCHEMA_VERSION
}

impl Default for PreinstalledStateFile {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            seeded_from: None,
            plugins: BTreeMap::new(),
        }
    }
}

/// Directories this build ships plugins in, in scan order.
///
/// A missing or unreadable directory is dropped rather than reported: a build
/// without preinstalled plugins is valid (the E2E harness runs like that), and
/// `IsADirectory` failures here would only refuse a start that works fine.
pub(crate) fn preinstalled_dirs() -> Vec<PathBuf> {
    let mut dirs = env_dirs(PREINSTALLED_DIRS_ENV);
    if dirs.is_empty() {
        dirs = env_dirs(LEGACY_PREINSTALLED_DIR_ENV);
    }
    dirs.retain(|dir| dir.is_dir());
    dirs
}

/// Directories the user added in settings, in scan order.
pub(crate) fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = env_dirs(EXTRA_DIRS_ENV);
    dirs.retain(|dir| dir.is_dir());
    dirs
}

/// Split one environment variable into existing absolute paths, keeping order.
fn env_dirs(name: &str) -> Vec<PathBuf> {
    let Ok(raw) = std::env::var(name) else {
        return Vec::new();
    };
    std::env::split_paths(&raw)
        .filter(|path| !path.as_os_str().is_empty())
        .collect()
}

/// Version of the application that wrote the record, when the shell says so.
pub(crate) fn build_version() -> Option<String> {
    std::env::var("PI_DESKTOP_APP_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl PluginManager {
    pub(crate) fn preinstalled_state_path(&self) -> PathBuf {
        self.data_dir.join(STATE_FILE)
    }

    /// Read the record. An absent file is the state every existing install is
    /// in: nothing was shipped before this mechanism existed, so nothing was
    /// decided either.
    pub(crate) fn load_preinstalled_state(&mut self) {
        let path = self.preinstalled_state_path();
        let Ok(raw) = fs::read_to_string(path) else {
            self.preinstalled_state = PreinstalledStateFile::default();
            return;
        };
        self.preinstalled_state = serde_json::from_str(&raw).unwrap_or_default();
    }

    pub(crate) fn save_preinstalled_state(&self) -> Result<()> {
        let path = self.preinstalled_state_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            path,
            serde_json::to_string_pretty(&self.preinstalled_state)?,
        )?;
        Ok(())
    }

    /// Record the version this build shipped, when nothing newer is known.
    fn remember_seeded(&mut self, id: &str, version: &str) -> bool {
        let build = build_version();
        let mut changed = false;
        {
            let record = self
                .preinstalled_state
                .plugins
                .entry(id.to_string())
                .or_insert_with(|| PreinstalledRecord {
                    seeded_version: version.to_string(),
                    state: PreinstalledState::Untouched,
                });
            if record.seeded_version != version {
                record.seeded_version = version.to_string();
                changed = true;
            }
        }
        if let Some(build) = build {
            if self.preinstalled_state.seeded_from.as_deref() != Some(build.as_str()) {
                self.preinstalled_state.seeded_from = Some(build);
                changed = true;
            }
        }
        changed
    }

    /// The user installed this id themselves: keep their copy across launches.
    ///
    /// `version` is the version now registered under that id. An existing
    /// record keeps the `seeded_version` it already has: that field is the
    /// image's version, which only the sync pass may move.
    pub(crate) fn mark_preinstalled_modified(&mut self, id: &str, version: &str) {
        if !self.preinstalled_ids.contains(id) {
            return;
        }
        let record = self
            .preinstalled_state
            .plugins
            .entry(id.to_string())
            .or_insert_with(|| PreinstalledRecord {
                seeded_version: version.to_string(),
                state: PreinstalledState::Untouched,
            });
        record.state = PreinstalledState::Modified;
        let _ = self.save_preinstalled_state();
    }

    /// The user uninstalled this id: remember it so the next launch does not
    /// seed it back.
    pub(crate) fn mark_preinstalled_removed(&mut self, id: &str, version: &str) {
        if !self.preinstalled_ids.contains(id) {
            return;
        }
        let record = self
            .preinstalled_state
            .plugins
            .entry(id.to_string())
            .or_insert_with(|| PreinstalledRecord {
                seeded_version: version.to_string(),
                state: PreinstalledState::Removed,
            });
        record.state = PreinstalledState::Removed;
        if !version.trim().is_empty() {
            record.seeded_version = version.to_string();
        }
        let _ = self.save_preinstalled_state();
    }

    /// Preinstalled ids the user removed, newest decision last.
    pub fn preinstalled_removed(&self) -> Vec<(String, String)> {
        self.preinstalled_state
            .plugins
            .iter()
            .filter(|(_, record)| record.state == PreinstalledState::Removed)
            .map(|(id, record)| (id.clone(), record.seeded_version.clone()))
            .collect()
    }

    /// Put a removed plugin back. The record is cleared rather than flipped
    /// back to `untouched`, because a user who removed 1.0.0 and installed
    /// 1.4.0 by hand must not have that decision reappear as "untouched".
    pub fn restore_preinstalled(&mut self, id: &str) -> Result<Option<PluginSummary>> {
        // A removed plugin is not in `preinstalled_ids` — that set is what this
        // launch ships as rows — so the record is what proves the id was ever
        // preinstalled.
        let known =
            self.preinstalled_ids.contains(id) || self.preinstalled_state.plugins.contains_key(id);
        if !known {
            return Ok(None);
        }
        self.preinstalled_state.plugins.remove(id);
        self.save_preinstalled_state()?;
        let dirs = self.preinstalled_dirs.clone();
        self.sync_preinstalled(&dirs)?;
        Ok(self.get(id))
    }

    /// Reconcile the registry with the plugins this image ships.
    ///
    /// A preinstalled plugin is an ordinary plugin in every other respect: it
    /// goes through the same contribution channel a third-party plugin uses
    /// (ADR 0104) and can be removed like one. What the image decides is the
    /// *default* — the row exists without the user installing anything — and
    /// what the user decides is whether it stays.
    ///
    /// Directories are scanned in order and the first manifest for an id wins,
    /// so a distribution can layer its own set in front of a vendored one.
    /// Rows belonging to an `external` directory take precedence over all of
    /// this: the user pointed at that directory on purpose.
    pub fn sync_preinstalled(&mut self, dirs: &[PathBuf]) -> Result<()> {
        let readable: Vec<PathBuf> = dirs.iter().filter(|dir| dir.is_dir()).cloned().collect();
        if readable.is_empty() {
            // Not "this build ships nothing", but "this launch cannot see what
            // it ships" — an unset variable, a checkout that has no
            // `resources/plugins`, a mount that is not ready yet. Reconciling
            // against nothing would drop every row and every decision, so leave
            // both alone and let the next launch decide.
            return Ok(());
        }
        // Remember what we reconciled against, so `restore_preinstalled` can
        // rebuild a row later without being handed the directories again.
        self.preinstalled_dirs = readable.clone();

        let mut shipped: Vec<PluginSummary> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for dir in &readable {
            let Ok(entries) = fs::read_dir(dir) else {
                // A directory that vanished is not a reason to refuse a start.
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.join("manifest.json").exists() {
                    continue;
                }
                let manifest = match Self::read_manifest(&path) {
                    Ok(manifest) => manifest,
                    // A malformed shipped plugin is a build defect. Skip it
                    // rather than refusing to start the whole host.
                    Err(_) => continue,
                };
                if !seen.insert(manifest.id.clone()) {
                    continue;
                }
                // A plugin the user removed stays removed, whatever the image
                // ships, until they ask for it back.
                let removed = self
                    .preinstalled_state
                    .plugins
                    .get(&manifest.id)
                    .is_some_and(|record| record.state == PreinstalledState::Removed);
                if removed {
                    continue;
                }
                // An `external` row means the user is running their own copy of
                // this id; the image must not claim the name.
                if self
                    .runtime
                    .iter()
                    .any(|p| p.id == manifest.id && p.source == "external")
                {
                    continue;
                }
                let previous = self.runtime.iter().find(|p| p.id == manifest.id);
                let now = Utc::now().to_rfc3339();
                let enabled = previous
                    .map(|p| p.enabled)
                    .unwrap_or(manifest.enabled_by_default.unwrap_or(true));
                shipped.push(PluginSummary {
                    id: manifest.id.clone(),
                    name: manifest.name.clone(),
                    version: manifest.version.clone(),
                    enabled,
                    scope: previous.map(|p| p.scope.clone()).unwrap_or_default(),
                    source: "preinstalled".into(),
                    bundled: true,
                    status: if enabled {
                        "ready".into()
                    } else {
                        "disabled".into()
                    },
                    error_message: None,
                    permissions: manifest.permissions.clone(),
                    path: Some(path.to_string_lossy().to_string()),
                    capabilities: derive_capabilities(&manifest),
                    description: manifest.description.clone(),
                    author: manifest.author.clone(),
                    installed_at: previous
                        .and_then(|p| p.installed_at.clone())
                        .or(Some(now.clone())),
                    updated_at: Some(now),
                    marketplace: None,
                    auto_update: None,
                    update_available: None,
                    // A preinstalled plugin has no publisher to yank it; its
                    // lifecycle is the application's own release cycle.
                    yanked: None,
                    ui: manifest.ui.clone(),
                    fs: manifest.fs.clone(),
                    settings: derive_settings(&manifest),
                    i18n: manifest.i18n.clone(),
                });
            }
        }

        self.preinstalled_ids = shipped.iter().map(|p| p.id.clone()).collect();
        self.drop_missing_preinstalled(&shipped)?;

        let mut state_changed = false;
        for summary in &shipped {
            // An install the user made over a preinstalled plugin is theirs to
            // keep: it stays registered unless this build ships something
            // strictly newer (ADR 0241).
            let user_copy = self
                .runtime
                .iter()
                .find(|p| {
                    p.id == summary.id && p.source != "preinstalled" && p.source != "external"
                })
                .filter(|p| compare_plugin_versions(&p.version, &summary.version) != Ordering::Less)
                .cloned();
            match user_copy {
                Some(existing) => {
                    // Their copy wins for now; remember that this id is theirs
                    // so a later launch does not read the row as untouched.
                    let already = self
                        .preinstalled_state
                        .plugins
                        .get(&summary.id)
                        .is_some_and(|record| {
                            record.state != PreinstalledState::Untouched
                                && record.seeded_version == summary.version
                        });
                    if !already {
                        self.preinstalled_state.plugins.insert(
                            summary.id.clone(),
                            PreinstalledRecord {
                                seeded_version: summary.version.clone(),
                                state: PreinstalledState::Modified,
                            },
                        );
                        state_changed = true;
                    }
                    self.runtime.retain(|p| p.id != summary.id);
                    self.runtime.push(PluginSummary {
                        bundled: true,
                        ..existing
                    });
                }
                None => {
                    self.runtime.retain(|p| p.id != summary.id);
                    self.runtime.push(summary.clone());
                    if self.remember_seeded(&summary.id, &summary.version) {
                        state_changed = true;
                    }
                }
            }
        }

        // What this build ships decides the flag, not what the row says.
        let preinstalled_ids = self.preinstalled_ids.clone();
        for plugin in &mut self.runtime {
            plugin.bundled = preinstalled_ids.contains(&plugin.id);
        }

        // Forget decisions about ids this build stopped shipping: the record
        // exists to reconcile an image with a user, and there is no image left.
        // `seen` — not `shipped` — is the key, because a plugin the user removed
        // is absent from `shipped` by design and its tombstone is the one record
        // that must survive.
        let before = self.preinstalled_state.plugins.len();
        self.preinstalled_state
            .plugins
            .retain(|id, _| seen.contains(id));
        if self.preinstalled_state.plugins.len() != before {
            state_changed = true;
        }

        if state_changed {
            self.save_preinstalled_state()?;
        }
        self.save()
    }

    /// Reconcile the registry with directories the user pointed at.
    ///
    /// Unlike `sync_preinstalled`, nothing here is copied and nothing is
    /// remembered: the directory is the user's, so a row appears while the
    /// manifest is there and disappears when it is gone. Removing such a plugin
    /// only removes the row — the files are not ours to delete.
    pub fn sync_extra(&mut self, dirs: &[PathBuf]) -> Result<()> {
        if dirs.is_empty() {
            // Dropping the variable retires every row it used to justify: with
            // no directory on the list, no external plugin is authorized, even
            // if its files are still on disk.
            let before = self.runtime.len();
            self.runtime.retain(|p| p.source != "external");
            if self.runtime.len() != before {
                self.save()?;
            }
            return Ok(());
        }
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut rows: Vec<PluginSummary> = Vec::new();
        for dir in dirs {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.join("manifest.json").exists() {
                    continue;
                }
                let Ok(manifest) = Self::read_manifest(&path) else {
                    continue;
                };
                if !seen.insert(manifest.id.clone()) {
                    continue;
                }
                let previous = self.runtime.iter().find(|p| p.id == manifest.id);
                let now = Utc::now().to_rfc3339();
                let enabled = previous
                    .map(|p| p.enabled)
                    .unwrap_or(manifest.enabled_by_default.unwrap_or(true));
                rows.push(PluginSummary {
                    id: manifest.id.clone(),
                    name: manifest.name.clone(),
                    version: manifest.version.clone(),
                    enabled,
                    scope: previous.map(|p| p.scope.clone()).unwrap_or_default(),
                    source: "external".into(),
                    bundled: false,
                    status: if enabled {
                        "ready".into()
                    } else {
                        "disabled".into()
                    },
                    error_message: None,
                    permissions: manifest.permissions.clone(),
                    path: Some(path.to_string_lossy().to_string()),
                    capabilities: derive_capabilities(&manifest),
                    description: manifest.description.clone(),
                    author: manifest.author.clone(),
                    installed_at: previous
                        .and_then(|p| p.installed_at.clone())
                        .or(Some(now.clone())),
                    updated_at: Some(now),
                    marketplace: None,
                    auto_update: Some(false),
                    update_available: None,
                    yanked: None,
                    ui: manifest.ui.clone(),
                    fs: manifest.fs.clone(),
                    settings: derive_settings(&manifest),
                    i18n: manifest.i18n.clone(),
                });
            }
        }

        let keep: BTreeSet<String> = rows.iter().map(|p| p.id.clone()).collect();
        let before = self.runtime.len();
        // A row from an external directory that is no longer scanned — removed
        // from the list, or its manifest deleted — is stale; one the user
        // installed under the same id is not.
        self.runtime
            .retain(|p| p.source != "external" || keep.contains(&p.id));
        let mut changed = self.runtime.len() != before;
        for row in rows {
            // An external copy replaces whatever the image or the marketplace
            // put under that id: pointing at a directory is a deliberate act.
            self.runtime.retain(|p| p.id != row.id);
            self.runtime.push(row);
            changed = true;
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    /// Forget preinstalled rows this build no longer ships, and rows the user
    /// removed.
    fn drop_missing_preinstalled(&mut self, shipped: &[PluginSummary]) -> Result<()> {
        let keep: Vec<&str> = shipped.iter().map(|p| p.id.as_str()).collect();
        self.runtime
            .retain(|p| p.source != "preinstalled" || keep.contains(&p.id.as_str()));
        Ok(())
    }
}
