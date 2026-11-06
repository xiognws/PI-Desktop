//! Office document tools: read and write `.xlsx`, `.docx`, `.pptx`, and `.pdf`.
//!
//! The libraries that understand these formats are Python-only, and the client
//! ships its own interpreter for exactly that reason (see
//! `apps/desktop/electron/main/python-runtime.ts`). So each call runs one short
//! lived Python process against the worker script in the bundle and returns its
//! JSON. Two consequences shape this module:
//!
//! * A malformed document can only kill the worker. The host reads a broken
//!   response, not a signal, and the session continues.
//! * Path containment is decided here, before the worker starts. The worker
//!   receives an already-resolved absolute path and never joins user input onto
//!   a root, so an argument cannot talk its way out of the workspace.
//!
//! Read operations only inspect a document; write operations replace a file and
//! are gated like `Write`.

use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::tools::hashline::ToolError;
use crate::workspace::{resolve_tool_path_with_external, ContainedRoots};

/// The formats the worker knows how to open. Keeping this list here (rather than
/// trusting whatever `format` says) means a typo fails with a real message
/// instead of a worker crash.
const FORMATS: [&str; 4] = ["xlsx", "docx", "pptx", "pdf"];

/// How long a document operation may run. Reading a 200-page PDF or writing a
/// 50k-row workbook is slow but not unbounded; anything past this is a hung
/// worker, and the caller should see a timeout rather than a frozen turn.
pub const OFFICE_TIMEOUT: Duration = Duration::from_secs(120);

/// Ceiling on the worker's stdout. The worker truncates its own output, so this
/// only catches a runaway that ignores its arguments.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// What the caller asked for, already validated.
#[derive(Debug)]
pub struct OfficeRequest {
    pub format: String,
    pub operation: String,
    pub path: String,
}

fn require_str(args: &Value, key: &str) -> Result<String, ToolError> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
        _ => Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!("`{key}` is required"),
        )),
    }
}

/// Read the caller's intent, refusing a format or operation the worker cannot
/// serve before spending a process on it.
pub fn parse_request(args: &Value) -> Result<OfficeRequest, ToolError> {
    let format = require_str(args, "format")?.to_lowercase();
    if !FORMATS.contains(&format.as_str()) {
        return Err(
            ToolError::new("INVALID_ARGUMENT", format!("unsupported format: {format}"))
                .with_extra(json!({ "supported": FORMATS })),
        );
    }
    let operation = args
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("read")
        .to_lowercase();
    if operation != "read" && operation != "write" {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            format!("unsupported operation: {operation}"),
        )
        .with_extra(json!({ "supported": ["read", "write"] })));
    }
    // `pdf` has no document model to edit; its write is a merge. Saying that
    // here keeps the message clear when the model asks for something that
    // cannot exist.
    if format == "pdf" && operation == "write" {
        return Err(ToolError::new(
            "INVALID_ARGUMENT",
            "pdf support is read and merge only; use the sources argument with operation write to merge",
        ));
    }
    let path = require_str(args, "path")?;
    Ok(OfficeRequest {
        format,
        operation,
        path,
    })
}

/// Locate the worker script in the shipped tree.
///
/// `PI_DESKTOP_PYTHON_TOOLS_DIR` lets a development build point at the source
/// checkout; a packaged build reads it from `<resources>/python/tools`, which
/// the bundle script created next to the interpreter.
fn worker_script(tools_dir: Option<&Path>) -> Result<std::path::PathBuf, ToolError> {
    let dir = tools_dir.ok_or_else(|| {
        ToolError::new(
            "PYTHON_RUNTIME_UNAVAILABLE",
            "this build ships no Python runtime; run scripts/bundle-python-runtime.mjs",
        )
    })?;
    let script = dir.join("office.py");
    if !script.is_file() {
        return Err(ToolError::new(
            "PYTHON_RUNTIME_UNAVAILABLE",
            format!("{} is missing from the bundled runtime", script.display()),
        ));
    }
    Ok(script)
}

/// Resolve one caller-supplied path against the session roots.
fn resolve_argument(
    workspace_root: &Path,
    roots: &ContainedRoots,
    input: &str,
    allow_external_paths: bool,
) -> Result<std::path::PathBuf, ToolError> {
    resolve_tool_path_with_external(workspace_root, roots, input, allow_external_paths)
        .map(|(path, _)| path)
        .map_err(|code| {
            let message = match code.as_str() {
                "PATH_OUTSIDE_WORKSPACE" => {
                    "the path is outside the workspace and session scratch directory".to_string()
                }
                _ => format!("{input} could not be resolved"),
            };
            ToolError::new(code, message)
        })
}

