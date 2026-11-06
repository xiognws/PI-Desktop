//! Tests for the session-persistent shell runner.
//!
//! Protocol tests are pure: they feed synthetic byte streams to the scanner and
//! assert the exact bytes a command would have produced. Shell tests drive the
//! real session loop (`run_session`) against a locally resolved interpreter,
//! with a temporary directory as the workspace, and skip when no supported
//! shell is installed instead of depending on one machine's layout.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::shell;
use super::shell_session::{
    cell_text, decode_cell_frame, encode_cell_frame, is_stale, marker_holdback,
    persistent_enabled_for, run_session, session_args, CellFrame, CellScanner, Dialect, HeadStrip,
    ScanOutcome,
};
use super::ToolRunnerStartConfig;

const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn collect(scanner: &mut CellScanner, chunk: &[u8]) -> (Vec<u8>, Option<(i32, Vec<u8>)>) {
    match scanner.feed(chunk) {
        ScanOutcome::More(bytes) => (bytes, None),
        ScanOutcome::End {
            tail,
            code,
            trailing,
        } => (tail, Some((code, trailing))),
    }
}

#[test]
fn cell_frame_round_trips() {
    let frame = CellFrame::command("printf hello", Path::new("C:/work"), NONCE);
    let encoded = encode_cell_frame(&frame).expect("frame encodes");
    assert_eq!(
        u32::from_le_bytes([encoded[0], encoded[1], encoded[2], encoded[3]]) as usize,
        encoded.len() - 4,
        "length prefix covers exactly the JSON payload"
    );
    let decoded = decode_cell_frame(&encoded).expect("frame decodes");
    assert_eq!(decoded.command, "printf hello");
    assert_eq!(decoded.cwd.as_deref(), Some(Path::new("C:/work")));
    assert_eq!(decoded.nonce, NONCE);
}

#[test]
fn cell_frame_rejects_malformed_input() {
    // Truncated length prefix.
    assert!(decode_cell_frame(&[1, 0]).is_err());
    // Length that disagrees with the payload.
    let mut wrong = (4u32).to_le_bytes().to_vec();
    wrong.extend_from_slice(b"{}");
    assert!(decode_cell_frame(&wrong).is_err());
    // A command carrying a NUL can never be framed.
    let nul = CellFrame::command("bad\0command", Path::new("C:/work"), NONCE);
    assert!(encode_cell_frame(&nul).is_err());
    // An unknown frame kind is refused rather than silently misread.
    let mut json = serde_json::to_vec(&serde_json::json!({
        "kind": "shutdown",
        "command": "x",
        "nonce": NONCE,
    }))
    .expect("json");
    let mut frame = (json.len() as u32).to_le_bytes().to_vec();
    frame.append(&mut json);
    assert!(decode_cell_frame(&frame).is_err());
}

#[test]
fn scanner_returns_exact_output_before_the_marker() {
    let mut scanner = CellScanner::new(NONCE);
    let (out, end) = collect(&mut scanner, format!("hello\n\n{NONCE} 0\n").as_bytes());
    assert_eq!(out, b"hello\n");
    let (code, trailing) = end.expect("cell ends");
    assert_eq!(code, 0);
    assert!(trailing.is_empty());
}

#[test]
fn scanner_keeps_output_that_lacks_a_trailing_newline() {
    let mut scanner = CellScanner::new(NONCE);
    let (out, end) = collect(&mut scanner, format!("no-newline\n{NONCE} 7\n").as_bytes());
    assert_eq!(out, b"no-newline");
    assert_eq!(end.expect("cell ends").0, 7);
}

#[test]
fn scanner_accepts_crlf_markers_and_keeps_output_crlf() {
    let mut scanner = CellScanner::new(NONCE);
    let (out, end) = collect(
        &mut scanner,
        format!("line\r\n\r\n{NONCE} 3\r\n").as_bytes(),
    );
    assert_eq!(
        out, b"line\r\n",
        "the separator CRLF is protocol, earlier CRLFs are output"
    );
    assert_eq!(end.expect("cell ends").0, 3);
}

#[test]
fn scanner_reports_a_negative_exit_code() {
    let mut scanner = CellScanner::new(NONCE);
    let (_, end) = collect(
        &mut scanner,
        format!("\n{NONCE} -1073741510\r\n").as_bytes(),
    );
    assert_eq!(end.expect("cell ends").0, -1_073_741_510);
}

