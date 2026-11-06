//! Session-persistent shell runner.
//!
//! A foreground `Bash` call used to cost three processes: the host, a second
//! copy of the host started in runner mode, and the interpreter, plus the
//! command itself. Measured turns issue dozens of such calls, so the host
//! looked like an unsigned binary spawning interpreters in a tight loop — the
//! shape endpoint protection scores as malicious.
//!
//! A persistent runner keeps one runner process and one interpreter alive per
//! (session, shell, workspace) and feeds commands through pipes instead, so a
//! call costs the command alone. The protocol and its invariants are described
//! in `docs/notes/persistent-shell-runner.md`; this module implements both
//! ends.
//!
//! Wire shape:
//!
//! ```text
//! host -> runner (runner stdin)    u32 LE length | JSON CellFrame
//! runner -> host (runner stdout)   raw command output, then "<nonce> <code>\r?\n"
//! ```
//!
//! The per-command nonce is 128 random bits, so a command cannot forge the end
//! marker by accident. Only `stdout` carries the marker: `stderr` stays a pure
//! copy of the interpreter's stderr, exactly as in one-shot mode.
//!
//! The frame stream (host -> runner) is never the interpreter's stdin. The
//! runner reads frames on its own stdin and gives the shell a separate pipe it
//! writes command text to, so a command that reads stdin can only ever eat its
//! own cell text — never a frame, and never another cell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{
    bash_aborted_error, bash_success_result, bash_timeout_error, kill_and_reap, spawn_tool_runner,
    spawn_with_retries, wait_for_cancellation, BashExecutionOptions, CapturedOutput, OutputChunk,
    OutputNotifier, OutputStream, SpawnedToolRunner, ToolRunnerStartConfig,
    DEFAULT_BASH_TIMEOUT_MS, INTERNAL_RUNNER_ERROR_PREFIX, OUTPUT_NOTIFICATION_INTERVAL,
    PIPE_DRAIN_TIMEOUT,
};

/// A single command frame may carry this much JSON. Commands are bounded far
/// below this by the tool-input budget; the ceiling exists so a corrupt length
/// prefix cannot ask the runner to allocate without bound.
const CELL_FRAME_MAX_BYTES: usize = 1024 * 1024;
/// Session lifetimes. A host process outlives many sessions, so an unused
/// shell must not accumulate: idle sessions are closed and the number of live
/// ones is capped.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const SESSION_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const MAX_SESSIONS: usize = 8;
/// Environment switch: `PI_DESKTOP_PERSISTENT_SHELL=0` (also false/off/no)
/// forces every call back onto the one-shot path without a rebuild.
const PERSISTENT_SHELL_ENV: &str = "PI_DESKTOP_PERSISTENT_SHELL";
/// Exit-code digits the marker may carry, sign included. Bounded so
/// nonce-shaped text in command output cannot stall the scanner.
const SENTINEL_MAX_CODE_BYTES: usize = 12;
/// How long a freshly started session may take to answer its init cell.
const INIT_CELL_TIMEOUT_MS: u64 = 30_000;

/// How long a closing session waits for the interpreter to run the cells that
/// were already queued before the control stream ended.
///
/// Killing the shell the moment control closes loses the output of every queued
/// cell; cmd and PowerShell both exit on stdin EOF once their queue is empty, so
/// the normal case needs no kill at all.
const SESSION_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// Shell family a session speaks, named after `shell::dialect_for_id` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    Posix,
    Cmd,
    PowerShell,
}

impl Dialect {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "posix" => Some(Self::Posix),
            "cmd" => Some(Self::Cmd),
            "powershell" => Some(Self::PowerShell),
            _ => None,
        }
    }

    pub(crate) fn from_shell_id(id: &str) -> Option<Self> {
        Self::from_name(super::shell::dialect_for_id(id)?)
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Cmd => "cmd",
            Self::PowerShell => "powershell",
        }
    }

    /// Only a POSIX shell parses its stdin line by line and tolerates a
    /// multi-line cell.
    ///
    /// PowerShell's `-Command -` reader accumulates an incomplete construct and
    /// then stops executing anything until that construct is satisfied, which
    /// silently wedges the session: measured, an `if (...) {` block sent line by
    /// line produced no output and no error, and every later command was
    /// swallowed too. cmd answers each continuation line with a `More? `
    /// prompt, which would be interleaved into command output. Both dialects
    /// therefore replay a multi-line command through the one-shot path.
    fn allows_multiline(self) -> bool {
        matches!(self, Self::Posix)
    }
}

/// Interpreter arguments that make the shell read commands from stdin for the
/// rest of its life.
///
/// This deliberately differs from the one-shot invocation, where the command is
/// embedded in the arguments (`-Command <script>`, `/C <command>`, `-c <cmd>`)
/// — which is exactly what made that process short-lived.
pub(crate) fn session_args(dialect: Dialect) -> Vec<String> {
    match dialect {
        Dialect::Posix => vec!["--noprofile".into(), "--norc".into(), "-s".into()],
        Dialect::Cmd => vec!["/D".into(), "/Q".into(), "/V:OFF".into()],
        Dialect::PowerShell => vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "-".into(),
        ],
    }
}

