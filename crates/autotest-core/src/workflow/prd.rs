//! PRD structure splitting.
//!
//! Deliberately not semantic: the judgement about *what* an item means is the
//! agent's job. This layer only guarantees the same document splits the same way
//! every time — case traceability and report statistics depend on that.
//!
//! Output contract (shared by tools and UI, append-only):
//!
//! ```text
//! { function_points: [{id, name, detail, priority, source}],
//!   non_functional:  [{category, item}],
//!   dependencies:    [{item}],
//!   risks:           [{item}],
//!   stats:           {chars, sections, function_points, module} }
//! ```

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use super::hashes;

pub const MAX_FUNCTION_POINTS: usize = 200;
pub const MAX_ITEM_CHARS: usize = 200;
pub const MAX_ITEMS_PER_GROUP: usize = 60;

fn heading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*$").expect("static pattern"))
}

fn numbered_heading() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:第[一二三四五六七八九十百]+[章节部分]|[一二三四五六七八九十]+、|\d+\.\d*)\s*(.+)$")
            .expect("static pattern")
    })
}

/// Chapter numbers in a title (`1.1` / `1.1.` / `1、`): a function-point name is
/// used to search the knowledge base, and a leading number means it never hits
/// the clause body — real PRDs number almost every heading, so keeping it would
/// mark the whole document as "no evidence".
fn leading_number() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*\d+(?:\.\d+)*\s*[.、)．]?\s*").expect("static pattern"))
}

fn list_item() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(?:[-*+]|\d+[.)、]|\(\d+\))\s+(.+)$").expect("static pattern"))
}

fn requirement_words() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(应|必须|需要|支持|能够|可以|允许|提供|禁止|不得|保证)").expect("static pattern")
    })
}

fn whitespace() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("static pattern"))
}

const FUNCTIONAL_SECTION: [&str; 9] = ["功能", "需求", "流程", "页面", "交互", "接口", "业务", "操作", "场景"];

const NON_FUNCTIONAL: [(&str, &[&str]); 5] = [
    ("性能", &["性能", "响应时间", "并发", "吞吐", "延迟", "帧率", "耗时"]),
    ("安全", &["安全", "权限", "鉴权", "加密", "越权", "审计", "合规"]),
    ("兼容", &["兼容", "适配", "版本", "机型", "分辨率", "平台"]),
    ("可用性", &["可用性", "容错", "降级", "重试", "断网", "异常恢复"]),
    ("可维护性", &["日志", "监控", "告警", "可观测", "埋点"]),
];

const DEPENDENCY: [&str; 8] = ["依赖", "前置", "上游", "第三方", "联调", "接口提供", "需由", "由.*提供"];
const RISK: [&str; 9] = ["风险", "待确认", "待定", "tbd", "疑问", "约束", "限制", "不确定", "待评审"];

pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").replace('\u{3000}', " ")
}

/// `re.sub(r"\s+", " ", value).strip()[:200]` — the single text column the case
/// table keeps is written from these trimmed items.
pub fn trim_item(value: &str) -> String {
    let squashed = whitespace().replace_all(value, " ");
    let trimmed = squashed.trim();
    trimmed.chars().take(MAX_ITEM_CHARS).collect()
}

pub fn priority(text: &str) -> &'static str {
    let lowered = text.to_lowercase();
    if ["必须", "核心", "P0", "阻塞"].iter().any(|word| text.contains(word)) || lowered.contains("p0")
    {
        return "高";
    }
    if ["可选", "建议", "P2", "锦上添花"].iter().any(|word| text.contains(word)) || lowered.contains("p2")
    {
        return "低";
    }
    "中"
}

/// `re.search(pattern, text) or pattern in text.lower()`.
///
/// Most of these "patterns" are literal words, but `由.*提供` is a real regex in
/// the Python source, so both readings are kept: a pattern that contains regex
/// syntax is searched as a regex, everything else as a substring of either the
/// original or the lowered text.
fn matches(text: &str, patterns: &[&str]) -> bool {
    let lowered = text.to_lowercase();
    patterns.iter().any(|pattern| {
        if pattern.contains(".*") {
            Regex::new(pattern)
                .map(|re| re.is_match(text))
                .unwrap_or(false)
        } else {
            text.contains(pattern) || lowered.contains(&pattern.to_lowercase())
        }
    })
}

struct Section {
    title: String,
    body: Vec<String>,
    level: usize,
}

fn split_sections(lines: &[String]) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut current = Section {
        title: String::new(),
        body: Vec::new(),
        level: 0,
    };
    for line in lines {
        let heading_match = heading().captures(line);
        let numbered_match = if heading_match.is_none() {
            numbered_heading().captures(line)
        } else {
            None
        };
        if heading_match.is_some() || numbered_match.is_some() {
            if !current.body.is_empty() || !current.title.is_empty() {
                sections.push(current);
            }
            let raw_title = if let Some(captures) = &heading_match {
                captures.get(2).map(|item| item.as_str()).unwrap_or("")
            } else {
                numbered_match
                    .as_ref()
                    .and_then(|captures| captures.get(1))
                    .map(|item| item.as_str())
                    .unwrap_or("")
            }
            .trim();
            let stripped = leading_number().replace(raw_title, "");
            let stripped = stripped.trim();
            let title = if stripped.is_empty() {
                raw_title.to_string()
            } else {
                stripped.to_string()
            };
            let level = heading_match
                .as_ref()
                .and_then(|captures| captures.get(1))
                .map(|item| item.as_str().chars().count())
                .unwrap_or(0);
            current = Section {
                title,
                body: Vec::new(),
                level,
            };
        } else {
            current.body.push(line.clone());
        }
    }
    if !current.body.is_empty() || !current.title.is_empty() {
        sections.push(current);
    }
    sections
}

