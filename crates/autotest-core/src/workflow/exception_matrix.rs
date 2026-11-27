//! The exception matrix: "异常" is not one template any more, it is a set of
//! failure modes generated only where the evidence can support them.
//!
//! Each class asks "how far does the evidence go?":
//! * a number in the clause → out-of-range / boundary can name values;
//! * a clause about messages/reports → a comm-timeout case can be written;
//! * a clause about protection/thresholds/sampling → electrical fault injection;
//! * anything the evidence cannot support is *not* invented — it is recorded as a
//!   gap so the UI can ask for the missing document.

use serde_json::{json, Value};

pub struct ExceptionClass {
    pub id: &'static str,
    pub label: &'static str,
    pub keywords: &'static [&'static str],
    pub needs_numbers: bool,
}

/// Order is generation priority: safety/numeric classes first, recovery last.
pub const CLASSES: [ExceptionClass; 8] = [
    ExceptionClass {
        id: "out_of_range",
        label: "越界值",
        keywords: &["阈值", "范围", "限值", "最大值", "最小值", "上限", "下限"],
        needs_numbers: true,
    },
    ExceptionClass {
        id: "boundary",
        label: "边界值",
        keywords: &["阈值", "范围", "限值", "上限", "下限", "临界"],
        needs_numbers: true,
    },
    // Keywords must cover different kinds of project: embedded (messages /
    // sampling / power-up), host + API (request / response / database /
    // transaction), HMI (interaction / state / permission). No hit, no case.
    ExceptionClass {
        id: "illegal_value",
        label: "非法枚举",
        keywords: &[
            "状态", "模式", "档位", "枚举", "命令", "指令", "参数", "入参", "非法值", "未定义",
        ],
        needs_numbers: false,
    },
    ExceptionClass {
        id: "comm_timeout",
        label: "通信超时",
        keywords: &[
            "报文", "信号", "通信", "CAN", "LIN", "以太网", "总线", "周期", "网络", "接口",
            "请求", "响应", "超时", "第三方", "HTTP", "RPC",
        ],
        needs_numbers: false,
    },
    ExceptionClass {
        id: "electrical",
        label: "电气故障",
        keywords: &["采样", "电压", "电流", "开路", "短路", "传感器", "保护", "硬件"],
        needs_numbers: false,
    },
    ExceptionClass {
        id: "power_cycle",
        label: "上下电",
        keywords: &[
            "上电", "下电", "掉电", "休眠", "唤醒", "复位", "初始化", "启动", "重启", "冷启",
        ],
        needs_numbers: false,
    },
    ExceptionClass {
        id: "concurrency",
        label: "并发重入",
        keywords: &["重复", "并发", "多次", "并行", "触发", "请求", "同时", "幂等", "重入"],
        needs_numbers: false,
    },
    ExceptionClass {
        id: "persistence",
        label: "持久化",
        keywords: &[
            "存储", "记录", "写入", "掉数据", "NVM", "Flash", "快照", "数据库", "缓存", "事务",
            "持久化", "落盘",
        ],
        needs_numbers: false,
    },
];

/// Hitting these means the failure consequence is safety/hardware related, so
/// the priority is raised to 高.
pub const SAFETY_KEYWORDS: [&str; 10] = [
    "保护", "过压", "过流", "短路", "急停", "互锁", "失效", "安全", "烧", "熔断",
];

pub const DEFAULT_EXCEPTION_BUDGET: usize = 3;

/// Out-of-range step: 10 %, but never finer than the original precision (an
/// integer moves by at least 1, one decimal by at least 0.1).
///
/// 5.5 V → 6.05 V (+10 %), 5 times → 6 times (+1). A flat 1.0 would turn 5.5 V
/// into 6.5 V; a flat 0.01 would turn "5 times" into 5.5 times.
pub fn step_for(value: f64) -> f64 {
    let text = format!("{value:.10}");
    let text = text.trim_end_matches('0');
    let text = if text.ends_with('.') {
        &text[..text.len() - 1]
    } else {
        text
    };
    let decimals = match text.split_once('.') {
        Some((_, fraction)) => fraction.len(),
        None => 0,
    };
    let floor = if decimals > 0 {
        10f64.powi(-(decimals as i32))
    } else {
        1.0
    };
    (value.abs() * 0.10).max(floor)
}

/// `int(value) if value.is_integer() else round(value, 2)` rendered with the
/// unit — the shape every case text uses.
pub fn format_number(value: f64, unit: &str) -> String {
    format!("{}{unit}", py_number(value))
}

