//! Requirement documents → text.
//!
//! `prd-parse` can take a `requirement_ref` (a file in the requirements table or
//! under `specs/` / `requirements/`). Text formats are decoded here; container
//! formats (.docx / .xlsx / .pdf / .html) go through the bundled interpreter,
//! because a ZIP/PDF reader is not something to re-implement by hand — and
//! decoding a .docx as text yields ZIP noise (a 649 KB spec decoded to 620 K
//! characters with zero headings, so `prd-parse` reported "0 function points"
//! while the chain looked healthy).

use std::path::{Path, PathBuf};

use crate::config;
use crate::error::{ApiError, ApiResult};

const HTML_SUFFIXES: [&str; 3] = [".html", ".htm", ".xhtml"];
const CONTAINER_SUFFIXES: [&str; 3] = [".pdf", ".docx", ".xlsx"];

pub const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
pub const MAX_CHARS: usize = 3_000_000;

fn suffix_of(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn needs_interpreter(filename: &str) -> bool {
    let suffix = suffix_of(filename);
    HTML_SUFFIXES.contains(&suffix.as_str()) || CONTAINER_SUFFIXES.contains(&suffix.as_str())
}

/// The interpreter used for container formats: the host-provided one when
/// present, else the copy shipped next to this binary.
fn python(service_root: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AUTOTEST_PYTHON") {
        if !explicit.trim().is_empty() {
            return Some(PathBuf::from(explicit));
        }
    }
    config::python_executable(service_root)
}

/// The extraction script. It stays close to `knowledge/extract.py` (skip the
/// Word table of contents, headings become `#` lines, tables become `| … |` rows)
/// but uses only the standard library, so it also runs where python-docx or
/// openpyxl were never installed.
const EXTRACT_SCRIPT: &str = r##"
import json, re, sys, zipfile
from xml.etree import ElementTree

name, path = sys.argv[1], sys.argv[2]
suffix = ("." + name.rsplit(".", 1)[-1]).lower() if "." in name else ""
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

def docx_text(raw):
    with zipfile.ZipFile(raw) as archive:
        try:
            xml = archive.read("word/document.xml")
        except KeyError:
            raise SystemExit("word/document.xml 不存在，可能不是 .docx")
    root = ElementTree.fromstring(xml)
    parts = []
    for paragraph in root.iter(W + "p"):
        texts = [(node.text or "") for node in paragraph.iter(W + "t")]
        text = "".join(texts).strip()
        if not text:
            continue
        style = ""
        for node in paragraph.iter(W + "pStyle"):
            style = (node.get(W + "val") or "").lower()
            break
        # A table of contents is a copy of the headings: keeping it makes every
        # entry its own section and shreds the body text.
        if style.startswith("toc"):
            continue
        heading = re.match(r"heading(\d+)", style)
        if heading:
            parts.append("#" * int(heading.group(1)) + " " + text)
        else:
            parts.append(text)
    for table in root.iter(W + "tbl"):
        for row in table.iter(W + "tr"):
            cells = []
            for cell in row.iter(W + "tc"):
                cells.append("".join((n.text or "") for n in cell.iter(W + "t")).strip())
            if any(cells):
                parts.append("| " + " | ".join(cells) + " |")
    return "\n\n".join(parts)

def xlsx_text(raw):
    with zipfile.ZipFile(raw) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root:
                shared.append("".join((n.text or "") for n in item.iter() if n.tag.endswith("}t")))
        sheets = [n for n in archive.namelist() if n.startswith("xl/worksheets/sheet")]
        parts = []
        for index, sheet in enumerate(sorted(sheets), start=1):
            parts.append("# Sheet%d" % index)
            root = ElementTree.fromstring(archive.read(sheet))
            emitted = 0
            for row in root.iter():
                if not row.tag.endswith("}row"):
                    continue
                cells = []
                for cell in row:
                    if not cell.tag.endswith("}c"):
                        continue
                    kind = cell.get("t")
                    value = ""
                    for node in cell.iter():
                        if node.tag.endswith("}v") and node.text:
                            value = node.text
                    if kind == "s" and value.isdigit():
                        value = shared[int(value)] if int(value) < len(shared) else ""
                    cells.append(value.strip())
                if not any(cells):
                    continue
                parts.append("| " + " | ".join(cells) + " |")
                emitted += 1
                if emitted >= 4000:
                    parts.append("[该表超过 4000 行，已截断]")
                    break
        return "\n\n".join(parts)

