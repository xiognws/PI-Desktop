//! `BrowserExec`: load one URL in a real headless browser and return what the
//! page looks like **after** its JavaScript ran.
//!
//! Why this is not `web_extract`: a fetcher sees the served HTML. A single-page
//! app, a portal that fills its grid on load, a page behind a JS redirect — all
//! of them arrive as a shell with no content. Only a browser engine runs the
//! script, so a page that renders empty for a fetcher renders here.
//!
//! Three decisions are deliberate and each one costs something:
//!
//! * **A persistent profile.** Chromium with a fresh `--user-data-dir` pays the
//!   profile setup on every call: measured on this host, 102 s cold against
//!   29–31 s once the directory already exists. The directory therefore lives
//!   under `<data_dir>/cache/browser-profile` and is created rather than thrown
//!   away — the whole tool is unusable at a hundred seconds a page.
//! * **A process tree, not a process.** A browser forks a zygote, renderers and
//!   a crash handler; killing the launcher alone leaves them holding the profile
//!   and the next call blocks on it. The child is placed in the host's job
//!   object (Windows) / process group (Unix) and terminated through
//!   [`crate::tools::ProcessOwnership`], the same containment `Bash` and
//!   `ExecuteCode` get.
//! * **A byte ceiling.** A rendered DOM of a portal is megabytes; the model
//!   needs the first screen of it, not all of it.
//!
//! V1 boundary, stated rather than pretended: **one visit per call**. No
//! clicking, no typing, no session reuse beyond the cached profile. A task that
//! needs interaction is a CDP session, not this tool.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::tools::hashline::ToolError;

/// The name the kernel declares. `browser_exec` is accepted too: it is the
/// upstream spelling, and a kernel that declares the snake_case name should not
/// have to wait for a host release.
pub const TOOL_NAME: &str = "BrowserExec";

/// Three minutes. Measured on this host: 29–31 s for a warm profile, but a cold one
/// costs 102 s and a run under load has been seen at 123 s — so a two-minute default
/// cut real calls off. Three minutes clears the worst case measured here and still
/// reports a blocked launch inside one call.
pub const DEFAULT_TIMEOUT_MS: u64 = 180_000;

/// The ceiling a caller can ask for. Past five minutes the browser is not slow,
/// it is stuck, and the profile lock it holds blocks the next call too.
pub const MAX_TIMEOUT_MS: u64 = 300_000;

/// Ceiling on returned DOM or text. Sixty kilobytes is a screenful of structure
/// or a long article; past it the excerpt stops informing and starts costing.
pub const MAX_OUTPUT_BYTES: usize = 60 * 1024;

/// How much stderr is worth quoting when a call produces nothing. Enough to read
/// the browser's own complaint, little enough not to flood the transcript.
const MAX_STDERR_DETAIL: usize = 600;

/// How much raw output beyond the ceiling is retained so the cut can be moved
/// back to a character boundary. Four bytes is the widest UTF-8 sequence.
const BOUNDARY_SLACK_BYTES: usize = 4;

/// Where a screenshot lands, relative to the workspace root: next to the project
/// it was taken for, not inside the data directory.
pub const SCREENSHOT_DIR: &str = "screenshots";

/// The profile directory, relative to the data directory. Under `cache/` because
/// it is exactly that: rebuildable, and never something the user wrote.
const PROFILE_RELATIVE: [&str; 2] = ["cache", "browser-profile"];

/// A viewport wide enough for a desktop layout. A narrower default (800 px) makes
/// portals render their mobile shell, which is not what a caller asking for a
/// screenshot wants to see.
const WINDOW_SIZE: &str = "1280,900";

/// Edge, then Chrome. Edge ships with Windows, so it is the likely hit and the
/// first measured working binary on this host.
pub const EDGE_CANDIDATES: [&str; 2] = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
];

pub const CHROME_CANDIDATES: [&str; 2] = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
];

/// The environment variable that overrides every candidate above.
pub const BROWSER_ENV: &str = "PI_BROWSER_BIN";

/// Distinguishes two concurrent screenshots in one process.
static SCREENSHOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// What the caller asked for, already validated and bounded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserRequest {
    pub url: String,
    pub mode: Mode,
    pub max_bytes: usize,
    pub timeout_ms: u64,
}

/// What to return, and therefore what to ask the browser for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The rendered HTML.
    Dom,
    /// The rendered HTML with tags removed.
    Text,
    /// A PNG written into the workspace.
    Screenshot,
}

impl Mode {
    /// The spelling used in results and error messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Dom => "dom",
            Mode::Text => "text",
            Mode::Screenshot => "screenshot",
        }
    }
}

/// Does this tool name belong to the browser-exec family?
pub fn recognizes(tool_name: &str) -> bool {
    tool_name == TOOL_NAME || tool_name == "browser_exec"
}

/// Canonicalise a mode spelling. `None` means "not a mode this tool knows".
pub fn normalize_mode(raw: &str) -> Option<Mode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "dom" | "html" => Some(Mode::Dom),
        "text" | "inner-text" | "innertext" => Some(Mode::Text),
        "screenshot" | "png" | "image" => Some(Mode::Screenshot),
        _ => None,
    }
}

