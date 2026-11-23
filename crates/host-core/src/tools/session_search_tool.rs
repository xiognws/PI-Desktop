//! `SessionSearch`: the model's own way back through the history it already had.
//!
//! The desktop has searched this database for a long time (`search.sessions`,
//! `crate::session_search::search`), but only the renderer could call it. The
//! model could not: asked "what did we decide about the retry budget last week",
//! it could only say it does not remember. This tool gives it the same search
//! under a tool name, with the reference agent's argument names (`query`,
//! `limit`, `offset`).
//!
//! Deliberately thin. The matching, the page cursor, the FTS prefilter and the
//! sentence excerpt are `crate::session_search`'s — a second implementation of
//! "which messages contain this text" would answer differently from the one the
//! search box shows, and a model quoting history the user cannot find is worse
//! than one that cannot quote it at all. What is added here is the part the RPC
//! did not need:
//!
//! * one flat list of hits, so a hit carries its own `sessionId` / `messageId`
//!   pair and can be cited without walking a nested shape;
//! * `matchType`, which separates a session whose *title* matched from one whose
//!   *body* did — the difference between "this conversation was about that" and
//!   "this conversation said that";
//! * refusals the RPC never had to make, because its caller was a UI with a
//!   search box: an empty `query` is an error here, not an empty page. A model
//!   that searched for nothing and read `[]` learns the wrong lesson.
//!
//! `limit` counts *sessions*, not hits, because that is what the cursor pages:
//! the desktop merges this database with the sidecar's cursorless catalog and
//! pages it thirty sessions at a time (`SEARCH_PAGE_SIZE`). One session can
//! contribute up to three hits (a metadata hit plus its two newest matching
//! messages), so a `limit` of ten can return more than ten rows.

use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Database;
use crate::session_search::{self, excerpt, SessionMatch};
use crate::tools::hashline::ToolError;

/// The name the kernel declares. The reference agent spells it `session_search`;
/// that spelling is accepted too, so a kernel that changes its mind does not need
/// a host release.
pub const TOOL_NAME: &str = "SessionSearch";

/// Sessions per page when the caller does not say. Ten is a screenful of titles;
/// a model reading twenty sessions' worth of history has usually solved the
/// problem it was searching for by the third.
pub const DEFAULT_LIMIT: i64 = 10;

/// The widest page a caller may ask for. Above this the answer stops being a
/// citation and becomes a transcript, paid for in the next request's context.
pub const MAX_LIMIT: i64 = 50;

/// The RPC's own ceiling (`search.sessions`), kept identical so the two callers
/// of the same search agree on what a query is. A 501st character is a pasted
/// file, not a search.
const MAX_QUERY_CHARS: usize = 500;

/// Characters of context around a match. The same budget the desktop preview
/// uses (`sentence_excerpt(…, 180)`), so a cited line reads the same in the
/// chat and in the search panel.
const SNIPPET_BUDGET: usize = 180;

/// Does this tool name belong to session search?
pub fn recognizes(tool_name: &str) -> bool {
    tool_name == TOOL_NAME || tool_name == "session_search"
}

/// One reason the search matched, in the shape the model reads.
///
/// A session can contribute more than one: its title may match and so may two of
/// its messages. They are separate rows on purpose — each carries the id needed
/// to cite it, and a row that mixed a title with a message body would have to
/// pretend one of the two ids does not exist.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Hit {
    session_id: String,
    title: String,
    /// `"title"` for a session-level match (title, project name or project
    /// path), `"message"` for a message body.
    match_type: &'static str,
    /// Absent for a `"title"` hit: nothing in particular was matched, the
    /// session's own metadata was.
    message_id: Option<String>,
    role: Option<String>,
    snippet: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
}

/// Page on `search` and hand the model a flat, citable list.
///
/// Synchronous on purpose: it is one bounded SQLite query, and the async wrapper
/// below puts it on the blocking pool rather than occupying a worker.
pub fn search_page(args: &Value, data_dir: &Path) -> Result<Value, ToolError> {
    let query = args.get("query").and_then(Value::as_str).unwrap_or("");
    let query = query.trim();
    if query.is_empty() {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "query is empty: pass the text to look for in past sessions",
        ));
    }
    let chars = query.chars().count();
    if chars > MAX_QUERY_CHARS {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!("query is {chars} characters; the limit is {MAX_QUERY_CHARS}"),
        ));
    }
    let limit = page_limit(args.get("limit").and_then(Value::as_i64));
    // A negative offset is the caller's mistake, but it has one harmless reading
    // — "from the start" — and no page of a cursor can be before it. Clamped
    // rather than refused, the same way `search` clamps its own.
    let offset = args
        .get("offset")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let db = Database::open_in_dir(data_dir).map_err(|error| {
        ToolError::new(
            "SESSION_SEARCH_UNAVAILABLE",
            format!("the session store could not be read: {error}"),
        )
    })?;
    let page = session_search::search(&db, query, offset, limit).map_err(|error| {
        ToolError::new(
            "SESSION_SEARCH_FAILED",
            format!("the session search failed: {error}"),
        )
    })?;
    let hits = hits_for(&page.hits, query);
    Ok(json!({
        "query": query,
        "results": hits,
        "sessionCount": page.hits.len(),
        "nextOffset": page.next_offset,
    }))
}

