//! Cases → pytest scripts (deterministic template).
//!
//! The generated file is a skeleton that can be collected and run: the case steps
//! and expectations become module constants and the test function holds an
//! explicit skip. Whoever fills in the implementation does not have to rewrite the
//! header, the executor can collect the case immediately, and the report's case
//! count lines up with the design stage.
//!
//! The text is reproduced byte for byte, including the Python literal quoting of
//! the module constants — the fixtures compare total line counts.

use serde_json::{json, Value};

use super::pyrepr;

pub const MAX_SCRIPT_CASE_CHARS: usize = 200;

fn clip(value: &str) -> String {
    let text = value.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_SCRIPT_CASE_CHARS {
        return text.to_string();
    }
    format!(
        "{}…",
        chars[..MAX_SCRIPT_CASE_CHARS].iter().collect::<String>()
    )
}

fn clip_field(case: &Value, key: &str) -> String {
    clip(case.get(key).and_then(Value::as_str).unwrap_or(""))
}

/// Text that goes inside the triple-quoted docstring.
///
/// Case text comes from a requirement or a model: a double quote, a triple quote
/// or a backslash closes the docstring and the generated file never parses again
/// (one HTML attribute in a requirement was enough to hit this).
fn doc_safe(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace("\"\"\"", "\\\"\\\"\\\"")
        .replace('\r', " ")
        .replace('\n', " ")
}

/// Text that goes inside a `#` comment: newlines flattened, or the extra lines
/// become bare code.
fn comment_safe(text: &str) -> String {
    text.replace('\r', " ").replace('\n', " ")
}

fn slug(case: &Value) -> String {
    let seed = format!(
        "{}|{}|{}",
        case.get("title").and_then(Value::as_str).unwrap_or(""),
        case.get("function_point").and_then(Value::as_str).unwrap_or(""),
        case.get("case_type").and_then(Value::as_str).unwrap_or(""),
    );
    format!("case_{}", super::hashes::sha1_prefix(seed.as_bytes(), 8))
}

