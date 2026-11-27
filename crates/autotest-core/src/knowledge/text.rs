//! Character-counted string helpers.
//!
//! Python's `len(str)` counts code points and its slicing is code-point based,
//! so chunking has to be too: a `chars().count()` and a `char`-indexed slice are
//! what keep the chunk boundaries identical to the Python service. Byte offsets
//! would split a CJK character in half and change every downstream count.

/// `len(text)` in Python terms.
pub fn char_len(text: &str) -> usize {
    text.chars().count()
}

/// `text[start:end]` in Python terms.
pub fn slice_chars(text: &str, start: usize, end: usize) -> String {
    text.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}

/// `text[-count:]` in Python terms.
pub fn tail_chars(text: &str, count: usize) -> String {
    if count == 0 {
        return String::new();
    }
    let total = char_len(text);
    if total <= count {
        return text.to_string();
    }
    slice_chars(text, total - count, total)
}

/// `text.replace("\r\n", "\n").replace("\r", "\n")`.
pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_code_points_not_bytes() {
        assert_eq!(char_len("单体电压"), 4);
        assert_eq!(slice_chars("单体电压", 1, 3), "体电");
        assert_eq!(tail_chars("单体电压", 2), "电压");
        assert_eq!(tail_chars("单体电压", 9), "单体电压");
    }

    #[test]
    fn normalizes_crlf_and_cr() {
        assert_eq!(normalize_newlines("a\r\nb\rc"), "a\nb\nc");
    }
}
