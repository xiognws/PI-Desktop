use super::*;
use crate::agent_capabilities::test_support;
use tempfile::tempdir;

fn input(name: &str, level: &str, project_path: Option<&str>) -> UserSkillInput {
    UserSkillInput {
        name: Some(name.into()),
        level: Some(level.into()),
        project_path: project_path.map(str::to_string),
        description: Some("Check the relevant files".into()),
        body: Some("Do the thing.".into()),
        ..Default::default()
    }
}

#[test]
fn imports_one_file_into_the_global_skills_directory() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    let raw = "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n";
    fs::write(&source, raw).unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(source.to_str().unwrap(), input("Ignored", "global", None))
            .unwrap();
        let expected_doc = home.path().join("skills").join("review.md");
        assert_eq!(record.level.as_deref(), Some("global"));
        assert_eq!(record.path, expected_doc.to_string_lossy());
        assert_eq!(fs::read_to_string(&expected_doc).unwrap(), raw);
        assert!(source.is_file());
    });
}

#[test]
fn project_skills_shadow_global_skills_by_name() {
    let app = tempdir().unwrap();
    let global = app.path().join("global");
    let project = app.path().join("project");
    fs::create_dir_all(global.join("skills")).unwrap();
    fs::create_dir_all(project.join(".agents/skills")).unwrap();
    fs::write(
        global.join("skills/review.md"),
        "---\nname: Review\n---\n\nGlobal\n",
    )
    .unwrap();
    fs::write(
        project.join(".agents/skills/review.md"),
        "---\nname: Review\n---\n\nProject\n",
    )
    .unwrap();
    let (fields, body) =
        parse_front_matter(&fs::read_to_string(project.join(".agents/skills/review.md")).unwrap());
    assert_eq!(fields.get("name").map(String::as_str), Some("Review"));
    assert_eq!(body, "Project");
}

#[test]
fn capability_state_is_not_written_into_skill_documents() {
    let app = tempdir().unwrap();
    let mut state = CapabilityState::new(app.path(), SKILL_KIND);
    state
        .set_enabled(SKILL_KIND, CapabilityLevel::Global, "review", None, false)
        .unwrap();
    assert!(!app
        .path()
        .join("agent-capabilities/skills.json")
        .to_string_lossy()
        .contains(".agents"));
}

#[test]
fn builtin_activation_defaults_on_persists_and_is_separate_from_scanned_skills() {
    let app = tempdir().unwrap();
    let agents = tempdir().unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    assert!(registry.disabled_builtins().is_empty());

    registry
        .set_builtin_enabled("pi-desktop/imagegen", false)
        .unwrap();
    assert_eq!(
        registry.disabled_builtins(),
        vec!["pi-desktop/imagegen".to_string()]
    );

    test_support::with_global_agents(agents.path(), || {
        registry.list(CapabilityLevel::Global, None).unwrap();
    });
    let mut reopened = UserSkillRegistry::new(app.path());
    test_support::with_global_agents(agents.path(), || {
        reopened.list(CapabilityLevel::Global, None).unwrap();
    });
    assert_eq!(
        reopened.disabled_builtins(),
        vec!["pi-desktop/imagegen".to_string()]
    );
    assert!(app
        .path()
        .join("agent-capabilities/skill-builtins.json")
        .is_file());

    reopened
        .set_builtin_enabled("pi-desktop/imagegen", true)
        .unwrap();
    assert!(reopened.disabled_builtins().is_empty());
}

#[test]
fn builtin_activation_rejects_invalid_ids() {
    let app = tempdir().unwrap();
    let mut registry = UserSkillRegistry::new(app.path());
    for id in [
        "",
        "imagegen",
        "PI-Desktop/imagegen",
        "pi-desktop/",
        "pi-desktop/imagegen/extra",
    ] {
        assert!(
            registry.set_builtin_enabled(id, false).is_err(),
            "accepted {id:?}"
        );
    }
    assert!(registry.disabled_builtins().is_empty());
}