fn string_list(case: &Value, key: &str) -> Vec<String> {
    case.get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One case → one script file body.
pub fn author_script(case: &Value, sdk: &str, assertion_body: Option<&[String]>) -> Result<Value, String> {
    if sdk != "pytest" {
        return Err(format!("unsupported script sdk: {sdk}"));
    }

    let title = {
        let value = clip_field(case, "title");
        if value.is_empty() {
            "未命名用例".to_string()
        } else {
            value
        }
    };
    let function_point = clip_field(case, "function_point");
    let case_type = {
        let value = clip_field(case, "case_type");
        if value.is_empty() {
            "功能".to_string()
        } else {
            value
        }
    };
    let priority = {
        let value = clip_field(case, "priority");
        if value.is_empty() {
            "中".to_string()
        } else {
            value
        }
    };
    let precondition = {
        let value = clip_field(case, "precondition");
        if value.is_empty() {
            "测试环境就绪".to_string()
        } else {
            value
        }
    };

    let steps: Vec<String> = string_list(case, "steps")
        .iter()
        .map(|item| {
            let value = clip(item);
            if value.is_empty() {
                "-".to_string()
            } else {
                value
            }
        })
        .collect();
    let expected: Vec<String> = string_list(case, "expected")
        .iter()
        .map(|item| {
            let value = clip(item);
            if value.is_empty() {
                "-".to_string()
            } else {
                value
            }
        })
        .collect();

    let steps_comment = if steps.is_empty() {
        "    #   （用例未给出步骤）".to_string()
    } else {
        steps
            .iter()
            .enumerate()
            .map(|(index, step)| format!("    #   {}. {}", index + 1, comment_safe(step)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let expected_comment = if expected.is_empty() {
        "    #   （用例未给出预期）".to_string()
    } else {
        expected
            .iter()
            .map(|item| format!("    #   - {}", comment_safe(item)))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let function_point_text = if function_point.is_empty() {
        "未标注".to_string()
    } else {
        function_point.clone()
    };
    let slug = slug(case);
    let notice = pyrepr::repr_str(&format!("骨架未实现：{title}"));
    let body_or_skip = match assertion_body {
        // With contract assertions the function body is the assertions: no
        // "skeleton not implemented" print any more.
        Some(lines) if !lines.is_empty() => lines.join("\n"),
        _ => format!(
            "    if \"PYTEST_CURRENT_TEST\" in os.environ:\n        import pytest\n\n        pytest.skip(\"自动生成的骨架：补充被测调用与断言后重新执行\")\n    print({notice})"
        ),
    };

    let mut content = String::new();
    content.push_str(&format!("\"\"\"自动生成：{}\n", doc_safe(&title)));
    content.push_str("\n");
    content.push_str(&format!("功能点：{}\n", doc_safe(&function_point_text)));
    content.push_str(&format!("类型：{case_type}    优先级：{priority}\n"));
    content.push_str("生成方式：workflow author_script（确定性模板，未调用模型）\n");
    content.push_str("\n");
    content.push_str("两种运行方式都支持：\n");
    content.push_str("  pytest <file>          收集为用例（骨架阶段 skip）\n");
    content.push_str("  python <file>          直接执行（骨架阶段打印提示后退出 0）\n");
    content.push_str("\"\"\"\n");
    content.push_str("\n");
    content.push_str("import os\n");
    content.push_str("\n");
    content.push_str(&format!("CASE_TITLE = {}\n", pyrepr::repr_str(&title)));
    content.push_str(&format!(
        "FUNCTION_POINT = {}\n",
        pyrepr::repr_str(&function_point)
    ));
    content.push_str(&format!("CASE_TYPE = {}\n", pyrepr::repr_str(&case_type)));
    content.push_str(&format!("PRIORITY = {}\n", pyrepr::repr_str(&priority)));
    content.push_str(&format!(
        "PRECONDITION = {}\n",
        pyrepr::repr_str(&precondition)
    ));
    content.push_str(&format!("STEPS = {}\n", pyrepr::repr_str_list(&steps)));
    content.push_str(&format!("EXPECTED = {}\n", pyrepr::repr_str_list(&expected)));
    content.push_str("\n");
    content.push_str("\n");
    content.push_str(&format!("def test_{slug}():\n"));
    content.push_str(&format!("    \"\"\"{}\"\"\"\n", doc_safe(&title)));
    content.push_str(&format!(
        "    # 前置：{}\n",
        comment_safe(&precondition)
    ));
    content.push_str("    # 步骤：\n");
    content.push_str(&steps_comment);
    content.push('\n');
    content.push_str("    # 预期：\n");
    content.push_str(&expected_comment);
    content.push('\n');
    content.push_str("    # 判定用 env 而不是 sys.modules：本文件自己 import 过 pytest 也不算\n");
    content.push_str("    # \"在 pytest 里跑\"；PYTEST_CURRENT_TEST 只在 pytest 执行用例时存在。\n");
    content.push_str(&body_or_skip);
    content.push('\n');
    content.push('\n');
    content.push('\n');
    content.push_str("if __name__ == \"__main__\":\n");
    content.push_str(&format!("    test_{slug}()\n"));

    let lines = content.matches('\n').count();
    Ok(json!({
        "name": format!("{slug}.py"),
        "language": "python",
        "content": content,
        "case_ref": {
            "title": title,
            "function_point": function_point,
            "case_type": case_type,
            "priority": priority,
        },
        "stats": {
            "steps": steps.len(),
            "expected": expected.len(),
            "lines": lines,
        },
    }))
}

/// Batch authoring; anything past 200 cases is dropped, matching the case ceiling.
/// `assertions` maps case title → assertion block produced by the contract
/// generator; a case without one stays a skeleton.
pub fn author_scripts(
    cases: &[Value],
    sdk: &str,
    assertions: &std::collections::BTreeMap<String, Vec<String>>,
) -> Result<Value, String> {
    let mut scripts: Vec<Value> = Vec::new();
    for case in cases.iter().take(200) {
        let title = case.get("title").and_then(Value::as_str).unwrap_or("");
        let body = assertions.get(title).map(|lines| lines.as_slice());
        scripts.push(author_script(case, sdk, body)?);
    }
    let lines: i64 = scripts
        .iter()
        .map(|item| item["stats"]["lines"].as_i64().unwrap_or(0))
        .sum();
    Ok(json!({
        "scripts": scripts,
        "stats": { "total": scripts.len(), "sdk": sdk, "lines": lines },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_has_the_collectable_shape() {
        let case = json!({
            "title": "过压保护-主流程",
            "function_point": "过压保护",
            "case_type": "功能",
            "priority": "高",
            "precondition": "台架就绪",
            "steps": ["进入入口", "执行操作", "检查结果"],
            "expected": ["结果符合原文"],
        });
        let script = author_script(&case, "pytest", None).expect("script");
        let content = script["content"].as_str().expect("content");
        assert!(content.contains("生成方式："));
        assert!(content.contains("pytest.skip("));
        assert!(content.contains("if __name__ == \"__main__\":"));
        assert!(content.contains("STEPS = ['进入入口', '执行操作', '检查结果']"));
    }
}