/// Read the mode argument. An absent or blank value is `dom`: the caller asked
/// for a rendered page, and the rendered HTML is what "rendered" means.
pub fn parse_mode(raw: Option<&str>) -> Result<Mode, ToolError> {
    let Some(raw) = raw else {
        return Ok(Mode::Dom);
    };
    if raw.trim().is_empty() {
        return Ok(Mode::Dom);
    }
    normalize_mode(raw).ok_or_else(|| {
        ToolError::new(
            "INVALID_ARGUMENT",
            format!("`mode` must be `dom`, `text` or `screenshot`, not `{raw}`"),
        )
    })
}

/// Accept a URL the browser can be pointed at.
///
/// Only `http(s)` and `file` are allowed. The rest are refused rather than
/// passed through: `javascript:` and `data:` would run script the model wrote in
/// a page context, and `ftp:` is a scheme every current browser has dropped —
/// handing it over produces a timeout instead of a diagnosis.
pub fn validate_url(raw: &str) -> Result<String, ToolError> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "`url` is required (an http(s) URL or a file:// path)",
        ));
    }
    let lower = url.to_ascii_lowercase();
    let (scheme, rest) = if let Some(rest) = lower.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        ("http", rest)
    } else if let Some(rest) = lower.strip_prefix("file://") {
        ("file", rest)
    } else {
        let prefix = lower.split([':', '/']).next().unwrap_or_default();
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!(
                "`url` must start with http://, https:// or file://, not `{}`",
                if prefix.is_empty() { url } else { prefix }
            ),
        ));
    };
    // A scheme with no host (`http:///page`) is a URL the browser would fail to
    // load; refusing it here names the argument instead of the symptom.
    if scheme != "file" {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if host.is_empty() {
            return Err(ToolError::new(
                "INVALID_ARGUMENT",
                format!("`url` names no host: `{url}`"),
            ));
        }
    }
    Ok(url.to_string())
}

/// The output ceiling, applied to one requested byte count.
///
/// `0` reads as "unspecified" rather than "nothing": a caller asking for zero
/// bytes asked for a call that cannot say anything.
pub fn clamp_max_bytes(requested: Option<u64>) -> usize {
    match requested {
        None | Some(0) => MAX_OUTPUT_BYTES,
        Some(bytes) => (bytes as usize).min(MAX_OUTPUT_BYTES),
    }
}

/// The ceiling, applied to one requested timeout. Same `0` reading as
/// [`clamp_max_bytes`].
pub fn clamp_timeout(requested: Option<u64>) -> u64 {
    match requested {
        None | Some(0) => DEFAULT_TIMEOUT_MS,
        Some(ms) => ms.min(MAX_TIMEOUT_MS),
    }
}

/// A number argument, from either spelling, tolerating a numeric string for the
/// same reason `ExecuteCode` does: a model that read the host's Rust instead of
/// the declaration should still get the bound it asked for.
fn numeric_arg(args: &Value, camel: &str, snake: &str) -> Option<u64> {
    let value = args.get(camel).or_else(|| args.get(snake))?;
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// Read the caller's intent.
pub fn parse_request(args: &Value) -> Result<BrowserRequest, ToolError> {
    let url = validate_url(args.get("url").and_then(Value::as_str).unwrap_or_default())?;
    Ok(BrowserRequest {
        url,
        mode: parse_mode(args.get("mode").and_then(Value::as_str))?,
        max_bytes: clamp_max_bytes(numeric_arg(args, "maxBytes", "max_bytes")),
        timeout_ms: clamp_timeout(numeric_arg(args, "timeoutMs", "timeout_ms")),
    })
}

/// Cut `text` to at most `limit` bytes without splitting a character.
///
/// The cut moves *back* to the previous boundary, so the returned text is always
/// valid UTF-8; a cut moved forward would leave a replacement glyph at the end
/// of a `CJK` page.
pub fn truncate_output(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut cut = limit.min(text.len());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    (
        format!("{}\n[output truncated at {limit} bytes]", &text[..cut]),
        true,
    )
}

/// Tag names whose boundaries end a line in the extracted text.
fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "br" | "p"
            | "div"
            | "li"
            | "tr"
            | "td"
            | "th"
            | "ul"
            | "ol"
            | "table"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "nav"
            | "main"
            | "aside"
            | "hr"
            | "pre"
            | "blockquote"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
    )
}

/// The tag name a `<...>` body names, lowercased, without its `/` or `!`.
fn tag_name(body: &str) -> &str {
    let body = body.trim_start_matches(['/', '!', '?']);
    let end = body
        .find(|ch: char| ch.is_whitespace() || ch == '/' || ch == '>')
        .unwrap_or(body.len());
    &body[..end]
}