/// Session start-up script, written before the first cell.
///
/// cmd is the only dialect that needs one: `chcp 65001` matches the one-shot
/// UTF-8 contract, and `prompt $` reduces the per-command prompt to a bare line
/// break, which keeps cell output at deterministic offsets. The banner cmd
/// prints at start-up lands in the init cell, whose output the host discards.
fn prelude(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Posix => "",
        Dialect::Cmd => "chcp 65001>nul\r\nprompt $\r\n",
        Dialect::PowerShell => {
            "$OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $OutputEncoding; $ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'\r\n"
        }
    }
}

/// A cell whose output and status the host throws away: it exists so the
/// session is known to answer before a real command depends on it.
///
/// These must be real statements, not comments: cmd's `rem` swallows the rest of
/// its parenthesised line (including the closing paren, which leaves the
/// interpreter waiting at a `More?` prompt) and PowerShell's `#` swallows the
/// rest of the single-line wrapper, marker included.
fn init_command(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::Posix => ":",
        Dialect::Cmd => "ver >nul",
        Dialect::PowerShell => "$null = 0",
    }
}

fn posix_quote(path: &Path) -> String {
    // POSIX shells on Windows (Git Bash) consume forward slashes, and a
    // backslash would be an escape character outside quotes.
    let text = path.to_string_lossy().replace('\\', "/");
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn powershell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}

/// One command, wrapped so that (a) it always starts in `cwd`, (b) it cannot
/// read the shell's command stream, and (c) its exit status reaches the host.
///
/// Every dialect emits command output, then a blank line, then
/// `<nonce> <code>`; the host cuts output at that separator, so a command whose
/// output does not end with a newline keeps its exact bytes.
pub(crate) fn cell_text(dialect: Dialect, cwd: &Path, command: &str, nonce: &str) -> String {
    match dialect {
        // The command sits in a subshell so `< /dev/null` can be applied to it
        // without swallowing the rest of the session's stdin, and so `$?`
        // afterwards is the command's own status. Multi-line commands are fine
        // here: the sub-shell stays open until its closing paren.
        Dialect::Posix => format!(
            "cd {cwd}\n(\n{command}\n) < /dev/null\nprintf '\\n%s %s\\n' {nonce} $?\n",
            cwd = posix_quote(cwd)
        ),
        // `cd /d` must succeed before the command runs, and `<nul` keeps a
        // command that reads stdin from consuming the next command line. The
        // parentheses sit tight against the command: cmd echoes the space
        // between a command and its closing paren, so `( echo hi )` would report
        // `hi ` while the one-shot path reports `hi`. The exit code is echoed on
        // its own line because cmd expands `%ERRORLEVEL%` when it parses that
        // line, i.e. after the command ran.
        Dialect::Cmd => format!(
            "cd /d \"{cwd}\" && ({command})<nul\r\necho {nonce} %ERRORLEVEL%\r\n",
            cwd = cwd.display()
        ),
        // Mirrors the one-shot PowerShell wrapper (same stderr routing, same
        // native-vs-PowerShell error rule) so both paths report the same exit
        // code for the same command. One line on purpose: see
        // `Dialect::allows_multiline`.
        Dialect::PowerShell => format!(
            "$global:LASTEXITCODE = 0; $script:piSessionError = $false; Set-Location -LiteralPath {cwd}; & {{ {command} }} 2>&1 | ForEach-Object {{ if ($_ -is [System.Management.Automation.ErrorRecord]) {{ if ($_.FullyQualifiedErrorId -notlike 'NativeCommandError*') {{ $script:piSessionError = $true }}; [Console]::Error.WriteLine($_.Exception.Message) }} else {{ $_ }} }} | Out-String -Stream | ForEach-Object {{ [Console]::Out.WriteLine($_) }}; $piCode = $(if ($script:piSessionError) {{ 1 }} else {{ $LASTEXITCODE }}); [Console]::Out.WriteLine(); [Console]::Out.WriteLine('{nonce} ' + $piCode)\r\n",
            cwd = powershell_quote(cwd)
        ),
    }
}

fn new_nonce() -> String {
    // uuid v4 is already a dependency and draws 122 random bits from the OS
    // generator: enough that command output cannot collide with the marker.
    uuid::Uuid::new_v4().simple().to_string()
}

/// One unit of work for a live session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CellFrame {
    /// Protocol tag, reserved so a later stage can add frames beside commands.
    pub(crate) kind: String,
    pub(crate) command: String,
    /// Command working directory; the runner falls back to the configured
    /// workspace when absent.
    #[serde(default)]
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) nonce: String,
}

impl CellFrame {
    pub(crate) fn command(command: &str, cwd: &Path, nonce: &str) -> Self {
        Self {
            kind: "command".into(),
            command: command.to_string(),
            cwd: Some(cwd.to_path_buf()),
            nonce: nonce.to_string(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.kind != "command" {
            return Err(format!("unknown session frame kind '{}'", self.kind));
        }
        if self.command.contains('\0') {
            return Err("session command contains an embedded NUL".into());
        }
        if self.nonce.is_empty()
            || self.nonce.len() > 64
            || !self.nonce.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err("session command nonce is invalid".into());
        }
        if self
            .cwd
            .as_deref()
            .is_some_and(|path| path.as_os_str().is_empty() || path_has_nul(path))
        {
            return Err("session command directory is invalid".into());
        }
        Ok(())
    }
}

fn path_has_nul(path: &Path) -> bool {
    path.to_string_lossy().contains('\0')
}

pub(crate) fn encode_cell_frame(frame: &CellFrame) -> Result<Vec<u8>, String> {
    frame.validate()?;
    let json = serde_json::to_vec(frame)
        .map_err(|error| format!("failed to encode session command: {error}"))?;
    if json.is_empty() || json.len() > CELL_FRAME_MAX_BYTES || json.len() > u32::MAX as usize {
        return Err("session command is too large".into());
    }
    let mut bytes = Vec::with_capacity(4 + json.len());
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&json);
    Ok(bytes)
}