def html_text(raw):
    from html.parser import HTMLParser
    class Collector(HTMLParser):
        def __init__(self):
            super().__init__()
            self.blocks = []
            self.skip = 0
        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style"):
                self.skip += 1
        def handle_endtag(self, tag):
            if tag in ("script", "style") and self.skip:
                self.skip -= 1
        def handle_data(self, data):
            if not self.skip:
                text = data.strip()
                if text:
                    self.blocks.append(text)
    collector = Collector()
    collector.feed(raw.decode("utf-8", "replace"))
    return "\n".join(collector.blocks)

def pdf_text(raw):
    try:
        import io, pdfplumber
    except ImportError:
        raise SystemExit("缺少 pdfplumber，无法读取 PDF。请在打包机/开发机执行：pip install --target services/autotest/.deps pdfplumber")
    pages = []
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            body = (page.extract_text() or "").strip()
            if body:
                pages.append("[第 %d 页]\n%s" % (number, body))
    return "\n\n".join(pages)

try:
    raw = open(path, "rb").read()
except OSError as problem:
    raise SystemExit("文件读不到：%s" % problem)
if suffix == ".html" or suffix == ".htm" or suffix == ".xhtml":
    text = html_text(raw)
elif suffix == ".pdf":
    text = pdf_text(raw)
elif suffix == ".docx":
    text = docx_text(raw)
elif suffix == ".xlsx":
    text = xlsx_text(raw)
else:
    text = raw.decode("utf-8", "replace")
text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
if not text:
    raise SystemExit("文件里没有可读文本（可能是扫描版 PDF 或空文档）")
sys.stdout.write(text)
"##;

fn run_interpreter(service_root: &Path, filename: &str, path: &Path) -> ApiResult<String> {
    let Some(python) = python(service_root) else {
        return Err(ApiError::bad_request(
            "缺少 Python 运行时，无法读取 .docx/.pdf/.xlsx/.html 文档",
        ));
    };
    let output = std::process::Command::new(python)
        .arg("-c")
        .arg(EXTRACT_SCRIPT)
        .arg(filename)
        .arg(path)
        .output()
        .map_err(|error| ApiError::bad_request(format!("文档解析失败：{error}")))?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() || text.trim().is_empty() {
        let message = String::from_utf8_lossy(&output.stderr);
        let message = message.trim();
        let message = message
            .strip_prefix("SystemExit: ")
            .unwrap_or(message)
            .lines()
            .last()
            .unwrap_or("文档无法解析")
            .to_string();
        return Err(ApiError::bad_request(message));
    }
    Ok(text)
}

fn decode_text(bytes: &[u8]) -> String {
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        // GB18030 (the encoding most automotive specs are still written in)
        // cannot be decoded without a table this crate does not ship, so the
        // lossy UTF-8 read is the fallback — the same last resort Python uses.
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Full text of one requirement document, already normalised.
pub fn extract_text(
    path: &Path,
    filename: &str,
    service_root: &Path,
) -> ApiResult<String> {
    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size > MAX_FILE_BYTES {
        return Err(ApiError::bad_request(format!(
            "文件超过 {} MB，请拆分后再导入",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }

    let text = if needs_interpreter(filename) {
        run_interpreter(service_root, filename, path)?
    } else {
        let bytes = std::fs::read(path)?;
        let decoded = decode_text(&bytes);
        let extension = suffix_of(filename);
        if extension == ".json" || extension == ".jsonl" {
            // Pretty-print valid JSON so the splitter sees one field per line;
            // JSONL or a commented config simply stays as it is.
            match serde_json::from_str::<serde_json::Value>(&decoded) {
                Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(decoded),
                Err(_) => decoded,
            }
        } else {
            decoded
        }
    };

    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalised = normalised.trim();
    if normalised.is_empty() {
        return Err(ApiError::bad_request(
            "文件里没有可读文本（可能是扫描版 PDF 或空文档）",
        ));
    }
    let chars: Vec<char> = normalised.chars().collect();
    if chars.len() > MAX_CHARS {
        return Ok(format!(
            "{}\n\n[内容超过 {MAX_CHARS} 字符，已截断]",
            chars[..MAX_CHARS].iter().collect::<String>()
        ));
    }
    Ok(normalised.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_suffixes_go_through_the_interpreter() {
        assert!(needs_interpreter("spec.DOCX"));
        assert!(needs_interpreter("spec.pdf"));
        assert!(!needs_interpreter("spec.md"));
        assert_eq!(decode_text("\u{feff}正文".as_bytes()), "正文");
    }
}
