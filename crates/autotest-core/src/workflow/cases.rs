//! Case generation (deterministic, no model).
//!
//! The agent decides *what* a function point should be tested for; this layer
//! turns that decision into one fixed shape so script generation and report
//! statistics never need per-case special cases.
//!
//! With evidence, steps and expectations quote the clause and its numbers
//! ("单体电压置 3.70 V，超过原文 3.65 V 阈值") instead of "执行正常操作"; without
//! evidence the case is marked `grounding=none` so the UI shows which cases are
//! still empty.

use serde_json::{json, Map, Value};

use super::exception_matrix;

pub const MAX_CASES: usize = 200;

struct Template {
    case_type: &'static str,
    suffix: &'static str,
    steps: [&'static str; 3],
    expected: [&'static str; 2],
}

/// `{name}` is substituted like `str.format(name=…)` did.
const TEMPLATES: [Template; 5] = [
    Template {
        case_type: "功能",
        suffix: "主流程",
        steps: [
            "进入“{name}”入口，确认前置条件满足",
            "按需求描述执行“{name}”的正常操作",
            "检查页面/接口返回与状态变化",
        ],
        expected: ["“{name}”按需求描述完成，结果与预期一致", "过程中无报错、无脏数据"],
    },
    Template {
        case_type: "异常",
        suffix: "异常输入",
        steps: [
            "进入“{name}”入口",
            "输入非法、缺省或超长的参数执行“{name}”",
            "观察系统提示与后续状态",
        ],
        expected: ["给出明确可读的错误提示", "系统不崩溃、不写入脏数据，可继续操作"],
    },
    Template {
        case_type: "边界",
        suffix: "边界值",
        steps: [
            "准备“{name}”的边界数据（空、最小值、最大值、超长）",
            "逐项执行“{name}”并记录实际结果",
            "比较实际结果与边界定义",
        ],
        expected: ["边界值按定义被接受或拒绝", "无越界、截断或静默失败"],
    },
    Template {
        case_type: "接口",
        suffix: "接口契约",
        steps: [
            "构造“{name}”的合法请求",
            "校验返回码、字段与业务码",
            "构造非法请求，验证参数校验与鉴权",
        ],
        expected: ["合法请求的响应与接口契约一致", "非法请求被拒绝且不泄露内部信息"],
    },
    Template {
        case_type: "兼容",
        suffix: "兼容性",
        steps: [
            "在目标机型/版本上进入“{name}”",
            "执行主流程操作",
            "检查布局、交互与性能表现",
        ],
        expected: ["功能可用，布局无遮挡、无错位", "交互响应在可接受范围内"],
    },
];

fn template_for(case_type: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|item| item.case_type == case_type)
}

fn normalize_types(types: &[String]) -> Vec<String> {
    let wanted: Vec<String> = types
        .iter()
        .filter(|item| template_for(item).is_some())
        .cloned()
        .collect();
    if wanted.is_empty() {
        return vec!["功能".to_string(), "异常".to_string()];
    }
    wanted
}

/// `f"{value}{unit}"` with an integral float printed as an integer.
fn format_number(item: &Value) -> String {
    let unit = item.get("unit").and_then(Value::as_str).unwrap_or("");
    match item.get("value") {
        Some(Value::Number(number)) => {
            let value = number.as_f64().unwrap_or(0.0);
            exception_matrix::format_number(value, unit)
        }
        _ => format!("{}{unit}", item.get("value").map(render).unwrap_or_default()),
    }
}

fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// An out-of-range value derived from the clause threshold: +10 %, and at least
/// +1 for small magnitudes.
fn over_value(item: &Value) -> Option<String> {
    let value = item.get("value").and_then(Value::as_f64)?;
    let unit = item.get("unit").and_then(Value::as_str).unwrap_or("");
    let step = (value.abs() * 0.1).max(1.0);
    Some(exception_matrix::format_number(round2(value + step), unit))
}

fn under_value(item: &Value) -> Option<String> {
    let value = item.get("value").and_then(Value::as_f64)?;
    let unit = item.get("unit").and_then(Value::as_str).unwrap_or("");
    let step = (value.abs() * 0.1).max(1.0);
    Some(exception_matrix::format_number(round2((value - step).max(0.0)), unit))
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn numbers_of(evidence: &[Value]) -> Vec<Value> {
    let primary = match evidence.first() {
        Some(item) => item,
        None => return Vec::new(),
    };
    primary
        .get("numbers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|item| item.get("value").map(|value| !value.is_null()).unwrap_or(false))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn doc_of(evidence: &[Value]) -> String {
    evidence
        .first()
        .and_then(|item| item.get("doc"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("项目资料")
        .to_string()
}

fn quote_of(evidence: &[Value]) -> String {
    evidence
        .first()
        .and_then(|item| item.get("quote"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

struct Body {
    precondition: String,
    steps: Vec<String>,
    expected: Vec<String>,
}

/// When the evidence carries numbers, write concrete steps from the clause.
/// `None` sends the caller back to the template.
fn grounded_case(name: &str, case_type: &str, evidence: &[Value]) -> Option<Body> {
    if evidence.is_empty() {
        return None;
    }
    let numbers = numbers_of(evidence);
    if numbers.is_empty() {
        return None;
    }
    let doc = doc_of(evidence);
    let quote = quote_of(evidence);
    let first = numbers[0].clone();
    let shown = numbers
        .iter()
        .take(3)
        .map(format_number)
        .collect::<Vec<_>>()
        .join("、");

    let (steps, expected): (Vec<String>, Vec<String>) = match case_type {
        "功能" => (
            vec![
                format!("按《{doc}》要求准备环境：{quote}"),
                format!("把“{name}”的输入置为原文范围内的正常值（原文参数：{shown}）"),
                format!("读取“{name}”的输出与状态，逐项对照原文判定"),
            ],
            vec![
                format!("结果符合《{doc}》：{quote}"),
                "过程无报错、无脏数据".to_string(),
            ],
        ),
        "异常" => {
            let over = over_value(&first);
            let under = under_value(&first);
            let abnormal = [over, under]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" / ");
            let threshold = format_number(&first);
            (
                vec![
                    format!("按《{doc}》确认“{name}”的阈值：{threshold}"),
                    format!("输入越界值 {abnormal}（超出原文阈值 {threshold}）执行“{name}”"),
                    "观察系统提示、保护动作与后续状态".to_string(),
                ],
                vec![
                    format!("越界输入被拒绝或触发保护（原文阈值 {threshold}）"),
                    "不写入脏数据，系统可继续操作".to_string(),
                ],
            )
        }
        "边界" => {
            let normal = format_number(&first);
            (
                vec![
                    format!("按《{doc}》取“{name}”的边界点：{normal}"),
                    format!("分别在 {normal}、略低于与略高于 {normal} 三个点执行“{name}”"),
                    "记录每个点的实际结果与系统提示".to_string(),
                ],
                vec![
                    format!("边界 {normal} 处行为与原文一致"),
                    "越界侧的输入被拒绝，另一侧正常执行".to_string(),
                ],
            )
        }
        "接口" => (
            vec![
                format!("按《{doc}》构造“{name}”的合法请求（原文参数：{shown}）"),
                "校验返回码、字段与业务码".to_string(),
                "构造越界与缺省参数的请求，验证校验逻辑".to_string(),
            ],
            vec![
                "合法请求响应与原文约定一致".to_string(),
                "非法请求被拒绝且不泄露内部信息".to_string(),
            ],
        ),
        _ => (
            vec![
                format!("在目标机型/版本上按《{doc}》配置“{name}”（原文参数：{shown}）"),
                "执行主流程操作".to_string(),
                "检查布局、交互与响应时间".to_string(),
            ],
            vec![
                "功能可用，布局无遮挡".to_string(),
                "交互响应在可接受范围内".to_string(),
            ],
        ),
    };

    Some(Body {
        precondition: format!("《{doc}》：{quote}"),
        steps,
        expected,
    })
}

/// A clause exists but carries no number: write the clause into the steps.
///
/// This used to fall back to `TEMPLATES`, so "grounded" cases contained
/// "结果与预期一致" — an unjudgeable sentence while the evidence sat right there.
/// This path only turns the clause into an action and an observation point; it
/// never invents a threshold.
fn clause_case(name: &str, case_type: &str, evidence: &[Value]) -> Body {
    let doc = doc_of(evidence);
    let quote = quote_of(evidence);
    let quote = if quote.is_empty() {
        format!("《{doc}》中关于“{name}”的条款")
    } else {
        quote
    };
    let basis = format!("《{doc}》：{quote}");

    let (steps, expected): (Vec<String>, Vec<String>) = match case_type {
        "异常" => (
            vec![
                format!("按{basis}确认“{name}”的约束条件"),
                format!("构造违反该约束的输入，执行“{name}”"),
                "观察系统提示、拦截动作与后续状态".to_string(),
            ],
            vec![
                format!("违反约束的输入被拦截或给出提示（依据{basis}）"),
                "系统可继续操作".to_string(),
            ],
        ),
        "边界" => (
            vec![
                format!("按{basis}确定“{name}”的取值或状态边界"),
                "在边界两侧各执行一次“{name}”".to_string(),
                "分别记录两次的实际结果与提示".to_string(),
            ],
            vec![format!("边界两侧的行为符合{basis}")],
        ),
        "接口" => (
            vec![
                format!("按{basis}构造“{name}”的合法请求"),
                "校验返回码、字段与业务码".to_string(),
                "构造缺省或越界参数的请求，验证校验逻辑".to_string(),
            ],
            vec![
                format!("合法请求的响应符合{basis}"),
                "非法请求被拒绝".to_string(),
            ],
        ),
        "兼容" => (
            vec![
                format!("在目标机型/版本上按{basis}配置“{name}”"),
                "执行条款描述的主流程".to_string(),
                "检查布局、交互与响应表现".to_string(),
            ],
            vec![format!("各机型上的表现一致且符合{basis}")],
        ),
        _ => (
            vec![
                format!("按{basis}准备环境与前置条件"),
                format!("对“{name}”执行条款描述的操作"),
                "逐条核对界面/状态是否与条款一致".to_string(),
            ],
            vec![
                format!("满足{basis}"),
                "同一操作可重复执行，结果一致".to_string(),
            ],
        ),
    };

    Body {
        precondition: basis,
        steps,
        expected,
    }
}

fn evidence_payload(evidence: &[Value]) -> Value {
    let Some(primary) = evidence.first() else {
        return Value::Null;
    };
    json!({
        "doc": primary.get("doc").cloned().unwrap_or(Value::Null),
        "quote": primary.get("quote").cloned().unwrap_or(Value::Null),
        "numbers": primary
            .get("numbers")
            .and_then(Value::as_array)
            .map(|list| list.iter().map(format_number).collect::<Vec<_>>())
            .unwrap_or_default(),
    })
}

fn fill(template: &str, name: &str) -> String {
    template.replace("{name}", name)
}

pub struct DesignInput<'a> {
    pub prd_result: &'a Value,
    pub types: &'a [String],
    pub template: &'a str,
    pub evidence: &'a std::collections::BTreeMap<String, Vec<Value>>,
    pub reasons: &'a std::collections::BTreeMap<String, String>,
    pub skip_ungrounded: bool,
    pub exception_budget: usize,
}

/// function point × test type. `skip_ungrounded` (the default) does not create a
/// case when there is no evidence — it records the point in the "needs material"
/// list instead, because a library full of "进入 X 入口执行正常操作" shells is
/// noise that also looks like coverage.
pub fn design_cases(input: DesignInput<'_>) -> Value {
    let empty = Vec::new();
    let function_points = input
        .prd_result
        .get("function_points")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let chosen_types = normalize_types(input.types);

    let mut cases: Vec<Value> = Vec::new();
    let mut levels: Vec<(String, i64)> = vec![
        ("strong".to_string(), 0),
        ("weak".to_string(), 0),
        ("none".to_string(), 0),
    ];
    let mut uncovered: Vec<Value> = Vec::new();
    let mut exception_gaps: Vec<(String, Value)> = Vec::new();

    for point in function_points {
        let name = point
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let priority = point
            .get("priority")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("中")
            .to_string();
        let point_evidence = input.evidence.get(&name).cloned().unwrap_or_default();

        // 异常 is not one template any more: generate per failure mode the
        // evidence can support, and record what it cannot support as a gap.
        let mut matrix_emitted = false;
        if chosen_types.iter().any(|item| item == "异常") && !point_evidence.is_empty() {
            let (classes, gap_classes) =
                exception_matrix::applicable(&name, &point_evidence, input.exception_budget);
            let raw_numbers = numbers_of(&point_evidence);
            for class_id in &classes {
                if cases.len() >= MAX_CASES {
                    break;
                }
                let built = exception_matrix::build(class_id, &name, &point_evidence);
                let built_text = format!(
                    "{} {}",
                    join_text(built.get("steps")),
                    join_text(built.get("expected"))
                );
                // "strong" only when the built text actually quotes the clause
                // number — the same rule the other paths use.
                let level = if !raw_numbers.is_empty()
                    && built_text.contains(&format_number(&raw_numbers[0]))
                {
                    "strong"
                } else {
                    "weak"
                };
                bump(&mut levels, level);
                let mut case = Map::new();
                case.insert(
                    "title".to_string(),
                    json!(format!("{name}-异常-{}", exception_matrix::label_of(class_id))),
                );
                case.insert("function_point".to_string(), json!(name));
                case.insert("case_type".to_string(), json!("异常"));
                case.insert("exception_class".to_string(), json!(class_id));
                case.insert(
                    "priority".to_string(),
                    json!(exception_matrix::priority_for(&name, &point_evidence, &priority)),
                );
                case.insert(
                    "precondition".to_string(),
                    built.get("precondition").cloned().unwrap_or(Value::Null),
                );
                case.insert("steps".to_string(), built.get("steps").cloned().unwrap_or(json!([])));
                case.insert(
                    "expected".to_string(),
                    built.get("expected").cloned().unwrap_or(json!([])),
                );
                case.insert("grounding".to_string(), json!(level));
                case.insert("basis_reason".to_string(), json!("ok"));
                case.insert("evidence".to_string(), evidence_payload(&point_evidence));
                cases.push(Value::Object(case));
                matrix_emitted = true;
            }
            if !gap_classes.is_empty() {
                exception_gaps.push((
                    name.clone(),
                    json!(exception_matrix::gap_labels(&gap_classes)),
                ));
            }
        }

        for case_type in &chosen_types {
            if case_type == "异常" && matrix_emitted {
                // Already generated per failure mode; do not add the generic
                // "异常输入" case on top. With no writable failure mode the
                // clause path still runs, so a negative case is not lost.
                continue;
            }
            if cases.len() >= MAX_CASES {
                break;
            }
            let spec = match template_for(case_type) {
                Some(spec) => spec,
                None => continue,
            };
            let level: &str;
            let body: Body;
            match grounded_case(&name, case_type, &point_evidence) {
                Some(grounded) => {
                    level = "strong";
                    body = grounded;
                }
                None => {
                    let candidate = if point_evidence.is_empty() { "none" } else { "weak" };
                    if candidate == "none" && input.skip_ungrounded {
                        let reason_key = input
                            .reasons
                            .get(&name)
                            .cloned()
                            .unwrap_or_else(|| "no_clause".to_string());
                        bump(&mut levels, "none");
                        push_uncovered(&mut uncovered, &name, &reason_key, case_type);
                        continue;
                    }
                    if candidate == "weak" {
                        // A clause without numbers: write the clause itself, a
                        // template would throw the evidence away.
                        level = "weak";
                        body = clause_case(&name, case_type, &point_evidence);
                    } else {
                        level = "none";
                        body = Body {
                            precondition: format!("“{name}”对应功能已可用，测试环境就绪"),
                            steps: spec.steps.iter().map(|step| fill(step, &name)).collect(),
                            expected: spec
                                .expected
                                .iter()
                                .map(|item| fill(item, &name))
                                .collect(),
                        };
                    }
                }
            }
            bump(&mut levels, level);
            let reason = if level != "none" {
                "ok".to_string()
            } else {
                input
                    .reasons
                    .get(&name)
                    .cloned()
                    .unwrap_or_else(|| "no_clause".to_string())
            };
            let mut case = Map::new();
            case.insert("title".to_string(), json!(format!("{name}-{}", spec.suffix)));
            case.insert("function_point".to_string(), json!(name));
            case.insert("case_type".to_string(), json!(case_type));
            case.insert("priority".to_string(), json!(priority));
            case.insert("precondition".to_string(), json!(body.precondition));
            case.insert("steps".to_string(), json!(body.steps));
            case.insert("expected".to_string(), json!(body.expected));
            case.insert("grounding".to_string(), json!(level));
            case.insert("basis_reason".to_string(), json!(reason));
            case.insert("evidence".to_string(), evidence_payload(&point_evidence));
            cases.push(Value::Object(case));
        }
        if cases.len() >= MAX_CASES {
            break;
        }
    }

    let mut by_type: Vec<(String, i64)> = Vec::new();
    let mut by_exception_class: Vec<(String, i64)> = Vec::new();
    let mut exception_matrix_map: Map<String, Value> = Map::new();
    for case in &cases {
        let case_type = case.get("case_type").and_then(Value::as_str).unwrap_or("");
        count_into(&mut by_type, case_type);
        if let Some(class_id) = case.get("exception_class").and_then(Value::as_str) {
            count_into(&mut by_exception_class, class_id);
            let point = case
                .get("function_point")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let entry = exception_matrix_map
                .entry(point)
                .or_insert_with(|| json!([]));
            if let Some(list) = entry.as_array_mut() {
                list.push(json!(exception_matrix::label_of(class_id)));
            }
        }
    }

    let reasons = reason_counts(&uncovered, input.reasons);
    let skipped: usize = uncovered
        .iter()
        .map(|entry| {
            entry
                .get("case_types")
                .and_then(Value::as_array)
                .map(|list| list.len())
                .unwrap_or(0)
        })
        .sum();
    let mut exception_gaps_map = Map::new();
    for (point, labels) in exception_gaps {
        exception_gaps_map.insert(point, labels);
    }

    json!({
        "cases": cases,
        "stats": {
            "total": cases.len(),
            "by_type": pairs_to_object(by_type),
            "function_points": function_points.len(),
            "types": chosen_types,
            "template": input.template,
            "grounding": pairs_to_object(levels),
            "reasons": reasons,
            "skipped": skipped,
            "uncovered": uncovered,
            "generate_all": !input.skip_ungrounded,
            "exception_matrix": Value::Object(exception_matrix_map),
            "exception_gaps": Value::Object(exception_gaps_map),
            "by_exception_class": pairs_to_object(by_exception_class),
            "exception_budget": input.exception_budget,
        },
    })
}

fn join_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|item| item.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn bump(levels: &mut [(String, i64)], level: &str) {
    for entry in levels.iter_mut() {
        if entry.0 == level {
            entry.1 += 1;
        }
    }
}

fn count_into(target: &mut Vec<(String, i64)>, key: &str) {
    if let Some(entry) = target.iter_mut().find(|entry| entry.0 == key) {
        entry.1 += 1;
    } else {
        target.push((key.to_string(), 1));
    }
}

fn pairs_to_object(pairs: Vec<(String, i64)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key, json!(value));
    }
    Value::Object(map)
}

fn push_uncovered(uncovered: &mut Vec<Value>, name: &str, reason: &str, case_type: &str) {
    for entry in uncovered.iter_mut() {
        if entry.get("function_point").and_then(Value::as_str) == Some(name) {
            if let Some(list) = entry.get_mut("case_types").and_then(Value::as_array_mut) {
                list.push(json!(case_type));
            }
            return;
        }
    }
    uncovered.push(json!({
        "function_point": name,
        "reason": reason,
        "case_types": [case_type],
    }));
}

/// Group skipped cases by why they had no evidence — the UI tells the user what
/// to add from these counts.
fn reason_counts(
    uncovered: &[Value],
    reasons: &std::collections::BTreeMap<String, String>,
) -> Value {
    let mut counts: Vec<(String, i64)> = Vec::new();
    for entry in uncovered {
        let name = entry
            .get("function_point")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = entry
            .get("reason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .or_else(|| reasons.get(name).cloned())
            .unwrap_or_else(|| "no_clause".to_string());
        let width = entry
            .get("case_types")
            .and_then(Value::as_array)
            .map(|list| {
                if list.is_empty() {
                    1
                } else {
                    list.len()
                }
            })
            .unwrap_or(1) as i64;
        if let Some(found) = counts.iter_mut().find(|item| item.0 == key) {
            found.1 += width;
        } else {
            counts.push((key, width));
        }
    }
    pairs_to_object(counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ungrounded_cases_are_skipped_by_default() {
        let prd = json!({
            "function_points": [{ "name": "登录失败锁定", "priority": "中" }],
        });
        let evidence = std::collections::BTreeMap::new();
        let reasons = std::collections::BTreeMap::new();
        let result = design_cases(DesignInput {
            prd_result: &prd,
            types: &[],
            template: "standard",
            evidence: &evidence,
            reasons: &reasons,
            skip_ungrounded: true,
            exception_budget: 3,
        });
        assert_eq!(result["stats"]["total"], 0);
        assert_eq!(result["stats"]["skipped"], 2);
        assert_eq!(result["stats"]["reasons"]["no_clause"], 2);
    }
}
