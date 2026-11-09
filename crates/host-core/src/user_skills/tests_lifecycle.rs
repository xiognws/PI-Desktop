//! Resource lifecycle and duplicate detection for user skills.
//!
//! Split from `tests.rs` so each file stays inside the module size budget;
//! these cases drive the same registry and share its fixtures.

use super::tests::input;
use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

#[test]
fn write_resource_promotes_a_flat_skill_and_adds_a_reference() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry.create(input("Review", "global", None)).unwrap();
        assert!(
            record.path.ends_with("review.md"),
            "starts flat: {}",
            record.path
        );

        let written = registry
            .write_resource(
                &record.id,
                None,
                None,
                "references/pitfalls.md",
                "# Pitfalls\n\nA 200 with an HTML body is not success.",
            )
            .unwrap();
        assert_eq!(written, "references/pitfalls.md");

        let root_dir = home.path().join("skills").join(&record.id);
        assert!(
            root_dir.join("SKILL.md").is_file(),
            "the document was promoted into the directory shape"
        );
        assert!(
            !home.path().join("skills").join("review.md").exists(),
            "the flat document must not survive the promotion"
        );
        let reference = root_dir.join("references").join("pitfalls.md");
        assert!(reference.is_file());
        assert!(fs::read_to_string(&reference)
            .unwrap()
            .contains("200 with an HTML body"));

        // The id is the directory name in this shape, so it must not change.
        let listed = registry.list(CapabilityLevel::Global, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, record.id);
    });
}

#[test]
fn write_resource_accepts_a_directory_skill_without_rewriting_it() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut shape = input("Review", "global", None);
        shape.shape = Some("dir".into());
        let record = registry.create(shape).unwrap();
        let document = PathBuf::from(&record.path);
        assert!(document.ends_with("SKILL.md"));
        let before = fs::read_to_string(&document).unwrap();

        registry
            .write_resource(&record.id, None, None, "references/notes.md", "note")
            .unwrap();

        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            before,
            "SKILL.md untouched"
        );
        assert!(document
            .parent()
            .unwrap()
            .join("references/notes.md")
            .is_file());
    });
}

#[test]
fn remove_resource_deletes_one_reference_and_keeps_the_rest() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut shape = input("Review", "global", None);
        shape.shape = Some("dir".into());
        let record = registry.create(shape).unwrap();
        let document = PathBuf::from(&record.path);
        let before = fs::read_to_string(&document).unwrap();
        registry
            .write_resource(
                &record.id,
                None,
                None,
                "references/pitfalls.md",
                "old lesson",
            )
            .unwrap();
        registry
            .write_resource(&record.id, None, None, "references/notes.md", "keep me")
            .unwrap();

        let removed = registry
            .remove_resource(&record.id, None, None, "references/pitfalls.md")
            .unwrap();
        assert_eq!(removed, "references/pitfalls.md");

        let root = document.parent().unwrap();
        assert!(
            !root.join("references/pitfalls.md").exists(),
            "the named reference goes"
        );
        assert!(
            root.join("references/notes.md").is_file(),
            "its sibling stays"
        );
        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            before,
            "SKILL.md is never touched by a resource delete"
        );
    });
}

#[test]
fn remove_resource_refuses_a_path_outside_references() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut shape = input("Review", "global", None);
        shape.shape = Some("dir".into());
        let record = registry.create(shape).unwrap();
        let document = PathBuf::from(&record.path);

        for attempt in ["../SKILL.md", "notes.md", "references/../SKILL.md"] {
            let error = registry
                .remove_resource(&record.id, None, None, attempt)
                .unwrap_err()
                .to_string();
            assert!(error.contains("SKILL_INVALID"), "{attempt}: {error}");
        }
        assert!(
            document.is_file(),
            "the document survives every refused call"
        );
    });
}

#[test]
fn write_resource_rejects_paths_outside_references() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry.create(input("Review", "global", None)).unwrap();

        for bad in [
            "../escape.md",
            "references/../../escape.md",
            "/etc/passwd",
            "notes.md",
            "references/deep.txt",
            "",
        ] {
            assert!(
                registry
                    .write_resource(&record.id, None, None, bad, "x")
                    .is_err(),
                "must reject {bad:?}"
            );
        }
        assert!(
            !home.path().join("skills").join("escape.md").exists(),
            "no traversal artefact may be created"
        );
    });
}

