//! Turn a file's bytes into plain text.
//!
//! Ported from `autotest/knowledge/extract.py`. The rule there still holds: do
//! not guess a format, do not degrade silently. A known structured format is
//! read as text, HTML is stripped to its text nodes, `.docx` is read out of the
//! ZIP's `word/document.xml`. Unknown extensions are rejected, and an empty
//! extraction is an error — never a successful import that produced zero chunks.
//!
//! Two Python capabilities are not reproduced, because the Rust build cannot
//! link Python and no new crate may be added offline: PDF (pdfplumber) and the
//! GB18030 fallback decoding. Both answer 400 with a message saying so, instead
//! of importing mojibake or an empty document.

use std::sync::OnceLock;

use regex::Regex;

use super::text::{char_len, normalize_newlines, slice_chars};
use super::zip;

pub const MAX_FILE_BYTES: usize = 40 * 1024 * 1024;
pub const MAX_CHARS: usize = 3_000_000;

const TEXT_SUFFIXES: &[&str] = &[
    ".md",
    ".markdown",
    ".txt",
    ".log",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".xml",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".java",
    ".c",
    ".h",
    ".cpp",
    ".cs",
    ".sql",
    ".sh",
    ".ps1",
    ".bat",
    ".robot",
    ".feature",
];
const HTML_SUFFIXES: &[&str] = &[".html", ".htm", ".xhtml"];
const PDF_SUFFIXES: &[&str] = &[".pdf"];
const DOCX_SUFFIXES: &[&str] = &[".docx"];
const XLSX_SUFFIXES: &[&str] = &[".xlsx"];

const MAX_XLSX_ROWS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub text: String,
    pub format: String,
    pub truncated: bool,
}

/// Lowercase suffix including the dot, `""` when there is none — the same
/// answer as `Path(filename).suffix.lower()` in Python.
pub fn suffix_of(filename: &str) -> String {
    let name = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    match name.rsplit_once('.') {
        // A leading dot is a hidden file name, not an extension (`.bashrc`).
        Some((stem, extension)) if !stem.is_empty() => format!(".{}", extension.to_lowercase()),
        _ => String::new(),
    }
}

pub fn is_supported(filename: &str) -> bool {
    let suffix = suffix_of(filename);
    supported_suffixes().iter().any(|item| item == &suffix)
}

/// Every supported suffix, sorted and comma separated — the tail of the
/// "this file type is not supported" message.
fn supported_suffixes() -> &'static [String] {
    static LIST: OnceLock<Vec<String>> = OnceLock::new();
    LIST.get_or_init(|| {
        let mut all: Vec<String> = TEXT_SUFFIXES
            .iter()
            .chain(HTML_SUFFIXES)
            .chain(PDF_SUFFIXES)
            .chain(DOCX_SUFFIXES)
            .chain(XLSX_SUFFIXES)
            .map(|suffix| (*suffix).to_string())
            .collect();
        all.sort();
        all
    })
}

fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<[^>]*>").expect("tag regex"))
}

fn comment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").expect("comment regex"))
}

fn script_style_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?is)<(script|style)\b[^>]*>.*?</(script|style)\s*>").expect("script regex")
    })
}

fn entity_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);").expect("entity regex")
    })
}

fn decode(raw: &[u8]) -> Result<String, String> {
    // Python tried utf-8, utf-8-sig, then gb18030. The first two differ only in
    // BOM handling, and the digest below strips BOMs either way; the GB18030
    // fallback needs an encoding table that is not in the frozen crate set.
    match std::str::from_utf8(raw) {
        Ok(text) => Ok(strip_bom(text)),
        Err(_) => Err("文件不是 UTF-8 / GB18030 文本，且格式未识别".to_string()),
    }
}

fn strip_bom(text: &str) -> String {
    text.trim_start_matches('\u{feff}').to_string()
}

fn clip(text: &str) -> (String, bool) {
    if char_len(text) <= MAX_CHARS {
        return (text.to_string(), false);
    }
    let keep = slice_chars(text, 0, MAX_CHARS);
    (
        format!("{keep}\n\n[内容超过 {MAX_CHARS} 字符，已截断]"),
        true,
    )
}