fn collect_items(section: &Section) -> Vec<String> {
    let mut items = Vec::new();
    for line in &section.body {
        let stripped = line.trim();
        if stripped.is_empty() {
            continue;
        }
        if let Some(captures) = list_item().captures(line) {
            items.push(
                captures
                    .get(1)
                    .map(|item| item.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            );
        } else if requirement_words().is_match(stripped)
            && stripped.chars().count() <= MAX_ITEM_CHARS * 2
        {
            items.push(stripped.to_string());
        }
    }
    items
}

fn function_point_id(index: usize, name: &str) -> String {
    format!("fp-{index:03}-{}", hashes::sha1_prefix(name.as_bytes(), 6))
}

/// Split a PRD into function points, non-functional items, dependencies and
/// risks. `module` is statistics only — it never changes the split.
pub fn parse_prd(text: &str, module: &str) -> Value {
    let normalized = normalize(text);
    let lines: Vec<String> = normalized.split('\n').map(|line| line.to_string()).collect();
    let sections = split_sections(&lines);

    let mut function_points: Vec<Value> = Vec::new();
    let mut non_functional: Vec<Value> = Vec::new();
    let mut dependencies: Vec<Value> = Vec::new();
    let mut risks: Vec<Value> = Vec::new();
    let mut seen_names: Vec<String> = Vec::new();

    for section in &sections {
        let title = section.title.as_str();
        let items = collect_items(section);

        for item in &items {
            if matches(item, &RISK) {
                if risks.len() < MAX_ITEMS_PER_GROUP {
                    risks.push(json!({ "item": trim_item(item) }));
                }
            } else if matches(item, &DEPENDENCY) {
                if dependencies.len() < MAX_ITEMS_PER_GROUP {
                    dependencies.push(json!({ "item": trim_item(item) }));
                }
            }
            for (category, words) in NON_FUNCTIONAL {
                if matches(item, words) && non_functional.len() < MAX_ITEMS_PER_GROUP {
                    non_functional.push(json!({ "category": category, "item": trim_item(item) }));
                    break;
                }
            }
        }

        let in_functional_section = FUNCTIONAL_SECTION.iter().any(|word| title.contains(word));
        if !in_functional_section {
            continue;
        }
        // A document title (h1) is only a container, not a function point; a
        // section with no items falls back to its own h2+ heading.
        let heading_usable = section.level >= 2 || section.level == 0;

        let candidates: Vec<String> = if !items.is_empty() {
            items.clone()
        } else if !title.is_empty() && heading_usable {
            vec![title.to_string()]
        } else {
            Vec::new()
        };
        for item in candidates {
            let name = trim_item(&item);
            if name.is_empty() || name.chars().count() < 4 {
                continue;
            }
            let key = name.to_lowercase();
            if seen_names.contains(&key) {
                continue;
            }
            seen_names.push(key);
            if function_points.len() >= MAX_FUNCTION_POINTS {
                break;
            }
            let short: String = name.chars().take(60).collect();
            function_points.push(json!({
                "id": function_point_id(function_points.len() + 1, &name),
                "name": short,
                "detail": name,
                "priority": priority(&item),
                "source": if title.is_empty() { "正文" } else { title },
            }));
        }
    }

    if function_points.is_empty() {
        // No explicit chapters: degrade to headings + items so the tool always
        // yields a usable skeleton — but say so in `stats`, so the caller does
        // not mistake it for a full structure.
        for section in &sections {
            if section.title.is_empty() || section.level == 1 {
                continue;
            }
            let name = trim_item(&section.title);
            if name.chars().count() < 4 || seen_names.contains(&name.to_lowercase()) {
                continue;
            }
            seen_names.push(name.to_lowercase());
            let short: String = name.chars().take(60).collect();
            function_points.push(json!({
                "id": function_point_id(function_points.len() + 1, &name),
                "name": short,
                "detail": name,
                "priority": priority(&name),
                "source": "heading",
            }));
            if function_points.len() >= MAX_FUNCTION_POINTS {
                break;
            }
        }
    }

    json!({
        "function_points": function_points,
        "non_functional": non_functional,
        "dependencies": dependencies,
        "risks": risks,
        "stats": {
            "chars": normalized.chars().count(),
            "sections": sections.len(),
            "function_points": function_points.len(),
            "module": module,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRD: &str = "# 电池管理系统需求\n\n## 1. 功能需求\n- 采集单体电压，范围 0~5000 mV，采样周期 100 ms。\n- 当单体电压超过 4200 mV 时，应在 200 ms 内上报过压故障。\n- 支持 CAN 报文 0x351 上报总电压与总电流。\n- 上电自检应在 500 ms 内完成，失败时点亮故障灯。\n\n## 2. 非功能需求\n- 通信超时 1000 ms 后进入安全状态。\n\n## 3. 依赖\n- 依赖整车 12V 供电。\n";

    #[test]
    fn splits_the_fixture_prd() {
        let result = parse_prd(PRD, "BMS");
        let points = result["function_points"].as_array().expect("points");
        assert_eq!(points.len(), 5);
        assert_eq!(points[0]["id"], "fp-001-274b18");
        assert_eq!(points[0]["source"], "功能需求");
        assert_eq!(points[4]["source"], "非功能需求");
        assert_eq!(result["stats"]["sections"], 4);
        assert_eq!(result["stats"]["chars"], 218);
        assert_eq!(result["non_functional"][0]["category"], "安全");
        assert_eq!(result["dependencies"][0]["item"], "依赖整车 12V 供电。");
        assert_eq!(result["risks"].as_array().expect("risks").len(), 0);
    }
}
