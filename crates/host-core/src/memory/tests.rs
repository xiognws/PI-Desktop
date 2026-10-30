use super::*;
use crate::db::{Database, SCHEMA_VERSION};

fn db() -> (Database, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (db, dir)
}

fn project_memory(title: &str, body: &str, project: &str) -> NewMemory {
    NewMemory::new(MemoryScope::Project, MemoryKind::Fact, title, body).in_project(project)
}

fn recall_into(db: &Database, text: &str, project: &str, session: &str) -> Vec<String> {
    db.recall(RecallQuery {
        query: text.to_string(),
        project_path: Some(project.to_string()),
        session_id: Some(session.to_string()),
        ..Default::default()
    })
    .unwrap()
    .into_iter()
    .map(|hit| hit.memory.title)
    .collect()
}

#[test]
fn remember_then_read_back() {
    let (db, _dir) = db();
    let outcome = db
        .remember(project_memory(
            "deploy target",
            "the deploy host is sda-build-02",
            "/w/pi",
        ))
        .unwrap();
    assert!(!outcome.deduped);
    assert_eq!(outcome.memory.scope, MemoryScope::Project);
    assert_eq!(outcome.memory.project_path.as_deref(), Some("/w/pi"));
    assert!(outcome.memory.is_live());

    let fetched = db.get_memory(&outcome.memory.id).unwrap();
    assert_eq!(fetched.title, "deploy target");
    assert_eq!(fetched.body, "the deploy host is sda-build-02");
}

#[test]
fn identical_write_dedupes_instead_of_duplicating() {
    let (db, _dir) = db();
    let first = db
        .remember(project_memory(
            "deploy target",
            "host is sda-build-02",
            "/w/pi",
        ))
        .unwrap();
    let second = db
        .remember(project_memory(
            "deploy target",
            "host is sda-build-02",
            "/w/pi",
        ))
        .unwrap();
    assert!(second.deduped);
    assert_eq!(first.memory.id, second.memory.id);
    assert_eq!(db.memory_stats().unwrap().total, 1);
}

#[test]
fn same_text_in_a_different_project_is_a_different_memory() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "deploy target",
        "host is sda-build-02",
        "/w/a",
    ))
    .unwrap();
    db.remember(project_memory(
        "deploy target",
        "host is sda-build-02",
        "/w/b",
    ))
    .unwrap();
    assert_eq!(db.memory_stats().unwrap().total, 2);
}

#[test]
fn project_memories_do_not_leak_across_projects() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "deploy target",
        "host is sda-build-02",
        "/w/a",
    ))
    .unwrap();
    assert_eq!(
        recall_into(&db, "deploy", "/w/a", "s1"),
        vec!["deploy target"]
    );
    assert!(recall_into(&db, "deploy", "/w/b", "s1").is_empty());
}

#[test]
fn session_memories_stay_inside_their_session_but_global_ones_travel() {
    let (db, _dir) = db();
    db.remember(
        NewMemory::new(
            MemoryScope::Session,
            MemoryKind::Decision,
            "this run",
            "use plan mode",
        )
        .in_session("s1"),
    )
    .unwrap();
    db.remember(NewMemory::new(
        MemoryScope::Global,
        MemoryKind::Preference,
        "user preference",
        "answers should be terse",
    ))
    .unwrap();

    assert_eq!(
        recall_into(&db, "plan mode", "/w/a", "s1"),
        vec!["this run"]
    );
    assert!(recall_into(&db, "plan mode", "/w/a", "s2").is_empty());
    // Global memories reach every project and session.
    assert_eq!(
        recall_into(&db, "terse", "/w/b", "s2"),
        vec!["user preference"]
    );
}

#[test]
fn chinese_text_is_recallable_without_a_segmenter() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "上下文压缩阈值",
        "keepRecentTokens 设为 20000，reserveTokens 设为 16384",
        "/w/pi",
    ))
    .unwrap();

    // Two-character query has to match a longer CJK run.
    assert_eq!(
        recall_into(&db, "压缩", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
    // Mixed query: CJK plus a latin token.
    assert_eq!(
        recall_into(&db, "压缩 20000", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
    assert!(recall_into(&db, "部署", "/w/pi", "s1").is_empty());
}

#[test]
fn fts_operators_in_the_query_are_inert() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "deploy target",
        "host is sda-build-02",
        "/w/pi",
    ))
    .unwrap();
    for query in [
        "deploy*",
        "\"deploy\"",
        "deploy OR nothing",
        "deploy -target",
        "deploy:host",
    ] {
        let hits = recall_into(&db, query, "/w/pi", "s1");
        assert!(
            hits.is_empty() || hits == vec!["deploy target"],
            "query {query:?} produced unexpected hits {hits:?}"
        );
    }
}

