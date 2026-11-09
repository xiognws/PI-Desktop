//! Where an absorbed skill went.
//!
//! Consolidating two skills is the one maintenance action that changes what the
//! library *means*: the absorbed document stops being a skill of its own and its
//! resources move under an umbrella. Nothing is deleted — the document stays on
//! disk and one toggle brings it back — so the library needs a record of the
//! decision, or the absorbed skill looks like an ordinary disabled one and nobody
//! can tell why it went quiet.
//!
//! Storage is the third small JSON file beside the others
//! (`<data>/agent-capabilities/skill-links.json`): the library is bounded by the
//! skill cap, and a table plus a migration would be more machinery than the
//! feature deserves.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::agent_capabilities::{normalize_project_path, CapabilityLevel};

/// One consolidation: the skill that was absorbed and the umbrella that took it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLink {
    /// Id of the umbrella skill this document was merged into.
    pub into: String,
    /// Epoch milliseconds, so a reader can say when the two became one.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkKey {
    level: String,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

impl LinkKey {
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
        serde_json::to_string(self).expect("link key is serializable")
    }

    fn decode(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LinkFile {
    #[serde(default)]
    values: BTreeMap<String, SkillLink>,
}

pub struct SkillLinkStore {
    path: PathBuf,
    values: BTreeMap<String, SkillLink>,
}

impl SkillLinkStore {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("agent-capabilities").join("skill-links.json");
        let values = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<LinkFile>(&raw).ok())
            .map(|file| file.values)
            .unwrap_or_default();
        Self { path, values }
    }

    pub fn get(
        &self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Option<SkillLink> {
        self.values
            .get(&LinkKey::new(level, id, project_path).encode())
            .cloned()
    }

    pub fn set(
        &mut self,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
        link: SkillLink,
    ) -> Result<()> {
        self.values
            .insert(LinkKey::new(level, id, project_path).encode(), link);
        self.save()
    }

    /// Drop links of one level whose skill the scan did not find.
    pub fn retain(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        live_ids: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let target = LinkKey::new(level, "", project_path);
        let before = self.values.len();
        self.values.retain(|key, _| {
            let Some(parsed) = LinkKey::decode(key) else {
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

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let payload = serde_json::to_string_pretty(&LinkFile {
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
    fn a_link_round_trips_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillLinkStore::new(dir.path());
        store
            .set(
                CapabilityLevel::Global,
                "old",
                None,
                SkillLink {
                    into: "umbrella".into(),
                    at: 7,
                },
            )
            .unwrap();
        let reopened = SkillLinkStore::new(dir.path());
        assert_eq!(
            reopened.get(CapabilityLevel::Global, "old", None),
            Some(SkillLink {
                into: "umbrella".into(),
                at: 7
            })
        );
    }

    #[test]
    fn retain_drops_links_of_deleted_documents() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = SkillLinkStore::new(dir.path());
        for id in ["gone", "kept"] {
            store
                .set(
                    CapabilityLevel::Global,
                    id,
                    None,
                    SkillLink {
                        into: "umbrella".into(),
                        at: 1,
                    },
                )
                .unwrap();
        }
        let live: std::collections::HashSet<String> = ["kept".to_string()].into_iter().collect();
        store.retain(CapabilityLevel::Global, None, &live).unwrap();
        assert!(store.get(CapabilityLevel::Global, "gone", None).is_none());
        assert!(store.get(CapabilityLevel::Global, "kept", None).is_some());
    }

    #[test]
    fn a_corrupt_file_reads_as_no_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-capabilities");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("skill-links.json"), "{not json").unwrap();
        assert!(SkillLinkStore::new(dir.path())
            .get(CapabilityLevel::Global, "old", None)
            .is_none());
    }
}
