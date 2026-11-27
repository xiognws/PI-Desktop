//! Case review (deterministic).
//!
//! Only answers "can this be tested at all" and "is it a duplicate" — whether a
//! case is *well written* is the agent's call.

use serde_json::{json, Value};

use super::consistency::{scalar_text, PLACEHOLDERS};

pub const MIN_STEPS: usize = 2;

/// Expectations built only from these phrases have no judgeable object: the
/// person executing the case would not know what to look at.
fn filler_phrases() -> [&'static str; 5] {
    [
        PLACEHOLDERS[0],
        PLACEHOLDERS[1],
        PLACEHOLDERS[2],
        "按需求描述完成",
        "按需求执行",
    ]
}

fn expected_judgeable(expected: &[Value]) -> bool {
    let fillers = filler_phrases();
    expected.iter().any(|item| {
        let text = scalar_text(item);
        if text.trim().is_empty() {
            return false;
        }
        !fillers.iter().any(|phrase| text.contains(phrase))
    })
}

fn non_empty(items: Option<&Value>) -> Vec<String> {
    items
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(scalar_text)
                .filter(|text| !text.trim().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

pub fn review_cases(cases: &[Value], module: &str) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut duplicates: Vec<Value> = Vec::new();
    let mut untestable: Vec<Value> = Vec::new();
    let mut seen: Vec<(String, usize)> = Vec::new();

    for (index, case) in cases.iter().enumerate() {
        let title = case
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            untestable.push(json!({ "index": index, "reason": "缺少标题" }));
            continue;
        }
        let key = title.to_lowercase();
        if let Some((_, first)) = seen.iter().find(|entry| entry.0 == key) {
            duplicates.push(json!({
                "index": index,
                "title": title,
                "duplicate_of": first,
            }));
        } else {
            seen.push((key, index));
        }

        // A case without evidence is not testable: it tests a template sentence,
        // not a requirement.
        if case.get("grounding").and_then(Value::as_str).unwrap_or("") == "none" {
            untestable.push(json!({
                "index": index,
                "title": title,
                "reason": "无依据（占位用例，资料缺失）",
            }));
            continue;
        }

        let steps = non_empty(case.get("steps"));
        let expected = non_empty(case.get("expected"));
        if steps.is_empty() {
            untestable.push(json!({ "index": index, "title": title, "reason": "缺少步骤" }));
        } else if steps.len() < MIN_STEPS {
            issues.push(json!({
                "index": index,
                "title": title,
                "reason": format!("步骤少于 {MIN_STEPS} 条"),
            }));
        }
        if expected.is_empty() {
            untestable.push(json!({ "index": index, "title": title, "reason": "缺少预期结果" }));
        } else {
            let values = case
                .get("expected")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if !expected_judgeable(&values) {
                untestable.push(json!({
                    "index": index,
                    "title": title,
                    "reason": "预期不可判定（只有空话）",
                }));
            }
        }
        if case
            .get("priority")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            issues.push(json!({ "index": index, "title": title, "reason": "缺少优先级" }));
        }
    }

    let verdict = if untestable.is_empty() && duplicates.is_empty() {
        "ok"
    } else {
        "needs_fix"
    };
    json!({
        "verdict": verdict,
        "issues": issues,
        "duplicates": duplicates,
        "untestable": untestable,
        "stats": { "total": cases.len(), "module": module },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filler_only_expectation_is_untestable() {
        let cases = vec![json!({
            "title": "过压保护-主流程",
            "grounding": "weak",
            "priority": "中",
            "steps": ["a", "b"],
            "expected": ["结果与预期一致"],
        })];
        let review = review_cases(&cases, "BMS");
        assert_eq!(review["verdict"], "needs_fix");
        assert_eq!(review["untestable"][0]["reason"], "预期不可判定（只有空话）");
    }
}
