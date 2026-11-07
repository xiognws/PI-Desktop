//! Session-persistent shell runner: host half.
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
//! in `docs/notes/persistent-shell-runner.md`.
//!
//! Responsibilities split three ways:
//!
//! * `protocol` — the cell wire format and the stdout scanner. Both ends use
//!   it, so it spawns nothing and knows nothing about sessions.
//! * this module — the session loop both ends run, the live session a host
//!   keeps, the registry that owns it, and the rules that decide whether a call
//!   may join a session at all.
//! * `shell` — the one-shot path `attempt` falls back to.

#![allow(dead_code, unused_imports)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::anyhow;
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
// The wire protocol is part of this module's surface: the tests drive
// `cell_text`, the frame codec and the scanner through these names.

pub(crate) use protocol::{
    cell_text, decode_cell_frame, encode_cell_frame, marker_holdback, session_args, CellFrame,
    CellScanner, Dialect, HeadStrip, ScanOutcome,
};
use protocol::{
    forward, init_command, new_nonce, prelude, read_frames, write_cell_frame, INIT_CELL_TIMEOUT_MS,
    SESSION_DRAIN_TIMEOUT,
};

/// Session lifetimes. A host process outlives many sessions, so an unused
/// shell must not accumulate: idle sessions are closed and the number of live
/// ones is capped.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
const SESSION_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const MAX_SESSIONS: usize = 8;
/// Environment switch: `PI_DESKTOP_PERSISTENT_SHELL=0` (also false/off/no)
/// forces every call back onto the one-shot path without a rebuild.
const PERSISTENT_SHELL_ENV: &str = "PI_DESKTOP_PERSISTENT_SHELL";
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

// `mod` declarations sit at the end so the session loop above reads as one
// piece without module plumbing through the middle of it. The file is named
// `shell_session_protocol.rs` so the two halves of this module sort together.
#[path = "shell_session_protocol.rs"]
mod protocol;