/// Drop every `<tag ...> ... </tag>` block, case-insensitively.
///
/// `script` and `style` bodies are not prose: a page whose stylesheet is returned
/// as text is a page the model has to read past before it reaches the sentence
/// it needs. Byte offsets stay aligned because lowercasing ASCII does not change
/// length, and the tag names searched for are ASCII.
fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;
    while let Some(found) = lower[cursor..].find(&open) {
        let start = cursor + found;
        let after = lower[start + open.len()..].chars().next();
        // `<scriptlet>` is not `<script>`.
        if !matches!(
            after,
            Some(' ') | Some('>') | Some('/') | Some('\t') | Some('\n') | Some('\r')
        ) {
            out.push_str(&html[cursor..start + open.len()]);
            cursor = start + open.len();
            continue;
        }
        out.push_str(&html[cursor..start]);
        let Some(body) = lower[start..].find(&close) else {
            // An unclosed block swallows the rest, which is what a browser does
            // with it too.
            return out;
        };
        let after_close = start + body + close.len();
        match html[after_close..].find('>') {
            Some(end) => cursor = after_close + end + 1,
            None => return out,
        }
    }
    out.push_str(&html[cursor..]);
    out
}

/// One named HTML entity, or `None` when the name is not one worth decoding.
fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "copy" => '©',
        "reg" => '®',
        "middot" => '·',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "times" => '×',
        "bull" => '•',
        "euro" => '€',
        _ => return None,
    })
}

/// Decode one `&...;` body: a named entity or a numeric code point.
fn decode_entity(body: &str) -> Option<char> {
    if let Some(digits) = body.strip_prefix('#') {
        let value = match digits
            .strip_prefix(['x', 'X'])
            .map(|hex| u32::from_str_radix(hex, 16))
        {
            Some(Ok(value)) => value,
            Some(Err(_)) => return None,
            None => digits.parse::<u32>().ok()?,
        };
        return char::from_u32(value);
    }
    named_entity(body)
}

/// Append `text` to `out`, decoding character references.
///
/// Source newlines become spaces: a newline inside a paragraph is layout in the
/// file, not a line break on the page (only a block boundary ends a line here),
/// so keeping it would give a three-line article four lines.
fn push_decoded(out: &mut String, text: &str) {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        decoded.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        // A stray `&` is text. Only a short run ending in `;` is a reference.
        let mut end = None;
        for (index, ch) in tail.char_indices().take(12) {
            if ch == ';' {
                end = Some(index);
                break;
            }
            if ch.is_whitespace() {
                break;
            }
        }
        match end.and_then(|end| decode_entity(&tail[1..end]).map(|ch| (end, ch))) {
            Some((end, ch)) => {
                decoded.push(ch);
                rest = &tail[end + 1..];
            }
            None => {
                decoded.push('&');
                rest = &tail[1..];
            }
        }
    }
    decoded.push_str(rest);
    for ch in decoded.chars() {
        out.push(if matches!(ch, '\n' | '\r' | '\t') {
            ' '
        } else {
            ch
        });
    }
}

/// Collapse runs of whitespace, keeping one line per block.
pub fn collapse_whitespace(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for line in raw.lines() {
        let mut wrote = false;
        for (index, word) in line.split_whitespace().enumerate() {
            if index > 0 {
                out.push(' ');
            }
            out.push_str(word);
            wrote = true;
        }
        if wrote {
            out.push('\n');
        }
    }
    while out.ends_with('\n') {
        out.pop();
    }
    out
}

/// The readable text of a rendered page: `script`/`style` removed, tags removed,
/// entities decoded, whitespace collapsed, one line per block.
///
/// A pure function of its input on purpose — this is the half of `mode=text`
/// worth testing without a browser.
pub fn html_to_text(html: &str) -> String {
    let stripped = strip_tag_blocks(html, "script");
    let stripped = strip_tag_blocks(&stripped, "style");
    let mut out = String::with_capacity(stripped.len() / 2);
    let mut rest = stripped.as_str();
    while let Some(open) = rest.find('<') {
        push_decoded(&mut out, &rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            // Unbalanced markup: the remainder is text, not a tag.
            push_decoded(&mut out, &rest[open..]);
            rest = "";
            break;
        };
        if is_block_tag(tag_name(&rest[open + 1..open + close])) {
            out.push('\n');
        }
        rest = &rest[open + close + 1..];
    }
    push_decoded(&mut out, rest);
    collapse_whitespace(&out)
}

/// Every browser this tool will try, in order: the environment override, then
/// Edge, then Chrome.
pub fn candidate_paths(env_value: Option<&str>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = env_value.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value));
    }
    paths.extend(EDGE_CANDIDATES.iter().map(PathBuf::from));
    paths.extend(CHROME_CANDIDATES.iter().map(PathBuf::from));
    paths
}

