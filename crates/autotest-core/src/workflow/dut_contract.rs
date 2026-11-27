//! The device-under-test contract: what turns "fill in the assertions" from
//! manual work into a repeatable generation step.
//!
//! Skeleton scripts stayed skeletons because the pipeline did not know **how to
//! drive the DUT and where to read the verdict**. The contract says it once per
//! function point; `assertion_gen` can then derive real assertions from the
//! numbers in the clause instead of a person rewriting each file.
//!
//! The contract lives in the project database (`dut_contracts`, one JSON row) and
//! travels with the project data, never with the repository: different projects
//! have different devices.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

/// One function point: how it is driven, where the verdict is read.
pub const ENTRY_KEYS: [&str; 5] = ["function_point", "factory", "arrange", "observe", "expect"];

/// Shape of the expectation: boolean / number / contains / should raise.
pub const EXPECT_KINDS: [&str; 4] = ["bool", "number", "contains", "raises"];

#[derive(Debug, Clone)]
pub struct Entry {
    pub function_point: String,
    pub factory: String,
    pub arrange: Vec<String>,
    pub observe: String,
    pub expect: Value,
    pub tolerance: f64,
}

impl Entry {
    pub fn kind(&self) -> String {
        self.expect
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    pub fn value(&self) -> Value {
        self.expect.get("value").cloned().unwrap_or(Value::Null)
    }

    /// `str(value)` of the contract value, the way it lands inside generated code.
    pub fn value_text(&self) -> String {
        match self.value() {
            Value::String(text) => text,
            Value::Null => String::new(),
            other => other.to_string(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Contract {
    pub driver: String,
    pub imports: Vec<String>,
    pub entries: Vec<(String, Entry)>,
}

impl Contract {
    pub fn get(&self, function_point: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|(key, _)| key == function_point)
            .map(|(_, entry)| entry)
    }

    /// Find a contract entry for a function point, tolerating "short name versus
    /// full sentence".
    ///
    /// A requirement's function point is often a whole sentence ("登录失败锁定：
    /// 连续 5 次密码错误后锁定 300 秒") while a person writes only the short name
    /// in the contract. Strict equality would leave such a project permanently
    /// "missing a contract", so this tries: exact → the part before a
    /// colon/comma/parenthesis → a unique prefix match.
    pub fn resolve(&self, function_point: &str) -> Option<&Entry> {
        if let Some(entry) = self.get(function_point) {
            return Some(entry);
        }
        let mut head = function_point;
        for separator in ["：", ":", "，", ",", "（", "(", " - ", "—"] {
            if let Some((before, _)) = head.split_once(separator) {
                head = before;
            }
        }
        let head = head.trim();
        if !head.is_empty() {
            if let Some(entry) = self.get(head) {
                return Some(entry);
            }
            let prefixed: Vec<&Entry> = self
                .entries
                .iter()
                .filter(|(key, _)| function_point.starts_with(key.as_str()))
                .map(|(_, entry)| entry)
                .collect();
            if prefixed.len() == 1 {
                return Some(prefixed[0]);
            }
        }
        None
    }

    /// Which of these function points already resolve to a contract (the
    /// scaffold uses this to compute "already wired up").
    pub fn covered_names(&self, function_points: &[String]) -> Vec<String> {
        function_points
            .iter()
            .filter(|name| self.resolve(name).is_some())
            .cloned()
            .collect()
    }
}

pub fn ensure_contract_table(conn: &Connection) -> ApiResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dut_contracts (\n            project_id TEXT PRIMARY KEY,\
         \n            payload TEXT NOT NULL,\n            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n        )",
        [],
    )?;
    Ok(())
}

fn contract_error(message: impl Into<String>) -> ApiError {
    // A bad contract is a client error: refuse it rather than generate fake
    // assertions from it.
    ApiError::bad_request(message)
}

fn validate_entry(raw: &Value, index: usize) -> Result<Entry, ApiError> {
    let Some(object) = raw.as_object() else {
        return Err(contract_error(format!("entries[{index}] 必须是对象")));
    };
    let missing: Vec<&str> = ENTRY_KEYS
        .iter()
        .filter(|key| !is_truthy(object.get(**key)))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(contract_error(format!(
            "entries[{index}] 缺少字段：{}",
            missing.join(", ")
        )));
    }
    let arrange_value = object.get("arrange").cloned().unwrap_or(Value::Null);
    let Some(arrange_list) = arrange_value.as_array() else {
        return Err(contract_error(format!(
            "entries[{index}].arrange 必须是字符串列表（每行一条驱动调用）"
        )));
    };
    if arrange_list.iter().any(|line| !line.is_string()) {
        return Err(contract_error(format!(
            "entries[{index}].arrange 必须是字符串列表（每行一条驱动调用）"
        )));
    }
    let expect = object.get("expect").cloned().unwrap_or(Value::Null);
    let kind_ok = expect
        .get("kind")
        .and_then(Value::as_str)
        .map(|kind| EXPECT_KINDS.contains(&kind))
        .unwrap_or(false);
    if !ok_object(&expect) || !kind_ok {
        return Err(contract_error(format!(
            "entries[{index}].expect.kind 只能取 {}",
            EXPECT_KINDS.join("/")
        )));
    }
    let tolerance_value = object.get("tolerance").cloned().unwrap_or(Value::Null);
    let tolerance = if is_truthy(Some(&tolerance_value)) {
        match tolerance_value.as_f64() {
            Some(number) if number >= 0.0 => number,
            _ => {
                return Err(contract_error(format!(
                    "entries[{index}].tolerance 必须是非负数"
                )))
            }
        }
    } else {
        0.0
    };

    Ok(Entry {
        function_point: text_field(object.get("function_point")),
        factory: text_field(object.get("factory")),
        arrange: arrange_list
            .iter()
            .map(|line| line.as_str().unwrap_or("").to_string())
            .collect(),
        observe: text_field(object.get("observe")),
        expect,
        tolerance,
    })
}

fn ok_object(value: &Value) -> bool {
    value.is_object()
}

/// Python truthiness for the fields `_validate_entry` checks with `not raw.get(key)`.
fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|item| item != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(list)) => !list.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