#[test]
fn import_uses_parent_directory_when_name_is_not_ascii() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/code-review");
    fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("SKILL.md");
    fs::write(
        &source,
        "---\nname: 代码审查\ndescription: >\n  Review diffs before merge.\n---\n\nCheck the patch.\n",
    )
    .unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(source.to_str().unwrap(), input("Ignored", "global", None))
            .unwrap();
        assert_eq!(record.id, "code-review");
        assert_eq!(record.name, "代码审查");
        assert_eq!(
            record.description.as_deref(),
            Some("Review diffs before merge.")
        );
        let listed = registry.list(CapabilityLevel::Global, None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "code-review");
        assert_eq!(listed[0].name, "代码审查");
    });
}

#[test]
fn directory_skills_do_not_collide_on_the_skill_file_stem() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    fs::create_dir_all(home.path().join("skills/pdf")).unwrap();
    fs::create_dir_all(home.path().join("skills/docx")).unwrap();
    fs::write(
        home.path().join("skills/pdf/SKILL.md"),
        "# PDF\n\nExtract text.\n",
    )
    .unwrap();
    fs::write(
        home.path().join("skills/docx/SKILL.md"),
        "# DOCX\n\nEdit documents.\n",
    )
    .unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let listed = registry.list(CapabilityLevel::Global, None).unwrap();
        let ids: Vec<_> = listed.iter().map(|record| record.id.as_str()).collect();
        assert_eq!(ids, vec!["docx", "pdf"]);
    });
}

/// A global skill document plus the project directory it can move into.
fn skill_home(home: &Path) {
    fs::create_dir_all(home.join("skills")).unwrap();
}

fn project_dir(project: &Path) -> String {
    project.to_str().unwrap().to_string()
}

fn record(id: &str, name: &str) -> UserSkillRecord {
    UserSkillRecord {
        id: id.into(),
        name: name.into(),
        level: None,
        project_path: None,
        description: None,
        enabled: true,
        scope: ActivationScope::default(),
        source: "imported".into(),
        path: String::new(),
        size_bytes: 0,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// Compare two paths despite platform separator differences.
fn canonical(value: &str) -> String {
    value.replace('\\', "/")
}

#[test]
fn a_transfer_toward_a_project_target_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::write(
            home.path().join("skills/review.md"),
            "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let err = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        // The global document stays put; no project directory appears.
        assert!(home.path().join("skills/review.md").is_file());
        assert!(!project.path().join(".agents").exists());
        assert_eq!(
            registry.list(CapabilityLevel::Global, None).unwrap().len(),
            1
        );
    });
}

#[test]
fn a_transfer_renaming_into_a_project_target_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        let original = "---\nname: Review\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n";
        fs::write(home.path().join("skills/review.md"), original).unwrap();
        fs::write(
            project.path().join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject copy\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        // The global document is untouched; the project copy remains too.
        assert_eq!(
            fs::read_to_string(home.path().join("skills/review.md")).unwrap(),
            original
        );
        assert!(project.path().join(".agents/skills/review.md").is_file());
    });
}

#[test]
fn a_directory_skill_transfer_into_a_project_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        let source = home.path().join("skills/pdf");
        fs::create_dir_all(source.join("templates")).unwrap();
        fs::write(source.join("SKILL.md"), "# PDF\n\nExtract text.\n").unwrap();
        fs::write(source.join("templates/page.html"), "<p>page</p>").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "pdf",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        // Document and resource remain in the global library.
        assert!(source.join("SKILL.md").is_file());
        assert!(source.join("templates/page.html").is_file());
    });
}

#[test]
fn a_renamed_directory_skill_transfer_into_a_project_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills/pdf")).unwrap();
        fs::write(
            project.path().join(".agents/skills/pdf/SKILL.md"),
            "# PDF\n\nProject copy.\n",
        )
        .unwrap();
        let source = home.path().join("skills/pdf");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "# PDF\n\nGlobal copy.\n").unwrap();
        fs::write(source.join("notes.txt"), "keep me").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "pdf",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        // Global document, resource, and the separate project copy all survive.
        assert!(source.join("SKILL.md").is_file());
        assert!(source.join("notes.txt").is_file());
        assert!(project.path().join(".agents/skills/pdf/SKILL.md").is_file());
    });
}