/// Run one worker request.
///
/// The request goes in on stdin and the response comes back on stdout, so the
/// caller never builds a command line: a path with spaces, quotes, or a leading
/// dash cannot change what runs.
pub async fn execute(
    workspace_root: &Path,
    roots: &ContainedRoots,
    args: &Value,
    allow_external_paths: bool,
    python_executable: Option<&Path>,
    tools_dir: Option<&Path>,
) -> Result<Value, ToolError> {
    let request = parse_request(args)?;
    let python = python_executable.ok_or_else(|| {
        ToolError::new(
            "PYTHON_RUNTIME_UNAVAILABLE",
            "this build ships no Python runtime; Office and file tools need it",
        )
    })?;
    let script = worker_script(tools_dir)?;

    // Containment first: the worker gets a resolved path and does no joining of
    // its own, so this is the only place the boundary is decided.
    let resolved = resolve_argument(workspace_root, roots, &request.path, allow_external_paths)?;
    if request.operation == "read" && !resolved.is_file() {
        return Err(ToolError::new(
            "FILE_NOT_FOUND",
            format!("{} does not exist", request.path),
        ));
    }

    // `args` is forwarded so per-format options (sheet, maxRows, blocks, slides,
    // sources) reach the worker without this module growing a field per format.
    let mut forwarded = args.clone();
    if let Some(object) = forwarded.as_object_mut() {
        object.insert("path".into(), json!(resolved.to_string_lossy()));
        if request.format == "pdf" && request.operation == "write" {
            // Merge sources obey the same roots the target does.
            let sources = object.get("sources").and_then(Value::as_array).cloned();
            if let Some(sources) = sources {
                let mut resolved_sources = Vec::with_capacity(sources.len());
                for source in sources {
                    let Some(text) = source.as_str() else {
                        return Err(ToolError::new(
                            "INVALID_ARGUMENT",
                            "sources must be strings",
                        ));
                    };
                    resolved_sources.push(json!(resolve_argument(
                        workspace_root,
                        roots,
                        text,
                        allow_external_paths
                    )?
                    .to_string_lossy()));
                }
                object.insert("sources".into(), Value::Array(resolved_sources));
            }
        }
    }
    let payload = json!({
        "format": request.format,
        "operation": request.operation,
        "args": forwarded,
    });

    let mut command = Command::new(python);
    command
        .arg(&script)
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // Same suppression the tool runner uses: a console window must not flash
        // when the agent reads a spreadsheet.
        command.creation_flags(0x0800_0000);
    }

    let mut child = command.spawn().map_err(|error| {
        ToolError::new(
            "PYTHON_RUNTIME_UNAVAILABLE",
            format!("could not start {}: {error}", python.display()),
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        let body = payload.to_string();
        // A worker that dies before reading stdin gives a broken pipe, which is
        // a worker failure, not an argument failure.
        stdin.write_all(body.as_bytes()).await.map_err(|error| {
            ToolError::new(
                "PYTHON_RUNTIME_UNAVAILABLE",
                format!("could not send the request: {error}"),
            )
        })?;
    }

    let output = match tokio::time::timeout(OFFICE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(ToolError::new(
                "TOOL_FAILED",
                format!("the document worker failed: {error}"),
            ))
        }
        Err(_) => {
            return Err(ToolError::new(
                "TIMEOUT",
                format!(
                    "the document worker did not finish in {} seconds",
                    OFFICE_TIMEOUT.as_secs()
                ),
            ))
        }
    };

    if output.stdout.len() > MAX_RESPONSE_BYTES {
        return Err(ToolError::new(
            "OUTPUT_TOO_LARGE",
            "the document result exceeded the response budget",
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(text.trim()).map_err(|_| {
        // No JSON means the worker died before it could answer. Its stderr is
        // the only evidence, so it becomes the message rather than being lost.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .last()
            .unwrap_or("the worker produced no output");
        ToolError::new(
            "DOCUMENT_UNREADABLE",
            format!("the document worker stopped early: {detail}"),
        )
    })?;

    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = parsed
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("DOCUMENT_UNREADABLE")
            .to_string();
        let message = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the document could not be processed")
            .to_string();
        return Err(ToolError::new(code, message).with_extra(parsed));
    }

    Ok(parsed)
}

/// Does this tool name belong to the Office family?
pub fn recognizes(tool_name: &str) -> bool {
    tool_name == "OfficeRead" || tool_name == "OfficeWrite"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A caller that names an unknown format should be told what is supported,
    /// not handed a worker crash: the model reads this message and retries.
    #[test]
    fn an_unknown_format_is_refused_with_the_supported_list() {
        let error = parse_request(&json!({ "format": "csv", "path": "a.csv" }))
            .expect_err("csv is not an Office format");
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("csv"));
        assert!(error.extra["supported"].is_array());
    }

    /// `operation` defaults to read, which is what an inspecting caller means by
    /// naming only a file.
    #[test]
    fn operation_defaults_to_read() {
        let request =
            parse_request(&json!({ "format": "XLSX", "path": "book.xlsx" })).expect("a request");
        assert_eq!(request.operation, "read");
        // Normalised, so `XLSX` and `xlsx` reach the same worker branch instead
        // of one of them falling through.
        assert_eq!(request.format, "xlsx");
    }

    /// PDF has no editable document model here; saying so beats a generic
    /// "unsupported operation" that invites the model to keep trying.
    #[test]
    fn pdf_write_explains_that_it_merges() {
        let error = parse_request(&json!({
            "format": "pdf", "operation": "write", "path": "out.pdf",
        }))
        .expect_err("pdf write is a merge, not an edit");
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("merge"));
    }

    #[test]
    fn a_missing_path_is_an_argument_error() {
        for args in [
            json!({ "format": "docx" }),
            json!({ "format": "docx", "path": "   " }),
        ] {
            let error = parse_request(&args).expect_err("path is required");
            assert_eq!(error.code, "INVALID_ARGUMENT");
        }
    }

    /// A build without a bundled runtime must say so plainly; falling back to
    /// the customer's own Python would make behaviour depend on their machine.
    #[test]
    fn a_build_without_a_runtime_says_so() {
        let error = worker_script(None).expect_err("no tools directory");
        assert_eq!(error.code, "PYTHON_RUNTIME_UNAVAILABLE");
        assert!(error.message.contains("bundle-python-runtime"));
    }

    #[test]
    fn requires_exactly_the_two_office_tools() {
        assert!(recognizes("OfficeRead"));
        assert!(recognizes("OfficeWrite"));
        assert!(!recognizes("Read"));
        assert!(!recognizes("officeRead"));
    }
}
