//! Writing designed cases into the project's `test_cases` table.
//!
//! The case page, the execution status write-back and the script association all
//! read that table: leaving the design only inside a `workflow_steps` payload
//! means the UI stays at "0 cases".
//!
//! Idempotency is on (module_id, title): re-designing the same title updates the
//! row instead of inserting a second one, so running case-design repeatedly does
//! not double the case library.

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::error::ApiResult;

fn column_names(conn: &Connection, table: &str) -> ApiResult<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = Vec::new();
    for row in rows {
        names.push(row?);
    }
    Ok(names)
}

/// Flatten a designed case's steps into the single text column the table keeps.
pub fn steps_text(case: &Value) -> String {
    let steps = case
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let expected = case
        .get("expected")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let mut line = format!("{}. {}", index + 1, scalar(step));
        if index < expected.len() {
            line.push_str(&format!(" → 预期：{}", scalar(&expected[index])));
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn text_field(case: &Value, key: &str) -> String {
    case.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// The evidence a case is stored with: JSON (doc/quote/numbers + grounding level).
///
/// Text rather than columns: different sources carry different fields (clause,
/// knowledge chunk, manual note), and splitting them into columns would block the
/// next source from being added.
pub fn evidence_text(case: &Value) -> String {
    let grounding = {
        let value = text_field(case, "grounding");
        if value.is_empty() {
            "none".to_string()
        } else {
            value
        }
    };
    let reason = text_field(case, "basis_reason");
    let evidence = case.get("evidence").cloned().unwrap_or(Value::Null);
    let mut payload = Map::new();
    payload.insert("grounding".to_string(), json!(grounding));
    payload.insert("reason".to_string(), json!(reason));
    payload.insert("evidence".to_string(), evidence.clone());
    // The failure mode travels with the evidence so the case list can group by
    // it without re-deriving the class from the title.
    if let Some(class_id) = case.get("exception_class").and_then(Value::as_str) {
        if !class_id.is_empty() {
            payload.insert("exception_class".to_string(), json!(class_id));
        }
    }
    let truthy = match &evidence {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Array(list) => !list.is_empty(),
        Value::Object(map) => !map.is_empty(),
        Value::Number(_) => true,
    };
    if !truthy {
        return json!({
            "grounding": payload.get("grounding").cloned().unwrap_or(Value::Null),
            "reason": payload.get("reason").cloned().unwrap_or(Value::Null),
            "evidence": Value::Null,
        })
        .to_string();
    }
    Value::Object(payload).to_string()
}

/// Title → case id, in insertion order.
pub fn persist_designed_cases(
    conn: &Connection,
    module: &str,
    cases: &[Value],
) -> ApiResult<Vec<(String, String)>> {
    // Very old databases have no `evidence` column: add it on demand instead of
    // rebuilding the table and losing user data.
    let columns = column_names(conn, "test_cases")?;
    if !columns.iter().any(|name| name == "evidence") {
        conn.execute(
            "ALTER TABLE test_cases ADD COLUMN evidence TEXT DEFAULT ''",
            [],
        )?;
    }

    let mut ids: Vec<(String, String)> = Vec::new();
    for case in cases {
        let title = text_field(case, "title").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM test_cases WHERE title = ?1 AND COALESCE(module_id, '') = ?2",
                rusqlite::params![title, module],
                |row| row.get(0),
            )
            .ok();
        let steps = steps_text(case);
        let expected: Vec<String> = case
            .get("expected")
            .and_then(Value::as_array)
            .map(|list| list.iter().map(scalar).collect())
            .unwrap_or_default();
        let expected_text = expected.join("\n");
        let case_type = defaulted(case, "case_type", "正向");
        let priority = defaulted(case, "priority", "中");
        let precondition = text_field(case, "precondition");
        let evidence = evidence_text(case);

        let case_id = match existing {
            Some(case_id) => {
                conn.execute(
                    "UPDATE test_cases SET precondition = ?1, steps = ?2, expected = ?3, \
                     case_type = ?4, priority = ?5, module_id = ?6, evidence = ?7, \
                     updated_at = CURRENT_TIMESTAMP WHERE id = ?8",
                    rusqlite::params![
                        precondition,
                        steps,
                        expected_text,
                        case_type,
                        priority,
                        module,
                        evidence,
                        case_id
                    ],
                )?;
                case_id
            }
            None => {
                let case_id = format!(
                    "case_{}",
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                // Tags hold the function point so the list page can group by it;
                // quotes are stripped because the column doubles as a JSON array.
                let function_point = text_field(case, "function_point").replace('"', "");
                let tags = if function_point.is_empty() {
                    json!([])
                } else {
                    json!([function_point])
                };
                conn.execute(
                    "INSERT INTO test_cases (id, module_id, title, precondition, steps, expected, \
                     case_type, priority, status, tags, favorite, evidence) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '未执行', ?9, 0, ?10)",
                    rusqlite::params![
                        case_id,
                        module,
                        title,
                        precondition,
                        steps,
                        expected_text,
                        case_type,
                        priority,
                        tags.to_string(),
                        evidence
                    ],
                )?;
                case_id
            }
        };
        ids.push((title, case_id));
    }
    Ok(ids)
}

fn defaulted(case: &Value, key: &str, fallback: &str) -> String {
    let value = text_field(case, key);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// Delete old cases that only existed because they had no evidence.
///
/// Only rows whose stored evidence says `grounding=none` are touched: grounded
/// cases and hand-written cases stay.
pub fn drop_stale_ungrounded(conn: &Connection, module: &str, keep_titles: &[String]) -> ApiResult<usize> {
    let mut removed = 0;
    let mut statement = conn.prepare(
        "SELECT id, title, evidence FROM test_cases WHERE COALESCE(module_id, '') = ?1",
    )?;
    let rows = statement.query_map([module], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut doomed: Vec<String> = Vec::new();
    for row in rows {
        let (id, title, evidence) = row?;
        let title = title.unwrap_or_default();
        if keep_titles.contains(&title) {
            continue;
        }
        let Some(raw) = evidence else { continue };
        if raw.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if parsed.get("grounding").and_then(Value::as_str) == Some("none") {
            doomed.push(id);
        }
    }
    for id in doomed {
        conn.execute("DELETE FROM test_cases WHERE id = ?1", [&id])?;
        removed += 1;
    }
    Ok(removed)
}

/// Remove the old generic "-异常输入" case once its function point has cases split
/// by failure mode.
///
/// Without this the library holds both "X-异常输入" and "X-异常-越界值": the count
/// goes up while half of it is duplicated. Only this module is touched, and only
/// for function points that got failure-mode cases this round.
pub fn drop_superseded_generic_exception(
    conn: &Connection,
    module: &str,
    titles: &[String],
) -> ApiResult<usize> {
    let mut covered: Vec<String> = Vec::new();
    for title in titles {
        if let Some((head, _)) = title.rsplit_once("-异常-") {
            if !covered.iter().any(|item| item == head) {
                covered.push(head.to_string());
            }
        }
    }
    if covered.is_empty() {
        return Ok(0);
    }
    let mut removed = 0;
    let mut statement =
        conn.prepare("SELECT id, title FROM test_cases WHERE COALESCE(module_id, '') = ?1")?;
    let rows = statement.query_map([module], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    let mut doomed: Vec<String> = Vec::new();
    for row in rows {
        let (id, title) = row?;
        let title = title.unwrap_or_default();
        let Some(head) = title.strip_suffix("-异常输入") else {
            continue;
        };
        if covered.iter().any(|item| item == head) {
            doomed.push(id);
        }
    }
    for id in doomed {
        conn.execute("DELETE FROM test_cases WHERE id = ?1", [&id])?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_text_joins_steps_with_expectations() {
        let case = json!({
            "steps": ["a", "b"],
            "expected": ["x"],
        });
        assert_eq!(steps_text(&case), "1. a → 预期：x\n2. b");
    }

    #[test]
    fn evidence_without_payload_keeps_the_null_shape() {
        let case = json!({ "grounding": "none", "basis_reason": "no_hit", "evidence": null });
        let parsed: Value = serde_json::from_str(&evidence_text(&case)).expect("json");
        assert_eq!(parsed["grounding"], "none");
        assert_eq!(parsed["reason"], "no_hit");
        assert!(parsed["evidence"].is_null());
        assert!(parsed.get("exception_class").is_none());
    }
}
