//! Real assertions generated from clause numbers through the DUT contract.
//!
//! Input is "the case plus its contract entry"; output is an assertion block that
//! can be pasted into a script. Three hard rules:
//!
//! 1. **Numbers only come from the clause** (`evidence.numbers`) — no literals.
//!    Change the clause and the assertion changes with it.
//! 2. **Four shapes only**: `==` (bool/number), `in` (contains), `pytest.raises`
//!    (must be rejected), plus a numeric tolerance. No compound expressions that
//!    merely look like they verify something.
//! 3. **It must be able to fail**: `mutation` is the same block with the
//!    expectation inverted, and `vacuity` runs it. A mutant that still passes
//!    means the assertion is empty.

use std::path::Path;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::Value;

use super::dut_contract::Entry;
use super::exception_matrix;
use super::pyrepr;

fn placeholder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\{\{(number|over|under|near)(?::(\d+))?(?::([+-]))?\}\}").expect("static pattern")
    })
}

fn numeric_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*(-?\d+(?:\.\d+)?)").expect("static pattern"))
}

#[derive(Debug)]
pub struct GenerationError(pub String);

impl std::fmt::Display for GenerationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug)]
pub struct Generated {
    pub body: Vec<String>,
}

fn numbers(case: &Value) -> Result<Vec<String>, GenerationError> {
    let numbers: Vec<String> = case
        .get("evidence")
        .and_then(|evidence| evidence.get("numbers"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| match item {
                    Value::String(text) if !text.is_empty() => Some(text.clone()),
                    Value::Null => None,
                    other if other.is_null() => None,
                    other => Some(text_of(other)),
                })
                .collect()
        })
        .unwrap_or_default();
    if numbers.is_empty() {
        return Err(GenerationError(
            "用例没有条款数值，不能生成断言".to_string(),
        ));
    }
    Ok(numbers)
}

fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        other => other.to_string(),
    }
}

/// Clause numbers are unit-bearing strings (`3.65V`); code needs only the number.
fn numeric(text: &str) -> Result<String, GenerationError> {
    match numeric_re().captures(text) {
        Some(captures) => Ok(captures
            .get(1)
            .map(|item| item.as_str().to_string())
            .unwrap_or_default()),
        None => Err(GenerationError(format!(
            "条款数值 {} 里没有可用的数字",
            pyrepr::repr_str(text)
        ))),
    }
}

fn decimals(value: f64) -> i32 {
    let text = format!("{value:.10}");
    let text = text.trim_end_matches('0');
    let text = text.strip_suffix('.').unwrap_or(text);
    match text.split_once('.') {
        Some((_, fraction)) => fraction.len() as i32,
        None => 0,
    }
}

/// Shift the clause number according to the placeholder kind, returning the
/// literal that goes into code (no unit).
fn offset(raw: &str, kind: &str, sign: &str) -> Result<String, GenerationError> {
    let base: f64 = numeric(raw)?.parse().unwrap_or(0.0);
    if kind == "number" {
        return numeric(raw);
    }
    let mut ratio: f64 = match kind {
        "over" => 0.10,
        "under" => -0.10,
        "near" => {
            if sign == "-" {
                -0.01
            } else {
                0.01
            }
        }
        _ => 0.01,
    };
    if kind == "near" {
        ratio = if sign != "-" { 0.01 } else { -0.01 };
    }
    // Same rule as `workflow.exception_matrix` (single source of truth): an
    // out-of-range step is 10 % but never finer than the clause precision
    // (5.5V → 6.05V, 5 times → 6 times); a boundary only moves 1 %.
    let step = if ratio.abs() < 0.05 {
        let floor = 10f64.powi(-(decimals(base) - 1).max(2));
        (base.abs() * ratio.abs()).max(floor)
    } else {
        exception_matrix::step_for(base)
    };
    let moved = if ratio > 0.0 {
        base + step
    } else {
        (base - step).max(0.0)
    };
    if moved.fract() == 0.0 && moved.abs() < 9.0e15 {
        return Ok(format!("{}", moved as i64));
    }
    let rendered = format!("{moved:.2}");
    Ok(rendered
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string())
}

