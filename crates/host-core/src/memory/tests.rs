use super::*;
use crate::db::Database;

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

/// The point of the trigram index: a run that spans a phrase, which `unicode61`
/// (one token per Chinese phrase) could never match.
#[test]
fn chinese_memories_match_a_substring_of_three_or_more_characters() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "上下文压缩阈值",
        "keepRecentTokens 设为 20000",
        "/w/pi",
    ))
    .unwrap();

    for query in ["文压缩", "下文压缩", "缩阈值", "上下文压缩阈值"] {
        assert_eq!(
            recall_into(&db, query, "/w/pi", "s1"),
            vec!["上下文压缩阈值"],
            "query {query:?} must match a substring of the title"
        );
    }
    assert!(recall_into(&db, "压缩算法", "/w/pi", "s1").is_empty());
    // The body is indexed the same way.
    assert_eq!(
        recall_into(&db, "设为 20000", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
}

/// A query too short for a trigram is answered by the `instr()` scan, and that
/// scan keeps every filter the index path applies.
#[test]
fn one_and_two_character_queries_fall_back_to_a_scan() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "上下文压缩阈值",
        "keepRecentTokens 设为 20000",
        "/w/pi",
    ))
    .unwrap();
    db.remember(project_memory("部署流程", "发布前先跑 pnpm", "/w/pi"))
        .unwrap();

    assert_eq!(
        recall_into(&db, "压", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
    assert_eq!(
        recall_into(&db, "压缩", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
    assert_eq!(recall_into(&db, "部署", "/w/pi", "s1"), vec!["部署流程"]);
    // Scope still decides what the scan may see.
    assert!(recall_into(&db, "压缩", "/w/other", "s1").is_empty());
    // As does the session window: a global memory is always in scope.
    db.remember(NewMemory::new(
        MemoryScope::Global,
        MemoryKind::Preference,
        "语气偏好",
        "回答保持简短",
    ))
    .unwrap();
    assert_eq!(recall_into(&db, "语气", "/w/other", "s2"), vec!["语气偏好"]);
}

#[test]
fn the_scan_fallback_hides_superseded_rows() {
    let (db, _dir) = db();
    let old = db
        .remember(project_memory("部署", "旧主机 sda-build-01", "/w/pi"))
        .unwrap();
    let new = db
        .remember(project_memory("发布", "新主机 sda-build-02", "/w/pi"))
        .unwrap();
    db.supersede_memory(&old.memory.id, &new.memory.id).unwrap();

    // Two characters, so this is the scan — which must skip the retired row even
    // though both rows carry the term.
    assert_eq!(recall_into(&db, "主机", "/w/pi", "s1"), vec!["发布"]);
}

#[test]
fn english_recall_still_matches_words_and_substrings() {
    let (db, _dir) = db();
    db.remember(project_memory(
        "deploy target",
        "the deploy host is sda-build-02",
        "/w/pi",
    ))
    .unwrap();

    assert_eq!(
        recall_into(&db, "deploy", "/w/pi", "s1"),
        vec!["deploy target"]
    );
    // Trigram matching is a substring match, not a word match, in English too.
    assert_eq!(
        recall_into(&db, "eploy host", "/w/pi", "s1"),
        vec!["deploy target"]
    );
    assert!(recall_into(&db, "gateway", "/w/pi", "s1").is_empty());
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
fn recall_plan_quotes_indexable_terms_and_keeps_short_ones() {
    let plan = RecallPlan::parse("压缩 20000 keepRecentTokens push");
    assert_eq!(
        plan.match_expression(),
        "\"20000\" AND \"keepRecentTokens\" AND \"push\""
    );
    // A term of one or two characters cannot be a trigram, so it never reaches
    // the MATCH expression; `recall` narrows with `instr()` instead.
    assert_eq!(plan.short, vec!["压缩"]);
    assert_eq!(RecallPlan::parse("压缩").match_expression(), "");
    assert_eq!(
        RecallPlan::parse("部署 plan").match_expression(),
        "\"plan\""
    );
    // Quoting makes an FTS5 operator a literal.
    assert_eq!(
        RecallPlan::parse("deploy* OR x").match_expression(),
        "\"deploy\""
    );
    // Duplicates are collapsed and an operator-only query is empty.
    assert_eq!(RecallPlan::parse("20000 20000").indexed, vec!["20000"]);
    assert!(RecallPlan::parse("  ** -- ").is_empty());
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
        crate::db::SCHEMA_VERSION,
        "a v25 database must be migrated to the latest schema"
    );
    let rows: i64 = db
        .conn
        .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0, "migration must leave an empty memory store");
}

/// Regression: a database already stamped at v26 must migrate to the latest
/// schema. v26 is a pure version stamp, so the same number can come from the
/// merged line or from a build that created the memory store before the merge;
/// both must open, and the second one must not fail on tables that already exist.
#[test]
fn opening_a_v26_database_migrates_instead_of_failing() {
    for memories_already_present in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            if !memories_already_present {
                db.conn
                    .execute_batch(
                        "DROP TABLE IF EXISTS memories_fts;
                         DROP TABLE IF EXISTS memories;",
                    )
                    .unwrap();
            }
            db.conn.execute_batch("PRAGMA user_version = 26;").unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            version,
            crate::db::SCHEMA_VERSION,
            "a v26 database (memories present: {memories_already_present}) must be \
             migrated to the latest schema"
        );
        let rows: i64 = db
            .conn
            .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "migration must leave an empty memory store");
    }
}