fn decode_entities(text: &str) -> String {
    entity_re()
        .replace_all(text, |captures: &regex::Captures<'_>| {
            let body = &captures[1];
            if let Some(number) = body.strip_prefix('#') {
                let code = if let Some(hex) = number
                    .strip_prefix('x')
                    .or_else(|| number.strip_prefix('X'))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    number.parse::<u32>().ok()
                };
                return code
                    .and_then(char::from_u32)
                    .map(|character| character.to_string())
                    .unwrap_or_else(|| captures[0].to_string());
            }
            match named_entity(body) {
                Some(replacement) => replacement.to_string(),
                None => captures[0].to_string(),
            }
        })
        .into_owned()
}

/// The named entities a specification document realistically contains. Anything
/// else is left as written rather than dropped.
fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ensp" => " ",
        "emsp" => " ",
        "thinsp" => " ",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "middot" => "·",
        "bull" => "•",
        "times" => "×",
        "divide" => "÷",
        "plusmn" => "±",
        "deg" => "°",
        "laquo" => "«",
        "raquo" => "»",
        "ldquo" => "“",
        "rdquo" => "”",
        "lsquo" => "‘",
        "rsquo" => "’",
        "sect" => "§",
        "para" => "¶",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "le" => "≤",
        "ge" => "≥",
        "ne" => "≠",
        "asymp" => "≈",
        "infin" => "∞",
        "sum" => "∑",
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "lambda" => "λ",
        "mu" => "μ",
        "pi" => "π",
        _ => return None,
    })
}

fn html_to_text(raw: &[u8]) -> Result<String, String> {
    let html = decode(raw)?;
    let without_comments = comment_re().replace_all(&html, "");
    let without_scripts = script_style_re().replace_all(&without_comments, "");
    // BeautifulSoup's `get_text("\n")` separates every text node with a newline;
    // replacing each tag with one keeps the same block boundaries.
    let separated = tag_re().replace_all(&without_scripts, "\n");
    let decoded = decode_entities(&separated);
    let lines: Vec<&str> = decoded
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    Ok(lines.join("\n"))
}

/// XML entity decoding, in one pass so `&amp;#20449;` is not decoded twice.
/// openpyxl writes every non-ASCII character as a numeric reference
/// (`&#20449;`), so numeric references are the common case, not an edge case.
fn xml_unescape(text: &str) -> String {
    decode_entities(text)
}

fn docx_to_text(raw: &[u8]) -> Result<String, String> {
    let document = zip::read_entry(raw, "word/document.xml")?
        .ok_or("Word 文件缺少 word/document.xml，无法读取正文")?;
    let xml = decode(&document)?;
    let styles = zip::read_entry(raw, "word/styles.xml")?
        .map(|bytes| decode(&bytes))
        .transpose()?
        .unwrap_or_default();

    let mut parts: Vec<String> = Vec::new();
    let tables = block_contents(&xml, "w:tbl");
    let body = without_blocks(&xml, "w:tbl");
    for paragraph in block_contents(&body, "w:p") {
        let text = paragraph_text(&paragraph);
        if text.is_empty() {
            continue;
        }
        let style = paragraph_style(&paragraph)
            .map(|style_id| style_name(&styles, &style_id))
            .unwrap_or_default()
            .to_lowercase();
        // A table of contents is a copy of the headings; keeping it makes every
        // TOC line look like a section and shreds the real body.
        if style.starts_with("toc") {
            continue;
        }
        if style.starts_with("heading") {
            let level: String = style.chars().filter(char::is_ascii_digit).collect();
            let level: usize = level.parse().unwrap_or(1).clamp(1, 6);
            parts.push(format!("{} {text}", "#".repeat(level)));
        } else {
            parts.push(text);
        }
    }
    for table in tables {
        for row in block_contents(&table, "w:tr") {
            let mut cells: Vec<String> = Vec::new();
            for cell in block_contents(&row, "w:tc") {
                let paragraphs: Vec<String> = block_contents(&cell, "w:p")
                    .iter()
                    .map(|paragraph| paragraph_text(paragraph))
                    .filter(|text| !text.is_empty())
                    .collect();
                cells.push(paragraphs.join("\n"));
            }
            if cells.iter().any(|cell| !cell.is_empty()) {
                parts.push(format!("| {} |", cells.join(" | ")));
            }
        }
    }
    Ok(parts.join("\n\n"))
}

