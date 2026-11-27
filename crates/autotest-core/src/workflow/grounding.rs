//! Finding "evidence" for a function point: deterministic retrieval of clause
//! text from the project knowledge base, with no model call.
//!
//! Cases read like templates ("进入 X 入口，执行正常操作") when generation holds
//! nothing but the name. The clause text is already in the project knowledge base
//! ("单体电压 > 3.65 V 时进入过压保护"); this layer retrieves it, picks the one
//! sentence that reads like a requirement for *this* point, and extracts the
//! numbers. Doing it without a model keeps the same document producing the same
//! evidence every time, which is what makes it testable.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::knowledge_bridge;

pub const MAX_EVIDENCE_PER_POINT: usize = 3;
pub const MAX_QUOTE_CHARS: usize = 220;
pub const MIN_TOKEN_CHARS: usize = 2;

/// Numbers with a unit: 3.65V / 120A / 200ms / 12.9 V / 95 %.
///
/// Both sides are boundary-checked: the "4A" inside "Figure 4AFE均衡电路" is a
/// figure number, not a current threshold, and without the check it would be
/// written into a case as a parameter.
const NUMBER_UNITS: &str = "kV|mV|mA|kA|V|A|ms|us|ns|s|%|℃|度|Hz|kHz|MHz|bps|kbps|KB|MB|GB|bit|个|次|条|秒|毫秒|伏|安";

fn number_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(r"(?i)(\d+(?:\.\d+)?)\s*({NUMBER_UNITS})")).expect("static pattern")
    })
}

fn sentence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^。；;\n|]+[。；;]?").expect("static pattern"))
}

fn token_split_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\s、,，/（）()\[\]【】\-_]+").expect("static pattern"))
}

/// Words too generic to mean "this is evidence for that function point".
const STOP_TOKENS: [&str; 19] = [
    "功能", "模块", "系统", "要求", "相关", "支持", "提供", "进行", "实现", "管理", "监控", "保护",
    "控制", "状态", "数据", "信息", "参数", "设计", "需求",
];

/// Between 应/必须/不得 … terms that mark a real constraint.
const CONSTRAINT_WORDS: [&str; 8] = ["应", "必须", "不得", "禁止", "要求", "大于", "小于", "超过"];

/// Debug hints that read like clauses but would be written as debugging steps
/// ("确认供电是不是大于 5.5V") instead of acceptance steps.
const DEBUG_WORDS: [&str; 6] = ["排查", "确认下", "建议", "如果", "若是", "试试"];

/// Split a function-point name into searchable tokens: the whole name, its
/// separator-delimited parts, and every 2-character window.
///
/// "电压监控" is written in the document as "单体电压大于 3.65V" — whole-name
/// matching alone would miss the clause that carries the threshold.
pub fn tokens(name: &str) -> Vec<String> {
    let parts: Vec<String> = token_split_re()
        .split(name)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect();
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = name.chars().collect();
    if chars.len() >= MIN_TOKEN_CHARS {
        out.push(name.to_string());
    }
    for part in parts {
        let part_chars: Vec<char> = part.chars().collect();
        if part_chars.len() >= MIN_TOKEN_CHARS
            && !STOP_TOKENS.contains(&part.as_str())
            && !out.contains(&part)
        {
            out.push(part.clone());
        }
        if part_chars.len() > 1 {
            for index in 0..part_chars.len() - 1 {
                let window: String = part_chars[index..index + 2].iter().collect();
                if !STOP_TOKENS.contains(&window.as_str()) && !out.contains(&window) {
                    out.push(window);
                }
            }
        }
    }
    out
}

/// One unit-bearing number found in `text`, in order of appearance.
struct FoundNumber {
    value: f64,
    unit: String,
    text: String,
}

