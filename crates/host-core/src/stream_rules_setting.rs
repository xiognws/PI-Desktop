//! Validation for the `streamRules` setting.
//!
//! Stream rules are a settings value that later becomes a regular expression
//! matched against model output, so this is the trust boundary: a rule that is
//! accepted here is compiled and run on every assistant token of every turn.
//! The renderer is the source, so nothing about the shape is assumed.
//!
//! The README-facing contract is deliberately narrow — `{ id, name, pattern,
//! message, flags?, maxPerTurn?, enabled? }` — and every rejection names the
//! offending rule, because a rule silently dropped at save time looks configured
//! and never fires.

use serde_json::Value;

const MAX_PATTERN_CHARS: usize = 400;
const MAX_MESSAGE_CHARS: usize = 2000;
const ALLOWED_FLAGS: [char; 5] = ['i', 'm', 's', 'u', 'g'];

/// Reject anything that cannot be a rule list. `Ok(())` means the value may be stored.
pub fn validate_stream_rules_setting(value: &Value) -> Result<(), String> {
    let Value::Array(rules) = value else {
        return Err("streamRules must be an array".to_string());
    };
    let mut seen: Vec<&str> = Vec::new();
    for (index, rule) in rules.iter().enumerate() {
        let Value::Object(object) = rule else {
            return Err(format!("streamRules[{}] is not an object", index));
        };
        let id = string_field(object.get("id"));
        let label = if id.is_empty() {
            format!("streamRules[{}]", index)
        } else {
            format!("streamRules[{index}] ({id})")
        };
        if id.is_empty() {
            return Err(format!("{label}: id is required"));
        }
        if seen.contains(&id) {
            return Err(format!("{label}: duplicate id"));
        }
        if string_field(object.get("name")).is_empty() {
            return Err(format!("{label}: name is required"));
        }
        let pattern = string_field(object.get("pattern"));
        if pattern.trim().is_empty() {
            return Err(format!("{label}: pattern is required"));
        }
        if pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(format!(
                "{label}: pattern exceeds {MAX_PATTERN_CHARS} characters"
            ));
        }
        let message = string_field(object.get("message"));
        if message.trim().is_empty() {
            return Err(format!("{label}: message is required"));
        }
        if message.chars().count() > MAX_MESSAGE_CHARS {
            return Err(format!(
                "{label}: message exceeds {MAX_MESSAGE_CHARS} characters"
            ));
        }
        if let Some(flags) = object.get("flags") {
            let Value::String(flags) = flags else {
                return Err(format!("{label}: flags must be a string"));
            };
            if let Some(bad) = flags.chars().find(|flag| !ALLOWED_FLAGS.contains(flag)) {
                return Err(format!("{label}: unsupported regex flag {bad:?}"));
            }
        }
        if let Some(limit) = object.get("maxPerTurn") {
            match limit.as_i64() {
                Some(value) if value >= 1 => {}
                _ => return Err(format!("{label}: maxPerTurn must be a positive integer")),
            }
        }
        if let Some(enabled) = object.get("enabled") {
            if !enabled.is_boolean() {
                return Err(format!("{label}: enabled must be a boolean"));
            }
        }
        seen.push(id);
    }
    Ok(())
}

/// Rule ids in stored order, for callers that only need to know what is configured.
pub fn stream_rule_ids(value: &Value) -> Vec<String> {
    let Some(rules) = value.as_array() else {
        return Vec::new();
    };
    rules
        .iter()
        .filter_map(|rule| rule.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn string_field(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::validate_stream_rules_setting;
    use serde_json::{json, Value};

    fn rule(id: &str) -> Value {
        json!({
            "id": id,
            "name": id,
            "pattern": "Box::leak",
            "message": "Don't reach for Box::leak in production code paths."
        })
    }

    #[test]
    fn accepts_an_empty_list_and_a_complete_rule() {
        assert!(validate_stream_rules_setting(&json!([])).is_ok());
        assert!(validate_stream_rules_setting(&json!([rule("box-leak")])).is_ok());
    }

    #[test]
    fn rejects_a_non_array() {
        let error = validate_stream_rules_setting(&json!({ "id": "x" })).unwrap_err();
        assert_eq!(error, "streamRules must be an array");
    }

    #[test]
    fn names_the_rule_that_is_wrong() {
        let mut broken = rule("box-leak");
        broken["message"] = json!("   ");
        let error = validate_stream_rules_setting(&json!([broken])).unwrap_err();
        assert!(error.contains("box-leak"), "{error}");
        assert!(error.contains("message is required"), "{error}");
    }

    #[test]
    fn rejects_duplicate_ids() {
        let error = validate_stream_rules_setting(&json!([rule("dup"), rule("dup")])).unwrap_err();
        assert!(error.contains("duplicate id"), "{error}");
    }

    #[test]
    fn rejects_a_flag_that_would_change_matching_semantics() {
        let mut broken = rule("flags");
        broken["flags"] = json!("y");
        let error = validate_stream_rules_setting(&json!([broken])).unwrap_err();
        assert!(error.contains("unsupported regex flag"), "{error}");
    }

    #[test]
    fn rejects_a_zero_activation_budget() {
        let mut broken = rule("limit");
        broken["maxPerTurn"] = json!(0);
        let error = validate_stream_rules_setting(&json!([broken])).unwrap_err();
        assert!(error.contains("maxPerTurn"), "{error}");
    }

    #[test]
    fn an_over_long_pattern_is_rejected_rather_than_truncated() {
        let mut broken = rule("long");
        broken["pattern"] = json!("x".repeat(401));
        let error = validate_stream_rules_setting(&json!([broken])).unwrap_err();
        assert!(error.contains("pattern exceeds"), "{error}");
    }
}