/// A profile written before v30 carries the `unicode61` index, where a whole
/// Chinese phrase is one token and only that exact phrase matched. Opening it
/// must rebuild the index — without rewriting a single stored row.
#[test]
fn a_pre_v30_database_becomes_searchable_for_chinese_after_the_migration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let memory_id = {
        let db = Database::open(&path).unwrap();
        let outcome = db
            .remember(project_memory(
                "上下文压缩阈值",
                "keepRecentTokens 设为 20000",
                "/w/pi",
            ))
            .unwrap();
        // Rewind the index to the v29 shape: the old tokenizer over a normalised
        // copy, plus the old stamp.
        db.conn
            .execute_batch(
                "DROP TABLE memories_fts;
                 CREATE VIRTUAL TABLE memories_fts USING fts5(
                   title, body, tags, tokenize = 'unicode61 remove_diacritics 2'
                 );
                 INSERT INTO memories_fts (rowid, title, body, tags)
                   SELECT rowid, '上 下 文 压 缩 阈 值',
                          'keepRecentTokens 设 为 20000', ''
                     FROM memories;
                 PRAGMA user_version = 29;",
            )
            .unwrap();
        let old_index_hits: i64 = db
            .conn
            .query_row(
                "SELECT count(*) FROM memories_fts WHERE memories_fts MATCH '\"文压缩\"'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            old_index_hits, 0,
            "the fixture has to reproduce the old, phrase-only behaviour"
        );
        outcome.memory.id
    };

    let db = Database::open(&path).unwrap();
    let version: i64 = db
        .conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::db::SCHEMA_VERSION);
    // The same memory, now reachable by substring.
    assert_eq!(
        recall_into(&db, "文压缩", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );

    // Nothing in `memories` was rewritten, and no row was lost.
    let stored = db.get_memory(&memory_id).unwrap();
    assert_eq!(stored.title, "上下文压缩阈值");
    assert_eq!(stored.body, "keepRecentTokens 设为 20000");
    let rows: i64 = db
        .conn
        .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);
    // The re-index stored the raw text, not a per-ideograph normalisation.
    let indexed: String = db
        .conn
        .query_row("SELECT title FROM memories_fts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(indexed, "上下文压缩阈值");

    // Re-running the rebuild converges on the same index, so the step is safe to
    // repeat.
    super::rebuild_memories_fts(db.conn()).unwrap();
    assert_eq!(
        recall_into(&db, "文压缩", "/w/pi", "s1"),
        vec!["上下文压缩阈值"]
    );
}