#[test]
fn superseded_memories_leave_recall_but_stay_in_the_table() {
    let (db, _dir) = db();
    let old = db
        .remember(project_memory(
            "deploy target",
            "host is sda-build-01",
            "/w/pi",
        ))
        .unwrap();
    let new = db
        .remember(project_memory(
            "deploy target moved",
            "host is sda-build-02",
            "/w/pi",
        ))
        .unwrap();
    db.supersede_memory(&old.memory.id, &new.memory.id).unwrap();

    assert_eq!(
        recall_into(&db, "deploy", "/w/pi", "s1"),
        vec!["deploy target moved"]
    );
    let history = db.get_memory(&old.memory.id).unwrap();
    assert_eq!(
        history.superseded_by.as_deref(),
        Some(new.memory.id.as_str())
    );
    assert!(history.valid_until.is_some());
    assert_eq!(db.memory_stats().unwrap().total, 2);
}

#[test]
fn update_rewrites_the_index() {
    let (db, _dir) = db();
    let memory = db
        .remember(project_memory(
            "deploy target",
            "host is sda-build-01",
            "/w/pi",
        ))
        .unwrap();
    db.update_memory(
        &memory.memory.id,
        Some("staging target"),
        Some("staging host is sda-stage-01"),
        None,
        None,
        None,
    )
    .unwrap();

    assert_eq!(
        recall_into(&db, "staging", "/w/pi", "s1"),
        vec!["staging target"]
    );
    assert!(recall_into(&db, "sda-build-01", "/w/pi", "s1").is_empty());
}

#[test]
fn forget_removes_the_row_and_the_index_entry() {
    let (db, _dir) = db();
    let memory = db
        .remember(project_memory(
            "deploy target",
            "host is sda-build-01",
            "/w/pi",
        ))
        .unwrap();
    assert!(db.forget_memory(&memory.memory.id).unwrap());
    assert!(db
        .recall(RecallQuery {
            query: "deploy".into(),
            project_path: Some("/w/pi".into()),
            ..Default::default()
        })
        .unwrap()
        .is_empty());
    assert!(!db.forget_memory(&memory.memory.id).unwrap());
}

#[test]
fn forgetting_a_session_drops_exactly_its_memories() {
    let (db, _dir) = db();
    db.remember(
        NewMemory::new(MemoryScope::Session, MemoryKind::Fact, "one", "alpha").in_session("s1"),
    )
    .unwrap();
    db.remember(
        NewMemory::new(MemoryScope::Session, MemoryKind::Fact, "two", "alpha").in_session("s2"),
    )
    .unwrap();
    db.remember(NewMemory::new(
        MemoryScope::Global,
        MemoryKind::Fact,
        "three",
        "alpha",
    ))
    .unwrap();

    assert_eq!(db.forget_memories_for_session("s1").unwrap(), 1);
    assert_eq!(db.memory_stats().unwrap().total, 2);
}

#[test]
fn recall_orders_pinned_first_and_counts_uses() {
    let (db, _dir) = db();
    db.remember(project_memory("alpha note", "deploy detail one", "/w/pi"))
        .unwrap();
    db.remember(project_memory("beta note", "deploy detail two", "/w/pi").pinned(true))
        .unwrap();

    let hits = db
        .recall(RecallQuery {
            query: "deploy".into(),
            project_path: Some("/w/pi".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hits[0].memory.title, "beta note");
    assert_eq!(db.get_memory(&hits[0].memory.id).unwrap().use_count, 1);
}

#[test]
fn pinned_memories_come_back_without_a_query() {
    let (db, _dir) = db();
    db.remember(project_memory("rule one", "always run lint", "/w/pi").pinned(true))
        .unwrap();
    db.remember(project_memory("rule two", "never touch main", "/w/pi"))
        .unwrap();

    let pinned = db.pinned_memories(Some("/w/pi"), Some("s1"), 8).unwrap();
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0].title, "rule one");
}

#[test]
fn invalid_writes_are_rejected_before_any_state_changes() {
    let (db, _dir) = db();
    let missing_path = NewMemory::new(MemoryScope::Project, MemoryKind::Fact, "t", "b");
    assert!(db.remember(missing_path).is_err());

    let missing_session = NewMemory::new(MemoryScope::Session, MemoryKind::Fact, "t", "b");
    assert!(db.remember(missing_session).is_err());

    let mut bad_confidence = NewMemory::new(MemoryScope::Global, MemoryKind::Fact, "t", "b");
    bad_confidence.confidence = 1.5;
    assert!(db.remember(bad_confidence).is_err());

    let long_title = "x".repeat(MAX_TITLE_CHARS + 1);
    assert!(db
        .remember(NewMemory::new(
            MemoryScope::Global,
            MemoryKind::Fact,
            long_title,
            "body"
        ))
        .is_err());

    assert_eq!(db.memory_stats().unwrap().total, 0);
}

