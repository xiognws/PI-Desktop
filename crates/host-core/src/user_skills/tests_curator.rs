//! Curation behaviour against real documents: what a pass reports, what it
//! changes, and what it must never do.

use super::*;
use crate::user_skills::curator::CuratorPolicy;
use std::time::{Duration, SystemTime};

/// Move a document's timestamp into the past, the way an idle skill looks on disk.
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

#[test]
fn an_idle_document_is_reported_before_it_is_archived() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Idle", "global", None)).unwrap();
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

        let applied = registry
            .curate(None, CuratorPolicy::default(), false)
            .unwrap();
        assert_eq!(applied.archived, vec![created.id.clone()]);
        let archived = row(&mut registry, &created.id);
        assert!(!archived.enabled, "archiving is the activation flag");
        // Recoverable: the same toggle brings it back, and nothing was deleted.
        assert!(Path::new(&archived.path).is_file());
        registry
            .set_enabled(&created.id, true, Some(CapabilityLevel::Global), None)
            .unwrap();
        assert!(row(&mut registry, &created.id).enabled);
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
            .create(input("Recent idle", "global", None))
            .unwrap();
        let ancient = registry
            .create(input("Ancient idle", "global", None))
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
        let created = registry.create(input("Pinned", "global", None)).unwrap();
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
    });
}

#[test]
fn unpinning_returns_a_skill_to_the_pass() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Unpinned", "global", None)).unwrap();
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
