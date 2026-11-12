use super::*;
use std::collections::BTreeSet;

pub struct PluginManager {
    pub(crate) data_dir: PathBuf,
    pub(crate) runtime: Vec<PluginSummary>,
    /// Ids this image ships as preinstalled plugins (ADR 0241, ADR 0396).
    ///
    /// Recomputed from disk on every launch and never persisted: a plugin this
    /// build stops shipping must stop being treated as preinstalled
    /// immediately, whatever the row that survives it looks like.
    pub(crate) preinstalled_ids: BTreeSet<String>,
    /// What the user decided about each preinstalled plugin.
    ///
    /// Persisted in `plugins/preinstalled-state.json` next to the registry, and
    /// the only memory that survives an app update: see `preinstalled.rs`.
    pub(crate) preinstalled_state: super::preinstalled::PreinstalledStateFile,
    /// Directories scanned for preinstalled plugins, resolved once at start.
    pub(crate) preinstalled_dirs: Vec<PathBuf>,
    /// Directories the user pointed the host at, resolved once at start.
    pub(crate) extra_dirs: Vec<PathBuf>,
    /// Catalog channel pinned by app settings.
    pub(crate) market_channel: MarketChannel,
    /// Cancel token of the install currently running, when one is.
    ///
    /// The renderer's cancel action flips it and the download loop reads it.
    /// Only one install runs at a time — the RPC that starts one holds the
    /// state lock — so a single slot is enough.
    pub(crate) install_cancel: Option<CancelToken>,
    /// Locale a row's display fields are resolved against.
    ///
    /// The desktop shell owns the app language — `settings.language`, or the
    /// OS locale while it is `auto` — and pushes it here. Until it does, rows
    /// read English, which is the source language of the plugin contract.
    pub(crate) locale: String,
}

impl PluginManager {
    /// Build a manager against the official catalog channel.
    ///
    /// The legacy custom URL argument is accepted and ignored for compatibility.
    pub fn new(
        data_dir: &Path,
        market_channel: MarketChannel,
        _legacy_custom_url: Option<String>,
    ) -> Self {
        let mut mgr = Self {
            data_dir: data_dir.to_path_buf(),
            runtime: Vec::new(),
            preinstalled_ids: BTreeSet::new(),
            preinstalled_state: super::preinstalled::PreinstalledStateFile::default(),
            preinstalled_dirs: super::preinstalled::preinstalled_dirs(),
            extra_dirs: super::preinstalled::extra_dirs(),
            market_channel,
            install_cancel: None,
            locale: "en".into(),
        };
        let _ = mgr.ensure_dirs();
        let _ = mgr.ensure_default_catalog();
        mgr.load_preinstalled_state();
        let _ = mgr.reload_from_disk();
        // Directories the user pointed at come first: naming one is a
        // deliberate act, so that copy wins over anything the image or the
        // marketplace put under the same id. Then the image's own set.
        let extra = mgr.extra_dirs.clone();
        let _ = mgr.sync_extra(&extra);
        let shipped = mgr.preinstalled_dirs.clone();
        let _ = mgr.sync_preinstalled(&shipped);
        mgr
    }

    pub(crate) fn ensure_dirs(&self) -> Result<()> {
        for rel in [
            "plugins/installed",
            "plugins/disabled",
            "plugins/data",
            "plugins/logs",
            "plugins/cache/download",
            "plugins/cache/backup",
            "plugins/market",
        ] {
            fs::create_dir_all(self.data_dir.join(rel))?;
        }
        Ok(())
    }

    pub(crate) fn registry_path(&self) -> PathBuf {
        self.data_dir.join("plugins/registry.json")
    }

    pub(crate) fn catalog_path(&self) -> PathBuf {
        self.data_dir.join("plugins/market/catalog.json")
    }

    pub(crate) fn installed_dir(&self, id: &str) -> PathBuf {
        self.data_dir
            .join("plugins/installed")
            .join(sanitize_id(id))
    }

    pub(crate) fn data_dir_for(&self, id: &str) -> PathBuf {
        self.data_dir.join("plugins/data").join(sanitize_id(id))
    }