#[test]
fn a_transfer_out_of_a_project_source_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        fs::write(
            project.path().join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject copy\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        // The project document stays put; nothing appears in the global library.
        assert!(project.path().join(".agents/skills/review.md").is_file());
        assert!(registry
            .list(CapabilityLevel::Global, None)
            .unwrap()
            .is_empty());
    });
}

#[test]
fn a_frontmatterless_transfer_into_a_project_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        let source_doc = home.path().join("skills/review.md");
        fs::write(&source_doc, "# Review\n\nDo it.\n").unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        assert!(source_doc.is_file());
    });
}

#[test]
fn placement_uses_the_id_the_scan_will_derive_from_the_name() {
    let directory = tempdir().unwrap();
    let source = record("code-review", "代码审查");
    let existing = vec![record("code-review", "代码审查")];

    let placement = plan_skill_placement(&source, directory.path(), true, &existing).unwrap();
    assert_eq!(placement.name, "代码审查 (2)");
    // The rename's slug is `2`, not the file stem the move started from, so
    // that is what both the directory and the next scan will call it.
    assert_eq!(placement.stem, "2");
    let document = skill_document_path(directory.path(), &placement.stem, true);
    assert_eq!(
        capability_id(&placement.name, &document, 64),
        placement.stem
    );

    // A flat destination derives the same id from the `.md` stem.
    let placement = plan_skill_placement(&source, directory.path(), false, &existing).unwrap();
    let document = skill_document_path(directory.path(), &placement.stem, false);
    assert_eq!(
        capability_id(&placement.name, &document, 64),
        placement.stem
    );
}

#[test]
fn placement_reports_exhaustion_instead_of_reusing_a_taken_name() {
    let directory = tempdir().unwrap();
    let source = record("review", "Review");
    let existing: Vec<UserSkillRecord> = (1..=MAX_ID_SUFFIX)
        .map(|ordinal| {
            record(
                &format!("other-{ordinal}"),
                &display_name_candidate("Review", ordinal, MAX_NAME_CHARS),
            )
        })
        .collect();
    // Every candidate the planner could use is already a displayed name, so
    // there is no collision-free placement and the move must refuse rather
    // than write a duplicate.
    assert!(plan_skill_placement(&source, directory.path(), false, &existing).is_none());
}

#[test]
fn a_cjk_named_skill_transfer_into_a_project_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::write(
            home.path().join("skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nGlobal copy.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "code-review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        assert!(home.path().join("skills/code-review.md").is_file());
    });
}

