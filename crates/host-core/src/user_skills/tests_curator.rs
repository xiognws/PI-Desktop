//! Curation behaviour against real documents: what a pass reports, what it
//! moves, and what it must never do.

use super::*;
use crate::user_skills::curator::{CurationReason, CuratorPolicy};
use std::time::{Duration, SystemTime};

/// Move a document's timestamp into the past, the way an idle skill looks on disk.
/// The agent wrote this document, so the maintenance pass owns it (ADR 0394).
fn agent_input(name: &str, level: &str, project_path: Option<&str>) -> UserSkillInput {
    UserSkillInput {
        created_by: Some("agent".into()),
        ..input(name, level, project_path)
    }
}

fn backdate(path: &Path, days: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    let when = SystemTime::now() - Duration::from_secs(days * 24 * 60 * 60);
    file.set_times(fs::FileTimes::new().set_modified(when))
        .unwrap();
}

fn row(registry: &mut UserSkillRegistry, id: &str) -> UserSkillRecord {
    registry
        .list(CapabilityLevel::Global, None)
        .unwrap()
        .into_iter()
        .find(|record| record.id == id)
        .expect("the skill is listed")
}

fn listed_ids(registry: &mut UserSkillRegistry) -> Vec<String> {
    registry
        .list(CapabilityLevel::Global, None)
        .unwrap()
        .into_iter()
        .map(|record| record.id)
        .collect()
}

/// The archive of the global library, spelled the way the product spells it.
fn archive_root() -> PathBuf {
    capability_dir(CapabilityLevel::Global, None, "skills")
        .expect("the global library")
        .join(".archive")
}

#[test]
fn an_idle_document_is_reported_before_it_is_archived() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Idle", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 200);

        let dry = registry
            .curate(None, CuratorPolicy::default(), true)
            .unwrap();
        assert!(dry.dry_run);
        let entry = dry
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(
            entry.state,
            crate::user_skills::curator::CurationState::Archive
        );
        assert!(entry.idle_days >= 200);
        assert!(dry.archived.is_empty(), "a dry run turns nothing off");
        assert!(
            row(&mut registry, &created.id).enabled,
            "the document is still enabled after a dry run"
        );
        assert!(
            Path::new(&created.path).is_file(),
            "a dry run moves nothing"
        );

        let applied = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(applied.archived, vec![created.id.clone()]);
        // Archived means moved out of the library, not flagged: the document
        // waits in `<root>/.archive/` and the catalog no longer holds it.
        let archived = archive_root().join(format!("{}.md", created.id));
        assert!(archived.is_file(), "the document waits in the archive");
        assert!(
            !Path::new(&created.path).exists(),
            "…and it is no longer in the library"
        );
        assert!(listed_ids(&mut registry).is_empty());
    });
}

#[test]
fn archiving_moves_the_document_out_of_every_listing() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Gone quiet", "global", None))
            .unwrap();
        let raw = fs::read_to_string(&created.path).unwrap();
        backdate(Path::new(&created.path), 200);

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(report.archived, vec![created.id.clone()]);

        let archived = archive_root().join(format!("{}.md", created.id));
        assert_eq!(
            fs::read_to_string(&archived).unwrap(),
            raw,
            "the archived copy is the same bytes, not a rewrite"
        );
        // The catalog, `skills.list` and the `Skill` tool all read this one scan,
        // so a document the scan no longer sees is out of all three.
        assert!(listed_ids(&mut registry).is_empty());
        assert!(registry
            .active_for(None)
            .unwrap()
            .iter()
            .all(|record| record.id != created.id));
        assert!(
            registry.read(&created.id, None, None).unwrap().is_none(),
            "the model can no longer load it"
        );
    });
}

#[test]
fn restore_puts_the_document_back_and_lists_it_again() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Comes back", "global", None))
            .unwrap();
        let raw = fs::read_to_string(&created.path).unwrap();
        backdate(Path::new(&created.path), 200);
        registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let archived = archive_root().join(format!("{}.md", created.id));
        assert!(archived.is_file());

        let restored = registry.restore(&created.id, None, None).unwrap();
        assert_eq!(restored.id, created.id);
        assert!(restored.enabled, "a restore is a skill you can use");
        assert_eq!(fs::read_to_string(&restored.path).unwrap(), raw);
        assert!(!archived.exists(), "the archive no longer holds it");
        assert_eq!(listed_ids(&mut registry), vec![created.id.clone()]);
        assert!(registry.read(&created.id, None, None).unwrap().is_some());

        // A restore is evidence of use, so the pass does not take the same
        // document straight back out — that would make the undo a no-op.
        let after = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert!(
            after.archived.is_empty(),
            "a restored document is not idle any more: {:?}",
            after.archived
        );

        // And once it is idle again the pass still owns it: the origin and the id
        // survived the round trip, so archiving took nothing away from what the
        // host knew about this skill.
        backdate(Path::new(&restored.path), 200);
        let again = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(again.archived, vec![created.id.clone()]);
    });
}

