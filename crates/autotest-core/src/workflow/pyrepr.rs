//! Python `repr()` / `str.format`-compatible rendering.
//!
//! Generated scripts embed case text as Python literals (`STEPS = ['…']`) and the
//! consistency messages quote values with `!r`. Both are compared against the
//! Python service output, so the quoting and escaping rules have to be the same
//! ones, not merely something Python would accept.

use serde_json::Value;

/// `repr(str)`: single quotes unless the text contains a single quote and no
/// double quote (then double quotes), with backslash and control characters
/// escaped.
pub fn repr_str(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch == quote => {
                out.push('\\');
                out.push(ch);
            }
            ch if (ch as u32) < 0x20 || ch as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push(quote);
    out
}

/// `repr()` of a JSON value as it appears in Python (`None`, `True`, numbers,
/// quoted strings).
pub fn repr_value(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => repr_str(text),
        other => other.to_string(),
    }
}

/// `repr([...])` for string lists — the shape `STEPS = [...]` and `EXPECTED = [...]`
/// are written in.
pub fn repr_str_list(items: &[String]) -> String {
    let rendered: Vec<String> = items.iter().map(|item| repr_str(item)).collect();
    format!("[{}]", rendered.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_like_python() {
        assert_eq!(repr_str("abc"), "'abc'");
        assert_eq!(repr_str("it's"), "\"it's\"");
        assert_eq!(repr_str("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(repr_str("a\nb"), "'a\\nb'");
        assert_eq!(repr_str("路径\\x"), "'路径\\\\x'");
        assert_eq!(repr_str_list(&["a".to_string(), "b'c".to_string()]), "['a', \"b'c\"]");
    }
}