/// The async entry point the dispatcher calls.
pub async fn execute(args: &Value, data_dir: &Path) -> Result<Value, ToolError> {
    let args = args.clone();
    let data_dir = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || search_page(&args, &data_dir))
        .await
        .map_err(|error| ToolError::new("INTERNAL", format!("tool task failed: {error}")))?
}

/// `limit` as the caller asked for it, brought inside the documented range.
///
/// Clamped rather than refused: a model that asks for a hundred has asked for
/// "as much as you have", and the honest answer is the largest page this tool
/// serves, not an error it has to guess its way out of.
fn page_limit(raw: Option<i64>) -> i64 {
    raw.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn hits_for(matched: &[SessionMatch], query: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    for session in matched {
        if session.metadata_match {
            hits.push(Hit {
                session_id: session.session.id.clone(),
                title: session.session.title.clone(),
                match_type: "title",
                message_id: None,
                role: None,
                snippet: metadata_snippet(session, query),
                created_at: session.session.created_at.clone(),
                project_name: session.project_name.clone(),
            });
        }
        for message in &session.matches {
            hits.push(Hit {
                session_id: session.session.id.clone(),
                title: session.session.title.clone(),
                match_type: "message",
                message_id: Some(message.message_id.clone()),
                role: Some(message.role.clone()),
                snippet: message.snippet.clone(),
                created_at: message.created_at.clone(),
                project_name: session.project_name.clone(),
            });
        }
    }
    hits
}

/// Quote the metadata field that actually matched.
///
/// `metadata_match` covers the title, the project's name and the project's path.
/// Quoting the title of a session that matched by path would show the model text
/// the query is not in — and a citation it cannot place is a citation it should
/// not make.
fn metadata_snippet(session: &SessionMatch, query: &str) -> String {
    let needle = query.to_lowercase();
    for field in [
        Some(session.session.title.as_str()),
        session.session.project_path.as_deref(),
        session.project_name.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if field.to_lowercase().contains(&needle) {
            return excerpt(field, query, SNIPPET_BUDGET);
        }
    }
    session.session.title.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{self, UiMessage};

    fn message(id: &str, text: &str) -> UiMessage {
        serde_json::from_value(json!({ "id": id, "role": "user", "content": text,
            "createdAt": "2026-09-13T00:00:00Z" }))
        .unwrap()
    }

    /// Two sessions: one whose *title* holds the word, one whose *body* does.
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let titled = sessions::create_session(
            &db,
            Some("quarterly-review planning".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        sessions::append_message(&db, &titled.id, &message("t1", "unrelated words"), None).unwrap();
        let body = sessions::create_session(&db, Some("Errand list".into()), None, None, None, None)
            .unwrap();
        sessions::append_message(
            &db,
            &body.id,
            &message("b1", "We settled it: the quarterly-review budget is 40 hours."),
            None,
        )
        .unwrap();
        // Nothing to do with the query, and it must not come back.
        let other = sessions::create_session(&db, Some("Unrelated".into()), None, None, None, None)
            .unwrap();
        sessions::append_message(&db, &other.id, &message("o1", "nothing here"), None).unwrap();
        dir
    }

    fn results(value: &Value) -> Vec<Value> {
        value["results"].as_array().expect("results").clone()
    }

    #[test]
    fn both_spellings_reach_the_same_tool() {
        assert!(recognizes(TOOL_NAME));
        assert!(recognizes("session_search"));
        assert!(!recognizes("SessionSearchContext"));
        assert!(!recognizes("search.sessions"));
        assert!(!recognizes("Read"));
    }

    #[test]
    fn a_title_hit_and_a_body_hit_are_both_found_and_told_apart() {
        let dir = fixture();
        let page = search_page(&json!({"query": "quarterly-review"}), dir.path()).unwrap();
        let rows = results(&page);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(page["sessionCount"], 2);

        let title = rows
            .iter()
            .find(|row| row["matchType"] == "title")
            .expect("the title hit");
        assert_eq!(title["title"], "quarterly-review planning");
        assert_eq!(title["matchType"], "title");
        assert!(title["messageId"].is_null(), "{title}");
        assert!(title["role"].is_null(), "{title}");
        assert!(title["snippet"]
            .as_str()
            .unwrap()
            .contains("quarterly-review"));
        assert!(title["createdAt"].is_string());

        let body = rows
            .iter()
            .find(|row| row["matchType"] == "message")
            .expect("the body hit");
        assert_eq!(body["title"], "Errand list");
        assert_eq!(body["messageId"], "b1");
        assert_eq!(body["role"], "user");
        assert!(body["snippet"]
            .as_str()
            .unwrap()
            .contains("quarterly-review budget"));
        assert!(body["createdAt"].is_string());

        // Both rows name the session they came from, which is what a citation is.
        assert!(title["sessionId"].is_string() && body["sessionId"].is_string());
        assert_ne!(title["sessionId"], body["sessionId"]);
    }

    #[test]
    fn an_empty_query_is_refused_instead_of_returning_no_hits() {
        let dir = fixture();
        for args in [json!({}), json!({"query": ""}), json!({"query": "   "}), json!({"query": null})] {
            let error = search_page(&args, dir.path()).expect_err("an empty query is an error");
            assert_eq!(error.code, "INVALID_ARGUMENT", "{args}");
            assert!(error.message.contains("query is empty"), "{}", error.message);
        }
        // The RPC's ceiling, applied to the same text.
        let long = "中".repeat(MAX_QUERY_CHARS + 1);
        let error = search_page(&json!({ "query": long }), dir.path()).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("the limit is 500"), "{}", error.message);
    }

    #[test]
    fn the_limit_is_clamped_to_the_documented_range() {
        assert_eq!(page_limit(None), DEFAULT_LIMIT);
        assert_eq!(page_limit(Some(7)), 7);
        assert_eq!(page_limit(Some(0)), 1, "a zero limit is one session, not none");
        assert_eq!(page_limit(Some(-5)), 1);
        assert_eq!(page_limit(Some(999)), MAX_LIMIT);

        // Observable through the tool too: two matching sessions, a limit of
        // zero, one session returned and a cursor that says so.
        let dir = fixture();
        let page = search_page(&json!({"query": "quarterly-review", "limit": 0}), dir.path()).unwrap();
        assert_eq!(page["sessionCount"], 1);
        assert_eq!(page["nextOffset"], 1);
        let mut ids: Vec<String> = results(&page)
            .iter()
            .map(|row| row["sessionId"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn a_page_walks_the_sessions_once_each() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        for n in 0..(MAX_LIMIT + 2) {
            let session =
                sessions::create_session(&db, Some(format!("review {n}")), None, None, None, None)
                    .unwrap();
            sessions::append_message(
                &db,
                &session.id,
                &message(&format!("m{n}"), "the review is on friday"),
                None,
            )
            .unwrap();
        }
        // limit 999 is clamped to MAX_LIMIT, so the second page starts there.
        let first = search_page(&json!({"query": "review", "limit": 999}), dir.path()).unwrap();
        assert_eq!(first["sessionCount"], MAX_LIMIT);
        let next = first["nextOffset"].as_i64().expect("another page");
        let second = search_page(
            &json!({"query": "review", "limit": 999, "offset": next}),
            dir.path(),
        )
        .unwrap();
        assert_eq!(second["sessionCount"], 2, "the tail of the walk");
        assert!(second["nextOffset"].is_null(), "the last page is the last");

        let mut first_ids: Vec<String> = results(&first)
            .iter()
            .filter(|row| row["matchType"] == "title")
            .map(|row| row["sessionId"].as_str().unwrap().to_string())
            .collect();
        let second_ids: Vec<String> = results(&second)
            .iter()
            .filter(|row| row["matchType"] == "title")
            .map(|row| row["sessionId"].as_str().unwrap().to_string())
            .collect();
        first_ids.sort();
        assert!(second_ids.iter().all(|id| !first_ids.contains(id)));
    }

    #[test]
    fn a_path_match_quotes_the_path_not_the_title() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let project = dir.path().join("kernel-port");
        std::fs::create_dir_all(&project).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Unrelated title".into()),
            None,
            None,
            None,
            Some(project.to_string_lossy().to_string()),
        )
        .unwrap();
        sessions::append_message(&db, &session.id, &message("m1", "body"), None).unwrap();
        let page = search_page(&json!({"query": "kernel-port"}), dir.path()).unwrap();
        let row = results(&page).into_iter().next().expect("a hit");
        assert_eq!(row["matchType"], "title");
        // The `createdAt` of a metadata hit is the session's, and the snippet
        // names the path that matched rather than a title the query is not in.
        assert!(row["snippet"].as_str().unwrap().contains("kernel-port"));
        assert!(!row["snippet"].as_str().unwrap().contains("Unrelated"));
    }

    #[test]
    fn a_deleted_session_is_not_searchable() {
        let dir = fixture();
        let db = Database::open_in_dir(dir.path()).unwrap();
        db.conn()
            .execute(
                "UPDATE sessions SET deleted_at = 1 WHERE title = 'Errand list'",
                [],
            )
            .unwrap();
        let page = search_page(&json!({"query": "quarterly-review"}), dir.path()).unwrap();
        let rows = results(&page);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0]["matchType"], "title");
    }
}