/// The first candidate that exists, judged by the injected predicate.
///
/// The predicate is a parameter rather than `Path::is_file` so the priority order
/// is testable without installing a browser at a known path.
pub fn resolve_browser_with(
    env_value: Option<&str>,
    exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf, ToolError> {
    let candidates = candidate_paths(env_value);
    if let Some(found) = candidates.iter().find(|path| exists(path)) {
        return Ok(found.clone());
    }
    let env_note = if env_value.is_some_and(|value| !value.trim().is_empty()) {
        String::new()
    } else {
        format!(", and ${BROWSER_ENV} was not set")
    };
    Err(ToolError::new(
        "BROWSER_NOT_FOUND",
        format!(
            "no Chromium-based browser was found (looked at {}{env_note}; set {BROWSER_ENV} to point at one)",
            candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

/// [`resolve_browser_with`] against the real filesystem and the real environment.
pub fn resolve_browser() -> Result<PathBuf, ToolError> {
    let env_value = std::env::var(BROWSER_ENV).ok();
    resolve_browser_with(env_value.as_deref(), |path| path.is_file())
}

/// `<data_dir>/cache/browser-profile`.
///
/// Reused between calls on purpose: a fresh profile costs about 102 s on this
/// host against 29–31 s for an existing one. Never the platform temp directory —
/// the temp directory is swept by other software, and losing the profile puts
/// every call back on the cold path.
pub fn profile_dir(data_dir: &Path) -> PathBuf {
    let mut dir = data_dir.to_path_buf();
    for part in PROFILE_RELATIVE {
        dir.push(part);
    }
    dir
}

/// `<data_dir>/tmp` — the host's own scratch root (AGENTS.md §8).
pub fn temp_root(data_dir: &Path) -> PathBuf {
    data_dir.join("tmp")
}

/// The temporary file the browser writes, before it is moved into the workspace.
pub fn temp_screenshot_file(pid: u32, sequence: u64) -> String {
    format!("browser-shot-{pid}-{sequence}.png")
}

/// The name a screenshot gets once it is in `<workspace>/screenshots`.
pub fn screenshot_file(stamp_ms: u128, sequence: u64) -> String {
    format!("page-{stamp_ms}-{sequence}.png")
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

/// Owns one temporary screenshot and removes it however the call ends — a
/// timeout, a missing output file, a failed move, an early return.
struct TempScreenshot {
    path: PathBuf,
    sequence: u64,
}

impl TempScreenshot {
    fn new(data_dir: &Path) -> Result<Self, ToolError> {
        let dir = temp_root(data_dir);
        std::fs::create_dir_all(&dir).map_err(|error| {
            ToolError::new(
                "TOOL_FAILED",
                format!("could not create {}: {error}", dir.display()),
            )
        })?;
        let sequence = SCREENSHOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Ok(Self {
            path: dir.join(temp_screenshot_file(std::process::id(), sequence)),
            sequence,
        })
    }

    /// The same guard for a caller that already knows the path. Tests use it.
    #[allow(dead_code)]
    fn at(path: PathBuf) -> Self {
        Self { path, sequence: 0 }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// The number this call took from the process-wide sequence, so the file it
    /// adopts into the workspace carries the same one.
    fn sequence(&self) -> u64 {
        self.sequence
    }
}

impl Drop for TempScreenshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Give the browser the same containment every other process tool gets: its own
/// process group on Unix, its own job object on Windows. A browser is a tree, and
/// a timeout that reaches only the launcher leaves renderers holding the profile.
fn contain_process_tree(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(super::windows_tool_runner_creation_flags(
        super::windows_breakaway_allowed(),
    ));
    #[cfg(all(not(windows), not(unix)))]
    let _ = command;
}

/// Build the browser command line for one call.
///
/// `screenshot` is the temporary path the browser writes when the mode asks for
/// one, and `None` otherwise. The flags are the measured-working set on this
/// host: `--headless=new` renders and runs script, `--dump-dom` prints the DOM
/// after load, and the persistent `--user-data-dir` is what keeps a call at
/// 29–31 s instead of 102 s.
pub fn build_command(
    program: &Path,
    request: &BrowserRequest,
    profile: &Path,
    screenshot: Option<&Path>,
) -> Command {
    let mut command = Command::new(program);
    command
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-extensions")
        .arg("--disable-background-networking")
        .arg("--hide-scrollbars")
        .arg("--mute-audio")
        .arg(format!("--user-data-dir={}", profile.display()))
        // The browser is a program the host starts, not the user's shell child:
        // nothing from the user's stdin belongs to it.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(profile)
        .kill_on_drop(true);
    match screenshot {
        Some(path) => {
            command
                .arg(format!("--screenshot={}", path.display()))
                .arg(format!("--window-size={WINDOW_SIZE}"));
        }
        None => {
            command.arg("--dump-dom");
        }
    }
    command.arg(&request.url);
    contain_process_tree(&mut command);
    command
}

/// Read one pipe to the ceiling while counting everything that arrived.
///
/// The pipe is drained past the ceiling rather than abandoned: a browser blocked
/// on a full pipe never exits, and the timeout would report a hang the tool
/// caused.
async fn drain_stream<R>(stream: Option<R>, keep: usize) -> (Vec<u8>, usize)
where
    R: AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return (Vec::new(), 0);
    };
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                total += read;
                if kept.len() < keep {
                    let room = keep - kept.len();
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                }
            }
        }
    }
    (kept, total)
}

/// Join one capture task, giving up after the drain window: a renderer that
/// outlived the launcher must not keep this call waiting on a pipe nobody closes.
async fn collect(task: tokio::task::JoinHandle<(Vec<u8>, usize)>) -> (Vec<u8>, usize) {
    match tokio::time::timeout(super::PIPE_DRAIN_TIMEOUT, task).await {
        Ok(Ok(value)) => value,
        _ => (Vec::new(), 0),
    }
}

/// A quoted tail of the browser's stderr, for an error that would otherwise say
/// only "nothing came back".
fn stderr_excerpt(raw: &[u8], total: usize) -> String {
    if total == 0 {
        return "the browser said nothing on stderr".to_string();
    }
    let text = String::from_utf8_lossy(raw);
    let flat = collapse_whitespace(&text);
    let excerpt: String = flat.chars().take(MAX_STDERR_DETAIL).collect();
    if excerpt.is_empty() {
        format!("the browser wrote {total} bytes on stderr, none of it text")
    } else {
        excerpt
    }
}

/// Write the browser's screenshot into `<workspace>/screenshots`.
///
/// The rename is what makes the workspace copy complete-or-absent: the browser
/// wrote into the data directory, and a half-written PNG in the project is a file
/// the user would have to notice.
fn adopt_screenshot(
    workspace: &Path,
    temp: &TempScreenshot,
    name: &str,
) -> Result<PathBuf, ToolError> {
    let dir = workspace.join(SCREENSHOT_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!("could not create {}: {error}", dir.display()),
        )
    })?;
    let target = dir.join(name);
    if std::fs::rename(temp.path(), &target).is_err() {
        // A workspace on another volume cannot be renamed across; the copy is
        // only attempted once the browser's file is known to exist.
        std::fs::copy(temp.path(), &target).map_err(|error| {
            ToolError::new(
                "TOOL_FAILED",
                format!(
                    "could not move the screenshot to {}: {error}",
                    target.display()
                ),
            )
        })?;
    }
    Ok(target)
}