    pub fn list(&self) -> Vec<PluginSummary> {
        self.runtime
            .iter()
            .map(|plugin| plugin.localized(&self.locale))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<PluginSummary> {
        self.runtime
            .iter()
            .find(|p| p.id == id)
            .map(|plugin| plugin.localized(&self.locale))
    }

    /// Follow the app language pushed down by the desktop shell.
    ///
    /// Stored rows keep the author's own strings; only reads are resolved, so
    /// switching language never rewrites the registry.
    pub fn set_locale(&mut self, locale: &str) {
        let next = locale.trim();
        // `auto` is a setting, not a locale: the desktop shell resolves it
        // before pushing. Storing it would only make every lookup read English.
        if next.is_empty() || next.eq_ignore_ascii_case("auto") {
            return;
        }
        if next != self.locale {
            self.locale = next.to_string();
        }
    }

    /// Locale a row's display text is resolved against.
    pub fn locale(&self) -> &str {
        &self.locale
    }

    pub fn reload_from_disk(&mut self) -> Result<()> {
        let path = self.registry_path();
        if !path.exists() {
            self.runtime.clear();
            return Ok(());
        }
        let raw = fs::read_to_string(path)?;
        self.runtime = serde_json::from_str(&raw).unwrap_or_default();
        for plugin in &mut self.runtime {
            // Rows written before preinstalled plugins were removable say
            // "builtin". The meaning is the same, but a row left as "builtin"
            // would be read by the sync pass as a user install and would keep
            // the image's own copy from ever being refreshed.
            if plugin.source == "builtin" {
                plugin.source = "preinstalled".into();
            }
        }
        for plugin in &mut self.runtime {
            let Some(plugin_path) = plugin.path.as_deref() else {
                continue;
            };
            let manifest_path = Path::new(plugin_path).join("manifest.json");
            let Ok(manifest_raw) = fs::read_to_string(manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<PluginManifest>(&manifest_raw) else {
                continue;
            };
            plugin.settings = derive_settings(&manifest);
            plugin.i18n = manifest.i18n.clone();
        }
        Ok(())
    }

    pub(crate) fn save(&self) -> Result<()> {
        let path = self.registry_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(&self.runtime)?)?;
        Ok(())
    }

    pub(crate) fn upsert_summary(&mut self, summary: PluginSummary) -> Result<PluginSummary> {
        self.runtime.retain(|p| p.id != summary.id);
        // The row is stored as the author wrote it and localized on the way
        // out, so every reader of this summary gets the same treatment as
        // `list()` and `get()`.
        let response = summary.localized(&self.locale);
        self.runtime.push(summary);
        self.save()?;
        Ok(response)
    }

    pub fn load_dev(&mut self, plugin_path: &str) -> Result<PluginSummary> {
        let path = PathBuf::from(plugin_path);
        let manifest = Self::read_manifest(&path)?;
        let now = Utc::now().to_rfc3339();
        let summary = PluginSummary {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            enabled: true,
            scope: ActivationScope::default(),
            source: "dev".into(),
            bundled: false,
            status: "ready".into(),
            error_message: None,
            permissions: manifest.permissions.clone(),
            path: Some(path.to_string_lossy().to_string()),
            capabilities: derive_capabilities(&manifest),
            description: manifest.description.clone(),
            author: manifest.author.clone(),
            installed_at: Some(now.clone()),
            updated_at: Some(now),
            marketplace: None,
            auto_update: Some(false),
            update_available: None,
            yanked: None,
            ui: manifest.ui.clone(),
            fs: manifest.fs.clone(),
            settings: derive_settings(&manifest),
            i18n: manifest.i18n.clone(),
        };
        self.upsert_summary(summary)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.enabled = enabled;
            plugin.status = if enabled {
                "ready".into()
            } else {
                "disabled".into()
            };
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    /// Move a plugin between "everywhere" and "these projects". Kept separate
    /// from `set_enabled` so switching a plugin off never discards its list.
    pub fn set_scope(&mut self, id: &str, scope: ActivationScope) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.scope = scope.normalized();
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn set_auto_update(&mut self, id: &str, enabled: bool) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.auto_update = Some(enabled);
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn uninstall(&mut self, id: &str) -> Result<bool> {
        let existing = self.get(id);
        // A preinstalled plugin is a plugin like any other: the user may remove
        // it, and the image does not get a vote. What has to survive the
        // removal is the *decision* — the tombstone in
        // `plugins/preinstalled-state.json` is what stops the next launch, or
        // the next app update, from seeding it back.
        //
        // The files stay: a preinstalled plugin's directory belongs to the
        // installation, and an `external` plugin's belongs to the user. Neither
        // is ours to delete, so removing either only removes the row.
        if let Some(plugin) = &existing {
            if self.preinstalled_ids.contains(id) {
                self.mark_preinstalled_removed(id, &plugin.version);
            }
        }
        let before = self.runtime.len();
        self.runtime.retain(|p| p.id != id);
        self.save()?;
        if let Some(plugin) = existing {
            if plugin.source != "dev" {
                let installed = self.installed_dir(id);
                if installed.exists() {
                    let _ = fs::remove_dir_all(installed);
                }
            }
            // Default policy: delete plugin private data on uninstall.
            let data = self.data_dir_for(id);
            if data.exists() {
                let _ = fs::remove_dir_all(data);
            }
            let log = self
                .data_dir
                .join("plugins/logs")
                .join(format!("{}.log", sanitize_id(id)));
            let _ = fs::remove_file(log);
        }
        Ok(self.runtime.len() < before)
    }

    pub fn grant_permissions(
        &mut self,
        id: &str,
        permissions: Vec<String>,
    ) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            for perm in permissions {
                if !plugin.permissions.iter().any(|p| p == &perm) {
                    plugin.permissions.push(perm);
                }
            }
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn revoke_permissions(
        &mut self,
        id: &str,
        permissions: Vec<String>,
    ) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin
                .permissions
                .retain(|p| !permissions.iter().any(|x| x == p));
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }
}