fn block_re(tag: &str) -> Regex {
    Regex::new(&format!(r"(?s)<{tag}\b[^>]*>(.*?)</{tag}\s*>")).expect("block regex")
}

/// Every complete `<tag>…</tag>` body. Nested tables of the same name are not
/// handled — a document nested inside itself is not a shape Word produces.
fn block_contents(xml: &str, tag: &str) -> Vec<String> {
    block_re(tag)
        .captures_iter(xml)
        .map(|captures| captures[1].to_string())
        .collect()
}

fn without_blocks(xml: &str, tag: &str) -> String {
    block_re(tag).replace_all(xml, "").into_owned()
}

fn run_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)<w:t(?:\s[^>]*)?>(.*?)</w:t>|<w:tab\s*/>|<w:(?:br|cr)\s*/>")
            .expect("run token regex")
    })
}

fn paragraph_text(paragraph: &str) -> String {
    let mut text = String::new();
    for captures in run_token_re().captures_iter(paragraph) {
        match captures.get(1) {
            Some(run) => text.push_str(&xml_unescape(run.as_str())),
            None => {
                if captures[0].starts_with("<w:tab") {
                    text.push('\t');
                } else {
                    text.push('\n');
                }
            }
        }
    }
    text.trim().to_string()
}

fn paragraph_style(paragraph: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"<w:pStyle\s+w:val="([^"]*)""#).expect("paragraph style regex")
    });
    re.captures(paragraph)
        .map(|captures| captures[1].to_string())
        .filter(|style| !style.is_empty())
}

