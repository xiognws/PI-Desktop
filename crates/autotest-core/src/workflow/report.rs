//! The test report (Markdown, assembled deterministically).
//!
//! The report only reads what is already stored: `counts` and the failure detail
//! must come from the same batch, so the pass rate is not recomputed here — the
//! stats and failures are laid out as they are, which is what keeps the report
//! and the execution detail from disagreeing.

use serde_json::{json, Value};

use super::execution;

pub const MAX_SECTIONS: usize = 50;
pub const MAX_EVIDENCE_CHARS: usize = 1_200;

fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    format!("{}\n…（已截断）", chars[..limit].iter().collect::<String>())
}

/// Exception coverage: function point × failure mode, plus the gaps the material
/// never mentioned.
///
/// The report is the only external deliverable. A bare "pass rate 100 %" without
/// saying which failure modes were covered leaves the reader unable to judge what
/// was actually verified — this section is that information.
fn exception_section(coverage: &Value, gaps: &Value) -> Vec<String> {
    let coverage_empty = coverage.as_object().map(|map| map.is_empty()).unwrap_or(true);
    let gaps_empty = gaps.as_object().map(|map| map.is_empty()).unwrap_or(true);
    if coverage_empty && gaps_empty {
        return Vec::new();
    }

    let mut lines = vec!["## 异常覆盖".to_string(), String::new()];
    if !coverage_empty {
        let entries = sorted_pairs(coverage);
        let mut labels: Vec<String> = Vec::new();
        for (_, items) in &entries {
            for label in items {
                if !labels.contains(label) {
                    labels.push(label.clone());
                }
            }
        }
        lines.push(format!("| 功能点 | {} |", labels.join(" | ")));
        lines.push(format!(
            "| --- | {} |",
            labels
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | ")
        ));
        for (point, items) in &entries {
            let marks: Vec<&str> = labels
                .iter()
                .map(|label| if items.contains(label) { "●" } else { "—" })
                .collect();
            lines.push(format!("| {point} | {} |", marks.join(" | ")));
        }
        lines.push(String::new());
        lines.push(format!(
            "- 覆盖失效模式：{} 类（{}）",
            labels.len(),
            labels.join(", ")
        ));
    } else {
        lines.push("- 本轮没有生成任何异常用例".to_string());
    }
    if !gaps_empty {
        lines.push(String::new());
        lines.push("### 待补资料的失效模式".to_string());
        lines.push(String::new());
        lines.push("| 功能点 | 缺依据的失效模式 |".to_string());
        lines.push("| --- | --- |".to_string());
        for (point, items) in sorted_pairs(gaps) {
            if !items.is_empty() {
                lines.push(format!("| {point} | {} |", items.join(", ")));
            }
        }
    }
    lines.push(String::new());
    lines
}

/// `sorted(container.items())` over a JSON object of string lists.
fn sorted_pairs(value: &Value) -> Vec<(String, Vec<String>)> {
    let mut pairs: Vec<(String, Vec<String>)> = value
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(key, items)| {
                    let list = items
                        .as_array()
                        .map(|list| {
                            list.iter()
                                .map(|item| item.as_str().unwrap_or("").to_string())
                                .collect()
                        })
                        .unwrap_or_default();
                    (key.clone(), list)
                })
                .collect()
        })
        .unwrap_or_default();
    pairs.sort_by(|left, right| left.0.cmp(&right.0));
    pairs
}

pub struct ReportInput<'a> {
    pub run_id: &'a str,
    pub module: &'a str,
    pub payload: &'a Value,
    pub cases_total: i64,
    pub requirement: &'a str,
    pub bugs: &'a [Value],
    pub exception_coverage: &'a Value,
    pub exception_gaps: &'a Value,
}

