//! Skill usage bookkeeping.
//!
//! The library knows when a document was written (`created_at` / `updated_at`
//! from the file) but not whether anybody ever *loaded* it, which is the one
//! input a maintenance pass needs: a skill nobody has opened in a month and one
//! opened every day look identical on disk. This store answers that question and
//! nothing else — it records a count and a timestamp per (level, id, project),
//! because "used" is a fact about the model loading the document, not about the
//! document changing.
//!
//! Storage is one small JSON file beside the activation state
//! (`<data>/agent-capabilities/skill-usage.json`), written whole on every change:
//! the file is bounded by the skill cap (128 documents per level), so a
//! whole-file rewrite is cheaper than a table, a migration, and a schema bump.
//! A corrupt or missing file reads as "no usage recorded" — losing the counters
//! costs a maintenance hint, never a document.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_capabilities::{normalize_project_path, CapabilityLevel};
use crate::db::now_ms;

/// One skill's usage. Small on purpose: a counter and the last load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    pub use_count: u32,
    /// Epoch milliseconds, the same unit as every other timestamp in the store.
    pub last_used_at: i64,
}

/// The identity of a usage row — the same three fields that identify a skill
/// record, so a project document and a global document with one name stay apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageKey {
    level: String,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

impl UsageKey {
    fn new(level: CapabilityLevel, id: &str, project_path: Option<&str>) -> Self {
        Self {
            level: level.as_str().to_string(),
            id: id.to_string(),
            project_path: project_path
                .map(normalize_project_path)
                .filter(|path| !path.is_empty()),
        }
    }

    fn encode(&self) -> String {
        serde_json::to_string(self).expect("usage key is serializable")
    }

    fn decode(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsageFile {
    #[serde(default)]
    values: BTreeMap<String, SkillUsage>,
}

pub struct SkillUsageStore {
    path: PathBuf,
    values: BTreeMap<String, SkillUsage>,
}

impl SkillUsageStore {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("agent-capabilities").join("skill-usage.json");
        let values = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<UsageFile>(&raw).ok())
            .map(|file| file.values)
            .unwrap_or_default();
        Self { path, values }
    }

    pub fn get(
        &self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Option<SkillUsage> {
        let key = UsageKey::new(level, id, project_path).encode();
        self.values.get(&key).copied()
    }

    /// Count one load and persist. Returns the usage after the increment.
    pub fn record(
        &mut self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Result<SkillUsage> {
        let key = UsageKey::new(level, id, project_path).encode();
        let now = now_ms();
        let entry = self.values.entry(key).or_insert(SkillUsage {
            use_count: 0,
            last_used_at: now,
        });
        entry.use_count = entry.use_count.saturating_add(1);
        entry.last_used_at = now;
        let recorded = *entry;
        self.save()?;
        Ok(recorded)
    }

    /// Drop the row for one skill that no longer exists.
    pub fn forget(&mut self, level: CapabilityLevel, id: &str, project_path: Option<&str>) {
        let key = UsageKey::new(level, id, project_path).encode();
        if self.values.remove(&key).is_some() {
            let _ = self.save();
        }
    }

    /// Drop rows of one level whose skill the scan did not find.
    ///
    /// Called right after a level is scanned, so a deleted document cannot leave
    /// a counter behind for a same-named successor. Rows of other levels are
    /// untouched: a global scan says nothing about the project library.
    pub fn retain(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        live_ids: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let target = UsageKey::new(level, "", project_path);
        let before = self.values.len();
        self.values.retain(|key, _| {
            let Some(parsed) = UsageKey::decode(key) else {
                // An unreadable key cannot be matched to a skill; drop it rather
                // than carry a row nothing can ever look up.
                return false;
            };
            if parsed.level != target.level || parsed.project_path != target.project_path {
                return true;
            }
            live_ids.contains(&parsed.id)
        });
        if self.values.len() != before {
            self.save()?;
        }
        Ok(())
    }

    /// Whole-file write through a temporary file, so a crash mid-write leaves the
    /// previous counters readable rather than a truncated one.
    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let payload = serde_json::to_string_pretty(&UsageFile {
            values: self.values.clone(),
        })?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, payload).with_context(|| format!("write {}", temporary.display()))?;
        fs::rename(&temporary, &self.path)
            .with_context(|| format!("replace {}", self.path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_count_starts_at_one_and_increments() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillUsageStore::new(dir.path());
        assert!(store.get(CapabilityLevel::Global, "alpha", None).is_none());

        let first = store
            .record(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        assert_eq!(first.use_count, 1);
        let second = store
            .record(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        assert_eq!(second.use_count, 2);
        assert!(second.last_used_at >= first.last_used_at);
    }

    #[test]
    fn counters_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        SkillUsageStore::new(dir.path())
            .record(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        let reopened = SkillUsageStore::new(dir.path());
        assert_eq!(
            reopened
                .get(CapabilityLevel::Global, "alpha", None)
                .map(|usage| usage.use_count),
            Some(1)
        );
    }

    #[test]
    fn a_project_document_does_not_share_the_global_counter() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillUsageStore::new(dir.path());
        store
            .record(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        store
            .record(CapabilityLevel::Project, "alpha", Some("D:\\work\\one"))
            .unwrap();
        assert_eq!(
            store
                .get(CapabilityLevel::Global, "alpha", None)
                .map(|usage| usage.use_count),
            Some(1)
        );
        assert_eq!(
            store
                .get(CapabilityLevel::Project, "alpha", Some("D:/work/one"))
                .map(|usage| usage.use_count),
            Some(1),
            "the same project written two ways is one row"
        );
    }

    #[test]
    fn forget_removes_only_its_own_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillUsageStore::new(dir.path());
        store
            .record(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        store.record(CapabilityLevel::Global, "beta", None).unwrap();
        store.forget(CapabilityLevel::Global, "alpha", None);
        assert!(store.get(CapabilityLevel::Global, "alpha", None).is_none());
        assert!(store.get(CapabilityLevel::Global, "beta", None).is_some());
    }

    #[test]
    fn retain_drops_rows_of_the_scanned_level_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillUsageStore::new(dir.path());
        store.record(CapabilityLevel::Global, "gone", None).unwrap();
        store.record(CapabilityLevel::Global, "kept", None).unwrap();
        store
            .record(CapabilityLevel::Project, "elsewhere", Some("D:\\work\\one"))
            .unwrap();

        store
            .retain(
                CapabilityLevel::Global,
                None,
                &["kept".to_string()].into_iter().collect(),
            )
            .unwrap();
        assert!(store.get(CapabilityLevel::Global, "gone", None).is_none());
        assert!(store.get(CapabilityLevel::Global, "kept", None).is_some());
        assert!(
            store
                .get(CapabilityLevel::Project, "elsewhere", Some("D:\\work\\one"))
                .is_some(),
            "a global scan must not erase the project library's counters"
        );
    }

    #[test]
    fn a_corrupt_file_reads_as_no_usage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-capabilities");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("skill-usage.json"), "{not json").unwrap();
        let store = SkillUsageStore::new(dir.path());
        assert!(store.get(CapabilityLevel::Global, "alpha", None).is_none());
    }
}
