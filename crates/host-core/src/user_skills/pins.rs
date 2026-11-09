//! Skills the user asked to keep, whatever the maintenance pass thinks.
//!
//! Curation is a rule, and a rule needs an escape hatch that is not "argue with
//! the rule": one skill in a library of forty is the reason the library exists,
//! and it may simply not have been loaded this quarter. A pin says that out loud
//! and the pass leaves it alone — Hermes exempts pinned skills from every
//! automatic transition for the same reason.
//!
//! Storage is a small JSON file beside the other capability state
//! (`<data>/agent-capabilities/skill-pins.json`), written whole on change: the
//! list is bounded by the skill cap, so a table and a migration would be more
//! machinery than the feature deserves. A corrupt file reads as "nothing pinned"
//! — the cost is a maintenance suggestion, never a document.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_capabilities::{normalize_project_path, CapabilityLevel};

/// The identity of a pin: the same three fields that identify a skill record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinKey {
    level: String,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

impl PinKey {
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
        serde_json::to_string(self).expect("pin key is serializable")
    }

    fn decode(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PinFile {
    /// Encoded keys, so a pin survives a rename of the struct's fields but not a
    /// change of identity. `true` is the only stored value; absence is "not
    /// pinned".
    #[serde(default)]
    values: BTreeMap<String, bool>,
}

pub struct SkillPinStore {
    path: PathBuf,
    values: BTreeMap<String, bool>,
}

impl SkillPinStore {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("agent-capabilities").join("skill-pins.json");
        let values = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PinFile>(&raw).ok())
            .map(|file| file.values)
            .unwrap_or_default();
        Self { path, values }
    }

    pub fn is_pinned(&self, level: CapabilityLevel, id: &str, project_path: Option<&str>) -> bool {
        self.values
            .get(&PinKey::new(level, id, project_path).encode())
            .copied()
            .unwrap_or(false)
    }

    /// Pin or unpin one skill. Returns whether the state changed, so a caller can
    /// skip a pointless write (and a pointless reload in the UI).
    pub fn set(
        &mut self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
        pinned: bool,
    ) -> Result<bool> {
        let key = PinKey::new(level, id, project_path).encode();
        let changed = match (pinned, self.values.get(&key).copied().unwrap_or(false)) {
            (true, false) => {
                self.values.insert(key, true);
                true
            }
            (false, true) => {
                self.values.remove(&key);
                true
            }
            _ => false,
        };
        if changed {
            self.save()?;
        }
        Ok(changed)
    }

    /// Drop pins of one level whose skill the scan did not find, so a deleted
    /// document cannot leave a pin behind for a same-named successor.
    pub fn retain(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        live_ids: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let target = PinKey::new(level, "", project_path);
        let before = self.values.len();
        self.values.retain(|key, _| {
            let Some(parsed) = PinKey::decode(key) else {
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
    /// previous pins readable rather than a truncated one.
    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let payload = serde_json::to_string_pretty(&PinFile {
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
    fn a_pin_round_trips_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillPinStore::new(dir.path());
        assert!(!store.is_pinned(CapabilityLevel::Global, "alpha", None));
        assert!(store
            .set(CapabilityLevel::Global, "alpha", None, true)
            .unwrap());
        assert!(store.is_pinned(CapabilityLevel::Global, "alpha", None));

        let reopened = SkillPinStore::new(dir.path());
        assert!(reopened.is_pinned(CapabilityLevel::Global, "alpha", None));
    }

    #[test]
    fn setting_the_same_value_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillPinStore::new(dir.path());
        assert!(store
            .set(CapabilityLevel::Global, "alpha", None, true)
            .unwrap());
        assert!(!store
            .set(CapabilityLevel::Global, "alpha", None, true)
            .unwrap());
        assert!(!store
            .set(CapabilityLevel::Global, "beta", None, false)
            .unwrap());
    }

    #[test]
    fn a_project_pin_does_not_pin_the_global_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillPinStore::new(dir.path());
        store
            .set(
                CapabilityLevel::Project,
                "alpha",
                Some("D:\\work\\one"),
                true,
            )
            .unwrap();
        assert!(!store.is_pinned(CapabilityLevel::Global, "alpha", None));
        assert!(store.is_pinned(CapabilityLevel::Project, "alpha", Some("D:/work/one")));
    }

    #[test]
    fn retain_drops_the_pin_of_a_deleted_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillPinStore::new(dir.path());
        store
            .set(CapabilityLevel::Global, "gone", None, true)
            .unwrap();
        store
            .set(CapabilityLevel::Global, "kept", None, true)
            .unwrap();
        let live: std::collections::HashSet<String> = ["kept".to_string()].into_iter().collect();
        store.retain(CapabilityLevel::Global, None, &live).unwrap();
        assert!(!store.is_pinned(CapabilityLevel::Global, "gone", None));
        assert!(store.is_pinned(CapabilityLevel::Global, "kept", None));
    }

    #[test]
    fn a_corrupt_file_reads_as_nothing_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-capabilities");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("skill-pins.json"), "{not json").unwrap();
        assert!(!SkillPinStore::new(dir.path()).is_pinned(CapabilityLevel::Global, "alpha", None));
    }
}