#[test]
fn scanner_ignores_output_that_only_mentions_the_nonce() {
    // A command cannot know the nonce, but a near-miss must not be mistaken for
    // the end of the cell: only `<nonce> <digits>` followed by a line break
    // terminates it.
    let mut scanner = CellScanner::new(NONCE);
    let noisy = format!("prefix {NONCE} suffix\n{NONCE}\n{NONCE} x\n{NONCE} 12x\n");
    let (out, end) = collect(&mut scanner, noisy.as_bytes());
    assert!(end.is_none(), "no marker in this stream");
    assert!(
        noisy.as_bytes().starts_with(&out),
        "forwarded bytes are always a prefix of the stream"
    );
    assert!(
        noisy.len() - out.len() <= marker_holdback(NONCE.len()),
        "only a bounded marker-sized tail may be withheld"
    );
}

#[test]
fn scanner_forwards_large_output_instead_of_holding_it() {
    // The hold-back is bounded by the marker length, so an ordinary large
    // output streams through as it arrives rather than accumulating.
    let mut scanner = CellScanner::new(NONCE);
    let chunk = vec![b'x'; 4096];
    let (out, end) = collect(&mut scanner, &chunk);
    assert!(end.is_none());
    assert_eq!(out.len(), 4096 - marker_holdback(NONCE.len()));
    assert!(out.iter().all(|byte| *byte == b'x'));
    // The withheld tail is released as soon as more bytes arrive.
    let (rest, end) = collect(&mut scanner, b"more\n");
    assert!(end.is_none());
    assert_eq!(
        out.len() + rest.len(),
        4096 + 5 - marker_holdback(NONCE.len())
    );
}

#[test]
fn scanner_detects_a_marker_split_across_reads() {
    let mut scanner = CellScanner::new(NONCE);
    let mut output = Vec::new();
    let end = {
        let mut end = None;
        for part in ["hel", "lo\n", "\n", NONCE, " ", "4", "2", "\r", "\n"] {
            let (bytes, cell) = collect(&mut scanner, part.as_bytes());
            output.extend_from_slice(&bytes);
            if cell.is_some() {
                end = cell;
            }
        }
        end
    };
    assert_eq!(output, b"hello\n");
    assert_eq!(end.expect("cell ends").0, 42);
}

#[test]
fn scanner_holds_back_only_a_possible_marker_prefix() {
    let mut scanner = CellScanner::new(NONCE);
    let (out, end) = collect(&mut scanner, NONCE.as_bytes());
    assert!(end.is_none());
    assert!(
        out.is_empty(),
        "a partial marker is withheld, not forwarded"
    );
    let (out, end) = collect(&mut scanner, b" tail\n");
    assert!(
        out.is_empty() || out.len() < marker_holdback(NONCE.len()),
        "the withheld tail is released only as it stops looking like a marker"
    );
    assert!(end.is_none());
}

#[test]
fn scanner_returns_trailing_bytes_for_the_next_cell() {
    let mut scanner = CellScanner::new(NONCE);
    let (_, end) = collect(
        &mut scanner,
        format!("x\n{NONCE} 0\n\r\nleftover").as_bytes(),
    );
    let (code, trailing) = end.expect("cell ends");
    assert_eq!(code, 0);
    assert_eq!(trailing, b"\r\nleftover");
}

#[test]
fn cwd_reset_prefix_matches_each_dialect() {
    let cwd = Path::new("C:/work dir/it's");
    let posix = cell_text(Dialect::Posix, cwd, "printf hi", NONCE);
    assert!(posix.contains("cd 'C:/work dir/it'\\''s'\n"), "{posix}");
    assert!(posix.contains("(\nprintf hi\n) < /dev/null\n"), "{posix}");
    assert!(
        posix.contains(&format!("printf '\\n%s %s\\n' {NONCE} $?")),
        "{posix}"
    );

    let cmd = cell_text(Dialect::Cmd, Path::new("C:/work"), "echo hi", NONCE);
    assert!(
        cmd.starts_with("cd /d \"C:/work\" && (echo hi)<nul\r\n"),
        "{cmd}"
    );
    assert!(cmd.contains(&format!("echo {NONCE} %ERRORLEVEL%")), "{cmd}");

    let ps = cell_text(Dialect::PowerShell, cwd, "Write-Output hi", NONCE);
    assert!(
        ps.contains("Set-Location -LiteralPath 'C:/work dir/it''s';"),
        "{ps}"
    );
    assert!(
        ps.contains(&format!("[Console]::Out.WriteLine('{NONCE} ' + $piCode)")),
        "{ps}"
    );
    assert!(
        !ps.trim_end().contains('\n'),
        "a PowerShell cell must stay on one line"
    );
}