#[test]
fn list_filters_and_counts() {
    let (db, _dir) = db();
    db.remember(project_memory("a", "aha", "/w/pi")).unwrap();
    db.remember(
        NewMemory::new(MemoryScope::Global, MemoryKind::Preference, "b", "bha")
            .with_tags(vec!["style".into()]),
    )
    .unwrap();

    let (page, total) = db
        .list_memories(&ListFilter {
            scope: Some(MemoryScope::Global),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(total, 1);
    assert_eq!(page[0].title, "b");
    assert_eq!(page[0].tags, vec!["style".to_string()]);

    let (all, total_all) = db.list_memories(&ListFilter::default()).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(total_all, 2);
}

#[test]
fn search_normalisation_tokenises_cjk_and_keeps_latin_words() {
    assert_eq!(normalise_search_text("上下文压缩"), "上 下 文 压 缩");
    assert_eq!(
        normalise_search_text("keepRecentTokens 20000"),
        "keepRecentTokens 20000"
    );
    assert_eq!(
        normalise_search_text("  混合  text\tthen 中文 "),
        "混 合 text then 中 文"
    );
}

#[test]
fn match_query_quotes_terms() {
    assert_eq!(
        fts_match_query("deploy gateway"),
        "\"deploy\" AND \"gateway\""
    );
    assert_eq!(fts_match_query("压缩"), "\"压\" AND \"缩\"");
    assert_eq!(fts_match_query("   "), "");
    assert_eq!(
        fts_match_query("deploy* OR x"),
        "\"deploy\" AND \"OR\" AND \"x\""
    );
}

#[test]
fn content_hash_ignores_surrounding_whitespace() {
    assert_eq!(content_hash(" t ", " b "), content_hash("t", "b"));
    assert_ne!(content_hash("t", "b"), content_hash("t", "b2"));
}

/// Regression: `Database::open` must migrate a v25 database instead of falling
/// into the "newer than supported" arm. Users upgrade in place, so a missing
/// match arm here is an app that will not start on their existing data.
#[test]
fn opening_a_v25_database_migrates_instead_of_failing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn
            .execute_batch(
                "DROP TABLE IF EXISTS memories_fts;
                 DROP TABLE IF EXISTS memories;
                 PRAGMA user_version = 25;",
            )
            .unwrap();
    }

    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        version,
        SCHEMA_VERSION,
        "a v25 database must be migrated to the current schema"
    );
    let rows: i64 = db
        .conn
        .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0, "migration must leave an empty memory store");
}

#[test]
fn a_retired_memory_leaves_recall_and_comes_back_on_restore() {
    let (db, _dir) = db();
    let stored = db
        .remember(project_memory(
            "Deploy flag",
            "The release build needs --locked",
            "/work/alpha",
        ))
        .unwrap();
    let id = stored.memory.id.clone();
    assert_eq!(recall_into(&db, "release build", "/work/alpha", "s1").len(), 1);

    assert!(db.retire_memory(&id, "decay").unwrap());
    assert!(
        recall_into(&db, "release build", "/work/alpha", "s1").is_empty(),
        "a retired memory must not be recalled"
    );
    assert!(
        db.list_memories(&ListFilter::default()).unwrap().0.iter().any(|row| row.id == id),
        "retiring is not deleting: the row stays auditable"
    );

    assert!(db.restore_memory(&id).unwrap());
    assert_eq!(
        recall_into(&db, "release build", "/work/alpha", "s1").len(),
        1,
        "restoring believes it again"
    );
}

#[test]
fn a_pinned_memory_is_never_retired_by_decay() {
    let (db, _dir) = db();
    let stored = db
        .remember(
            project_memory("Pinned fact", "The staging host is staging.example", "/work/alpha")
                .pinned(true),
        )
        .unwrap();
    let failure = db
        .retire_memory(&stored.memory.id, "decay")
        .unwrap_err()
        .to_string();
    assert!(failure.contains("MEMORY_PINNED"), "{failure}");
    assert_eq!(recall_into(&db, "staging host", "/work/alpha", "s1").len(), 1);
}