/// Python's `str()` of a number that was either an int, a float, or
/// `round(x, 2)`. Rust's shortest round-trip float format matches Python's
/// `repr` for the decimal values these thresholds come from.
pub fn py_number(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        return format!("{}", value as i64);
    }
    let rounded = (value * 100.0).round() / 100.0;
    if rounded.fract() == 0.0 && rounded.abs() < 9.0e15 {
        return format!("{}", rounded as i64);
    }
    rounded.to_string()
}

/// Every number the evidence carries, in evidence order.
pub fn numbers(evidence: &[Value]) -> Vec<(f64, String)> {
    let mut out = Vec::new();
    for item in evidence {
        if let Some(list) = item.get("numbers").and_then(Value::as_array) {
            for entry in list {
                if let Some(value) = entry.get("value").and_then(Value::as_f64) {
                    out.push((
                        value,
                        entry
                            .get("unit")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    ));
                }
            }
        }
    }
    out
}

fn combined_text(name: &str, evidence: &[Value]) -> String {
    let mut parts = vec![name.to_string()];
    for item in evidence {
        parts.push(
            item.get("quote")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        );
    }
    parts.join(" ")
}

/// `(classes that can be written, classes skipped for lack of evidence)`.
/// Applicability is judged on evidence only; the budget trims the list.
pub fn applicable(
    name: &str,
    evidence: &[Value],
    budget: usize,
) -> (Vec<String>, Vec<String>) {
    let text = combined_text(name, evidence);
    let has_numbers = !numbers(evidence).is_empty();
    let mut usable = Vec::new();
    let mut gaps = Vec::new();
    for spec in CLASSES.iter() {
        // Numeric classes only need a number in the clause; every other class
        // must be mentioned by the clause, or writing it would be invention.
        let ok = if spec.needs_numbers {
            has_numbers
        } else {
            spec.keywords.iter().any(|word| text.contains(word))
        };
        if ok {
            usable.push(spec.id.to_string());
        } else {
            gaps.push(spec.id.to_string());
        }
    }
    usable.truncate(budget);
    (usable, gaps)
}

pub fn priority_for(name: &str, evidence: &[Value], fallback: &str) -> String {
    let text = combined_text(name, evidence);
    if SAFETY_KEYWORDS.iter().any(|word| text.contains(word)) {
        return "高".to_string();
    }
    fallback.to_string()
}

fn basis(evidence: &[Value], name: &str) -> String {
    let primary = evidence.first().cloned().unwrap_or_else(|| json!({}));
    let doc = primary
        .get("doc")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("项目资料");
    let quote = primary
        .get("quote")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if quote.is_empty() {
        format!("《{doc}》中关于“{name}”的条款")
    } else {
        format!("《{doc}》：{quote}")
    }
}