#[test]
fn session_arguments_make_the_shell_read_stdin() {
    assert_eq!(
        session_args(Dialect::Posix),
        vec!["--noprofile", "--norc", "-s"]
    );
    assert_eq!(session_args(Dialect::Cmd), vec!["/D", "/Q", "/V:OFF"]);
    assert_eq!(
        session_args(Dialect::PowerShell),
        vec!["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]
    );
}

#[test]
fn idle_sessions_expire_at_the_limit() {
    assert!(!is_stale(
        Duration::from_secs(599),
        Duration::from_secs(600)
    ));
    assert!(is_stale(Duration::from_secs(600), Duration::from_secs(600)));
    assert!(is_stale(Duration::from_secs(601), Duration::from_secs(600)));
    assert!(!is_stale(Duration::ZERO, Duration::from_secs(600)));
}

#[test]
fn kill_switch_reads_the_environment() {
    assert!(persistent_enabled_for(None), "unset keeps the fast path");
    assert!(persistent_enabled_for(Some("")));
    assert!(persistent_enabled_for(Some("1")));
    for disabled in ["0", "false", "FALSE", "off", "no", " 0 "] {
        assert!(!persistent_enabled_for(Some(disabled)), "{disabled}");
    }
}

#[test]
fn head_strip_drops_one_cmd_prompt_break() {
    let mut strip = HeadStrip::new(true);
    assert_eq!(strip.apply(b"\r\nhello".to_vec()), b"hello");
    let mut split = HeadStrip::new(true);
    assert!(split.apply(b"\r".to_vec()).is_empty(), "waits for the pair");
    assert_eq!(split.apply(b"\nhello".to_vec()), b"hello");
    let mut empty_line = HeadStrip::new(true);
    assert_eq!(empty_line.apply(b"\r\n\r\n".to_vec()), b"\r\n");
    let mut untouched = HeadStrip::new(false);
    assert_eq!(untouched.apply(b"\r\nhello".to_vec()), b"\r\nhello");
}

// ---------------------------------------------------------------------------
// Real-shell session tests
// ---------------------------------------------------------------------------

fn session_config(program: PathBuf, workspace: &Path, dialect: Dialect) -> ToolRunnerStartConfig {
    ToolRunnerStartConfig {
        program,
        args: session_args(dialect),
        workspace: workspace.to_path_buf(),
        scratch_dir: None,
        env_path: shell::user_login_path().map(str::to_string),
        extra_env: Vec::new(),
        persistent: Some(true),
        session_key: Some("session-test".into()),
        shell_dialect: Some(dialect.name().to_string()),
    }
}

/// Runs one session over `cells` and returns `(exit code, per-cell output and
/// exit code)`. Frames are written up front; the bounded frame channel keeps the
/// runner reading them one at a time, in order.
async fn run_shell_session(
    dialect: Dialect,
    program: PathBuf,
    workspace: &Path,
    cells: &[&str],
) -> (i32, Vec<(String, i32)>) {
    let config = session_config(program, workspace, dialect);
    let mut frames = Vec::new();
    let mut nonces = Vec::new();
    for (index, command) in cells.iter().enumerate() {
        // Fixed per-cell nonces: the scan below pairs them with the replies.
        let nonce = format!("{index:02}abcdef{}", "0".repeat(26));
        nonces.push(nonce.clone());
        frames.extend_from_slice(
            &encode_cell_frame(&CellFrame::command(command, workspace, &nonce))
                .expect("test frame encodes"),
        );
    }

    let (mut reader, writer) = tokio::io::duplex(256 * 1024);
    let (mut err_reader, err_writer) = tokio::io::duplex(64 * 1024);
    let (control_writer, control_reader) = tokio::io::duplex(1024);
    let collector = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes).await;
        bytes
    });
    let err_collector = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = err_reader.read_to_end(&mut bytes).await;
        bytes
    });
    // The control side is a pipe, like the host's: one frame at a time, so the
    // session sees the same back-pressure it sees in production.
    let feeder = tokio::spawn(async move {
        let mut control_writer = control_writer;
        for frame in frames.chunks(64) {
            if control_writer.write_all(frame).await.is_err() {
                return;
            }
        }
        let _ = control_writer.shutdown().await;
    });
    let status = run_session(config, control_reader, writer, err_writer)
        .await
        .expect("session runs");
    let _ = feeder.await;
    let raw = collector.await.expect("collector joins");
    let err_raw = err_collector.await.expect("err collector joins");
    eprintln!(
        "DEBUG session status={status} raw_len={} raw={:?} stderr={:?}",
        raw.len(),
        String::from_utf8_lossy(&raw),
        String::from_utf8_lossy(&err_raw)
    );

    // Walk the reply the way the host does: one scanner per cell, with the same
    // head strip a cmd session applies.
    let mut results = Vec::new();
    let mut offset = 0usize;
    for nonce in &nonces {
        let mut scanner = CellScanner::new(nonce);
        let mut head = HeadStrip::new(dialect == Dialect::Cmd);
        let Some((output, code, trailing)) = (match scanner.feed(&raw[offset..]) {
            ScanOutcome::End {
                tail,
                code,
                trailing,
            } => Some((head.apply(tail), code, trailing)),
            ScanOutcome::More(_) => None,
        }) else {
            panic!(
                "cell {nonce} never completed: {:?}",
                String::from_utf8_lossy(&raw[offset..])
            );
        };
        offset += raw[offset..].len() - trailing.len();
        results.push((String::from_utf8_lossy(&output).to_string(), code));
    }
    (status, results)
}