#[test]
fn a_directory_skill_is_archived_and_restored_as_a_package() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(UserSkillInput {
                shape: Some("dir".into()),
                ..agent_input("Packaged", "global", None)
            })
            .unwrap();
        registry
            .write_resource(
                &created.id,
                Some(CapabilityLevel::Global),
                None,
                "references/notes.md",
                "a lesson\n",
            )
            .unwrap();
        let package = PathBuf::from(&created.path)
            .parent()
            .expect("the package directory")
            .to_path_buf();
        assert!(package.join("references/notes.md").is_file());
        backdate(&package.join("SKILL.md"), 200);

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(report.archived, vec![created.id.clone()]);

        let archived = archive_root().join(&created.id);
        assert!(archived.join("SKILL.md").is_file(), "the document moved");
        assert!(
            archived.join("references/notes.md").is_file(),
            "resources travel with the document"
        );
        assert!(!package.exists(), "no empty directory is left behind");
        assert!(listed_ids(&mut registry).is_empty());

        let restored = registry.restore(&created.id, None, None).unwrap();
        assert_eq!(restored.id, created.id);
        assert!(package.join("references/notes.md").is_file());
        assert_eq!(listed_ids(&mut registry), vec![created.id.clone()]);
    });
}

#[test]
fn a_scan_does_not_forget_an_archived_skill() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Remembered", "global", None))
            .unwrap();
        registry.set_pinned(&created.id, true, None, None).unwrap();

        // Archive it the way the pass would, then scan the library without it.
        let archive = archive_root();
        fs::create_dir_all(&archive).unwrap();
        let archived = archive.join(format!("{}.md", created.id));
        fs::rename(&created.path, &archived).unwrap();
        assert!(listed_ids(&mut registry).is_empty());

        // A pin and an origin are keyed by level+id+project, and the archive keeps
        // the id: the sweep that clears state for deleted documents must leave
        // this one alone, or the restore comes back as a stranger the pass would
        // archive again the same day.
        assert!(SkillPinStore::new(app.path()).is_pinned(
            CapabilityLevel::Global,
            &created.id,
            None
        ));
        assert!(SkillOriginStore::new(app.path()).is_agent_authored(
            CapabilityLevel::Global,
            &created.id,
            None
        ));

        let restored = registry.restore(&created.id, None, None).unwrap();
        assert!(restored.pinned, "the pin came back with the document");
        assert!(restored.enabled);
    });
}

#[test]
fn restoring_an_unknown_id_is_an_error() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        registry.create(input("Present", "global", None)).unwrap();

        let error = registry
            .restore("never-archived", None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("SKILL_INVALID"), "{error}");
        assert!(error.contains("no archived skill"), "{error}");
    });
}

#[test]
fn restore_refuses_a_destination_that_is_occupied() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Contested", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 200);
        registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let archived = archive_root().join(format!("{}.md", created.id));
        assert!(archived.is_file());

        // Something else took the name while the document was away.
        let root = capability_dir(CapabilityLevel::Global, None, "skills").unwrap();
        fs::write(
            root.join(format!("{}.md", created.id)),
            "---\nname: Contested\n---\n\nnewer\n",
        )
        .unwrap();

        let error = registry
            .restore(&created.id, None, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("SKILL_INVALID"), "{error}");
        assert!(error.contains("already exists"), "{error}");
        assert!(
            archived.is_file(),
            "the archived copy stays where it was: nothing is overwritten"
        );
    });
}

#[test]
fn a_load_keeps_a_document_out_of_the_report() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Used", "global", None)).unwrap();
        // Old document, but loaded a moment ago: the load is the evidence.
        backdate(Path::new(&created.path), 200);
        registry.record_use(&created.id, None).unwrap();

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(entry.idle_days, 0);
        assert!(report.archived.is_empty());
        assert!(row(&mut registry, &created.id).enabled);
    });
}

#[test]
fn a_fresh_unused_document_is_not_a_candidate() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Fresh", "global", None)).unwrap();
        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(entry.use_count, 0);
        assert_eq!(entry.idle_days, 0);
        assert!(report.archived.is_empty());
    });
}