#[test]
fn learning_a_retired_memory_again_creates_a_fresh_live_row() {
    let (db, _dir) = db();
    let first = db
        .remember(project_memory("Port note", "Dev server listens on 5173", "/work/alpha"))
        .unwrap();
    db.retire_memory(&first.memory.id, "decay").unwrap();

    let second = db
        .remember(project_memory("Port note", "Dev server listens on 5173", "/work/alpha"))
        .unwrap();
    assert!(second.deduped, "the dedupe index keeps one row per content hash");
    assert_eq!(second.memory.id, first.memory.id);
    assert!(
        second.memory.valid_until.is_none(),
        "re-learning a retired memory believes it again"
    );
    assert_eq!(recall_into(&db, "dev server", "/work/alpha", "s1").len(), 1);
}

#[test]
fn the_automatic_sweep_retires_instead_of_deleting() {
    let (db, _dir) = db();
    let stored = db
        .remember(project_memory("Old fact", "A stale build flag", "/work/alpha"))
        .unwrap();
    // Age it past every window the default policy uses.
    let ancient = now_ms() - 400 * 86_400_000;
    db.conn
        .execute(
            "UPDATE memories SET created_at = ?1, updated_at = ?1, last_used_at = NULL, confidence = 0.9
              WHERE id = ?2",
            params![ancient, stored.memory.id],
        )
        .unwrap();

    let (retired, _pruned) = db
        .retire_decayed(&crate::memory::decay::DecayPolicy::default())
        .unwrap();
    assert_eq!(retired, 1);
    let row = db.get_memory(&stored.memory.id).expect("the row survives the sweep");
    assert!(row.valid_until.is_some(), "the sweep stops recalling it");
    assert!(recall_into(&db, "stale build flag", "/work/alpha", "s1").is_empty());
}

fn proposal(title: &str, body: &str) -> NewMemoryProposal {
    NewMemoryProposal {
        scope: MemoryScope::Project,
        project_path: Some("/work/alpha".to_string()),
        session_id: None,
        kind: MemoryKind::Fact,
        title: title.to_string(),
        body: body.to_string(),
        tags: Vec::new(),
        confidence: Some(0.6),
        origin: "turn".to_string(),
    }
}

#[test]
fn a_proposal_queues_without_becoming_a_memory() {
    let (db, _dir) = db();
    let queued = db
        .propose_memory(proposal("Build flag", "Release builds need --locked"))
        .unwrap()
        .expect("queued");
    assert!(queued.decision.is_none());
    assert!(db.list_memories(&ListFilter::default()).unwrap().0.is_empty());
    assert_eq!(db.list_memory_proposals(false, 10).unwrap().len(), 1);
}

#[test]
fn a_proposal_the_store_already_believes_is_not_queued() {
    let (db, _dir) = db();
    db.remember(project_memory("Build flag", "Release builds need --locked", "/work/alpha"))
        .unwrap();
    assert!(db
        .propose_memory(proposal("Build flag", "Release builds need --locked"))
        .unwrap()
        .is_none());
}

#[test]
fn the_same_open_proposal_is_never_queued_twice() {
    let (db, _dir) = db();
    assert!(db
        .propose_memory(proposal("Port note", "Dev server listens on 5173"))
        .unwrap()
        .is_some());
    assert!(db
        .propose_memory(proposal("Port note", "Dev server listens on 5173"))
        .unwrap()
        .is_none());
    assert_eq!(db.list_memory_proposals(false, 10).unwrap().len(), 1);
}

#[test]
fn accepting_a_proposal_writes_the_memory_and_closes_the_proposal() {
    let (db, _dir) = db();
    let queued = db
        .propose_memory(proposal("Build flag", "Release builds need --locked"))
        .unwrap()
        .unwrap();
    let memory = db.accept_memory_proposal(&queued.id).unwrap().expect("memory");
    assert_eq!(memory.title, "Build flag");
    assert_eq!(memory.scope, MemoryScope::Project);
    assert_eq!(recall_into(&db, "release builds", "/work/alpha", "s1").len(), 1);
    assert!(db.list_memory_proposals(false, 10).unwrap().is_empty());
    assert!(db.accept_memory_proposal(&queued.id).is_err(), "review happens once");
}

#[test]
fn rejecting_a_proposal_never_writes_a_memory() {
    let (db, _dir) = db();
    let queued = db
        .propose_memory(proposal("Noise", "A guess the model made"))
        .unwrap()
        .unwrap();
    assert!(db.reject_memory_proposal(&queued.id).unwrap());
    assert!(db.list_memories(&ListFilter::default()).unwrap().0.is_empty());
    assert!(!db.reject_memory_proposal(&queued.id).unwrap(), "already decided");
    let decided = db.list_memory_proposals(true, 10).unwrap();
    assert_eq!(decided[0].decision.as_deref(), Some("rejected"));
}