pub(crate) fn decode_cell_frame(frame: &[u8]) -> Result<CellFrame, String> {
    if frame.len() < 4 {
        return Err("session command frame is truncated".into());
    }
    let length = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length == 0 || length > CELL_FRAME_MAX_BYTES {
        return Err("session command frame length is invalid".into());
    }
    if frame.len() != 4 + length {
        return Err("session command frame length does not match its payload".into());
    }
    let frame: CellFrame = serde_json::from_slice(&frame[4..])
        .map_err(|error| format!("invalid session command JSON: {error}"))?;
    frame.validate()?;
    Ok(frame)
}

async fn write_cell_frame<W>(writer: &mut W, frame: &CellFrame) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let bytes = encode_cell_frame(frame)?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| format!("failed to send session command: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("failed to flush session command: {error}"))
}

/// Reads frames until the peer closes the pipe, on its own task so the session
/// loop keeps relaying shell output while it waits.
async fn read_frames<R>(mut control: R, tx: mpsc::Sender<CellFrame>)
where
    R: AsyncRead + Unpin,
{
    loop {
        let mut length_bytes = [0u8; 4];
        if control.read_exact(&mut length_bytes).await.is_err() {
            // A closed pipe between frames is the host going away, not an error.
            return;
        }
        let length = u32::from_le_bytes(length_bytes) as usize;
        if length == 0 || length > CELL_FRAME_MAX_BYTES {
            return;
        }
        let mut payload = vec![0u8; length];
        if control.read_exact(&mut payload).await.is_err() {
            return;
        }
        let mut raw = Vec::with_capacity(4 + payload.len());
        raw.extend_from_slice(&length_bytes);
        raw.extend_from_slice(&payload);
        let frame = match decode_cell_frame(&raw) {
            Ok(frame) => frame,
            // A malformed frame means the two ends disagree about the protocol;
            // ending the session is safer than silently skipping a command.
            Err(_) => return,
        };
        if tx.send(frame).await.is_err() {
            return;
        }
    }
}

/// Copies one pipe to one writer until EOF. The runner relays bytes and never
/// interprets them: all protocol parsing happens at the host.
async fn forward<R, W>(mut reader: R, mut writer: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if writer.write_all(&buffer[..read]).await.is_err() {
                    break;
                }
                if writer.flush().await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = writer.flush().await;
}

/// Entry point for a runner started with `persistent: true`.
pub(crate) async fn run_persistent_runner(
    config: ToolRunnerStartConfig,
    control: tokio::io::Stdin,
) -> anyhow::Result<i32> {
    run_session(config, control, tokio::io::stdout(), tokio::io::stderr()).await
}