fn text_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Validate and parse a contract; the message has to tell a person which entry is
/// wrong.
pub fn parse(payload: Option<&Value>) -> Result<Contract, ApiError> {
    let Some(payload) = payload else {
        return Ok(Contract::default());
    };
    if !payload.is_object() {
        return Err(contract_error("契约必须是对象"));
    }
    let raw_entries = payload.get("entries").cloned().unwrap_or(Value::Null);
    let raw_entries = if is_truthy(Some(&raw_entries)) {
        raw_entries
    } else {
        json!([])
    };
    let Some(list) = raw_entries.as_array() else {
        return Err(contract_error("entries 必须是列表"));
    };
    let mut entries: Vec<(String, Entry)> = Vec::new();
    for (index, raw) in list.iter().enumerate() {
        let entry = validate_entry(raw, index)?;
        if entries.iter().any(|(key, _)| key == &entry.function_point) {
            return Err(contract_error(format!(
                "功能点「{}」在契约里重复",
                entry.function_point
            )));
        }
        entries.push((entry.function_point.clone(), entry));
    }
    let imports = payload.get("imports").cloned().unwrap_or(Value::Null);
    let imports = if is_truthy(Some(&imports)) {
        let Some(list) = imports.as_array() else {
            return Err(contract_error("imports 必须是列表"));
        };
        list.iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Contract {
        driver: payload
            .get("driver")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        imports,
        entries,
    })
}

pub fn load(conn: &Connection, project_id: &str) -> ApiResult<Contract> {
    ensure_contract_table(conn)?;
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload FROM dut_contracts WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(text) = payload else {
        return Ok(Contract::default());
    };
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| contract_error(format!("项目里存的契约不是合法 JSON：{error}")))?;
    parse(Some(&parsed))
}

pub fn save(conn: &Connection, project_id: &str, payload: &Value) -> ApiResult<Contract> {
    let contract = parse(Some(payload))?; // validate first: a bad contract never lands
    ensure_contract_table(conn)?;
    conn.execute(
        "INSERT INTO dut_contracts (project_id, payload, updated_at) \
         VALUES (?1, ?2, CURRENT_TIMESTAMP) \
         ON CONFLICT(project_id) DO UPDATE SET payload = excluded.payload, \
         updated_at = CURRENT_TIMESTAMP",
        rusqlite::params![project_id, payload.to_string()],
    )?;
    Ok(contract)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_accepts_a_short_name() {
        let payload = json!({
            "driver": "_support/dut.py",
            "imports": ["Dut"],
            "entries": [{
                "function_point": "登录失败锁定",
                "factory": "Dut()",
                "arrange": ["dut.login('a')"],
                "observe": "dut.locked",
                "expect": {"kind": "bool", "value": true},
            }],
        });
        let contract = parse(Some(&payload)).expect("contract");
        assert!(contract.resolve("登录失败锁定：连续 5 次密码错误后锁定 300 秒").is_some());
        assert!(contract.resolve("过压保护").is_none());
    }

    #[test]
    fn duplicate_function_points_are_rejected() {
        let entry = json!({
            "function_point": "过压保护",
            "factory": "Dut()",
            "arrange": ["dut.setup()"],
            "observe": "dut.over_voltage",
            "expect": {"kind": "bool", "value": true},
        });
        let payload = json!({ "entries": [entry.clone(), entry] });
        let error = parse(Some(&payload)).expect_err("duplicate");
        assert!(error.detail.contains("重复"));
    }
}
