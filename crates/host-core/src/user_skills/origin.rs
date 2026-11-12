//! Which skills the agent wrote itself, so the maintenance pass only manages
//! its own documents.
//!
//! The library holds two kinds of document and they are not the same kind of
//! thing: the ones `skill_manage` created during a turn, and the ones a person
//! wrote by hand or imported from somewhere they trust. A pass that classifies
//! by idle days alone cannot tell them apart, and retiring somebody's
//! hand-written procedure because it was quiet for a quarter is not a
//! maintenance suggestion — it is their work disappearing, with an undo they
//! have to go find. Hermes draws the same line: its curator only manages skills
//! the agent created, marked explicitly, and only ever archives.
//!
//! So origin is recorded, not inferred. The marker is written when a skill is
//! created with `created_by: agent`, and a document without it is never the
//! pass's to retire — including every document that predates this file, which is
//! the safe direction: an uncurated library is a nuisance, an archived
//! hand-written skill is a loss.
//!
//! Storage is a small JSON file beside the other capability state
//! (`<data>/agent-capabilities/skill-origins.json`), written whole on change and
//! keyed exactly like a pin: level, id, normalized project path. A corrupt file
//! reads as "nothing is agent authored", for the same reason.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_capabilities::{normalize_project_path, CapabilityLevel};

/// The marker `skills.create` accepts as `createdBy`. Spelling is normalized
/// case-insensitively, so a caller that writes `Agent` still means this.
pub const AGENT_AUTHOR: &str = "agent";

/// The identity of an origin entry: the same three fields that identify a skill
/// record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OriginKey {
    level: String,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

impl OriginKey {
    fn new(level: CapabilityLevel, id: &str, project_path: Option<&str>) -> Self {
        Self {
            level: level.as_str().to_string(),
            id: id.to_string(),
            project_path: project_path
                .map(normalize_project_path)
                .filter(|path| !path.is_empty()),
        }
    }

    /// Encoded keys, so an entry survives a rename of the struct's fields but not
    /// a change of identity. Serializing two owned strings cannot fail; if it
    /// somehow did, the empty key matches no lookup, which reads as "written by
    /// a person" — the direction that never archives anything.
    fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    fn decode(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OriginFile {
    /// `true` is the only stored value; absence is "not agent authored".
    #[serde(default)]
    values: BTreeMap<String, bool>,
}

pub struct SkillOriginStore {
    path: PathBuf,
    values: BTreeMap<String, bool>,
}

impl SkillOriginStore {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir
            .join("agent-capabilities")
            .join("skill-origins.json");
        let values = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<OriginFile>(&raw).ok())
            .map(|file| file.values)
            .unwrap_or_default();
        Self { path, values }
    }

    pub fn is_agent_authored(
        &self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> bool {
        self.values
            .get(&OriginKey::new(level, id, project_path).encode())
            .copied()
            .unwrap_or(false)
    }

    /// Mark one skill as written by the agent. Returns whether anything changed,
    /// so a caller can skip a pointless write.
    pub fn record_agent_authored(
        &mut self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Result<bool> {
        let key = OriginKey::new(level, id, project_path).encode();
        if self.values.insert(key, true).is_some() {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    /// Drop the entry of a skill that was deleted on purpose. Best effort: a
    /// failed write must not turn a successful delete into an error, and the
    /// scan's sweep removes the same entry on the next pass.
    pub fn forget(&mut self, level: CapabilityLevel, id: &str, project_path: Option<&str>) {
        let key = OriginKey::new(level, id, project_path).encode();
        if self.values.remove(&key).is_some() {
            let _ = self.save();
        }
    }

    /// Drop entries of one level whose skill the scan did not find, so a deleted
    /// document cannot leave its origin behind for a same-named successor.
    pub fn retain(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        live_ids: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let target = OriginKey::new(level, "", project_path);
        let before = self.values.len();
        self.values.retain(|key, _| {
            let Some(parsed) = OriginKey::decode(key) else {
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
    /// previous entries readable rather than a truncated file.
    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let payload = serde_json::to_string_pretty(&OriginFile {
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
    fn an_origin_round_trips_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillOriginStore::new(dir.path());
        assert!(!store.is_agent_authored(CapabilityLevel::Global, "alpha", None));
        assert!(store
            .record_agent_authored(CapabilityLevel::Global, "alpha", None)
            .unwrap());
        assert!(store.is_agent_authored(CapabilityLevel::Global, "alpha", None));

        let reopened = SkillOriginStore::new(dir.path());
        assert!(reopened.is_agent_authored(CapabilityLevel::Global, "alpha", None));
    }

    #[test]
    fn recording_the_same_origin_twice_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillOriginStore::new(dir.path());
        assert!(store
            .record_agent_authored(CapabilityLevel::Global, "alpha", None)
            .unwrap());
        assert!(!store
            .record_agent_authored(CapabilityLevel::Global, "alpha", None)
            .unwrap());
    }

    #[test]
    fn a_project_origin_does_not_mark_the_global_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillOriginStore::new(dir.path());
        store
            .record_agent_authored(CapabilityLevel::Project, "alpha", Some("D:\\work\\one"))
            .unwrap();
        assert!(!store.is_agent_authored(CapabilityLevel::Global, "alpha", None));
        assert!(store.is_agent_authored(CapabilityLevel::Project, "alpha", Some("D:/work/one")));
    }

    #[test]
    fn forget_removes_only_its_own_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillOriginStore::new(dir.path());
        store
            .record_agent_authored(CapabilityLevel::Global, "alpha", None)
            .unwrap();
        store
            .record_agent_authored(CapabilityLevel::Global, "beta", None)
            .unwrap();
        store.forget(CapabilityLevel::Global, "alpha", None);
        assert!(!store.is_agent_authored(CapabilityLevel::Global, "alpha", None));
        assert!(store.is_agent_authored(CapabilityLevel::Global, "beta", None));
    }

    #[test]
    fn retain_drops_the_origin_of_a_deleted_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillOriginStore::new(dir.path());
        store
            .record_agent_authored(CapabilityLevel::Global, "gone", None)
            .unwrap();
        store
            .record_agent_authored(CapabilityLevel::Global, "kept", None)
            .unwrap();
        let live: std::collections::HashSet<String> = ["kept".to_string()].into_iter().collect();
        store.retain(CapabilityLevel::Global, None, &live).unwrap();
        assert!(!store.is_agent_authored(CapabilityLevel::Global, "gone", None));
        assert!(store.is_agent_authored(CapabilityLevel::Global, "kept", None));
    }

    #[test]
    fn a_corrupt_file_reads_as_no_origins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-capabilities");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("skill-origins.json"), "{not json").unwrap();
        assert!(!SkillOriginStore::new(dir.path()).is_agent_authored(
            CapabilityLevel::Global,
            "alpha",
            None
        ));
    }
}