#[test]
fn write_resource_reports_an_unknown_skill() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        assert!(registry
            .write_resource("nope", None, None, "references/x.md", "x")
            .is_err());
    });
}

#[test]
fn creating_a_near_duplicate_is_refused_with_a_patch_hint() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        registry
            .create(input("Add npm script", "global", None))
            .unwrap();

        // `npm-script` is a token subset of `add-npm-script`: one lesson split
        // across two skills, which nothing would ever notice again.
        let error = registry
            .create(input("npm script", "global", None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("overlaps"), "{error}");
        assert!(error.contains("add-npm-script"), "{error}");
        assert!(error.contains("patch that skill"), "{error}");

        // The plural is the same word: this is the same duplicate attempted a
        // second way, and it must be refused the same way.
        let error = registry
            .create(input("npm scripts", "global", None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("overlaps"), "{error}");

        assert_eq!(
            registry.list(CapabilityLevel::Global, None).unwrap().len(),
            1
        );
    });
}

#[test]
fn two_variants_of_one_procedure_are_not_duplicates() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        // No umbrella present: a shared `deploy` token is not enough to call
        // these duplicates, and neither contains the other.
        registry
            .create(input("Deploy iOS", "global", None))
            .unwrap();
        registry
            .create(input("Deploy Android", "global", None))
            .unwrap();
        assert_eq!(
            registry.list(CapabilityLevel::Global, None).unwrap().len(),
            2
        );
    });

    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        // Two versions with no umbrella are likewise distinct skills.
        registry
            .create(input("Deploy iOS 17", "global", None))
            .unwrap();
        registry
            .create(input("Deploy iOS 18", "global", None))
            .unwrap();
        assert_eq!(
            registry.list(CapabilityLevel::Global, None).unwrap().len(),
            2
        );
    });
}

#[test]
fn a_versioned_variant_under_an_umbrella_goes_into_that_skill() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        registry
            .create(input("Deploy iOS", "global", None))
            .unwrap();

        // The umbrella already owns the topic; a version belongs in a reference
        // under it, not in a second skill beside it.
        let error = registry
            .create(input("Deploy iOS 17", "global", None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("overlaps"), "{error}");
        assert!(error.contains("deploy-ios"), "{error}");
    });
}

#[test]
fn remove_deletes_a_directory_skill_as_a_package() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut shape = input("Review", "global", None);
        shape.shape = Some("dir".into());
        let record = registry.create(shape).unwrap();
        let document = PathBuf::from(&record.path);
        registry
            .write_resource(&record.id, None, None, "references/pitfalls.md", "lesson")
            .unwrap();
        let package = document.parent().unwrap().to_path_buf();
        assert!(package.join("references/pitfalls.md").is_file());

        assert!(registry.remove(&record.id, None, None).unwrap());
        assert!(
            !package.exists(),
            "the document and the resources beside it are one skill"
        );
        assert!(
            !registry.remove(&record.id, None, None).unwrap(),
            "a second delete reports that there was nothing to delete"
        );
    });
}

#[test]
fn remove_deletes_a_single_file_skill_and_keeps_the_library() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry.create(input("Notes", "global", None)).unwrap();
        let document = PathBuf::from(&record.path);
        let library = document.parent().unwrap().to_path_buf();

        assert!(registry.remove(&record.id, None, None).unwrap());
        assert!(!document.exists());
        assert!(library.is_dir(), "the library itself survives");
    });
}

#[test]
fn remove_refuses_a_document_outside_the_skills_roots() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let stray = app.path().join("elsewhere/SKILL.md");
        fs::create_dir_all(stray.parent().unwrap()).unwrap();
        fs::write(&stray, "---\nname: Stray\n---\n\nnot a skill here\n").unwrap();
        let root = capability_dir(CapabilityLevel::Global, None, "skills").unwrap();

        let error = delete_skill_files(&stray, &[root]).unwrap_err().to_string();
        assert!(
            error.contains("does not resolve inside a skills root"),
            "{error}"
        );
        assert!(stray.is_file(), "nothing was deleted");
    });
}

