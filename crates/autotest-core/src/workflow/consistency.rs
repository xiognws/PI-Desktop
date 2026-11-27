//! Case/script/report consistency: the hard rules of `prompts/*.md` turned into
//! executable checks.
//!
//! Generation is deterministic, but cases also come from the agent (and later
//! from a model) — a prompt file constrains nothing by itself. This module makes
//! "not acceptable" concrete, so the review stage and the UI can stop it.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use super::pyrepr;

pub const CASE_TYPES: [&str; 5] = ["功能", "异常", "边界", "接口", "兼容"];
pub const PRIORITIES: [&str; 3] = ["高", "中", "低"];
pub const GROUNDINGS: [&str; 3] = ["strong", "weak", "none"];

pub const MIN_STEPS: usize = 3;
pub const MIN_EXPECTED: usize = 1;

/// Empty phrases only tolerated while `grounding=none` (placeholder mode).
pub const PLACEHOLDERS: [&str; 3] = ["执行正常操作", "结果与预期一致", "过程中无报错、无脏数据"];

/// At least one of these must appear in the expectation to make it observable:
/// a number, a rejection/protection action, a state bit or a diagnostic code.
pub const JUDGEABLE_MARKERS: [&str; 18] = [
    "拒绝", "拦截", "保护", "降级", "停机", "闭锁", "熔断", "DTC", "错误码", "故障码", "状态字",
    "状态位", "标志位", "恢复", "复位", "重试", "一致", "不变",
];

fn suffix_for(case_type: &str) -> Option<&'static str> {
    match case_type {
        "功能" => Some("主流程"),
        "异常" => Some("异常输入"),
        "边界" => Some("边界值"),
        "接口" => Some("接口契约"),
        "兼容" => Some("兼容性"),
        _ => None,
    }
}

fn digit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d").expect("static pattern"))
}

fn judgeable(text: &str) -> bool {
    if digit_re().is_match(text) {
        return true;
    }
    JUDGEABLE_MARKERS.iter().any(|marker| text.contains(marker))
}

/// Lists join with a single space; anything else is `str(value or "")`.
fn text_of(items: Option<&Value>) -> String {
    match items {
        Some(Value::Array(list)) => list
            .iter()
            .map(scalar_text)
            .collect::<Vec<_>>()
            .join(" "),
        Some(other) => scalar_text(other),
        None => String::new(),
    }
}

pub fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn list_len(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(list)) => list.len(),
        Some(Value::Null) | None => 0,
        _ => 0,
    }
}

fn by_field(issues: &[Value]) -> Value {
    let mut counts: Vec<(String, i64)> = Vec::new();
    for issue in issues {
        let field = issue.get("field").and_then(Value::as_str).unwrap_or("");
        if let Some(entry) = counts.iter_mut().find(|entry| entry.0 == field) {
            entry.1 += 1;
        } else {
            counts.push((field.to_string(), 1));
        }
    }
    let mut map = Map::new();
    for (key, value) in counts {
        map.insert(key, json!(value));
    }
    Value::Object(map)
}

fn issue_list(issues: &[Value]) -> Value {
    Value::Array(issues.iter().take(20).cloned().collect())
}