/// The session loop, generic over its pipes so tests can drive it directly.
pub(crate) async fn run_session<C, O, E>(
    config: ToolRunnerStartConfig,
    control: C,
    out: O,
    err: E,
) -> anyhow::Result<i32>
where
    C: AsyncRead + Unpin + Send + 'static,
    O: AsyncWrite + Unpin + Send + 'static,
    E: AsyncWrite + Unpin + Send + 'static,
{
    let dialect = config
        .shell_dialect
        .as_deref()
        .and_then(Dialect::from_name)
        .ok_or_else(|| anyhow!("persistent shell runner needs a known shell dialect"))?;

    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .current_dir(&config.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(scratch_dir) = config.scratch_dir.as_deref() {
        command.env("PI_SCRATCH_DIR", scratch_dir);
    }
    if let Some(path) = config.env_path.as_deref() {
        command.env("PATH", path);
    }
    for (name, value) in &config.extra_env {
        command.env(name, value);
    }
    #[cfg(windows)]
    {
        command.creation_flags(super::WINDOWS_CREATE_NO_WINDOW);
    }

    let mut child = match spawn_with_retries(&mut command).await {
        Ok(child) => child,
        Err((code, message)) if code == "PROCESS_RESOURCE_EXHAUSTED" => {
            eprintln!("{INTERNAL_RUNNER_ERROR_PREFIX}{code}\t{message}");
            return Ok(1);
        }
        Err((code, message)) => return Err(anyhow!("{code}: {message}")),
    };

    let mut shell_stdin = Some(
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("persistent shell did not expose stdin"))?,
    );
    let mut shell_stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("persistent shell did not expose stdout"))?;
    let shell_stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("persistent shell did not expose stderr"))?;

    let prelude = prelude(dialect);
    if !prelude.is_empty() {
        let stdin = shell_stdin
            .as_mut()
            .ok_or_else(|| anyhow!("persistent shell closed its stdin during start-up"))?;
        stdin
            .write_all(prelude.as_bytes())
            .await
            .map_err(|error| anyhow!("persistent shell rejected its prelude: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| anyhow!("persistent shell rejected its prelude: {error}"))?;
    }

    // Absorb the interpreter's start-up output before any real cell runs: cmd
    // prints a version banner and a prompt, PowerShell prints its prompt, and
    // both would otherwise land in the first command's output. The init cell
    // ends with its own marker, so everything up to it is discarded here.
    let startup_remainder = absorb_startup_banner(
        &mut shell_stdin,
        &mut shell_stdout,
        dialect,
        &config.workspace,
    )
    .await?;

    let out_task = tokio::spawn(forward_prefixed(startup_remainder, shell_stdout, out));
    let err_task = tokio::spawn(forward(shell_stderr, err));
    let (frame_tx, mut frame_rx) = mpsc::channel::<CellFrame>(1);
    let reader_task = tokio::spawn(read_frames(control, frame_tx));

    let mut shell_status = None;
    loop {
        tokio::select! {
            frame = frame_rx.recv() => {
                let Some(frame) = frame else {
                    // The control stream closed. Cells that were already queued
                    // still owe the host their output, so close the shell's
                    // stdin — cmd and PowerShell then exit on their own once the
                    // queue is empty — instead of killing it on the spot.
                    close_shell_stdin(&mut shell_stdin).await;
                    match tokio::time::timeout(SESSION_DRAIN_TIMEOUT, child.wait()).await {
                        Ok(Ok(status)) => shell_status = Some(status),
                        Ok(Err(_)) => {}
                        Err(_) => {
                            // A shell that ignores stdin EOF would hold the
                            // runner open forever; take it down instead.
                            let _ = child.start_kill();
                        }
                    }
                    break;
                };
                let cwd = frame.cwd.clone().unwrap_or_else(|| config.workspace.clone());
                let text = cell_text(dialect, &cwd, &frame.command, &frame.nonce);
                let Some(stdin) = shell_stdin.as_mut() else {
                    break;
                };
                if stdin.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
            status = child.wait() => {
                shell_status = status.ok();
                break;
            }
        }
    }

    reader_task.abort();
    let _ = reader_task.await;
    // Ending the session must not leave the interpreter behind: a runner that
    // exits on its own is not covered by the host's job/process-group teardown.
    let status = match shell_status {
        Some(status) => super::runner_exit_code(status),
        None => {
            close_shell_stdin(&mut shell_stdin).await;
            let _ = child.start_kill();
            match child.wait().await {
                Ok(status) => super::runner_exit_code(status),
                Err(_) => 1,
            }
        }
    };
    let _ = tokio::time::timeout(PIPE_DRAIN_TIMEOUT, out_task).await;
    let _ = tokio::time::timeout(PIPE_DRAIN_TIMEOUT, err_task).await;
    Ok(status)
}

/// Runs the init cell and discards everything the interpreter printed before its
/// marker, returning any bytes that arrived after it.
async fn absorb_startup_banner<R>(
    shell_stdin: &mut Option<tokio::process::ChildStdin>,
    shell_stdout: &mut R,
    dialect: Dialect,
    workspace: &Path,
) -> anyhow::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let nonce = new_nonce();
    let text = cell_text(dialect, workspace, init_command(dialect), &nonce);
    let stdin = shell_stdin
        .as_mut()
        .ok_or_else(|| anyhow!("persistent shell closed its stdin during start-up"))?;
    stdin
        .write_all(text.as_bytes())
        .await
        .map_err(|error| anyhow!("persistent shell rejected its init cell: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| anyhow!("persistent shell rejected its init cell: {error}"))?;

    let mut scanner = CellScanner::new(&nonce);
    let mut buffer = [0u8; 8192];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(INIT_CELL_TIMEOUT_MS);
    loop {
        let read = tokio::time::timeout_at(deadline, shell_stdout.read(&mut buffer))
            .await
            .map_err(|_| anyhow!("persistent shell did not answer its init cell"))??;
        if read == 0 {
            return Err(anyhow!(
                "persistent shell exited before answering its init cell"
            ));
        }
        if let ScanOutcome::End { trailing, .. } = scanner.feed(&buffer[..read]) {
            return Ok(trailing);
        }
    }
}

/// Forwards a session's stdout, emitting the bytes that were already read while
/// absorbing the start-up banner first.
async fn forward_prefixed<R, W>(prefix: Vec<u8>, reader: R, writer: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    if prefix.is_empty() {
        forward(reader, writer).await;
        return;
    }
    let mut writer = writer;
    if writer.write_all(&prefix).await.is_err() {
        return;
    }
    if writer.flush().await.is_err() {
        return;
    }
    forward(reader, writer).await;
}

/// Closes the interpreter's stdin so it sees EOF and exits once its queue is
/// empty.
///
/// `AsyncWrite::shutdown` on a child pipe flushes the buffer but leaves the OS
/// handle open, so cmd keeps waiting for input that never arrives: measured, a
/// session that only called `shutdown()` hung until its drain timeout killed
/// it. Dropping the handle is what actually closes the pipe.
async fn close_shell_stdin(stdin: &mut Option<tokio::process::ChildStdin>) {
    if let Some(mut handle) = stdin.take() {
        let _ = handle.shutdown().await;
        drop(handle);
    }
}

/// What one cell's stdout feed produced.
#[derive(Debug)]
pub(crate) enum ScanOutcome {
    /// Bytes confirmed to be command output; more may follow.
    More(Vec<u8>),
    /// The cell ended. `tail` is the last output not yet forwarded, `trailing`
    /// is everything after the marker (protocol junk for the next cell).
    End {
        tail: Vec<u8>,
        code: i32,
        trailing: Vec<u8>,
    },
}

/// Splits a session's stdout into command output and end-of-cell markers.
///
/// Bytes are held back only while they could still be the start of a marker, so
/// a marker split across two pipe reads is still recognised while a large
/// output is forwarded as it arrives.
pub(crate) struct CellScanner {
    nonce: Vec<u8>,
    pending: Vec<u8>,
}

impl CellScanner {
    pub(crate) fn new(nonce: &str) -> Self {
        Self {
            nonce: nonce.as_bytes().to_vec(),
            pending: Vec::new(),
        }
    }

    pub(crate) fn feed(&mut self, chunk: &[u8]) -> ScanOutcome {
        self.pending.extend_from_slice(chunk);
        let mut search = 0usize;
        loop {
            let Some(offset) = find_bytes(&self.pending[search..], &self.nonce) else {
                return ScanOutcome::More(self.drain_forwardable());
            };
            let start = search + offset;
            match self.match_end(start) {
                EndMatch::No => search = start + 1,
                EndMatch::Incomplete => {
                    // Keep the two bytes before the nonce: they may be the
                    // separator that the finished cell has to strip.
                    let hold = start.saturating_sub(2);
                    return ScanOutcome::More(self.pending.drain(..hold).collect());
                }
                EndMatch::Yes {
                    code,
                    terminator_end,
                } => {
                    let trailing = self.pending.split_off(terminator_end);
                    let body = std::mem::take(&mut self.pending);
                    let cut = separator_start(&body, start);
                    self.pending = trailing.clone();
                    return ScanOutcome::End {
                        tail: body[..cut].to_vec(),
                        code,
                        trailing,
                    };
                }
            }
        }
    }

    /// Keeps a bounded tail that could still begin a marker and returns the
    /// rest as output that is certainly not protocol.
    fn drain_forwardable(&mut self) -> Vec<u8> {
        let keep = marker_holdback(self.nonce.len());
        if self.pending.len() <= keep {
            return Vec::new();
        }
        let flush = self.pending.len() - keep;
        self.pending.drain(..flush).collect()
    }

    fn match_end(&self, nonce_start: usize) -> EndMatch {
        let bytes = &self.pending;
        let mut index = nonce_start + self.nonce.len();
        if bytes.get(index) != Some(&b' ') {
            return EndMatch::No;
        }
        index += 1;
        // The sign is part of the value: cmd reports crashed processes as
        // negative codes, and dropping it would misreport the command.
        let value_start = index;
        if bytes.get(index) == Some(&b'-') {
            index += 1;
        }
        let digits_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            if index - digits_start > SENTINEL_MAX_CODE_BYTES {
                return EndMatch::No;
            }
        }
        if index == digits_start {
            return EndMatch::No;
        }
        let code = match std::str::from_utf8(&bytes[value_start..index]) {
            Ok(digits) => match digits.parse::<i32>() {
                Ok(code) => code,
                Err(_) => return EndMatch::No,
            },
            Err(_) => return EndMatch::No,
        };
        match bytes.get(index) {
            None => EndMatch::Incomplete,
            Some(b'\n') => EndMatch::Yes {
                code,
                terminator_end: index + 1,
            },
            Some(b'\r') => match bytes.get(index + 1) {
                None => EndMatch::Incomplete,
                Some(b'\n') => EndMatch::Yes {
                    code,
                    terminator_end: index + 2,
                },
                Some(_) => EndMatch::No,
            },
            Some(_) => EndMatch::No,
        }
    }
}

enum EndMatch {
    Yes { code: i32, terminator_end: usize },
    No,
    Incomplete,
}

/// Where the separator line before the marker starts: the line break that ends
/// the previous line belongs to the protocol, not to command output.
fn separator_start(bytes: &[u8], nonce_start: usize) -> usize {
    if nonce_start >= 2 && bytes[nonce_start - 2] == b'\r' && bytes[nonce_start - 1] == b'\n' {
        nonce_start - 2
    } else if nonce_start >= 1 && bytes[nonce_start - 1] == b'\n' {
        nonce_start - 1
    } else {
        nonce_start
    }
}

/// Longest tail the scanner withholds while it could still be part of a marker.
pub(crate) fn marker_holdback(nonce_len: usize) -> usize {
    nonce_len + 1 + 1 + SENTINEL_MAX_CODE_BYTES + 2
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Drops the one line break cmd prints as an (empty) prompt at the head of each
/// cell. Holding at most two bytes makes it work across chunk boundaries.
pub(crate) struct HeadStrip {
    armed: bool,
    held: Vec<u8>,
}

impl HeadStrip {
    pub(crate) fn new(armed: bool) -> Self {
        Self {
            armed,
            held: Vec::new(),
        }
    }

    pub(crate) fn apply(&mut self, bytes: Vec<u8>) -> Vec<u8> {
        if !self.armed {
            return bytes;
        }
        self.held.extend_from_slice(&bytes);
        if self.held.len() < 2 && self.held.first() == Some(&b'\r') {
            return Vec::new();
        }
        match self.held.first() {
            Some(b'\r') if self.held.get(1) == Some(&b'\n') => {
                self.armed = false;
                // `drain` yields the removed bytes, so return what is left.
                self.held.drain(..2);
                std::mem::take(&mut self.held)
            }
            Some(b'\n') => {
                self.armed = false;
                self.held.drain(..1);
                std::mem::take(&mut self.held)
            }
            _ => {
                self.armed = false;
                std::mem::take(&mut self.held)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/// Registry key: one live shell per session, shell choice, and workspace. Two
/// sessions sharing a workspace still get separate shells, because environment
/// mutations persist for the life of a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    session_id: String,
    shell_id: String,
    workspace: PathBuf,
}

struct SessionSlot {
    session: tokio::sync::Mutex<Option<LiveSession>>,
    last_used: Mutex<Instant>,
}

impl SessionSlot {
    fn new() -> Self {
        Self {
            session: tokio::sync::Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        let mut last_used = self
            .last_used
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *last_used = Instant::now();
    }

    fn idle_for(&self, now: Instant) -> Duration {
        let last_used = self
            .last_used
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        now.saturating_duration_since(*last_used)
    }

    /// Closes the session if no call is using it. A busy slot is left alone: the
    /// owning call decides what happens to a shell that is running a command.
    async fn close(&self) {
        let Ok(mut guard) = self.session.try_lock() else {
            return;
        };
        let session = guard.take();
        drop(guard);
        if let Some(session) = session {
            session.kill().await;
        }
    }
}

struct ShellSessionRegistry {
    slots: Mutex<HashMap<SessionKey, Arc<SessionSlot>>>,
    sweeper_started: AtomicBool,
}

impl ShellSessionRegistry {
    fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
            sweeper_started: AtomicBool::new(false),
        }
    }

    fn acquire(self: &Arc<Self>, key: SessionKey) -> Arc<SessionSlot> {
        let mut evicted: Vec<Arc<SessionSlot>> = Vec::new();
        let slot = {
            let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(existing) = slots.get(&key) {
                existing.touch();
                return existing.clone();
            }
            // Cap live shells: one host process serves many sessions over its
            // lifetime, and each shell holds an interpreter plus its pipes.
            while slots.len() >= MAX_SESSIONS {
                let Some(candidate) = oldest_key(&slots) else {
                    break;
                };
                if let Some(slot) = slots.remove(&candidate) {
                    evicted.push(slot);
                }
            }
            let slot = Arc::new(SessionSlot::new());
            slots.insert(key, slot.clone());
            slot
        };
        for slot in evicted {
            tokio::spawn(async move { slot.close().await });
        }
        self.ensure_sweeper();
        slot
    }

    fn ensure_sweeper(self: &Arc<Self>) {
        if self.sweeper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let registry = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SESSION_SWEEP_INTERVAL).await;
                registry.sweep_idle().await;
            }
        });
    }

    async fn sweep_idle(self: &Arc<Self>) {
        let now = Instant::now();
        let expired: Vec<Arc<SessionSlot>> = {
            let mut slots = self.slots.lock().unwrap_or_else(|error| error.into_inner());
            let stale: Vec<SessionKey> = slots
                .iter()
                .filter(|(_, slot)| is_stale(slot.idle_for(now), SESSION_IDLE_TIMEOUT))
                .map(|(key, _)| key.clone())
                .collect();
            stale
                .into_iter()
                .filter_map(|key| slots.remove(&key))
                .collect()
        };
        for slot in expired {
            slot.close().await;
        }
    }
}

/// Whether an idle duration has reached the session limit. Pure so the expiry
/// rule is testable without a running registry.
pub(crate) fn is_stale(idle: Duration, limit: Duration) -> bool {
    idle >= limit
}

fn oldest_key(slots: &HashMap<SessionKey, Arc<SessionSlot>>) -> Option<SessionKey> {
    let now = Instant::now();
    slots
        .iter()
        .max_by_key(|(_, slot)| slot.idle_for(now))
        .map(|(key, _)| key.clone())
}

fn registry() -> &'static Arc<ShellSessionRegistry> {
    static REGISTRY: OnceLock<Arc<ShellSessionRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Arc::new(ShellSessionRegistry::new()))
}