#[test]
fn a_slug_collision_transfer_into_a_project_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let project = tempdir().unwrap();
    let project_path = project_dir(project.path());
    test_support::with_global_agents(home.path(), || {
        skill_home(home.path());
        fs::create_dir_all(project.path().join(".agents/skills")).unwrap();
        fs::write(
            home.path().join("skills/code-review.md"),
            "---\nname: 代码审查\n---\n\nGlobal copy.\n",
        )
        .unwrap();
        fs::write(
            project.path().join(".agents/skills/2.md"),
            "---\nname: 2\n---\n\nTakes the id 2.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());

        let err = registry
            .transfer(
                "code-review",
                &CapabilityTarget::new(CapabilityLevel::Global, None).unwrap(),
                &CapabilityTarget::new(CapabilityLevel::Project, Some(&project_path)).unwrap(),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_PROJECT_LEVEL_REMOVED"), "err = {err}");
        assert!(home.path().join("skills/code-review.md").is_file());
    });
}
#[test]
fn rewriting_a_name_keeps_the_frontmatter_shaped_document_intact() {
    // The helper is unit-tested directly because it is the only place a move
    // edits a document, and every byte it does not touch is a byte the user
    // gets to keep.
    let with_extra_fields = "---\nlicense: MIT\nname: Review\nallowed-tools: Read\n---\n\nBody\n";
    assert_eq!(
        rewrite_document_name(with_extra_fields, "Review (2)"),
        "---\nlicense: MIT\nname: Review (2)\nallowed-tools: Read\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("---\r\nname: A\r\n---\r\n\r\nBody\r\n", "B"),
        "---\nname: B\n---\r\n\r\nBody\r\n"
    );
    assert_eq!(
        rewrite_document_name("no frontmatter\n", "B"),
        "---\nname: B\n---\n\nno frontmatter\n"
    );
    assert_eq!(
        rewrite_document_name("---\nname: A\nnever closed\n", "B"),
        "---\nname: B\n---\n\n---\nname: A\nnever closed\n"
    );
    // A newline in the name would break the block it is written into.
    assert_eq!(
        rewrite_document_name("---\nname: A\n---\n\nBody\n", "Two\nLines"),
        "---\nname: Two Lines\n---\n\nBody\n"
    );
    // The parser keeps the *last* `name:` line, so a stale second one must
    // be dropped: keeping it would make the old name win again on the next
    // scan, silently defeating the rename.
    assert_eq!(
        rewrite_document_name("---\nname: A\nname: B\n---\n\nBody\n", "C"),
        "---\nname: C\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("---\nname: A\nlicense: MIT\nname: B\n---\n\nBody\n", "C"),
        "---\nname: C\nlicense: MIT\n---\n\nBody\n"
    );
    // A first line that only trims to `---` still opens frontmatter. Not
    // recognizing it would copy the old block into the new body, leaving
    // two frontmatter blocks in the document.
    assert_eq!(
        rewrite_document_name("--- \nname: A\n---\n\nBody\n", "C"),
        "---\nname: C\n---\n\nBody\n"
    );
    assert_eq!(
        rewrite_document_name("--- \r\nname: A\r\n---\r\n\r\nBody\r\n", "C"),
        "---\nname: C\n---\r\n\r\nBody\r\n"
    );
    // An indented `name:` is a nested map value, not the document's name.
    assert_eq!(
        rewrite_document_name("---\nmeta:\n  name: A\nname: B\n---\n\nBody\n", "C"),
        "---\nmeta:\n  name: A\nname: C\n---\n\nBody\n"
    );
}

#[test]
fn imports_a_directory_with_skill_md_in_copy_mode() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/example-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("SKILL.md"),
        "---\nname: Example\ndescription: Anthropic-style skill\n---\n\nBody.\n",
    )
    .unwrap();
    fs::write(source_dir.join("resource.txt"), "extra\n").unwrap();

    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(
                source_dir.to_str().unwrap(),
                input("Ignored", "global", None),
            )
            .unwrap();
        let expected_root = home.path().join("skills").join("example");
        assert!(expected_root.is_dir(), "target dir exists");
        assert!(expected_root.join("SKILL.md").is_file(), "SKILL.md placed");
        assert!(
            expected_root.join("resource.txt").is_file(),
            "resources copied"
        );
        assert_eq!(record.name, "Example");
        // The record path points at the SKILL.md the scanner selects.
        assert_eq!(
            canonical(&record.path),
            canonical(&expected_root.join("SKILL.md").to_string_lossy())
        );
        // Source is untouched under copy mode.
        assert!(source_dir.join("SKILL.md").is_file());
    });
}

#[test]
fn imports_a_directory_with_skill_md_in_link_mode() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/linked-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(
        source_dir.join("SKILL.md"),
        "---\nname: Linked\n---\n\nBody.\n",
    )
    .unwrap();

    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "global", None);
        payload.mode = Some("link".into());
        let record = match registry.import(source_dir.to_str().unwrap(), payload) {
            Ok(record) => record,
            Err(err) if cfg!(windows) && format!("{err:#}").contains("1314") => {
                // Unprivileged Windows environments without Developer Mode enabled
                // cannot create filesystem symlinks (os error 1314).
                return;
            }
            Err(err) => panic!("import failed unexpectedly: {err:#}"),
        };
        let expected_root = home.path().join("skills/linked");
        let metadata = fs::symlink_metadata(&expected_root).unwrap();
        assert!(
            metadata.file_type().is_symlink(),
            "link mode leaves a symlink at the destination"
        );
        // The symlink resolves and the scanned SKILL.md path reads back through it.
        assert!(expected_root.join("SKILL.md").is_file());
        assert_eq!(record.name, "Linked");
    });
}