fn substitute(line: &str, numbers: &[String], negative: bool) -> Result<String, GenerationError> {
    let mut error: Option<GenerationError> = None;
    let replaced = placeholder_re().replace_all(line, |captures: &Captures<'_>| {
        let mut kind = captures.get(1).map(|item| item.as_str()).unwrap_or("number");
        if negative && kind == "number" {
            // A negative case must be fed an out-of-range value: the contract only
            // carries the legal one, so the threshold derives it.
            kind = "over";
        }
        let index: usize = captures
            .get(2)
            .and_then(|item| item.as_str().parse().ok())
            .unwrap_or(0);
        let sign = captures.get(3).map(|item| item.as_str()).unwrap_or("+");
        if index >= numbers.len() {
            error = Some(GenerationError(format!(
                "占位符引用了第 {} 个数值，但条款只有 {} 个",
                index + 1,
                numbers.len()
            )));
            return String::new();
        }
        match offset(&numbers[index], kind, sign) {
            Ok(value) => value,
            Err(problem) => {
                error = Some(problem);
                String::new()
            }
        }
    });
    match error {
        Some(problem) => Err(problem),
        None => Ok(replaced.into_owned()),
    }
}

/// The script header that wires the DUT in and instantiates it.
///
/// Without it the generated assertion calls a `dut` that does not exist and the
/// script cannot even be collected.
fn preamble(driver: &str, imports: &[String], factory: &str) -> Vec<String> {
    let path = Path::new(driver);
    let module = path
        .file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "_support".to_string());
    let mut lines = vec![
        "    import sys".to_string(),
        "    from pathlib import Path".to_string(),
        format!(
            "    sys.path.insert(0, str(Path(__file__).resolve().parent / \"{folder}\"))"
        ),
    ];
    if !module.is_empty() && !imports.is_empty() {
        lines.push(format!("    from {module} import {}", imports.join(", ")));
    }
    lines.push(format!("    dut = {factory}"));
    lines
}

/// Generate the assertion block; `body` and `mutation` are statement lines
/// indented by four spaces.
///
/// `polarity="negative"` is for exception cases: the contract must declare
/// `expect.kind: raises`, otherwise the contract has not said that this point
/// should be rejected, and no assertion is generated rather than a fake one.
pub fn generate(
    case: &Value,
    entry: &Entry,
    driver: &str,
    imports: &[String],
    polarity: Option<&str>,
) -> Result<Generated, GenerationError> {
    let numbers = numbers(case)?;
    let negative = polarity == Some("negative");
    let prelude = preamble(driver, imports, &entry.factory);
    let mut arrange: Vec<String> = Vec::new();
    for line in &entry.arrange {
        arrange.push(format!("    {}", substitute(line, &numbers, negative)?));
    }
    let observe = &entry.observe;
    let kind = entry.kind();
    let value = entry.value();
    let label = &entry.function_point;

    if negative && kind != "raises" {
        return Err(GenerationError(format!(
            "契约把 {label} 写成 {kind}，没有声明该点会被拒绝；异常用例不能用合法值断言"
        )));
    }

    let body: Vec<String> = if kind == "raises" {
        // The exception class is a bare name; quoting it would not run
        // (`pytest.raises('ValueError')`).
        let exception = entry.value_text();
        if negative {
            let mut lines = prelude.clone();
            lines.push("    import pytest".to_string());
            lines.push(format!("    with pytest.raises({exception}):"));
            for line in &arrange {
                lines.push(format!("        {}", line.trim()));
            }
            lines
        } else {
            // A positive case cannot use the same shape: the contract says the
            // out-of-range value is rejected, so a legal value must **not** be.
            // Copying `raises` would fail the positive case for a component that
            // (correctly) does not raise.
            let mut lines = prelude.clone();
            lines.push("    import pytest".to_string());
            lines.push("    try:".to_string());
            for line in &arrange {
                lines.push(format!("        {}", line.trim()));
            }
            lines.push(format!("    except {exception} as problem:"));
            lines.push(format!(
                "        pytest.fail(f\"{label}：合法输入不应被拒绝（{{problem}}）\")"
            ));
            lines
        }
    } else if kind == "bool" {
        let expected = if value.as_bool().unwrap_or(false) {
            "True"
        } else {
            "False"
        };
        let mut lines = prelude.clone();
        lines.extend(arrange.clone());
        lines.push(format!(
            "    assert {observe} is {expected}, \"{label} 的判定应为 {expected}\""
        ));
        lines
    } else if kind == "contains" {
        let mut lines = prelude.clone();
        lines.extend(arrange.clone());
        lines.push(format!(
            "    assert {} in {observe}, \"{label} 的判定应包含 {}\"",
            json_literal(&value),
            text_of(&value)
        ));
        lines
    } else if kind == "number" {
        let literal = json_literal(&value);
        let mut lines = prelude.clone();
        lines.extend(arrange.clone());
        if entry.tolerance != 0.0 {
            let tolerance = py_float(entry.tolerance);
            lines.push(format!(
                "    assert abs({observe} - {literal}) <= {tolerance}, f\"{label} 的判定应在 {literal} ± {tolerance} 内\""
            ));
        } else {
            lines.push(format!(
                "    assert {observe} == {literal}, f\"{label} 的判定应为 {literal}\""
            ));
        }
        lines
    } else {
        return Err(GenerationError(format!("不支持的 expect.kind：{kind}")));
    };

    Ok(Generated { body })
}