#[test]
fn remove_refuses_the_document_sitting_directly_in_the_root() {
    let home = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let root = capability_dir(CapabilityLevel::Global, None, "skills").unwrap();
        fs::create_dir_all(&root).unwrap();
        let document = root.join("SKILL.md");
        fs::write(&document, "---\nname: Stray\n---\n\nnot a package\n").unwrap();

        let error = delete_skill_files(&document, std::slice::from_ref(&root))
            .unwrap_err()
            .to_string();
        assert!(error.contains("directly in the skills root"), "{error}");
        assert!(document.is_file(), "the stray document survives");
    });
}

/// A junction makes `remove_dir_all` leave the library, which is how a delete turns
/// into a wiped working directory. Junctions need no elevation on Windows, so this
/// runs where the product does.
#[cfg(windows)]
#[test]
fn remove_refuses_a_skill_directory_that_redirects() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let root = capability_dir(CapabilityLevel::Global, None, "skills").unwrap();
        let outside = app.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), "keep me").unwrap();
        fs::create_dir_all(&root).unwrap();
        let link = root.join("linked");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .status()
            .unwrap();
        assert!(status.success(), "junction creation failed");
        let document = link.join("SKILL.md");
        fs::write(&document, "---\nname: Linked\n---\n\nbody\n").unwrap();

        let error = delete_skill_files(&document, &[root])
            .unwrap_err()
            .to_string();
        assert!(error.contains("symlink or junction"), "{error}");
        assert!(document.is_file(), "nothing was deleted through the link");
        assert!(
            outside.join("precious.txt").is_file(),
            "the target survives"
        );
        let _ = fs::remove_dir_all(&link);
        let _ = fs::remove_file(outside.join("precious.txt"));
    });
}

/// The four containers a skill owns (ADR 0388). `references/` stays markdown,
/// the rest carry whatever the skill needs; nothing outside them is writable.
#[test]
fn write_resource_accepts_the_four_skill_containers() {
    // Project level on purpose: the global root is a process-wide env setting
    // other tests repoint, and a test about path rules must not join that race.
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project.path().to_string_lossy().to_string();
    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .create(input("Containers", "project", Some(&project_path)))
        .unwrap();
    let skill_dir = Path::new(&record.path).parent().unwrap().join(&record.id);

    for (path, body) in [
        ("references/api.md", "# api\n"),
        ("templates/report.md", "Report for {{date}}\n"),
        ("scripts/collect.ps1", "Get-ChildItem\n"),
        ("assets/schema.json", "{\"a\":1}\n"),
    ] {
        registry
            .write_resource(&record.id, None, Some(&project_path), path, body)
            .unwrap_or_else(|error| panic!("{path}: {error}"));
        assert_eq!(
            fs::read_to_string(skill_dir.join(path)).unwrap(),
            body,
            "{path}"
        );
    }
}

#[test]
fn write_resource_refuses_a_root_a_skill_does_not_own() {
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project.path().to_string_lossy().to_string();
    let mut registry = UserSkillRegistry::new(app.path());
    let record = registry
        .create(input("Roots", "project", Some(&project_path)))
        .unwrap();

    for path in [
        "SKILL.md",
        "notes/api.md",
        "references/../escape.md",
        "../references/x.md",
    ] {
        let error = registry
            .write_resource(&record.id, None, Some(&project_path), path, "x")
            .expect_err(path)
            .to_string();
        assert!(error.contains("SKILL_INVALID"), "{path}: {error}");
    }
    // A reference is prose the model reads, so it stays markdown.
    assert!(registry
        .write_resource(
            &record.id,
            None,
            Some(&project_path),
            "references/api.txt",
            "x"
        )
        .is_err());
    // The other containers are not restricted that way.
    assert!(registry
        .write_resource(
            &record.id,
            None,
            Some(&project_path),
            "templates/api.txt",
            "x"
        )
        .is_ok());
}