/// Concrete steps and observable expectations for one class. Values come from
/// the clause; no threshold is ever invented.
pub fn build(class_id: &str, name: &str, evidence: &[Value]) -> Value {
    let basis = basis(evidence, name);
    let nums = numbers(evidence);
    let (first_value, first_unit) = nums
        .first()
        .map(|(value, unit)| (Some(*value), unit.clone()))
        .unwrap_or((None, String::new()));
    let shown = nums
        .iter()
        .take(3)
        .map(|(value, unit)| format_number(*value, unit))
        .collect::<Vec<_>>()
        .join("、");
    let _ = shown;

    if class_id == "out_of_range" {
        if let Some(value) = first_value {
            let step = step_for(value);
            let over = format_number(value + step, &first_unit);
            let under = format_number((value - step).max(0.0), &first_unit);
            let baseline = format_number(value, &first_unit);
            return json!({
                "precondition": basis,
                "steps": [
                    format!("按{basis}把“{name}”的输入置为原文阈值 {baseline}，确认基线正常"),
                    format!("将输入改为越界值 {over} 与 {under}，各执行一次“{name}”"),
                    "记录两次的拒绝/保护动作、提示信息与恢复条件",
                ],
                "expected": [
                    format!("越界值 {over} / {under} 被拒绝或触发保护，不写入脏数据（原文阈值 {baseline}）"),
                    format!("退出越界输入后“{name}”恢复正常，状态与保护前一致"),
                ],
            });
        }
    }

    if class_id == "boundary" {
        if let Some(value) = first_value {
            let near = (value.abs() * 0.01).max(0.01);
            return json!({
                "precondition": basis,
                "steps": [
                    format!(
                        "按{basis}把“{name}”的输入依次置为 {}、{}、{}",
                        format_number(value - near, &first_unit),
                        format_number(value, &first_unit),
                        format_number(value + near, &first_unit)
                    ),
                    "每次保持输入稳定一个采样周期，记录判定结果与状态字",
                    "比较三者的接受/拒绝边界是否与原文一致",
                ],
                "expected": [
                    format!("等于原文阈值 {} 时行为与条款一致，越过阈值即切换", format_number(value, &first_unit)),
                    "边界两侧无抖动、无重复触发",
                ],
            });
        }
    }

    if class_id == "illegal_value" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}确认“{name}”合法的状态/枚举取值"),
                format!("注入一个未定义取值（越界枚举或未实现的模式/档位）执行“{name}”"),
                "检查系统是否停留在原状态，并记录上报的错误/DTC",
            ],
            "expected": [
                "未定义取值被拒绝，系统保持在上一个合法状态，不进入未定义态",
                "给出明确错误上报（错误码或 DTC），恢复合法取值后功能可继续",
            ],
        });
    }

    if class_id == "comm_timeout" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}让“{name}”在正常通信下运行并确认报文/信号周期性到达"),
                "停止发送该报文/信号（或注入超时），保持到超时阈值以上",
                "恢复通信，观察退出超时状态的条件",
            ],
            "expected": [
                "超时被检出并按条款进入降级/保护，相关信号标记为失效",
                "通信恢复后自动退出超时状态，无需重启",
            ],
        });
    }

    if class_id == "electrical" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}让“{name}”在正常采样值下运行并记录基线"),
                "注入开路（断线）与短路（对地/对电源），各保持一个采样周期",
                "恢复接线，检查故障记录与恢复条件",
            ],
            "expected": [
                "开路/短路被检出，触发条款描述的保护动作，不产生误动作",
                "恢复后故障消失，DTC/故障记录与恢复条件符合条款",
            ],
        });
    }

    if class_id == "power_cycle" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}让“{name}”进入工作状态并记录关键状态量"),
                "运行中断电再上电（分别做正常下电与硬掉电）",
                "上电后读取状态、配置与故障记录",
            ],
            "expected": [
                format!("上电后“{name}”重新初始化完成，配置与掉电前一致"),
                "无脏数据、无卡死；掉电期间的不完整操作有明确处理结果",
            ],
        });
    }

    if class_id == "concurrency" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}准备“{name}”的两个可同时发起的操作"),
                "连续快速触发两次（以及并发触发），观察执行顺序",
                "读取最终状态与计数，确认没有重复执行",
            ],
            "expected": [
                "重复/并发触发的请求被串行化或去重，不出现重复执行",
                "最终状态与单次执行一致，计数无漂移",
            ],
        });
    }

    if class_id == "persistence" {
        return json!({
            "precondition": basis,
            "steps": [
                format!("按{basis}让“{name}”写入一条记录/配置"),
                "在写入过程中断电，或把存储写满后再触发写入",
                "重启并读取已存在的数据",
            ],
            "expected": [
                "已存在的数据不被破坏，写入失败有明确返回",
                "重启后能从最后一条完整记录恢复，不需要人工清理",
            ],
        });
    }

    // Unreachable through `applicable`, but a bad class id must not silently
    // produce a case with no steps.
    json!({
        "precondition": basis,
        "steps": [format!("未知异常类：{class_id}")],
        "expected": [],
    })
}

pub fn label_of(class_id: &str) -> String {
    CLASSES
        .iter()
        .find(|spec| spec.id == class_id)
        .map(|spec| spec.label.to_string())
        .unwrap_or_else(|| class_id.to_string())
}

pub fn gap_labels(class_ids: &[String]) -> Vec<String> {
    class_ids.iter().map(|item| label_of(item)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_matches_python_precision_rule() {
        assert!((step_for(5.5) - 0.55).abs() < 1e-9);
        assert_eq!(step_for(5.0), 1.0);
        assert_eq!(step_for(1000.0), 100.0);
    }

    #[test]
    fn out_of_range_uses_clause_number() {
        let evidence = vec![json!({
            "doc": "BMS 需求.md",
            "quote": "- 当单体电压超过 4200 mV 时，应在 200 ms 内上报过压故障。",
            "numbers": [
                {"value": 4200.0, "unit": "mV", "text": "4200 mV"},
                {"value": 200.0, "unit": "ms", "text": "200 ms"},
            ],
        })];
        let built = build("out_of_range", "过压保护", &evidence);
        let steps = built["steps"].as_array().expect("steps");
        assert!(steps[1].as_str().expect("text").contains("4620mV 与 3780mV"));
    }
}