/// `styleId` → `w:name` from `word/styles.xml`. Word stores the heading level in
/// the style *name* ("heading 1"), while the id may be localized ("1").
fn style_name(styles: &str, style_id: &str) -> String {
    static STYLE_RE: OnceLock<Regex> = OnceLock::new();
    let re = STYLE_RE.get_or_init(|| {
        Regex::new(r#"(?s)<w:style\b[^>]*w:styleId="([^"]*)"[^>]*>(.*?)</w:style\s*>"#)
            .expect("style regex")
    });
    static NAME_RE: OnceLock<Regex> = OnceLock::new();
    let name_re = NAME_RE
        .get_or_init(|| Regex::new(r#"<w:name\s+w:val="([^"]*)""#).expect("style name regex"));
    for captures in re.captures_iter(styles) {
        if captures[1] != *style_id {
            continue;
        }
        if let Some(name) = name_re.captures(&captures[2]) {
            return name[1].to_string();
        }
    }
    style_id.to_string()
}

/// Re-indent a JSON document without touching its tokens.
///
/// Python did `json.dumps(json.loads(text), ensure_ascii=False, indent=2)`, which
/// both normalises layout and re-orders nothing: `dict` keeps insertion order, so
/// the keys of the source file stay in the order the author wrote them. serde_json
/// sorts object keys (no `preserve_order` in this offline build), so re-encoding
/// through it would silently reorder every spec. This rewrites whitespace only and
/// keeps each literal exactly as written.
///
/// Deviation: a source that escaped its strings (`"\u4fe1\u53f7"`) or wrote a
/// number in a non-canonical form (`1e5`) keeps that spelling, where Python would
/// have printed `信号` and `100000.0`.
fn pretty_json(raw: &str) -> Option<String> {
    if serde_json::from_str::<serde_json::Value>(raw).is_err() {
        return None;
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        ObjectOpen,
        ObjectClose,
        ArrayOpen,
        ArrayClose,
        Comma,
        Colon,
        Literal,
    }
    let mut tokens: Vec<(Kind, &str)> = Vec::new();
    let bytes = raw.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'{' => {
                tokens.push((Kind::ObjectOpen, "{"));
                index += 1;
            }
            b'}' => {
                tokens.push((Kind::ObjectClose, "}"));
                index += 1;
            }
            b'[' => {
                tokens.push((Kind::ArrayOpen, "["));
                index += 1;
            }
            b']' => {
                tokens.push((Kind::ArrayClose, "]"));
                index += 1;
            }
            b',' => {
                tokens.push((Kind::Comma, ","));
                index += 1;
            }
            b':' => {
                tokens.push((Kind::Colon, ":"));
                index += 1;
            }
            b'"' => {
                let start = index;
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index += 2,
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
                tokens.push((Kind::Literal, &raw[start..index]));
            }
            b if b.is_ascii_whitespace() => index += 1,
            _ => {
                let start = index;
                while index < bytes.len()
                    && !bytes[index].is_ascii_whitespace()
                    && !matches!(bytes[index], b'{' | b'}' | b'[' | b']' | b',' | b':')
                {
                    index += 1;
                }
                tokens.push((Kind::Literal, &raw[start..index]));
            }
        }
    }

    let mut out = String::with_capacity(raw.len() + raw.len() / 4);
    let mut depth = 0usize;
    let indent = |depth: usize| "  ".repeat(depth);
    for (position, (kind, text)) in tokens.iter().enumerate() {
        let next = tokens.get(position + 1).map(|(kind, _)| *kind);
        let previous = position
            .checked_sub(1)
            .and_then(|index| tokens.get(index))
            .map(|(kind, _)| *kind);
        match kind {
            Kind::ObjectOpen | Kind::ArrayOpen => {
                out.push_str(text);
                let empty = match kind {
                    Kind::ObjectOpen => next == Some(Kind::ObjectClose),
                    _ => next == Some(Kind::ArrayClose),
                };
                if !empty {
                    depth += 1;
                    out.push('\n');
                    out.push_str(&indent(depth));
                }
            }
            Kind::ObjectClose | Kind::ArrayClose => {
                let empty = match kind {
                    Kind::ObjectClose => previous == Some(Kind::ObjectOpen),
                    _ => previous == Some(Kind::ArrayOpen),
                };
                if !empty {
                    depth = depth.saturating_sub(1);
                    out.push('\n');
                    out.push_str(&indent(depth));
                }
                out.push_str(text);
            }
            Kind::Comma => {
                out.push(',');
                out.push('\n');
                out.push_str(&indent(depth));
            }
            Kind::Colon => out.push_str(": "),
            Kind::Literal => out.push_str(text),
        }
    }
    Some(out)
}

/// XML attribute value by name. Attributes always follow whitespace in a start
/// tag, so the leading space keeps `id` from matching `sheetId`.
fn attribute(attrs: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = attrs.find(&needle)? + needle.len();
    let rest = &attrs[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// `D12` → 3. The column letters of a cell reference.
fn column_index(reference: &str) -> Option<usize> {
    let letters: String = reference
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect();
    if letters.is_empty() {
        return None;
    }
    let mut index = 0usize;
    for character in letters.chars() {
        index = index * 26 + (character.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    Some(index - 1)
}

fn single_line(text: &str) -> String {
    text.lines().map(str::trim).collect::<Vec<_>>().join(" ")
}

/// Every `<t>` run of a rich-text container (`<si>`, `<is>`), concatenated the
/// way openpyxl joins them.
fn text_runs(fragment: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?s)<t(?:\s[^>]*)?>(.*?)</t\s*>").expect("shared string run regex")
    });
    re.captures_iter(fragment)
        .map(|captures| xml_unescape(&captures[1]))
        .collect()
}

/// `xl/sharedStrings.xml` as a vector of strings, indexed exactly as the `t="s"`
/// cells reference them.
fn shared_strings(xml: &str) -> Vec<String> {
    block_contents(xml, "si")
        .iter()
        .map(|item| text_runs(item))
        .collect()
}

/// Sheet name and member path, in workbook order.
fn workbook_sheets(workbook: &str, relationships: &str) -> Vec<(String, String)> {
    static SHEET_RE: OnceLock<Regex> = OnceLock::new();
    let sheet_re =
        SHEET_RE.get_or_init(|| Regex::new(r"<sheet\b([^>]*?)/?>").expect("sheet regex"));
    static REL_RE: OnceLock<Regex> = OnceLock::new();
    let rel_re = REL_RE
        .get_or_init(|| Regex::new(r"<Relationship\b([^>]*?)/?>").expect("relationship regex"));

    let targets: Vec<(String, String)> = rel_re
        .captures_iter(relationships)
        .filter_map(|captures| {
            Some((
                attribute(&captures[1], "Id")?,
                attribute(&captures[1], "Target")?,
            ))
        })
        .collect();

    sheet_re
        .captures_iter(workbook)
        .filter_map(|captures| {
            let name = attribute(&captures[1], "name")?;
            let id = attribute(&captures[1], "r:id")?;
            let target = targets
                .iter()
                .find(|(relationship, _)| relationship == &id)
                .map(|(_, target)| target.clone())?;
            // A relationship target is either package-absolute (`/xl/...`) or
            // relative to `xl/`.
            let path = if let Some(absolute) = target.strip_prefix('/') {
                absolute.to_string()
            } else {
                format!("xl/{target}")
            };
            Some((name, path))
        })
        .collect()
}

fn cell_value(attrs: &str, body: &str, strings: &[String]) -> String {
    let kind = attribute(attrs, "t").unwrap_or_else(|| "n".to_string());
    if kind == "inlineStr" {
        return text_runs(body);
    }
    let raw = match block_contents(body, "v").into_iter().next() {
        Some(raw) => xml_unescape(&raw),
        None => return String::new(),
    };
    match kind.as_str() {
        "s" => raw
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|index| strings.get(index).cloned())
            .unwrap_or_default(),
        "b" => {
            if raw.trim() == "1" {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        "str" | "e" => raw,
        _ => {
            // openpyxl casts an integral number to int, so `str(cell)` prints
            // "4200", not "4200.0"; anything else keeps Python's shortest form.
            match raw.trim().parse::<f64>() {
                Ok(number) if number.fract() == 0.0 && number.abs() < 1e15 => {
                    format!("{}", number as i64)
                }
                Ok(number) => format!("{number}"),
                Err(_) => raw,
            }
        }
    }
}

/// One worksheet as `| a | b |` lines, gaps filled, at most `MAX_XLSX_ROWS` rows.
fn sheet_rows(xml: &str, strings: &[String]) -> Vec<String> {
    static ROW_RE: OnceLock<Regex> = OnceLock::new();
    let row_re = ROW_RE.get_or_init(|| {
        Regex::new(r"(?s)<row\b([^>]*?)(?:/>|>(.*?)</row\s*>)").expect("row regex")
    });
    static CELL_RE: OnceLock<Regex> = OnceLock::new();
    let cell_re = CELL_RE
        .get_or_init(|| Regex::new(r"(?s)<c\b([^>]*?)(?:/>|>(.*?)</c\s*>)").expect("cell regex"));

    let mut parsed: Vec<std::collections::BTreeMap<usize, String>> = Vec::new();
    for row in row_re.captures_iter(xml) {
        let body = row.get(2).map(|value| value.as_str()).unwrap_or("");
        let mut cells: std::collections::BTreeMap<usize, String> = Default::default();
        let mut next = 0usize;
        for cell in cell_re.captures_iter(body) {
            let attrs = &cell[1];
            let body = cell.get(2).map(|value| value.as_str()).unwrap_or("");
            let column = attribute(attrs, "r")
                .and_then(|reference| column_index(&reference))
                .unwrap_or(next);
            next = column + 1;
            cells.insert(column, single_line(&cell_value(attrs, body, strings)));
        }
        if cells.values().any(|value| !value.is_empty()) {
            parsed.push(cells);
        }
    }

    let width = parsed
        .iter()
        .filter_map(|row| row.keys().next_back().map(|column| column + 1))
        .max()
        .unwrap_or(0);
    let mut out = Vec::new();
    let mut emitted = 0usize;
    for row in parsed {
        let mut cells = Vec::with_capacity(width);
        for column in 0..width {
            cells.push(row.get(&column).cloned().unwrap_or_default());
        }
        out.push(format!("| {} |", cells.join(" | ")));
        emitted += 1;
        if emitted >= MAX_XLSX_ROWS {
            out.push(format!("[该表超过 {MAX_XLSX_ROWS} 行，已截断]"));
            break;
        }
    }
    out
}

/// A workbook as "one section per sheet, one line per row".
///
/// Values are the cached ones (`data_only`), because a spec's indicator table is
/// worth what it computes, not how. Caveat: a cell formatted as a date prints as
/// its serial number here, while openpyxl fetched a real date — the number
/// format table is not read.
fn xlsx_to_text(raw: &[u8]) -> Result<String, String> {
    let workbook = zip::read_entry(raw, "xl/workbook.xml")?
        .ok_or("Excel 文件缺少 xl/workbook.xml，无法读取工作表")?;
    let workbook = decode(&workbook)?;
    let relationships = zip::read_entry(raw, "xl/_rels/workbook.xml.rels")?
        .map(|bytes| decode(&bytes))
        .transpose()?
        .unwrap_or_default();
    let strings = zip::read_entry(raw, "xl/sharedStrings.xml")?
        .map(|bytes| decode(&bytes))
        .transpose()?
        .map(|xml| shared_strings(&xml))
        .unwrap_or_default();

    let mut parts: Vec<String> = Vec::new();
    for (name, path) in workbook_sheets(&workbook, &relationships) {
        let Some(bytes) = zip::read_entry(raw, &path)? else {
            continue;
        };
        let xml = decode(&bytes)?;
        parts.push(format!("# {name}"));
        parts.extend(sheet_rows(&xml, &strings));
    }
    if parts.is_empty() {
        return Err("Excel 文件里没有工作表".to_string());
    }
    Ok(parts.join("\n\n"))
}

fn pdf_to_text(_raw: &[u8]) -> Result<String, String> {
    Err("不支持的文档格式 .pdf：Rust 服务未内置 PDF 解析（Python 服务使用 pdfplumber）".to_string())
}

pub fn extract_text(filename: &str, raw: &[u8]) -> Result<Extracted, String> {
    let suffix = suffix_of(filename);
    if !supported_suffixes().iter().any(|item| item == &suffix) {
        let listed = supported_suffixes().join(", ");
        let shown = if suffix.is_empty() {
            "(无扩展名)".to_string()
        } else {
            suffix
        };
        return Err(format!("不支持的文件类型 {shown}；支持：{listed}"));
    }
    if raw.len() > MAX_FILE_BYTES {
        return Err(format!(
            "文件超过 {} MB，请拆分后再导入",
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }

    let (text, format) = if HTML_SUFFIXES.contains(&suffix.as_str()) {
        (html_to_text(raw)?, "html")
    } else if PDF_SUFFIXES.contains(&suffix.as_str()) {
        (pdf_to_text(raw)?, "pdf")
    } else if DOCX_SUFFIXES.contains(&suffix.as_str()) {
        (docx_to_text(raw)?, "docx")
    } else if XLSX_SUFFIXES.contains(&suffix.as_str()) {
        (xlsx_to_text(raw)?, "xlsx")
    } else {
        let text = decode(raw)?;
        if suffix == ".json" || suffix == ".jsonl" {
            // Pretty-print when it parses, so a one-line JSON spec becomes
            // readable chunks; JSONL and commented configs stay as written.
            match pretty_json(&text) {
                Some(pretty) => (pretty, "json"),
                None => (text, "json"),
            }
        } else {
            (text, "text")
        }
    };

    let text = normalize_newlines(&text).trim().to_string();
    if text.is_empty() {
        return Err("文件里没有可读文本（可能是扫描版 PDF 或空文档）".to_string());
    }
    let (text, truncated) = clip(&text);
    Ok(Extracted {
        text,
        format: format.to_string(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffixes_follow_python_path_semantics() {
        assert_eq!(suffix_of("a/b/c.MD"), ".md");
        assert_eq!(suffix_of(r"a\b\c.TXT"), ".txt");
        assert_eq!(suffix_of("noext"), "");
        assert_eq!(suffix_of(".bashrc"), "");
        assert!(is_supported("需求.md"));
        assert!(!is_supported("需求.doc"));
    }

    #[test]
    fn markdown_is_read_verbatim_and_normalised() {
        let raw = "\u{feff}# 标题\r\n\r\n正文  \r\n".as_bytes();
        let extracted = extract_text("a.md", raw).expect("extract");
        assert_eq!(extracted.format, "text");
        assert_eq!(extracted.text, "# 标题\n\n正文");
        assert!(!extracted.truncated);
    }

    #[test]
    fn json_is_pretty_printed_keeping_key_order() {
        // Python's json.dumps(indent=2) keeps insertion order and prints
        // `: ` after a key; the source order must survive.
        let extracted = extract_text(
            "spec.json",
            "{\"名称\":\"单体电压\",\"范围\":[0,5000],\"空\":{},\"列表\":[]}".as_bytes(),
        )
        .expect("extract");
        assert_eq!(extracted.format, "json");
        assert_eq!(
            extracted.text,
            "{\n  \"名称\": \"单体电压\",\n  \"范围\": [\n    0,\n    5000\n  ],\n  \"空\": {},\n  \"列表\": []\n}"
        );
    }

    #[test]
    fn invalid_json_stays_as_written() {
        let extracted = extract_text("data.jsonl", b"{\"a\":1}\n{\"b\":2}").expect("extract");
        assert_eq!(extracted.format, "json");
        assert_eq!(extracted.text, "{\"a\":1}\n{\"b\":2}");
    }

    #[test]
    fn html_keeps_text_nodes_and_drops_scripts() {
        let html = b"<html><head><style>b{}</style><script>var x=1;</script></head>\
                     <body><h1>Report</h1><p>a &amp; b</p><p>l&nbsp;m</p></body></html>";
        let extracted = extract_text("page.html", html).expect("extract");
        assert_eq!(extracted.format, "html");
        assert_eq!(extracted.text, "Report\na & b\nl\u{a0}m");
    }

    #[test]
    fn empty_text_is_an_error_not_an_empty_document() {
        assert_eq!(
            extract_text("blank.md", b"   \n\n").unwrap_err(),
            "文件里没有可读文本（可能是扫描版 PDF 或空文档）"
        );
    }

    #[test]
    fn pdf_says_so_explicitly() {
        assert!(extract_text("a.pdf", b"%PDF-1.4")
            .unwrap_err()
            .starts_with("不支持的文档格式 .pdf"));
    }

    #[test]
    fn xlsx_matches_the_openpyxl_reading() {
        // Same bytes the Python service imported; same text it produced.
        let bytes = super::super::office_fixtures::unhex(super::super::office_fixtures::XLSX_HEX);
        let extracted = extract_text("指标.xlsx", &bytes).expect("extract");
        assert_eq!(extracted.format, "xlsx");
        assert_eq!(extracted.text, super::super::office_fixtures::XLSX_TEXT);
    }

    #[test]
    fn docx_heading_paragraph_and_table_match_python_docx() {
        let document = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>电池需求</w:t></w:r></w:p>
<w:p><w:r><w:t>单体电压 0~5000 mV，周期 100 ms。</w:t></w:r></w:p>
<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>信号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单位</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>单体电压</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>mV</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>"#;
        let bytes =
            super::zip::build_stored_zip(&[("word/document.xml", document.as_bytes(), false)]);
        let extracted = extract_text("需求.docx", &bytes).expect("extract");
        assert_eq!(extracted.format, "docx");
        assert_eq!(extracted.text, super::super::office_fixtures::DOCX_TEXT);
    }

    #[test]
    fn unknown_suffix_lists_what_is_supported() {
        let message = extract_text("a.doc", b"x").unwrap_err();
        assert!(message.starts_with("不支持的文件类型 .doc；支持：.bat, .c, .cfg"));
    }

    #[test]
    fn docx_reads_a_real_word_file() {
        // Word writes the same shape as this sample: paragraphs with styles, and
        // a table after the body.
        let document = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>需求</w:t></w:r></w:p>
<w:p><w:r><w:t>单体电压 0~5000 mV</w:t></w:r><w:r><w:tab/><w:t>周期 100 ms</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>信号</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>单位</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>"#;
        let bytes =
            super::zip::build_stored_zip(&[("word/document.xml", document.as_bytes(), true)]);
        let extracted = extract_text("spec.docx", &bytes).expect("extract");
        assert_eq!(extracted.format, "docx");
        assert_eq!(
            extracted.text,
            "# 需求\n\n单体电压 0~5000 mV\t周期 100 ms\n\n| 信号 | 单位 |"
        );
    }
}
