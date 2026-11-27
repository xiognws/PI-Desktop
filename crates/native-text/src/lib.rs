//! Decode text that a Windows program produced, without assuming it is UTF-8.
//!
//! A child process on a Chinese Windows box writes its output in whatever
//! encoding it thinks the console wants: python without `PYTHONUTF8` and a `.bat`
//! builtin both emit the ANSI code page (936), PowerShell redirection emits
//! UTF-16, and a well-behaved tool emits UTF-8. Judging all of it as UTF-8 turns
//! every Chinese character from the first two into replacement characters — one
//! per byte, so `但` (`b5 ab` in GBK) becomes `��`.
//!
//! The decision is made per line, not per buffer: a log that concatenates two
//! tools' output is genuinely mixed, and each line is almost always written by
//! one program. Splitting on `\n` is safe for the multi-byte code pages this
//! cares about (GBK, Big5, Shift_JIS all forbid `0x0A` as a trailing byte).
//!
//! Order of preference, per line:
//!   1. valid UTF-8 — the modern answer, and what a BOM would announce anyway;
//!   2. the Windows ANSI code page (`CP_ACP`) — covers the default of every
//!      program that never chose an encoding;
//!   3. UTF-8 with replacement, so a line that is genuinely broken still renders.

/// Tell a child process to speak UTF-8, when the host is not already saying so.
///
/// This is the prevention half of `decode_native_text`: on a Chinese Windows box
/// a program that is never told an encoding writes the ANSI code page, so python
/// prints GBK and `open(path, "w")` stores GBK. An install started from Explorer
/// has none of these variables set, which is why its scripts produced GBK files
/// while the same scripts run from a configured shell produced UTF-8.
///
/// Only the variables the child reads, and only as a default: a value the user
/// already set is passed through untouched, and a per-call override still wins
/// because callers apply their own environment after this list.
pub const CHILD_UTF8_ENV: [(&str, &str); 2] =
    [("PYTHONUTF8", "1"), ("PYTHONIOENCODING", "utf-8")];

/// Decode a buffer that arrived from a native program or file.
///
/// A UTF-8 or UTF-16 byte-order mark decides the whole buffer; otherwise each
/// line is decoded on its own.
pub fn decode_native_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(rest, false);
    }

    let mut out = String::with_capacity(bytes.len());
    for line in split_keeping_newlines(bytes) {
        match std::str::from_utf8(line) {
            Ok(text) => out.push_str(text),
            Err(_) => match decode_ansi(line) {
                Some(text) => out.push_str(&text),
                None => out.push_str(&String::from_utf8_lossy(line)),
            },
        }
    }
    out
}

/// The ANSI code page accepts almost any byte pair, and maps the pairs it has no
/// character for into the private use area. A line that is mostly private-use
/// characters was not text in that code page — it was binary, or another
/// encoding — and the replacement characters of a lossy decode say so honestly.
/// A rare CJK extension character among ordinary text keeps the ANSI reading.
#[cfg(windows)]
fn is_plausible_ansi_text(text: &str) -> bool {
    let private: usize = text
        .chars()
        .filter(|character| ('\u{E000}'..='\u{F8FF}').contains(character))
        .count();
    let non_ascii = text.chars().filter(|character| !character.is_ascii()).count();
    private == 0 || private * 2 <= non_ascii
}

fn split_keeping_newlines(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut start = 0;
    let mut index = 0;
    std::iter::from_fn(move || {
        if start >= bytes.len() {
            return None;
        }
        while index < bytes.len() {
            if bytes[index] == b'\n' {
                index += 1;
                break;
            }
            index += 1;
        }
        let slice = &bytes[start..index];
        start = index;
        Some(slice)
    })
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(windows)]
fn decode_ansi(bytes: &[u8]) -> Option<String> {
    let text = decode_windows_code_page(bytes, windows_sys::Win32::Globalization::CP_ACP)?;
    is_plausible_ansi_text(&text).then_some(text)
}

#[cfg(not(windows))]
fn decode_ansi(_bytes: &[u8]) -> Option<String> {
    None
}

#[cfg(windows)]
fn decode_windows_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    let byte_len = i32::try_from(bytes.len()).ok()?;
    if byte_len == 0 {
        return Some(String::new());
    }
    let wide_len =
        unsafe { MultiByteToWideChar(code_page, 0, bytes.as_ptr(), byte_len, null_mut(), 0) };
    if wide_len <= 0 {
        return None;
    }
    let mut wide = vec![0u16; wide_len as usize];
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            byte_len,
            wide.as_mut_ptr(),
            wide_len,
        )
    };
    if written <= 0 {
        return None;
    }
    wide.truncate(written as usize);
    Some(String::from_utf16_lossy(&wide))
}

#[cfg(test)]
mod tests {
    use super::decode_native_text;

    #[test]
    fn utf8_passes_through_unchanged() {
        let text = "本闸不判红，但会在输出里提示 ⇒ 🚀";
        assert_eq!(decode_native_text(text.as_bytes()), text);
    }

    /// The case the whole crate exists for: GBK bytes are not UTF-8, and the
    /// per-byte lossy answer (`��`) is what showed up in a client transcript.
    #[test]
    fn gbk_bytes_decode_to_the_characters_that_were_written() {
        // "但" in GBK
        assert_eq!(decode_native_text(b"\xb5\xab"), "但");
        // "中文" in GBK
        assert_eq!(decode_native_text(b"\xd6\xd0\xce\xc4"), "中文");
        // a whole GBK line, as `cmd` or a python child without PYTHONUTF8 writes it
        let gbk = b"\xb1\xbe\xd5\xa2\xb2\xbb\xc5\xd0\xba\xec\r\n";
        assert_eq!(decode_native_text(gbk), "本闸不判红\r\n");
    }

    #[test]
    fn a_utf8_bom_is_stripped_and_its_body_kept() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("中文".as_bytes());
        assert_eq!(decode_native_text(&bytes), "中文");
    }

    #[test]
    fn utf16_redirection_output_decodes_both_ways() {
        // "中文" as UTF-16, which is what PowerShell's `>` writes
        let little = [0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65];
        assert_eq!(decode_native_text(&little), "中文");
        let big = [0xFE, 0xFF, 0x4E, 0x2D, 0x65, 0x87];
        assert_eq!(decode_native_text(&big), "中文");
    }

    /// A log that interleaves two tools keeps both readable — this is why the
    /// decision is per line instead of per buffer.
    #[test]
    fn mixed_lines_are_decoded_line_by_line() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice("utf8 line 中文\n".as_bytes());
        bytes.extend_from_slice(b"\xd6\xd0\xce\xc4 gbk line\n");
        assert_eq!(decode_native_text(&bytes), "utf8 line 中文\n中文 gbk line\n");
    }

    #[test]
    fn broken_bytes_still_render_instead_of_panicking() {
        let text = decode_native_text(b"ok\xff\xfeok");
        assert!(text.starts_with("ok"), "{text:?}");
        assert!(text.ends_with("ok"), "{text:?}");
        assert_eq!(decode_native_text(b""), "");
    }

    #[test]
    fn the_old_answer_is_pinned_so_the_regression_is_visible() {
        // Two bytes that are not UTF-8, decoded the way the client used to.
        assert_eq!(String::from_utf8_lossy(b"\xb5\xab"), "\u{FFFD}\u{FFFD}");
    }
}