/// Problems in one case (empty list = acceptable).
pub fn check_case(case: &Value) -> Vec<Value> {
    let mut issues: Vec<Value> = Vec::new();
    let title = str_field(case, "title").trim().to_string();
    let grounding = {
        let value = str_field(case, "grounding");
        if value.is_empty() {
            "none".to_string()
        } else {
            value.to_string()
        }
    };
    let case_type = str_field(case, "case_type").to_string();

    let mut add = |field: &str, problem: String| {
        issues.push(json!({ "title": title, "field": field, "problem": problem }));
    };

    if title.is_empty() {
        add("title", "标题为空".to_string());
    }
    if !CASE_TYPES.contains(&case_type.as_str()) {
        add(
            "case_type",
            format!("类型 {} 不在固定枚举里", pyrepr::repr_str(&case_type)),
        );
    } else if case_type == "异常" {
        // Exception cases are split by failure mode (`-异常-越界值` / `-异常-通信超时`);
        // older databases still hold the generic `-异常输入`, and both are accepted.
        if !title.contains("-异常") {
            add(
                "title",
                "异常用例标题应包含「-异常」与失效模式（如 -异常-越界值）".to_string(),
            );
        }
    } else if let Some(suffix) = suffix_for(&case_type) {
        if !title.ends_with(suffix) {
            add("title", format!("标题后缀应为 {suffix}"));
        }
    }
    let priority = str_field(case, "priority");
    if !PRIORITIES.contains(&priority) {
        add("priority", "优先级只能取 高/中/低".to_string());
    }
    if !GROUNDINGS.contains(&grounding.as_str()) {
        add(
            "grounding",
            format!("grounding {} 不合法", pyrepr::repr_str(&grounding)),
        );
    }
    if str_field(case, "precondition").trim().is_empty() {
        add("precondition", "前置条件为空".to_string());
    }

    let steps = case.get("steps").cloned().unwrap_or_else(|| json!([]));
    let expected = case.get("expected").cloned().unwrap_or_else(|| json!([]));
    let step_count = list_len(Some(&steps));
    let expected_count = list_len(Some(&expected));
    if step_count < MIN_STEPS {
        add("steps", format!("步骤不足 {MIN_STEPS} 条（当前 {step_count}）"));
    }
    if expected_count < MIN_EXPECTED {
        add("expected", "预期为空".to_string());
    }
    let has_empty_step = steps
        .as_array()
        .map(|list| list.iter().any(|step| scalar_text(step).trim().is_empty()))
        .unwrap_or(false);
    if has_empty_step {
        add("steps", "存在空步骤".to_string());
    }

    let steps_text = text_of(Some(&steps));
    let expected_text = text_of(Some(&expected));

    if grounding != "none" {
        for phrase in PLACEHOLDERS {
            if steps_text.contains(phrase) || expected_text.contains(phrase) {
                add("wording", format!("有依据的用例里出现了空话「{phrase}」"));
            }
        }
    }

    if grounding == "strong" {
        let numbers = case
            .get("evidence")
            .and_then(|evidence| evidence.get("numbers"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if numbers.is_empty() {
            add("evidence", "grounding=strong 但没有原文数值".to_string());
        } else if !numbers.iter().any(|number| {
            let text = scalar_text(number);
            steps_text.contains(&text) || expected_text.contains(&text)
        }) {
            add(
                "steps",
                "grounding=strong 时步骤/预期必须出现原文数值".to_string(),
            );
        }
    }

    issues
}

pub fn check_cases(cases: &[Value]) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    for case in cases {
        issues.extend(check_case(case));
    }
    json!({
        "ok": issues.is_empty(),
        "checked": cases.len(),
        "issues": issue_list(&issues),
        "by_field": by_field(&issues),
    })
}

/// The review verdict checked against `prompts/case-review.md`.
///
/// Review is the last gate before scripts exist: an empty conclusion, an index
/// that points nowhere, or an ungrounded case declared testable would all let an
/// untestable case reach execution.
pub fn check_review(review: &Value, cases: &[Value]) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut add = |field: &str, problem: String| {
        issues.push(json!({ "field": field, "problem": problem }));
    };

    let verdict = str_field(review, "verdict").to_string();
    let untestable: Vec<Value> = review
        .get("untestable")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let duplicates: Vec<Value> = review
        .get("duplicates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !["ok", "needs_fix"].contains(&verdict.as_str()) {
        add(
            "verdict",
            format!(
                "verdict {} 只能取 ok / needs_fix",
                pyrepr::repr_str(&verdict)
            ),
        );
    }
    if verdict == "needs_fix" && untestable.is_empty() && duplicates.is_empty() {
        add("verdict", "needs_fix 却没有任何明细，等于空结论".to_string());
    }
    if verdict == "ok" && (!untestable.is_empty() || !duplicates.is_empty()) {
        add("verdict", "有不可测/重复明细却给了 ok".to_string());
    }

    for item in untestable.iter().chain(duplicates.iter()) {
        let index = item.get("index").cloned().unwrap_or(Value::Null);
        let valid = match &index {
            Value::Number(number) => number
                .as_i64()
                .map(|value| value >= 0 && (value as usize) < cases.len())
                .unwrap_or(false),
            _ => false,
        };
        if !valid {
            add(
                "index",
                format!(
                    "明细里的 index {} 定位不到输入用例",
                    pyrepr::repr_value(&index)
                ),
            );
        }
    }

    let ungrounded: Vec<usize> = cases
        .iter()
        .enumerate()
        .filter(|(_, case)| str_field(case, "grounding") == "none")
        .map(|(index, _)| index)
        .collect();
    let reported: Vec<i64> = untestable
        .iter()
        .filter_map(|item| item.get("index").and_then(Value::as_i64))
        .collect();
    for index in ungrounded {
        if !reported.contains(&(index as i64)) {
            let case = cases.get(index).cloned().unwrap_or_else(|| json!({}));
            let title = str_field(&case, "title");
            let title = if title.is_empty() {
                index.to_string()
            } else {
                title.to_string()
            };
            add(
                "grounding",
                format!("无依据用例「{title}」没有被判为不可测"),
            );
        }
    }

    // Exception cases must land on a concrete failure mode; a generic
    // "异常输入" would flow into a script and become an assertion that never
    // fails.
    let mut coverage: Vec<(String, i64)> = Vec::new();
    for case in cases {
        if str_field(case, "case_type") != "异常" {
            continue;
        }
        let class_id = str_field(case, "exception_class").to_string();
        let title = str_field(case, "title").to_string();
        if class_id.is_empty() && !title.contains("-异常-") {
            add(
                "exception_class",
                format!("异常用例「{title}」没有失效模式，仍是泛化模板"),
            );
            continue;
        }
        if !class_id.is_empty() {
            if let Some(entry) = coverage.iter_mut().find(|entry| entry.0 == class_id) {
                entry.1 += 1;
            } else {
                coverage.push((class_id, 1));
            }
        }
        if !judgeable(&text_of(case.get("expected"))) {
            add(
                "expected",
                format!("异常用例「{title}」的预期没有可判定结果（需数值/拒绝或保护动作/状态位/DTC）"),
            );
        }
    }

    let mut coverage_map = Map::new();
    for (key, value) in coverage {
        coverage_map.insert(key, json!(value));
    }
    json!({
        "ok": issues.is_empty(),
        "checked": cases.len(),
        "issues": issue_list(&issues),
        "by_field": by_field(&issues),
        "exception_coverage": Value::Object(coverage_map),
    })
}