/// Result of trying the persistent path for one Bash call.
pub(crate) enum PersistentAttempt {
    /// The call must use the one-shot path: the session path does not apply.
    NotApplicable,
    /// A session died before producing output, so nothing observable ran and
    /// the caller should replay the command on the one-shot path.
    SessionDied,
    /// A session ran the command (successfully or with a reported failure).
    Done(Result<Value, (String, String)>),
}

/// Runs one command on a live session when the session path applies.
pub(crate) async fn attempt(
    program: &Path,
    root: &Path,
    scratch: Option<&Path>,
    command: &str,
    options: &BashExecutionOptions,
) -> PersistentAttempt {
    let Some(dialect) = applicable_dialect(command, options) else {
        return PersistentAttempt::NotApplicable;
    };
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_BASH_TIMEOUT_MS);
    if super::validate_bash_timeout_ms(timeout_ms).is_err() {
        // The one-shot path owns the argument error and its message.
        return PersistentAttempt::NotApplicable;
    }
    let key = SessionKey {
        session_id: options.session_id.clone(),
        shell_id: options.command_shell_id.clone(),
        workspace: root.to_path_buf(),
    };
    let slot = registry().acquire(key);
    let mut guard = slot.session.lock().await;
    if guard.is_none() {
        match start_session(program, root, scratch, options, dialect).await {
            Ok(session) => *guard = Some(session),
            // A session that cannot start is not a command failure: let the
            // one-shot path run the command and report the real error.
            Err(error) => {
                tracing::warn!(%error, "persistent shell session failed to start");
                return PersistentAttempt::NotApplicable;
            }
        }
    }
    let Some(mut session) = guard.take() else {
        return PersistentAttempt::NotApplicable;
    };

    let run = session
        .run_cell(command, root, timeout_ms, options, true)
        .await;
    let outcome = match run.stop {
        CellStop::Ended => {
            *guard = Some(session);
            slot.touch();
            PersistentAttempt::Done(bash_success_result(
                &run.stdout,
                &run.stderr,
                Some(run.code),
                scratch,
                &options.command_shell_id,
            ))
        }
        CellStop::TimedOut => {
            // A wedged shell dies here; the next call starts a fresh one.
            session.kill().await;
            PersistentAttempt::Done(Err(bash_timeout_error(timeout_ms)))
        }
        CellStop::Aborted => {
            session.kill().await;
            PersistentAttempt::Done(Err(bash_aborted_error()))
        }
        CellStop::Lost(reason) => {
            session.kill().await;
            if run.stdout.result().0.is_empty() && run.stderr.result().0.is_empty() {
                // Nothing ran to completion (a command that ran `exit`, or a
                // shell that died at start). Replaying it one-shot is what the
                // caller would have got without sessions at all.
                tracing::warn!(%reason, "persistent shell session died before producing output");
                PersistentAttempt::SessionDied
            } else {
                PersistentAttempt::Done(Err((
                    "TOOL_FAILED".into(),
                    format!("bash session failed: {reason}"),
                )))
            }
        }
    };
    slot.touch();
    outcome
}

