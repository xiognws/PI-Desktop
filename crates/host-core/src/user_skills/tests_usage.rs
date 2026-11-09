//! Usage counters: who loaded what, and what happens to the count when the
//! document behind it changes.
//!
//! The RPC test in `rpc::tests` proves the wiring (the list carries the count).
//! These prove the rules, and they own the global root through
//! `with_global_agents` so they cannot read a directory another test repointed.

use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

fn listed_row(registry: &mut UserSkillRegistry, id: &str) -> UserSkillRecord {
    registry
        .list(CapabilityLevel::Global, None)
        .unwrap()
        .into_iter()
        .find(|record| record.id == id)
        .expect("the skill is listed")
}

#[test]
fn a_load_is_counted_and_the_list_carries_it() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Usage", "global", None)).unwrap();

        // Nothing has loaded it yet: zero, and no timestamp to report.
        let fresh = listed_row(&mut registry, &created.id);
        assert_eq!(fresh.use_count, 0);
        assert!(fresh.last_used_at.is_none());

        let (_, first) = registry.record_use(&created.id, None).unwrap().unwrap();
        assert_eq!(first.use_count, 1);
        let (_, second) = registry.record_use(&created.id, None).unwrap().unwrap();
        assert_eq!(second.use_count, 2);
        assert!(second.last_used_at >= first.last_used_at);

        let row = listed_row(&mut registry, &created.id);
        assert_eq!(row.use_count, 2);
        assert_eq!(row.last_used_at, Some(second.last_used_at));
    });
}

#[test]
fn an_id_the_library_does_not_own_is_not_an_error() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        // A built-in or plugin skill loads fine and is simply not in this library.
        let mut registry = UserSkillRegistry::new(app.path());
        assert!(registry
            .record_use("pi-desktop/imagegen", None)
            .unwrap()
            .is_none());
    });
}

#[test]
fn a_deleted_document_forgets_its_counter() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Usage", "global", None)).unwrap();
        registry.record_use(&created.id, None).unwrap();

        assert!(registry.remove(&created.id, None, None).unwrap());
        assert!(registry.record_use(&created.id, None).unwrap().is_none());
    });
}

#[test]
fn a_counter_does_not_survive_the_document_it_counted() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    test_support::with_global_agents(agents.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let created = registry.create(input("Counter", "global", None)).unwrap();
        registry.record_use(&created.id, None).unwrap();

        // Removed behind the registry's back, the way a user deletes a file.
        fs::remove_file(&created.path).unwrap();
        assert!(registry
            .list(CapabilityLevel::Global, None)
            .unwrap()
            .is_empty());

        // Same name, same id, new document: the old count must not follow it.
        let again = registry.create(input("Counter", "global", None)).unwrap();
        assert_eq!(again.id, created.id);
        assert_eq!(listed_row(&mut registry, &again.id).use_count, 0);
    });
}