pub const REPORT_COLUMNS: [&str; 8] = [
    "总数", "通过", "跳过", "失败", "异常", "取消", "通过率", "总耗时",
];

fn report_row_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|")
            .expect("static pattern")
    })
}

fn count_of(counts: &Value, key: &str) -> i64 {
    match counts.get(key) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// `prompts/report.md` checked against the generated markdown.
///
/// The report is the only external deliverable, and "numbers disagree with the
/// details and nobody notices" is its characteristic failure. Three things are
/// verified: fixed header order, table numbers equal to `counts`, and honest
/// wording around skips and pass rate.
pub fn check_report(markdown: &str, counts: &Value, pass_rate: &str, exception_expected: bool) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    let mut add = |field: &str, problem: String| {
        issues.push(json!({ "field": field, "problem": problem }));
    };

    let text = markdown;
    let total = count_of(counts, "total");
    let passed = count_of(counts, "passed");
    let skipped = count_of(counts, "skipped");
    let failed = count_of(counts, "failed");
    let errored = count_of(counts, "errored");
    let cancelled = count_of(counts, "cancelled");
    let asserted = (total - skipped).max(0);

    let header = format!("| {} |", REPORT_COLUMNS.join(" | "));
    if !text.contains(&header) {
        add("table", "结果汇总表头列顺序不符合报告规则".to_string());
    }
    if exception_expected && !text.contains("## 异常覆盖") {
        add(
            "exception",
            "报告缺少「异常覆盖」小节（类别 × 功能点）".to_string(),
        );
    }

    match report_row_re().captures(text) {
        None => add("table", "找不到结果汇总数据行".to_string()),
        Some(captures) => {
            let numbers: Vec<i64> = (1..=6)
                .map(|index| {
                    captures
                        .get(index)
                        .and_then(|item| item.as_str().parse::<i64>().ok())
                        .unwrap_or(0)
                })
                .collect();
            let expected = vec![total, passed, skipped, failed, errored, cancelled];
            if numbers != expected {
                add(
                    "table",
                    format!("表内数字 {numbers:?} 与执行统计 {expected:?} 不一致"),
                );
            }
        }
    }

    if skipped > 0 && !text.contains("未计通过") {
        add("skip", "有跳过用例，但报告没有声明「未计通过」".to_string());
    }
    if skipped > 0 && !text.contains("断言覆盖") {
        add(
            "skip",
            "有骨架跳过，但报告没有写出「真断言 / 骨架」的覆盖条数".to_string(),
        );
    }

    if asserted == 0 {
        if pass_rate != "—（全部跳过）" {
            add(
                "pass_rate",
                format!(
                    "全部跳过时通过率应为「—（全部跳过）」，实际 {}",
                    pyrepr::repr_str(pass_rate)
                ),
            );
        }
        if !text.contains("不能据此判定") {
            add("pass_rate", "全部跳过时没有说明不能据此判定功能通过".to_string());
        }
    } else {
        let want = format!("{:.1}%", passed as f64 / asserted as f64 * 100.0);
        if pass_rate != want {
            add(
                "pass_rate",
                format!(
                    "通过率应为 {want}（{passed}/{asserted}），实际 {}",
                    pyrepr::repr_str(pass_rate)
                ),
            );
        }
        if !text.contains(&want) {
            add("pass_rate", "正文里没有写出通过率数字".to_string());
        }
    }

    json!({
        "ok": issues.is_empty(),
        "checked": 1,
        "issues": issue_list(&issues),
        "by_field": by_field(&issues),
    })
}