#[test]
fn imports_a_file_in_link_mode() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source = app.path().join("incoming/notes.md");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(
        &source,
        "---\nname: Notes\ndescription: linked file\n---\n\nBody.\n",
    )
    .unwrap();

    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "global", None);
        payload.mode = Some("link".into());
        let record = match registry.import(source.to_str().unwrap(), payload) {
            Ok(record) => record,
            Err(err) if cfg!(windows) && format!("{err:#}").contains("1314") => {
                // Unprivileged Windows environments without Developer Mode enabled
                // cannot create filesystem symlinks (os error 1314).
                return;
            }
            Err(err) => panic!("import failed unexpectedly: {err:#}"),
        };
        let expected = home.path().join("skills/notes.md");
        let metadata = fs::symlink_metadata(&expected).unwrap();
        assert!(metadata.file_type().is_symlink());
        assert_eq!(record.name, "Notes");
    });
}

#[test]
fn directory_import_without_skill_md_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source_dir = app.path().join("incoming/no-skill");
    fs::create_dir_all(&source_dir).unwrap();
    fs::write(source_dir.join("readme.md"), "just docs\n").unwrap();

    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let err = registry
            .import(
                source_dir.to_str().unwrap(),
                input("Ignored", "global", None),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("SKILL_INVALID"), "err = {err}");
        assert!(err.contains("SKILL.md"), "err = {err}");
    });
}

#[test]
fn unknown_import_mode_is_rejected() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    fs::write(&source, "---\nname: Any\n---\n\nBody.\n").unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "global", None);
        payload.mode = Some("teleport".into());
        let err = registry
            .import(source.to_str().unwrap(), payload)
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown import mode"), "err = {err}");
    });
}

#[test]
fn shape_dir_requires_a_directory_source() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    let source = app.path().join("incoming.md");
    fs::write(&source, "---\nname: X\n---\n\nBody.\n").unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Ignored", "global", None);
        payload.shape = Some("dir".into());
        let err = registry
            .import(source.to_str().unwrap(), payload)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("SKILL_INVALID") && err.contains("directory"),
            "err = {err}"
        );
    });
}

#[test]
fn directory_skill_package_resources_round_trip_without_execution() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Packaged", "global", None);
        payload.id = Some("packaged".into());
        payload.shape = Some("dir".into());
        let record = registry.create(payload).unwrap();
        registry
            .write_package_files(
                &record.id,
                CapabilityLevel::Global,
                None,
                &[("scripts/check.txt".into(), b"safe bytes".to_vec())],
            )
            .unwrap();
        let files = registry
            .package_files(&record.id, CapabilityLevel::Global, None)
            .unwrap();
        assert_eq!(
            files,
            vec![("scripts/check.txt".into(), b"safe bytes".to_vec())]
        );
        assert!(record.path.ends_with("SKILL.md"));
    });
}

#[test]
fn directory_skill_package_rejects_traversal() {
    let home = tempdir().unwrap();
    let app = tempdir().unwrap();
    test_support::with_global_agents(home.path(), || {
        let mut registry = UserSkillRegistry::new(app.path());
        let mut payload = input("Packaged", "global", None);
        payload.id = Some("packaged".into());
        payload.shape = Some("dir".into());
        let record = registry.create(payload).unwrap();
        let error = registry
            .write_package_files(
                &record.id,
                CapabilityLevel::Global,
                None,
                &[("../outside.txt".into(), b"unsafe".to_vec())],
            )
            .unwrap_err()
            .to_string();
        assert!(error.contains("SKILL_INVALID"));
        assert!(!app.path().join("outside.txt").exists());
    });
}