/// Python's `_NUMBER` relies on a lookbehind/lookahead the regex crate does not
/// have, so the boundaries are checked here. A rejected candidate restarts the
/// scan one character later, exactly like the Python engine backtracking.
fn scan_numbers(text: &str) -> Vec<FoundNumber> {
    let mut found = Vec::new();
    let mut position = 0usize;
    while position < text.len() {
        let Some(captures) = number_re().captures(&text[position..]) else {
            break;
        };
        let whole = captures.get(0).expect("group 0");
        let start = position + whole.start();
        let end = position + whole.end();
        let before_ok = match text[..start].chars().next_back() {
            None => true,
            Some(ch) => !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '_'),
        };
        let after_ok = match text[end..].chars().next() {
            None => true,
            Some(ch) => !ch.is_ascii_alphabetic(),
        };
        if before_ok && after_ok {
            if let Some(value) = parse_capture(&captures, 1) {
                found.push(FoundNumber {
                    value,
                    unit: captures
                        .get(2)
                        .map(|item| item.as_str().to_string())
                        .unwrap_or_default(),
                    text: whole.as_str().trim().to_string(),
                });
                position = end;
                continue;
            }
        }
        // Advance one character past this candidate.
        let step = text[start..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        position = start + step;
        if position >= text.len() {
            break;
        }
    }
    found
}

fn parse_capture(captures: &Captures<'_>, index: usize) -> Option<f64> {
    captures.get(index)?.as_str().parse::<f64>().ok()
}

/// Unit-bearing numbers, de-duplicated on (value, unit) but kept in order.
pub fn extract_numbers(text: &str) -> Vec<Value> {
    let mut seen: Vec<(f64, String)> = Vec::new();
    let mut out = Vec::new();
    for item in scan_numbers(text) {
        let key = (item.value, item.unit.to_lowercase());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(json!({
            "value": item.value,
            "unit": item.unit,
            "text": item.text,
        }));
    }
    out
}

fn has_constraint(sentence: &str) -> bool {
    CONSTRAINT_WORDS.iter().any(|word| sentence.contains(word))
}

fn looks_like_caption(sentence: &str) -> bool {
    let lowered = sentence.trim().to_lowercase();
    ["figure", "fig.", "table", "图", "表"]
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
}

/// The sentence that most reads like "what this function point must do".
///
/// Scoring: mentions the point (± its 2-character windows) +3, carries a
/// unit-bearing number +3, uses a constraint word +1; debugging advice, figure
/// captions and over-long sentences lose points. Below 3 the document has no
/// usable clause.
pub fn best_sentence(content: &str, name: &str) -> String {
    let tokens = tokens(name);
    let mut best = String::new();
    let mut best_key = (0i32, false);
    for found in sentence_re().find_iter(content) {
        let sentence = found.as_str().trim_matches(|ch: char| {
            matches!(ch, ' ' | '\t' | '\r' | '\n' | '|')
        });
        if sentence.chars().count() < 8 {
            continue;
        }
        let mut score = 0i32;
        if tokens.iter().any(|token| sentence.contains(token.as_str())) {
            score += 3;
        }
        let numbers = extract_numbers(sentence);
        if !numbers.is_empty() {
            // Only a clause with a threshold/parameter can become a concrete
            // case, so it carries the highest weight.
            score += 3;
        }
        if has_constraint(sentence) {
            score += 1;
        }
        if DEBUG_WORDS.iter().any(|word| sentence.contains(word)) {
            // Reads like a clause, gets written as a debugging step: push it
            // below the threshold rather than let a debug hint become the
            // acceptance criterion.
            score -= 4;
        }
        if sentence.chars().count() > 160 {
            score -= 2;
        }
        if looks_like_caption(sentence) {
            score -= 3;
        }
        let key = (score, !numbers.is_empty());
        if key > best_key {
            best = sentence.to_string();
            best_key = key;
        }
    }
    if best_key.0 < 3 {
        return String::new();
    }
    best.chars().take(MAX_QUOTE_CHARS).collect()
}