/// Whether this call may use a session shell at all.
fn applicable_dialect(command: &str, options: &BashExecutionOptions) -> Option<Dialect> {
    // Unit tests run inside libtest's harness: `spawn_tool_runner` would start
    // the test binary rather than the host's runner mode, so the session path is
    // only meaningful in a real host process. The protocol itself is covered by
    // the module's own tests, which drive `run_session` directly.
    if cfg!(test) {
        return None;
    }
    if !persistent_enabled() {
        return None;
    }
    // Background tasks outlive the turn by design and never join a session.
    if options.run_in_background {
        return None;
    }
    if options.session_id.trim().is_empty() {
        return None;
    }
    let dialect = Dialect::from_shell_id(&options.command_shell_id)?;
    if !dialect.allows_multiline() && command.contains('\n') {
        return None;
    }
    Some(dialect)
}

fn persistent_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED
        .get_or_init(|| persistent_enabled_for(std::env::var(PERSISTENT_SHELL_ENV).ok().as_deref()))
}

/// Kill switch shared by the host and by tests. Absent or empty means enabled,
/// so an unconfigured host gets the fast path.
pub(crate) fn persistent_enabled_for(value: Option<&str>) -> bool {
    match value.map(str::trim) {
        None | Some("") => true,
        Some(value) => !matches!(
            value.to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
    }
}

/// A running session: one runner process, one interpreter, one carry buffer.
struct LiveSession {
    runner: SpawnedToolRunner,
    dialect: Dialect,
    stderr_rx: mpsc::Receiver<OutputChunk>,
    stderr_task: tokio::task::JoinHandle<()>,
    /// Bytes the previous cell read past its end marker. Keeping them makes the
    /// head of the next cell deterministic: cmd prints one prompt per command
    /// line, and that prompt may or may not land in the same read as a marker.
    carry: Vec<u8>,
}

impl LiveSession {
    fn new(mut runner: SpawnedToolRunner, dialect: Dialect) -> Self {
        let (tx, rx) = mpsc::channel::<OutputChunk>(super::OUTPUT_CHANNEL_CAPACITY);
        // One stderr reader for the life of the session: the runner relays the
        // interpreter's stderr verbatim, so the pipe is not re-plumbed per cell.
        let stderr = runner.stderr.take();
        let stderr_task = tokio::spawn(async move {
            super::read_pipe(stderr, OutputStream::Stderr, tx).await;
        });
        Self {
            runner,
            dialect,
            stderr_rx: rx,
            stderr_task,
            carry: Vec::new(),
        }
    }

    async fn run_cell(
        &mut self,
        command: &str,
        cwd: &Path,
        timeout_ms: u64,
        options: &BashExecutionOptions,
        emit: bool,
    ) -> CellRun {
        let LiveSession {
            runner,
            dialect,
            stderr_rx,
            carry,
            ..
        } = self;
        let mut run = CellRun {
            stop: CellStop::Lost("cell did not finish".into()),
            code: -1,
            stdout: CapturedOutput::default(),
            stderr: CapturedOutput::default(),
            notifications: OutputNotifier::new(options),
        };
        let nonce = new_nonce();
        let frame = CellFrame::command(command, cwd, &nonce);
        let write_result = match runner.control.as_mut() {
            Some(control) => write_cell_frame(control, &frame).await,
            None => Err("session control pipe is closed".to_string()),
        };
        if let Err(error) = write_result {
            run.stop = CellStop::Lost(error);
            return run;
        }

        let mut scanner = CellScanner::new(&nonce);
        let mut head = HeadStrip::new(*dialect == Dialect::Cmd);
        let mut end = None;
        let pending = std::mem::take(carry);
        if !pending.is_empty() {
            end = consume(&mut scanner, &pending, &mut run, emit, &mut head);
        }

        let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms));
        tokio::pin!(timeout);
        let mut cancellation = options.cancellation.clone();
        let mut notification_tick = tokio::time::interval(OUTPUT_NOTIFICATION_INTERVAL);
        let mut stderr_open = true;
        let mut buffer = [0u8; 8192];

        while end.is_none() {
            let Some(stdout) = runner.stdout.as_mut() else {
                run.stop = CellStop::Lost("session stdout is unavailable".into());
                break;
            };
            tokio::select! {
                read = stdout.read(&mut buffer) => match read {
                    // The runner closing stdout means the session is gone.
                    Ok(0) => {
                        run.stop = CellStop::Lost("shell session closed its output".into());
                        break;
                    }
                    Ok(read) => {
                        end = consume(&mut scanner, &buffer[..read], &mut run, emit, &mut head);
                    }
                    Err(error) => {
                        run.stop = CellStop::Lost(format!("session output failed: {error}"));
                        break;
                    }
                },
                chunk = stderr_rx.recv(), if stderr_open => match chunk {
                    Some(chunk) => {
                        if emit {
                            super::process_output_chunk(
                                chunk,
                                &mut run.stdout,
                                &mut run.stderr,
                                &mut run.notifications,
                            );
                        }
                    }
                    // A closed relay means the runner is gone; stdout reports
                    // the session's fate, so this only stops the branch.
                    None => stderr_open = false,
                },
                _ = notification_tick.tick() => {
                    if emit {
                        run.notifications.flush_due();
                    }
                }
                _ = &mut timeout => {
                    run.stop = CellStop::TimedOut;
                    return run;
                }
                cancelled = wait_for_cancellation(&mut cancellation) => {
                    if cancelled {
                        run.stop = CellStop::Aborted;
                        return run;
                    }
                }
            }
        }

        if let Some(end) = end {
            *carry = end.trailing;
            run.stop = CellStop::Ended;
            run.code = end.code;
        }
        run
    }

    /// Terminates the runner and everything it owns, and reaps it.
    async fn kill(self) {
        self.stderr_task.abort();
        let _ = self.stderr_task.await;
        let SpawnedToolRunner {
            pid,
            mut ownership,
            mut control,
            mut wait_task,
            ..
        } = self.runner;
        let _ = kill_and_reap(pid, &mut ownership, &mut control, &mut wait_task).await;
    }
}