fn int_field(value: &Value, key: &str) -> i64 {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn text_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Turn one execution payload into a Markdown report.
pub fn build_report(input: ReportInput<'_>) -> Value {
    let stats = input
        .payload
        .get("stats")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let total = int_field(&stats, "total");
    let passed = int_field(&stats, "pass");
    let skipped = int_field(&stats, "skip");
    let failed = int_field(&stats, "fail");
    let errored = int_field(&stats, "error");
    let cancelled = int_field(&stats, "cancelled");
    let scripts = int_field(&stats, "scripts");
    // The pass rate counts only cases that actually ran an assertion: a skipped
    // case is a skeleton with no assertion yet. Putting them in the denominator
    // makes 100 % look like verified, and in the numerator it is worse.
    let asserted = (total - skipped).max(0);
    let pass_rate = if asserted > 0 {
        format!("{:.1}%", passed as f64 / asserted as f64 * 100.0)
    } else {
        "—（全部跳过）".to_string()
    };
    let scripts_shown = if scripts != 0 { scripts } else { total };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("# 测试报告 {}", input.run_id));
    lines.push(String::new());
    lines.push(format!(
        "- 模块：{}",
        if input.module.is_empty() {
            "未标注"
        } else {
            input.module
        }
    ));
    lines.push(format!(
        "- 需求来源：{}",
        if input.requirement.is_empty() {
            "未关联"
        } else {
            input.requirement
        }
    ));
    lines.push(format!("- 设计用例数：{}", input.cases_total));
    lines.push(format!("- 执行脚本数：{scripts_shown}"));
    lines.push(format!(
        "- 执行用例数：{}（另有 {skipped} 条骨架跳过，未计通过）",
        total - skipped
    ));
    lines.push(format!("- 断言覆盖：真断言 {asserted} 条 / 骨架 {skipped} 条"));
    lines.push(format!(
        "- 生成时间：{}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    lines.push(String::new());
    lines.push("## 结果汇总".to_string());
    lines.push(String::new());
    lines.push("| 总数 | 通过 | 跳过 | 失败 | 异常 | 取消 | 通过率 | 总耗时 |".to_string());
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |".to_string());
    lines.push(format!(
        "| {total} | {passed} | {skipped} | {failed} | {errored} | {cancelled} \
         | {pass_rate} | {} ms |",
        int_field(&stats, "duration_ms")
    ));
    lines.push(String::new());
    lines.extend(exception_section(
        input.exception_coverage,
        input.exception_gaps,
    ));

    if total != input.cases_total {
        lines.push(format!(
            "> 注意：设计用例 {} 条，实际执行 {} 条（{scripts_shown} 个脚本）；差额来自未生成脚本的用例或人工筛选。",
            input.cases_total,
            total - skipped
        ));
        lines.push(String::new());
    }

    if !input.bugs.is_empty() {
        lines.push("## 缺陷清单".to_string());
        lines.push(String::new());
        lines.push("| Bug | 脚本 | 标题 | 级别 | 状态 | 错误类型 | 出现次数 |".to_string());
        lines.push("| --- | --- | --- | --- | --- | --- | --- |".to_string());
        for bug in input.bugs.iter().take(MAX_SECTIONS) {
            lines.push(format!(
                "| {} | {} | {} | {} | {} | {} | {} |",
                text_field(bug, "id"),
                or_dash(text_field(bug, "script_name")),
                text_field(bug, "title"),
                text_field(bug, "severity"),
                text_field(bug, "status"),
                or_dash(text_field(bug, "error_type")),
                int_field(bug, "occurrences").max(1)
            ));
        }
        lines.push(String::new());
    }

    let failures = execution::failed_results(input.payload);
    if failures.is_empty() {
        lines.push("## 失败明细".to_string());
        lines.push(String::new());
        lines.push("无失败用例。".to_string());
        lines.push(String::new());
    } else {
        lines.push("## 失败明细".to_string());
        lines.push(String::new());
        for item in failures.iter().take(MAX_SECTIONS) {
            let name = {
                let script_name = text_field(item, "script_name");
                if script_name.is_empty() {
                    text_field(item, "script_id").to_string()
                } else {
                    script_name.to_string()
                }
            };
            lines.push(format!("### {name}（{}）", text_field(item, "status")));
            lines.push(String::new());
            lines.push(format!(
                "- execution_id：{}",
                item.get("execution_id").map(render).unwrap_or_default()
            ));
            lines.push(format!(
                "- 耗时：{} ms",
                item.get("duration_ms").map(render).unwrap_or_default()
            ));
            let failure = clip(text_field(item, "failure"), MAX_EVIDENCE_CHARS);
            if !failure.is_empty() {
                lines.push(String::new());
                lines.push("**失败断言**".to_string());
                lines.push(String::new());
                lines.push("```text".to_string());
                lines.push(failure);
                lines.push("```".to_string());
            }
            let stderr = clip(text_field(item, "stderr_tail"), MAX_EVIDENCE_CHARS);
            if !stderr.is_empty() {
                lines.push(String::new());
                lines.push("**stderr**".to_string());
                lines.push(String::new());
                lines.push("```text".to_string());
                lines.push(stderr);
                lines.push("```".to_string());
            }
            lines.push(String::new());
        }
    }

    lines.push("## 结论".to_string());
    lines.push(String::new());
    if total == 0 {
        lines.push("本批次没有执行任何脚本，报告不含有效结论。".to_string());
    } else if asserted == 0 {
        lines.push(format!(
            "本次执行的 {skipped} 条用例全部是尚未补断言的骨架，不能据此判定功能通过。"
        ));
    } else if failed == 0 && errored == 0 {
        lines.push(format!(
            "通过率 {pass_rate}（{passed}/{asserted}），未发现失败或异常。"
        ));
    } else {
        lines.push(format!(
            "通过率 {pass_rate}（{passed}/{asserted}），存在 {} 个失败/异常用例，见上方失败明细。",
            failed + errored
        ));
    }

    let markdown = format!("{}\n", lines.join("\n"));
    json!({
        "markdown": markdown,
        "counts": {
            "total": total,
            "passed": passed,
            "skipped": skipped,
            "failed": failed,
            "errored": errored,
            "cancelled": cancelled,
            "scripts": scripts_shown,
            // Aligned with the status route: real assertions / skeletons, so both
            // places answer the same question the same way.
            "asserted": asserted,
            "skeleton": skipped,
            "bugs": input.bugs.len(),
        },
        "pass_rate": pass_rate,
        "name": format!("{}-report.md", input.run_id),
    })
}

fn or_dash(text: &str) -> &str {
    if text.is_empty() {
        "-"
    } else {
        text
    }
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