#[test]
fn the_report_lists_the_most_idle_document_first() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let recent = registry
            .create(agent_input("Recent idle", "global", None))
            .unwrap();
        let ancient = registry
            .create(agent_input("Ancient idle", "global", None))
            .unwrap();
        backdate(Path::new(&recent.path), 60);
        backdate(Path::new(&ancient.path), 300);

        let report = registry
            .curate(None, CuratorPolicy::default(), true)
            .unwrap();
        let order: Vec<&str> = report
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let ancient_at = order.iter().position(|id| *id == ancient.id).unwrap();
        let recent_at = order.iter().position(|id| *id == recent.id).unwrap();
        assert!(ancient_at < recent_at, "the worst offender reads first");
    });
}

#[test]
fn a_pin_keeps_an_idle_document_out_of_the_list() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Pinned", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 400);

        // Without a pin it is the worst offender in the library.
        let before = registry
            .curate(None, CuratorPolicy::default(), true)
            .unwrap();
        assert_eq!(
            before
                .entries
                .iter()
                .find(|entry| entry.id == created.id)
                .unwrap()
                .state,
            crate::user_skills::curator::CurationState::Archive
        );

        let pinned = registry
            .set_pinned(&created.id, true, None, None)
            .unwrap()
            .expect("the skill exists");
        assert!(pinned.pinned);

        let after = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = after
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(
            entry.state,
            crate::user_skills::curator::CurationState::Keep
        );
        assert!(entry.pinned, "the report says why it was left alone");
        assert!(after.archived.is_empty());
        assert!(
            row(&mut registry, &created.id).enabled,
            "nothing was switched off"
        );
        assert!(
            Path::new(&created.path).is_file(),
            "a pinned document is never moved out"
        );
    });
}

#[test]
fn unpinning_returns_a_skill_to_the_pass() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Unpinned", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 400);
        registry.set_pinned(&created.id, true, None, None).unwrap();
        let unpinned = registry
            .set_pinned(&created.id, false, None, None)
            .unwrap()
            .unwrap();
        assert!(!unpinned.pinned);

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(report.archived, vec![created.id.clone()]);
    });
}

#[test]
fn an_agent_authored_document_is_archived_when_it_goes_idle() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Agent written", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 200);

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(
            entry.state,
            crate::user_skills::curator::CurationState::Archive
        );
        assert_eq!(entry.reason, CurationReason::Idle);
        assert_eq!(report.archived, vec![created.id.clone()]);
    });
}

#[test]
fn a_document_the_agent_did_not_write_is_kept_whatever_its_age() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        // No `createdBy`: a person wrote this by hand, so its idle days are not
        // the pass's business.
        let created = registry
            .create(input("Hand written", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 200);

        let report = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(
            entry.state,
            crate::user_skills::curator::CurationState::Keep
        );
        assert_eq!(entry.reason, CurationReason::NotAgentAuthored);
        assert!(entry.idle_days >= 200, "the age is still reported");
        assert!(
            report.archived.is_empty(),
            "a hand-written document is never archived"
        );
        assert!(
            row(&mut registry, &created.id).enabled,
            "nothing was switched off"
        );
    });
}

#[test]
fn deleting_a_skill_drops_its_origin() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Doomed", "global", None))
            .unwrap();
        assert!(SkillOriginStore::new(app.path()).is_agent_authored(
            CapabilityLevel::Global,
            &created.id,
            None
        ));

        assert!(registry.remove(&created.id, None, None).unwrap());

        // Read from disk, not from the in-memory field: the entry is gone, so a
        // same-named successor cannot inherit "the agent wrote this".
        assert!(!SkillOriginStore::new(app.path()).is_agent_authored(
            CapabilityLevel::Global,
            &created.id,
            None
        ));
    });
}

#[test]
fn a_corrupt_origins_file_reads_as_no_origins_and_still_curates() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry
            .create(agent_input("Unreadable origin", "global", None))
            .unwrap();
        backdate(Path::new(&created.path), 200);
        fs::write(
            app.path()
                .join("agent-capabilities")
                .join("skill-origins.json"),
            "{not json",
        )
        .unwrap();

        // A new registry reads the file the way a restart does.
        let mut reopened = UserSkillRegistry::new(app.path());
        let report = reopened
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.id == created.id)
            .unwrap();
        assert_eq!(
            entry.reason,
            CurationReason::NotAgentAuthored,
            "an unreadable origin is not a claim the agent wrote it"
        );
        assert!(report.archived.is_empty(), "a lost marker archives nothing");
        assert!(row(&mut reopened, &created.id).enabled);
    });
}