struct CellRun {
    stop: CellStop,
    code: i32,
    stdout: CapturedOutput,
    stderr: CapturedOutput,
    notifications: OutputNotifier,
}

/// How a cell ended.
#[derive(Debug)]
enum CellStop {
    Ended,
    TimedOut,
    Aborted,
    /// The session died or misbehaved; its shell is no longer usable.
    Lost(String),
}

struct ScanEnd {
    code: i32,
    trailing: Vec<u8>,
}

fn consume(
    scanner: &mut CellScanner,
    bytes: &[u8],
    run: &mut CellRun,
    emit: bool,
    head: &mut HeadStrip,
) -> Option<ScanEnd> {
    let (output, end) = match scanner.feed(bytes) {
        ScanOutcome::More(output) => (output, None),
        ScanOutcome::End {
            tail,
            code,
            trailing,
        } => (tail, Some(ScanEnd { code, trailing })),
    };
    let output = head.apply(output);
    if emit && !output.is_empty() {
        super::process_output_chunk(
            OutputChunk {
                stream: OutputStream::Stdout,
                bytes: output,
            },
            &mut run.stdout,
            &mut run.stderr,
            &mut run.notifications,
        );
    }
    end
}

/// Starts a session shell and proves it answers before a call depends on it.
async fn start_session(
    program: &Path,
    root: &Path,
    scratch: Option<&Path>,
    options: &BashExecutionOptions,
    dialect: Dialect,
) -> Result<LiveSession, String> {
    let config = ToolRunnerStartConfig {
        program: program.to_path_buf(),
        args: session_args(dialect),
        workspace: root.to_path_buf(),
        scratch_dir: scratch
            .map(|path| super::shell::format_scratch_dir_for_shell(Some(dialect.name()), path)),
        env_path: super::shell::user_login_path().map(str::to_string),
        extra_env: options.extra_env.clone(),
        persistent: Some(true),
        session_key: Some(format!(
            "{}|{}|{}",
            options.session_id,
            options.command_shell_id,
            root.display()
        )),
        shell_dialect: Some(dialect.name().to_string()),
    };
    let runner = spawn_tool_runner(&config)
        .await
        .map_err(|(code, message)| format!("{code}: {message}"))?;
    let mut session = LiveSession::new(runner, dialect);
    let init = session
        .run_cell(
            init_command(dialect),
            root,
            INIT_CELL_TIMEOUT_MS,
            options,
            false,
        )
        .await;
    match init.stop {
        CellStop::Ended => Ok(session),
        other => {
            session.kill().await;
            Err(format!("session init cell failed: {other:?}"))
        }
    }
}