/// Run one browser visit.
///
/// `workspace` is where `screenshots/` is created — only `mode=screenshot` needs
/// it. `data_dir` is where the reusable profile and the temporary file live; a
/// host that has no data directory has nowhere to keep the profile and would pay
/// the cold path on every call, so it is refused rather than silently slowed.
pub async fn execute(
    args: &Value,
    workspace: Option<&Path>,
    data_dir: Option<&Path>,
) -> Result<Value, ToolError> {
    let request = parse_request(args)?;
    let data_dir = data_dir.ok_or_else(|| {
        ToolError::new(
            "DATA_DIR_UNAVAILABLE",
            "this host has no data directory, so a reusable browser profile cannot be kept \
             (the tool runs at a hundred seconds a page without one)",
        )
    })?;
    if request.mode == Mode::Screenshot && workspace.is_none() {
        return Err(ToolError::new(
            "WORKSPACE_REQUIRED",
            "a screenshot is written into <workspace>/screenshots, and no workspace is open",
        ));
    }

    let program = resolve_browser()?;
    let profile = profile_dir(data_dir);
    std::fs::create_dir_all(&profile).map_err(|error| {
        ToolError::new(
            "TOOL_FAILED",
            format!(
                "could not create the browser profile {}: {error}",
                profile.display()
            ),
        )
    })?;

    let temp = if request.mode == Mode::Screenshot {
        Some(TempScreenshot::new(data_dir)?)
    } else {
        None
    };
    let started = std::time::Instant::now();
    let mut command = build_command(
        &program,
        &request,
        &profile,
        temp.as_ref().map(TempScreenshot::path),
    );

    let mut child = super::spawn_with_retries(&mut command)
        .await
        .map_err(|(code, message)| {
            ToolError::new(
                code,
                format!("could not start {}: {message}", program.display()),
            )
            .with_extra(json!({ "browser": program.display().to_string() }))
        })?;
    let pid = child.id().unwrap_or_default();
    let mut ownership = match super::ProcessOwnership::assign(&child) {
        Ok(ownership) => ownership,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(ToolError::new(
                "TOOL_FAILED",
                format!("the browser could not be contained: {error}"),
            ));
        }
    };

    let keep = request.max_bytes + BOUNDARY_SLACK_BYTES;
    let stdout_task = tokio::spawn(drain_stream(child.stdout.take(), keep));
    let stderr_task = tokio::spawn(drain_stream(child.stderr.take(), keep));

    let status =
        match tokio::time::timeout(Duration::from_millis(request.timeout_ms), child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => {
                let _ = ownership.terminate_fail_closed(pid);
                return Err(ToolError::new(
                    "TOOL_FAILED",
                    format!("waiting for {} failed: {error}", program.display()),
                ));
            }
            Err(_) => {
                // The launcher alone is not the tree: renderers and the zygote would
                // keep the profile locked and the next call would block on it.
                let _ = ownership.terminate_fail_closed(pid);
                let _ = child.wait().await;
                let _ = collect(stdout_task).await;
                let _ = collect(stderr_task).await;
                return Err(ToolError::new(
                    "TOOL_TIMEOUT",
                    format!(
                        "the browser did not finish {} within {} ms; the process tree was killed",
                        request.url, request.timeout_ms
                    ),
                )
                .with_extra(json!({
                    "mode": request.mode.as_str(),
                    "url": request.url,
                    "elapsedMs": started.elapsed().as_millis() as u64,
                    "timeoutMs": request.timeout_ms,
                })));
            }
        };

    let (stdout_raw, _) = collect(stdout_task).await;
    let (stderr_raw, stderr_total) = collect(stderr_task).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut content = json!({
        "mode": request.mode.as_str(),
        "elapsedMs": elapsed_ms,
    });

    if let Some(temp) = &temp {
        let name = screenshot_file(now_millis(), temp.sequence());
        if !temp.path().is_file() {
            return Err(ToolError::new(
                "TOOL_FAILED",
                format!(
                    "the browser wrote no screenshot for {} (exit {}): {}",
                    request.url,
                    status
                        .code()
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "unknown".into()),
                    stderr_excerpt(&stderr_raw, stderr_total)
                ),
            )
            .with_extra(json!({ "mode": request.mode.as_str(), "elapsedMs": elapsed_ms })));
        }
        let workspace = workspace.expect("screenshot mode requires a workspace");
        let path = adopt_screenshot(workspace, temp, &name)?;
        let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        content["screenshotPath"] = json!(path.display().to_string());
        content["bytes"] = json!(bytes);
        content["truncated"] = json!(false);
        return Ok(content);
    }

    let html = String::from_utf8_lossy(&stdout_raw).into_owned();
    if html.trim().is_empty() {
        return Err(ToolError::new(
            "TOOL_FAILED",
            format!(
                "the browser returned no DOM for {} (exit {}): {}",
                request.url,
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".into()),
                stderr_excerpt(&stderr_raw, stderr_total)
            ),
        )
        .with_extra(json!({ "mode": request.mode.as_str(), "elapsedMs": elapsed_ms })));
    }
    let body = match request.mode {
        Mode::Dom => html,
        Mode::Text => html_to_text(&html),
        Mode::Screenshot => unreachable!("screenshot mode returns above"),
    };
    let (text, truncated) = truncate_output(&body, request.max_bytes);
    content["content"] = json!(text);
    content["bytes"] = json!(body.len());
    content["truncated"] = json!(truncated);
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(url: &str, mode: Mode) -> BrowserRequest {
        BrowserRequest {
            url: url.to_string(),
            mode,
            max_bytes: MAX_OUTPUT_BYTES,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }

    /// Test files live under the build directory, never the platform temp
    /// directory (AGENTS.md §8).
    fn test_dir(label: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("browser-exec-tests")
            .join(format!("{label}-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("test workspace");
        root
    }

    fn args_of(command: Command) -> Vec<String> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_tool_answers_to_both_spellings() {
        assert!(recognizes("BrowserExec"));
        assert!(recognizes("browser_exec"));
        assert!(!recognizes("BrowserPreview"));
        assert!(!recognizes("Bash"));
    }

    #[test]
    fn only_http_https_and_file_urls_are_accepted() {
        assert_eq!(
            validate_url(" https://example.com/a?b=1 ").expect("https"),
            "https://example.com/a?b=1"
        );
        assert_eq!(
            validate_url("http://example.com").expect("http"),
            "http://example.com"
        );
        assert_eq!(
            validate_url("file:///C:/tmp/page.html").expect("file"),
            "file:///C:/tmp/page.html"
        );
        for refused in [
            "ftp://example.com/file",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "example.com",
            "http:///no-host",
            "",
            "   ",
        ] {
            let error = validate_url(refused).expect_err(refused);
            assert_eq!(error.code, "INVALID_ARGUMENT", "{refused}");
        }
        // The refusal names the scheme, so the caller can act on it.
        let error = validate_url("ftp://example.com").expect_err("ftp is refused");
        assert!(error.message.contains("ftp"), "{}", error.message);
    }

    #[test]
    fn the_mode_defaults_to_dom_and_rejects_unknown_spellings() {
        assert_eq!(parse_mode(None).expect("default"), Mode::Dom);
        assert_eq!(parse_mode(Some("  ")).expect("blank is dom"), Mode::Dom);
        assert_eq!(parse_mode(Some("TEXT")).expect("case"), Mode::Text);
        assert_eq!(
            parse_mode(Some("screenshot")).expect("screenshot"),
            Mode::Screenshot
        );
        let error = parse_mode(Some("pdf")).expect_err("pdf is not a mode");
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("pdf"), "{}", error.message);
        // The `url` is what makes a request; without it there is nothing to load.
        assert_eq!(
            parse_request(&json!({})).expect_err("url is required").code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn max_bytes_is_clamped_to_the_ceiling_and_defaults_when_absent() {
        assert_eq!(clamp_max_bytes(None), MAX_OUTPUT_BYTES);
        assert_eq!(clamp_max_bytes(Some(0)), MAX_OUTPUT_BYTES);
        assert_eq!(clamp_max_bytes(Some(512)), 512);
        assert_eq!(
            clamp_max_bytes(Some(MAX_OUTPUT_BYTES as u64)),
            MAX_OUTPUT_BYTES
        );
        assert_eq!(
            clamp_max_bytes(Some(MAX_OUTPUT_BYTES as u64 * 4)),
            MAX_OUTPUT_BYTES
        );
        let parsed = parse_request(&json!({
            "url": "https://example.com",
            "maxBytes": 4096,
        }))
        .expect("a request");
        assert_eq!(parsed.max_bytes, 4096);
        assert_eq!(parsed.timeout_ms, DEFAULT_TIMEOUT_MS);
    }

    #[test]
    fn the_timeout_has_a_default_and_a_hard_ceiling() {
        assert_eq!(clamp_timeout(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(0)), DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(5_000)), 5_000);
        assert_eq!(clamp_timeout(Some(MAX_TIMEOUT_MS + 1)), MAX_TIMEOUT_MS);
    }

    #[test]
    fn script_and_style_bodies_never_reach_the_text() {
        let html = "<html><head><style>body{color:red}</style>\
                    <script>var secret = 'hidden';</script></head>\
                    <body><p>Visible</p></body></html>";
        let text = html_to_text(html);
        assert_eq!(text, "Visible");
        assert!(!text.contains("secret"));
        assert!(!text.contains("color"));
    }

    #[test]
    fn nested_tags_become_one_line_per_block() {
        let html = "<div><h1>Title</h1><p>One <b>bold</b> line</p>\
                    <ul><li>first</li><li>second</li></ul></div>";
        let text = html_to_text(html);
        assert_eq!(text, "Title\nOne bold line\nfirst\nsecond");
    }

    #[test]
    fn entities_and_stray_ampersands_are_decoded() {
        let html = "<p>Fish &amp; chips &lt;3 &#65; &#x42; &nbsp;done &unknown; &</p>";
        let text = html_to_text(html);
        assert_eq!(text, "Fish & chips <3 A B done &unknown; &");
    }

    #[test]
    fn an_uppercase_script_block_is_removed_too() {
        let html = "<SCRIPT>bad()</SCRIPT><p>ok</p>";
        assert_eq!(html_to_text(html), "ok");
    }

    #[test]
    fn whitespace_is_collapsed_but_paragraphs_stay_apart() {
        let html = "<p>a   \n  b</p>\n\n\n<p>c</p>";
        assert_eq!(html_to_text(html), "a b\nc");
    }

    #[test]
    fn short_output_is_returned_untouched() {
        let (text, cut) = truncate_output("<p>hi</p>", MAX_OUTPUT_BYTES);
        assert_eq!(text, "<p>hi</p>");
        assert!(!cut);
    }

    #[test]
    fn long_output_is_cut_at_the_ceiling() {
        let long = "a".repeat(MAX_OUTPUT_BYTES + 500);
        let (text, cut) = truncate_output(&long, MAX_OUTPUT_BYTES);
        assert!(cut);
        assert!(text.starts_with(&"a".repeat(MAX_OUTPUT_BYTES)));
        assert!(text.contains("truncated at"));
    }

    /// The cut lands on a character boundary, so the tail is readable instead of
    /// a replacement glyph.
    #[test]
    fn a_multibyte_character_is_never_sliced() {
        let text = "汉字汉字";
        // Three bytes per character: a limit of 4 falls inside the second one.
        let (cut, truncated) = truncate_output(text, 4);
        assert!(truncated);
        assert_eq!(cut.lines().next().unwrap_or_default(), "汉");
        assert!(!cut.contains('\u{FFFD}'));

        let (exact, truncated) = truncate_output(text, 6);
        assert!(truncated);
        assert_eq!(exact.lines().next().unwrap_or_default(), "汉字");
    }

    #[test]
    fn the_environment_override_wins_over_every_candidate() {
        let env_path = Path::new("/opt/custom/chrome");
        let found = resolve_browser_with(Some("/opt/custom/chrome"), |path| {
            path == env_path || path == Path::new(EDGE_CANDIDATES[1])
        })
        .expect("the override wins");
        assert_eq!(found, env_path);
    }

    #[test]
    fn edge_is_preferred_over_chrome() {
        let found = resolve_browser_with(None, |path| {
            path == Path::new(EDGE_CANDIDATES[0]) || path == Path::new(CHROME_CANDIDATES[0])
        })
        .expect("edge is installed");
        assert_eq!(found, Path::new(EDGE_CANDIDATES[0]));

        // The second Edge location (64-bit Program Files) is still ahead of Chrome.
        let found = resolve_browser_with(None, |path| {
            path == Path::new(EDGE_CANDIDATES[1]) || path == Path::new(CHROME_CANDIDATES[1])
        })
        .expect("the other edge location");
        assert_eq!(found, Path::new(EDGE_CANDIDATES[1]));

        let found = resolve_browser_with(None, |path| path == Path::new(CHROME_CANDIDATES[0]))
            .expect("chrome alone");
        assert_eq!(found, Path::new(CHROME_CANDIDATES[0]));
    }

    #[test]
    fn a_missing_browser_is_reported_with_every_path_it_looked_at() {
        let error = resolve_browser_with(None, |_| false).expect_err("nothing is installed");
        assert_eq!(error.code, "BROWSER_NOT_FOUND");
        for candidate in EDGE_CANDIDATES.iter().chain(CHROME_CANDIDATES.iter()) {
            assert!(
                error.message.contains(candidate),
                "{} missing from {}",
                candidate,
                error.message
            );
        }
        assert!(error.message.contains(BROWSER_ENV));

        // A set-but-missing override is named as one of the paths that was tried.
        let error = resolve_browser_with(Some("/nope/chrome"), |_| false).expect_err("missing");
        assert!(error.message.contains("/nope/chrome"), "{}", error.message);
        assert!(!error.message.contains("was not set"), "{}", error.message);
    }

    /// The profile is the difference between 29 s and 102 s a call, so its
    /// location is part of the contract: under the data directory, never temp.
    #[test]
    fn the_profile_lives_under_the_data_directory() {
        let dir = profile_dir(Path::new("/data"));
        assert_eq!(dir, Path::new("/data/cache/browser-profile"));
        assert!(!dir.starts_with(std::env::temp_dir()));
        assert_eq!(temp_root(Path::new("/data")), Path::new("/data/tmp"));
    }

    #[test]
    fn screenshot_names_carry_their_sequence() {
        assert_eq!(temp_screenshot_file(7, 3), "browser-shot-7-3.png");
        assert_eq!(
            screenshot_file(1_700_000_000_000, 4),
            "page-1700000000000-4.png"
        );
    }

    #[test]
    fn the_command_line_asks_for_a_rendered_dom_on_a_reused_profile() {
        let profile = Path::new("/data/cache/browser-profile");
        let command = build_command(
            Path::new("/bin/msedge"),
            &request("https://example.com", Mode::Dom),
            profile,
            None,
        );
        let args = args_of(command);
        assert!(args.iter().any(|arg| arg == "--headless=new"), "{args:?}");
        assert!(
            args.iter()
                .any(|arg| arg == "--user-data-dir=/data/cache/browser-profile"),
            "{args:?}"
        );
        assert!(args.iter().any(|arg| arg == "--dump-dom"), "{args:?}");
        assert!(!args.iter().any(|arg| arg.starts_with("--screenshot=")));
        assert_eq!(args.last().map(String::as_str), Some("https://example.com"));
    }

    #[test]
    fn screenshot_mode_writes_to_the_temporary_file_and_never_to_stdout() {
        let temp = Path::new("/data/tmp/browser-shot-1-1.png");
        let command = build_command(
            Path::new("/bin/msedge"),
            &request("file:///C:/page.html", Mode::Screenshot),
            Path::new("/data/cache/browser-profile"),
            Some(temp),
        );
        let args = args_of(command);
        assert!(
            args.iter()
                .any(|arg| arg == "--screenshot=/data/tmp/browser-shot-1-1.png"),
            "{args:?}"
        );
        assert!(args.iter().any(|arg| arg.starts_with("--window-size=")));
        assert!(!args.iter().any(|arg| arg == "--dump-dom"), "{args:?}");
    }

    /// The guard removes the browser's file on every path out of a call.
    #[test]
    fn the_temporary_screenshot_is_removed_when_the_guard_drops() {
        let dir = test_dir("temp-guard");
        let path = dir.join("shot.png");
        std::fs::write(&path, b"png").expect("a temporary file");
        {
            let guard = TempScreenshot::at(path.clone());
            assert_eq!(guard.path(), path.as_path());
            assert!(path.is_file());
        }
        assert!(!path.exists());
    }

    /// A screenshot is adopted into the workspace by rename, and the temporary
    /// file is gone afterwards.
    #[test]
    fn a_screenshot_is_moved_into_the_workspace_screenshots_directory() {
        let root = test_dir("adopt");
        let data = root.join("data");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(temp_root(&data)).expect("temp root");
        let shot = TempScreenshot::new(&data).expect("a temporary path");
        std::fs::write(shot.path(), b"\x89PNG\r\n").expect("the browser wrote a file");
        let adopted =
            adopt_screenshot(&workspace, &shot, "page-1-1.png").expect("the screenshot is adopted");
        assert_eq!(adopted, workspace.join("screenshots").join("page-1-1.png"));
        assert!(adopted.is_file());
        assert_eq!(std::fs::read(&adopted).expect("bytes"), b"\x89PNG\r\n");
        drop(shot);
        // The guard has nothing left to remove, and the workspace copy stays.
        assert!(adopted.is_file());
    }

    /// A screenshot with no workspace open is refused before anything runs: the
    /// picture would have nowhere to land.
    #[tokio::test]
    async fn a_screenshot_with_no_workspace_is_refused() {
        let error = execute(
            &json!({ "url": "https://example.com", "mode": "screenshot" }),
            None,
            Some(Path::new("/data")),
        )
        .await
        .expect_err("a workspace is required");
        assert_eq!(error.code, "WORKSPACE_REQUIRED");
    }

    /// No data directory means no reusable profile, which means the cold path on
    /// every call — refused rather than silently slowed.
    #[tokio::test]
    async fn a_host_with_no_data_directory_is_refused() {
        let error = execute(&json!({ "url": "https://example.com" }), None, None)
            .await
            .expect_err("a data directory is required");
        assert_eq!(error.code, "DATA_DIR_UNAVAILABLE");
    }
}