fn script_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^case_[0-9a-f]{8}\.py$").expect("static pattern"))
}

fn tautology_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"assert\s+1\s*==\s*1").expect("static pattern"))
}

fn assert_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s+assert\s+").expect("static pattern"))
}

/// Real assertions only: `assert True` is Python's `(?!True\b)` exclusion.
fn has_real_assertion(content: &str) -> bool {
    for found in assert_line_re().find_iter(content) {
        let rest = &content[found.end()..];
        let starts_true = rest.starts_with("True")
            && rest[4..]
                .chars()
                .next()
                .map(|ch| !(ch.is_alphanumeric() || ch == '_'))
                .unwrap_or(true);
        if !starts_true {
            return true;
        }
    }
    false
}

/// `prompts/script-author.md` checked against the generated script text.
///
/// This layer exists to prevent false passes: a skeleton written as `assert True`
/// or one that forgets to skip is green the moment pytest runs, while the report
/// claims everything was verified.
pub fn check_scripts(scripts: &[Value]) -> Value {
    let mut issues: Vec<Value> = Vec::new();
    for item in scripts {
        let name = str_field(item, "name").to_string();
        let content = str_field(item, "content").to_string();
        let slug = name.strip_suffix(".py").unwrap_or(&name).to_string();

        let mut add = |field: &str, problem: String| {
            issues.push(json!({ "script": name, "field": field, "problem": problem }));
        };
        if !script_name_re().is_match(&name) {
            add("name", "文件名应为 case_<8 位短哈希>.py".to_string());
        }
        if !content.contains(&format!("def test_{slug}(")) {
            add("function", format!("缺少函数 def test_{slug}()"));
        }
        if !content.contains("if __name__ == \"__main__\":") {
            add(
                "standalone",
                "缺少 __main__ 入口，无法直接 python 执行".to_string(),
            );
        }
        if !content.contains("生成方式：") {
            add("header", "文件头未写明生成方式".to_string());
        }
        if !content.contains("STEPS =") || !content.contains("EXPECTED =") {
            add(
                "constants",
                "步骤/预期未作为常量写进脚本，脚本无法脱离用例库自查".to_string(),
            );
        }
        if content.contains("assert True") || tautology_re().is_match(&content) {
            add("tautology", "出现恒真断言，等于伪装通过".to_string());
        }
        // A skeleton must skip explicitly; only a filled-in script may carry
        // real assertions.
        if !content.contains("pytest.skip(") && !has_real_assertion(&content) {
            add("skeleton", "既没有 pytest.skip 也没有真实断言".to_string());
        }
    }

    json!({
        "ok": issues.is_empty(),
        "checked": scripts.len(),
        "issues": issue_list(&issues),
        "by_field": by_field(&issues),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_exception_case_passes_every_rule() {
        let case = json!({
            "title": "过压保护-异常-越界值",
            "case_type": "异常",
            "priority": "高",
            "grounding": "strong",
            "precondition": "《BMS 需求.md》：…",
            "steps": ["a 4200mV", "b", "c"],
            "expected": ["越界值被拒绝"],
            "evidence": { "numbers": ["4200mV"] },
        });
        assert!(check_case(&case).is_empty());
    }

    #[test]
    fn empty_phrase_in_a_grounded_case_is_an_issue() {
        let case = json!({
            "title": "过压保护-主流程",
            "case_type": "功能",
            "priority": "中",
            "grounding": "weak",
            "precondition": "x",
            "steps": ["进入", "执行正常操作", "检查"],
            "expected": ["结果与预期一致"],
        });
        let issues = check_case(&case);
        assert_eq!(issues.len(), 2);
    }
}