fn point_name(point: &Value) -> String {
    point
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Look up one point's chunks: BM25 first, then plain `LIKE` if the index is
/// behind (a manual insert, a rebuild in progress). Missing evidence makes cases
/// fall back to templates silently, so the second attempt matters.
fn records_for(conn: &Connection, project_id: &str, name: &str, limit: i64) -> Vec<Value> {
    let mut records =
        knowledge_bridge::search_records(conn, project_id, name, "", "", limit).unwrap_or_default();
    if records.is_empty() {
        records = super::store::search_knowledge(conn, project_id, name, "", "", limit)
            .unwrap_or_default();
    }
    records
}

/// Why a point has no evidence.
///
/// The three ways to come up empty must stay distinct: the knowledge base never
/// mentions the point (add material), it mentions it but the chunk body is empty
/// (re-ingest), or the sentence has nothing judgeable (a weak basis at best).
pub fn diagnose(
    conn: &Connection,
    project_id: &str,
    function_points: &[Value],
    limit: i64,
) -> BTreeMap<String, String> {
    let mut reasons = BTreeMap::new();
    for point in function_points {
        let name = point_name(point);
        if name.is_empty() {
            continue;
        }
        let records = records_for(conn, project_id, &name, limit);
        if records.is_empty() {
            reasons.insert(name, "no_hit".to_string());
            continue;
        }
        let bodies: Vec<String> = records
            .iter()
            .map(|record| {
                record
                    .get("content")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .or_else(|| record.get("excerpt").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        let tokens = tokens(&name);
        // Only chunks that actually mention the point count: a table-of-contents
        // chunk of several hundred unrelated characters does not.
        let relevant: Vec<&String> = bodies
            .iter()
            .filter(|body| tokens.iter().any(|token| body.contains(token.as_str())))
            .collect();
        if !relevant.is_empty()
            && relevant
                .iter()
                .all(|body| body.trim().chars().count() < 8)
        {
            reasons.insert(name, "empty_source".to_string());
            continue;
        }
        let pool: Vec<&String> = if relevant.is_empty() {
            bodies.iter().collect()
        } else {
            relevant
        };
        let has_clause = pool
            .iter()
            .any(|body| !best_sentence(body, &name).is_empty());
        reasons.insert(
            name,
            if has_clause { "ok" } else { "no_clause" }.to_string(),
        );
    }
    reasons
}

/// Function point name → evidence list (raw clause + numbers). Nothing found
/// means an empty list; nothing is invented.
pub fn collect(
    conn: &Connection,
    project_id: &str,
    function_points: &[Value],
    limit: i64,
) -> BTreeMap<String, Vec<Value>> {
    let mut evidence: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for point in function_points {
        let name = point_name(point);
        if name.is_empty() {
            continue;
        }
        let mut found: Vec<Value> = Vec::new();
        let mut seen_quotes: Vec<String> = Vec::new();
        for record in records_for(conn, project_id, &name, limit) {
            let body = record
                .get("content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .or_else(|| record.get("excerpt").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let quote = best_sentence(&body, &name);
            if quote.is_empty() || seen_quotes.contains(&quote) {
                continue;
            }
            seen_quotes.push(quote.clone());
            found.push(json!({
                "doc": knowledge_bridge::document_name(conn, &record),
                "source_ref": record.get("source_ref").and_then(Value::as_str).unwrap_or(""),
                "chunk_id": record.get("id").cloned().unwrap_or(Value::Null),
                "quote": quote,
                "numbers": extract_numbers(&quote),
            }));
            if found.len() >= MAX_EVIDENCE_PER_POINT {
                break;
            }
        }
        evidence.insert(name, found);
    }
    evidence
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_units_and_skips_figure_numbers() {
        let numbers = extract_numbers("当单体电压超过 4200 mV 时，应在 200 ms 内上报；Figure 4AFE均衡电路");
        let texts: Vec<String> = numbers
            .iter()
            .map(|item| item["text"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(texts, vec!["4200 mV", "200 ms"]);
        assert_eq!(numbers[0]["value"], 4200.0);
        assert_eq!(numbers[0]["unit"], "mV");
    }

    #[test]
    fn duplicates_collapse_on_value_and_unit() {
        let numbers = extract_numbers("上限 4200 mV，下限 4200mV");
        assert_eq!(numbers.len(), 1);
    }

    #[test]
    fn picks_the_clause_with_a_threshold() {
        let body = "- 采集单体电压，范围 0~5000 mV，采样周期 100 ms。\n- 当单体电压超过 4200 mV 时，应在 200 ms 内上报过压故障。\n- 支持 CAN 报文 0x351 上报总电压与总电流。\n- 上电自检应在 500 ms 内完成，失败时点亮故障灯。";
        let quote = best_sentence(body, "采集单体电压，范围 0~5000 mV，采样周期 100 ms。");
        assert_eq!(quote, "- 当单体电压超过 4200 mV 时，应在 200 ms 内上报过压故障。");
    }

    #[test]
    fn tokens_include_two_char_windows() {
        let tokens = tokens("电压监控");
        assert!(tokens.contains(&"电压监控".to_string()));
        assert!(tokens.contains(&"电压".to_string()));
        // "监控" is a stop token: it appears in almost every clause and would make
        // unrelated chunks look like evidence for this point.
        assert!(!tokens.contains(&"监控".to_string()));
    }
}
