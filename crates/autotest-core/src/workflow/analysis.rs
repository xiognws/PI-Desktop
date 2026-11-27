//! Log and trace analysis (deterministic, no model).
//!
//! The agent decides *whether* to analyse and what to do with the conclusion;
//! this layer compresses a raw log into a fixed shape: summary, timeline,
//! suspect stack frames, and advice per error class. A 20 MB log is tail-clipped
//! first, so the response body cannot be dragged down by the log's size and the
//! same input always produces the same output.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

/// Only the tail is kept: the failure scene is at the end, and the tens of
/// megabytes before it contribute nothing to the conclusion.
pub const MAX_LOG_CHARS: usize = 400_000;
pub const MAX_TIMELINE: usize = 40;
pub const MAX_SUSPECTS: usize = 10;
pub const MAX_SUGGESTIONS: usize = 5;
pub const MAX_LINE_CHARS: usize = 500;

fn timestamp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?|\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)\b",
        )
        .expect("static pattern")
    })
}

fn frame_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"File "([^"]+)", line (\d+)(?:, in (\S+))?"#).expect("static pattern"))
}

fn error_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\b(?:ERROR|FATAL|CRITICAL|FAILED|FAIL|AssertionError|TimeoutError|ConnectionError|KeyError|ValueError|TypeError|ImportError|ModuleNotFoundError|PermissionError|OSError|RuntimeError|Exception)\b",
        )
        .expect("static pattern")
    })
}

fn exception_any_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b([A-Za-z_][\w.]*(?:Error|Exception|Failure))\b").expect("static pattern"))
}

/// (exception name, what it means, what to check next)
const HINTS: [(&str, &str, &str); 11] = [
    ("AssertionError", "断言与实际结果不一致", "对照用例 expected 与实际返回值，确认是需求变了还是实现错了"),
    ("ModuleNotFoundError", "运行环境缺少依赖", "确认脚本依赖是否已装进执行环境的 PYTHONPATH"),
    ("ImportError", "模块导入失败", "检查导入路径与被测包是否在同一解释器环境"),
    ("TimeoutError", "等待超时", "确认超时阈值、下游服务健康状态与网络可达性"),
    ("ConnectionError", "连接失败", "确认目标地址、端口与鉴权配置"),
    ("ConnectionRefused", "目标端口无监听", "确认被测服务已启动且监听在预期地址"),
    ("PermissionError", "权限不足", "检查文件/端口/接口的权限与账号配置"),
    ("KeyError", "字段缺失", "对照接口契约，确认响应字段名与结构"),
    ("ValueError", "取值不合法", "检查输入数据构造与边界值"),
    ("TypeError", "类型不匹配", "检查入参类型与序列化/反序列化层"),
    ("RuntimeError", "运行时状态异常", "检查前置步骤是否成功、状态是否被提前释放"),
];

fn clip(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_LINE_CHARS {
        return text.to_string();
    }
    format!("{}…", chars[..MAX_LINE_CHARS].iter().collect::<String>())
}

/// The exception name can sit mid-line behind a timestamp/log prefix, so the
/// *last* type name on the line wins.
fn error_type(message: &str) -> String {
    exception_any_re()
        .find_iter(message)
        .map(|found| found.as_str().to_string())
        .last()
        .unwrap_or_default()
}

/// Best-effort exception name for a whole log/failure block. Bug creation needs
/// the same answer the analyser would give, without building the report.
pub fn guess_error_type(text: &str) -> String {
    for line in text.split('\n').rev() {
        let found = error_type(line);
        if !found.is_empty() {
            return found;
        }
    }
    String::new()
}

fn suggestions(error_type: &str, message: &str) -> Vec<String> {
    let mut picked: Vec<String> = Vec::new();
    for (key, reason, advice) in HINTS {
        if error_type.contains(key) || message.contains(key) {
            picked.push(format!("{reason}：{advice}"));
            if picked.len() >= MAX_SUGGESTIONS {
                break;
            }
        }
    }
    if picked.is_empty() {
        picked.push(
            "日志里没有可识别的异常类型：补充失败用例的执行命令与最小复现步骤，再做二次分析"
                .to_string(),
        );
    }
    picked
}

/// Compress a raw log into summary / timeline / suspect frames / advice.
pub fn analyze_log(raw_log: &str, trace_id: &str, module: &str) -> Value {
    let chars: Vec<char> = raw_log.chars().collect();
    let truncated = chars.len() > MAX_LOG_CHARS;
    let text: String = if truncated {
        chars[chars.len() - MAX_LOG_CHARS..].iter().collect()
    } else {
        raw_log.to_string()
    };

    let lines: Vec<&str> = text.split('\n').map(|line| line.trim_end_matches('\r')).collect();
    let mut timeline: Vec<Value> = Vec::new();
    let mut suspects: Vec<Value> = Vec::new();
    let mut error_lines: Vec<String> = Vec::new();

    for line in &lines {
        let stripped = line.trim();
        if stripped.is_empty() {
            continue;
        }
        if let Some(captures) = timestamp_re().captures(stripped) {
            if timeline.len() < MAX_TIMELINE {
                timeline.push(json!({
                    "time": captures.get(1).map(|item| item.as_str()).unwrap_or(""),
                    "line": clip(stripped),
                }));
            }
        }
        if error_re().is_match(stripped) {
            error_lines.push(stripped.to_string());
        }
        for captures in frame_re().captures_iter(line) {
            if suspects.len() >= MAX_SUSPECTS {
                break;
            }
            let mut suspect = json!({
                "file": captures.get(1).map(|item| item.as_str()).unwrap_or(""),
                "line": captures
                    .get(2)
                    .and_then(|item| item.as_str().parse::<i64>().ok())
                    .unwrap_or(0),
            });
            if let Some(function) = captures.get(3) {
                suspect["function"] = json!(function.as_str());
            }
            suspects.push(suspect);
        }
    }

    let last_error = error_lines.last().cloned().unwrap_or_default();
    // Take the last failure line that names an exception type, not literally the
    // last line: pytest closes with `FAILED x.py::t - assert ...`, which carries
    // no exception name — the real AssertionError is one line above.
    let mut detected = String::new();
    for line in error_lines.iter().rev() {
        detected = error_type(line);
        if !detected.is_empty() {
            break;
        }
    }
    let summary = if !last_error.is_empty() {
        clip(&last_error)
    } else {
        clip(
            lines
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .copied()
                .unwrap_or(""),
        )
    };
    let summary = if summary.is_empty() {
        "日志为空".to_string()
    } else {
        summary
    };

    let error = if last_error.is_empty() {
        Value::Null
    } else {
        json!({ "type": detected, "message": clip(&last_error) })
    };

    json!({
        "summary": summary,
        "error": error,
        "timeline": timeline,
        "suspects": suspects,
        "suggestions": suggestions(&detected, &last_error),
        "stats": {
            "lines": lines.len(),
            "truncated": truncated,
            "error_lines": error_lines.len(),
            "trace_id": trace_id,
            "module": module,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_exception_not_the_pytest_summary_line() {
        let result = analyze_log(
            "E   assert 5000 <= 4200\nValueError: 过压阈值不匹配\n",
            "",
            "BMS",
        );
        assert_eq!(result["summary"], "ValueError: 过压阈值不匹配");
        assert_eq!(result["error"]["type"], "ValueError");
        assert_eq!(result["stats"]["lines"], 3);
        assert_eq!(result["stats"]["error_lines"], 1);
        assert_eq!(
            result["suggestions"][0],
            "取值不合法：检查输入数据构造与边界值"
        );
    }
}