/// The same block with the expectation inverted, for the vacuity check.
///
/// Only the expectation flips; the driving input stays. An assertion that really
/// verifies something must fail once its expectation is reversed — if the mutant
/// still passes, the assertion was never verifying anything (for instance a
/// tautology).
pub fn invert(
    case: &Value,
    entry: &Entry,
    driver: &str,
    imports: &[String],
) -> Result<Vec<String>, GenerationError> {
    let numbers = numbers(case)?;
    let prelude = preamble(driver, imports, &entry.factory);
    let mut arrange: Vec<String> = Vec::new();
    for line in &entry.arrange {
        arrange.push(format!("    {}", substitute(line, &numbers, false)?));
    }
    let observe = &entry.observe;
    let kind = entry.kind();
    let value = entry.value();
    let label = &entry.function_point;

    if kind == "raises" {
        // Reversed means "expected to be rejected". A real DUT does not reject a
        // legal input, so this mutant must fail — if it passes, the assertion
        // never took effect.
        let mut lines = prelude;
        lines.push("    import pytest".to_string());
        lines.push(format!("    with pytest.raises({}):", entry.value_text()));
        for line in &arrange {
            lines.push(format!("        {}", line.trim()));
        }
        return Ok(lines);
    }
    if kind == "bool" {
        let flipped = if value.as_bool().unwrap_or(false) {
            "False"
        } else {
            "True"
        };
        let mut lines = prelude;
        lines.extend(arrange);
        lines.push(format!(
            "    assert {observe} is {flipped}, \"{label} 的变异体\""
        ));
        return Ok(lines);
    }
    if kind == "contains" {
        let mut lines = prelude;
        lines.extend(arrange);
        lines.push(format!(
            "    assert {} in {observe}, \"{label} 的变异体\"",
            json_literal(&Value::String(format!("{}_不存在", text_of(&value))))
        ));
        return Ok(lines);
    }
    if kind == "number" {
        let base = value.as_f64().unwrap_or(0.0);
        let step = if entry.tolerance != 0.0 {
            entry.tolerance * 2.0
        } else {
            (base.abs() * 0.5).max(1.0)
        };
        let shifted = py_float(base + step);
        let tolerance = py_float(entry.tolerance);
        let mut lines = prelude;
        lines.extend(arrange);
        lines.push(format!(
            "    assert abs({observe} - {shifted}) <= {tolerance}, \"{label} 的变异体\""
        ));
        return Ok(lines);
    }
    Err(GenerationError(format!("不支持的 expect.kind：{kind}")))
}

/// A contract value as a Python literal (strings keep their quotes).
pub fn json_literal(value: &Value) -> String {
    match value {
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => pyrepr::repr_str(text),
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

/// `str(float)` — Python always shows a float as a float (`5.0`, not `5`).
pub fn py_float(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        return format!("{}.0", value as i64);
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(kind: &str, value: Value) -> Entry {
        Entry {
            function_point: "过压保护".to_string(),
            factory: "Dut()".to_string(),
            arrange: vec!["dut.set_voltage({{number:0}})".to_string()],
            observe: "dut.over_voltage".to_string(),
            expect: json!({ "kind": kind, "value": value }),
            tolerance: 0.0,
        }
    }

    fn case() -> Value {
        json!({ "evidence": { "numbers": ["4200mV", "200ms"] } })
    }

    #[test]
    fn bool_assertion_quotes_the_number_from_the_clause() {
        let generated = generate(&case(), &entry("bool", json!(true)), "_support/dut.py", &["Dut".to_string()], None)
            .expect("generated");
        let text = generated.body.join("\n");
        assert!(text.contains("dut.set_voltage(4200)"));
        assert!(text.contains("assert dut.over_voltage is True"));
        assert!(text.contains("from dut import Dut"));
        let mutation = invert(
            &case(),
            &entry("bool", json!(true)),
            "_support/dut.py",
            &["Dut".to_string()],
        )
        .expect("mutation");
        assert!(mutation.join("\n").contains("is False"));
    }

    #[test]
    fn negative_polarity_requires_raises() {
        let problem = generate(
            &case(),
            &entry("bool", json!(true)),
            "_support/dut.py",
            &[],
            Some("negative"),
        )
        .expect_err("must not generate");
        assert!(problem.0.contains("没有声明该点会被拒绝"));
    }

    #[test]
    fn missing_numbers_is_a_generation_error() {
        let problem = generate(&json!({}), &entry("bool", json!(true)), "", &[], None)
            .expect_err("must not generate");
        assert!(problem.0.contains("没有条款数值"));
    }
}