#[cfg(unix)]
#[tokio::test]
async fn posix_session_runs_each_command_in_the_workspace() {
    let Ok(resolved) = shell::resolve_shell(shell::BASH_ID) else {
        eprintln!("bash is not installed; skipping the posix session test");
        return;
    };
    let workspace = tempfile::tempdir().expect("temp workspace");
    let (status, cells) = run_shell_session(
        Dialect::Posix,
        resolved.program,
        workspace.path(),
        &[
            "cd /; printf 'first\\n'",
            // A `cd` in the previous cell must not leak into this one.
            "printf '%s' \"$PWD\"",
            "printf 'err\\n' 1>&2; exit 9",
        ],
    )
    .await;
    assert_eq!(status, 0, "the session exits cleanly after its last frame");
    assert_eq!(cells.len(), 3);
    assert_eq!(cells[0], ("first\n".into(), 0));
    let expected = workspace.path().to_string_lossy().replace('\\', "/");
    assert_eq!(
        cells[1].0.trim_end(),
        expected,
        "cell starts in the workspace"
    );
    assert_eq!(cells[2].1, 9, "the command's exit code reaches the host");
}

#[cfg(windows)]
#[tokio::test]
async fn cmd_session_runs_each_command_in_the_workspace() {
    let Ok(resolved) = shell::resolve_shell(shell::CMD_ID) else {
        eprintln!("cmd is not installed; skipping the cmd session test");
        return;
    };
    let workspace = tempfile::tempdir().expect("temp workspace");
    let (status, cells) = run_shell_session(
        Dialect::Cmd,
        resolved.program,
        workspace.path(),
        &["cd /d C:\\Windows && echo first", "cd", "cmd /c exit 9"],
    )
    .await;
    assert_eq!(status, 0, "the session exits cleanly after its last frame");
    assert_eq!(cells.len(), 3);
    assert_eq!(cells[0], ("first\r\n".into(), 0));
    assert_eq!(
        cells[1].0.trim_end(),
        workspace.path().to_string_lossy().trim_end(),
        "cell starts in the workspace"
    );
    assert_eq!(cells[2].1, 9, "the command's exit code reaches the host");
}

#[cfg(windows)]
#[tokio::test]
async fn powershell_session_runs_each_command_in_the_workspace() {
    let Ok(resolved) = shell::resolve_shell(shell::WINDOWS_POWERSHELL_ID) else {
        eprintln!("powershell is not installed; skipping the powershell session test");
        return;
    };
    let workspace = tempfile::tempdir().expect("temp workspace");
    let (status, cells) = run_shell_session(
        Dialect::PowerShell,
        resolved.program,
        workspace.path(),
        &[
            "Set-Location C:\\Windows; [Console]::Out.WriteLine('first')",
            "[Console]::Out.WriteLine((Get-Location).Path)",
            "cmd /c exit 9",
        ],
    )
    .await;
    assert_eq!(status, 0, "the session exits cleanly after its last frame");
    assert_eq!(cells.len(), 3);
    assert_eq!(cells[0], ("first\r\n".into(), 0));
    assert_eq!(
        cells[1].0.trim_end(),
        workspace.path().to_string_lossy().trim_end(),
        "cell starts in the workspace"
    );
    assert_eq!(cells[2].1, 9, "the command's exit code reaches the host");
}
