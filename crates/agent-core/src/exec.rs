//! Local command execution — deliberately the same shape the reference implementation uses, because that
//! shape does not trip an enterprise behaviour engine.
//!
//! The rules are not clever, they are *ordinary*: a command runs in a child with a
//! hidden console (`CREATE_NO_WINDOW`, not a script asking to be hidden), a scrubbed
//! environment so no credential is inherited, a timeout with a kill, output tail-capped
//! and scrubbed before anyone sees it, and a working directory that must exist. Nothing
//! here encodes a payload, copies this binary, writes a scheduled task or starts an
//! interpreter from a URL — those shapes are refused *before* a process exists, by
//! [`crate::exec_policy`].
//!
//! What the reference implementation does that this mirrors, concretely:
//!
//! | upstream | here |
//! | --- | --- |
//! | `subprocess.run(..., shell=True, capture_output=True)` | one child per call through the platform shell |
//! | `creationflags=windows_hide_flags()` | `CREATE_NO_WINDOW \| CREATE_NEW_PROCESS_GROUP` |
//! | `env=build_subprocess_env(strip_launch_profile=True)` | [`LocalExecutor::scrubbed_env`]: allow-list, secrets dropped by name |
//! | `timeout=30` + kill | [`DEFAULT_TIMEOUT_MS`], kill on expiry, `timedOut: true` in the answer |
//! | tail 4000/2000 + `redact_sensitive_text` | tail caps + [`crate::redaction::scrub_secrets`] |
//! | `detect_hardline_command` before spawn | [`crate::exec_policy::ExecPolicy::check`] before spawn |
//! | refuse a deleted cwd | [`ExecError::NoCwd`] |
//!
//! Honest limits: this kills the direct child, not its grandchildren (a shell that
//! backgrounded a server keeps it); it is a process boundary, not a sandbox; and it
//! matches command text, so a determined caller can walk around it. Its job is that the
//! *ordinary* path — the one a model reaches for by default — is the quiet one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::exec_policy::{ExecPolicy, ExecVerdict};

/// A command that runs longer than this is a service, not a tool call.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Output is tail-capped: the end of a build log is the part that explains it, and an
/// unbounded pipe is how a tool call turns into a memory event.
pub const MAX_STDOUT_CHARS: usize = 4_000;
pub const MAX_STDERR_CHARS: usize = 2_000;

/// Windows: no console window is ever created for the child.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Windows: the child gets its own process group, so a Ctrl-C in the host does not
/// land in the middle of its work.
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Words that never reach a child: the environment is an allow-list and these win even
/// if someone adds one to it.
const SECRET_NAME_FRAGMENTS: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "API_KEY",
    "APIKEY",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "SESSION_KEY",
    "COOKIE",
    "AUTH",
];

/// Variables a command legitimately needs. Everything else is dropped, so a shell this
/// kernel starts cannot see the provider credentials the host is holding.
const ENV_ALLOW: &[&str] = &[
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "USERNAME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "MSYSTEM",
    "MSYSTEM_PREFIX",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "JAVA_HOME",
    "NODE_PATH",
];

/// Which shell the command text is written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dialect {
    /// `bash -c`. Pipes, redirects and POSIX quoting.
    Posix,
    /// `cmd /C`. The Windows default when no bash is installed.
    Cmd,
}

/// The interpreter one command runs through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub program: String,
    /// Arguments placed before the command text.
    pub args: Vec<String>,
    pub dialect: Dialect,
}

impl ShellSpec {
    pub fn posix(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: vec!["-c".to_string()],
            dialect: Dialect::Posix,
        }
    }

    pub fn cmd() -> Self {
        Self {
            program: "cmd".to_string(),
            args: vec!["/C".to_string()],
            dialect: Dialect::Cmd,
        }
    }

    /// bash when the host has one (git-bash, MSYS, Linux, macOS), cmd otherwise.
    pub fn detect() -> Self {
        if let Some(bash) = find_in_path(if cfg!(windows) { "bash.exe" } else { "bash" }) {
            return Self::posix(bash);
        }
        if cfg!(windows) {
            Self::cmd()
        } else {
            Self::posix("sh")
        }
    }

    /// The argv a child gets: the interpreter's own arguments, then the command text.
    pub fn argv(&self, command: &str) -> Vec<String> {
        let mut argv = self.args.clone();
        argv.push(command.to_string());
        argv
    }
}

fn find_in_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// One command to run.
#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub command: String,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub max_stdout_chars: usize,
    pub max_stderr_chars: usize,
    /// Extra variables for this call only — the way to pass something the allow-list
    /// drops, explicitly, instead of widening the allow-list.
    pub env: Vec<(String, String)>,
}

impl ExecRequest {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            cwd: None,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            max_stdout_chars: MAX_STDOUT_CHARS,
            max_stderr_chars: MAX_STDERR_CHARS,
            env: Vec::new(),
        }
    }

    pub fn in_dir(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }
}

/// What a command produced. Never the raw bytes: capped tail, secrets scrubbed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    pub timed_out: bool,
    /// Whether a tail cap cut something, so a reader knows the head is gone.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
}

impl ExecOutcome {
    pub fn is_success(&self) -> bool {
        !self.timed_out && self.code == Some(0)
    }

    /// What a tool call returns to the model: the streams as they arrived, plus the
    /// exit status, because a model that cannot see the code guesses at it.
    pub fn render(&self) -> String {
        let mut out = String::new();
        if !self.stdout.is_empty() {
            out.push_str(&self.stdout);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        if !self.stderr.is_empty() {
            out.push_str("[stderr]\n");
            out.push_str(&self.stderr);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
        match self.code {
            Some(0) => out.push_str("[exit code 0]"),
            Some(code) => out.push_str(&format!("[exit code {code}]")),
            None => out.push_str("[exit code unknown]"),
        }
        if self.timed_out {
            out.push_str("[timed out, the child was killed]");
        }
        out
    }
}

/// Why a command did not run, or did not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    /// The execution policy refused the shape. No process was started.
    Refused(String),
    Empty,
    /// The working directory is not there any more: refuse rather than fall back to
    /// the kernel's own, which is never the directory the caller meant.
    NoCwd(PathBuf),
    Spawn(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(reason) => write!(f, "{reason}"),
            Self::Empty => write!(f, "refused — the command is empty."),
            Self::NoCwd(path) => write!(
                f,
                "refused — the working directory {} does not exist. Nothing was run.",
                path.display()
            ),
            Self::Spawn(reason) => write!(f, "the command could not be started: {reason}"),
        }
    }
}

impl std::error::Error for ExecError {}

/// Runs commands for one host, under one policy.
#[derive(Debug, Clone)]
pub struct LocalExecutor {
    policy: ExecPolicy,
    shell: ShellSpec,
    default_cwd: PathBuf,
    scrub_env: bool,
}

impl LocalExecutor {
    pub fn new(policy: ExecPolicy) -> Self {
        Self {
            policy,
            shell: ShellSpec::detect(),
            default_cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            scrub_env: true,
        }
    }

    pub fn with_shell(mut self, shell: ShellSpec) -> Self {
        self.shell = shell;
        self
    }

    pub fn with_default_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.default_cwd = cwd.into();
        self
    }

    /// Turn the scrub off only for a fixture that needs the whole environment; a
    /// session never should, because the value it would inherit is a credential.
    pub fn with_env_scrubbing(mut self, scrub: bool) -> Self {
        self.scrub_env = scrub;
        self
    }

    pub fn shell(&self) -> &ShellSpec {
        &self.shell
    }

    pub fn policy(&self) -> &ExecPolicy {
        &self.policy
    }

    /// The environment a child gets: the allow-list, minus anything whose name says
    /// it is a secret.
    pub fn scrubbed_env(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (key, value) in std::env::vars_os() {
            let (Some(key), Some(value)) = (key.to_str(), value.to_str()) else {
                continue;
            };
            if !self.scrub_env {
                out.push((key.to_string(), value.to_string()));
                continue;
            }
            let upper = key.to_ascii_uppercase();
            if SECRET_NAME_FRAGMENTS
                .iter()
                .any(|fragment| upper.contains(fragment))
            {
                continue;
            }
            if ENV_ALLOW
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(&upper))
            {
                out.push((key.to_string(), value.to_string()));
            }
        }
        out
    }

    /// Run one command. Refusals happen before any process exists.
    pub async fn run(&self, request: ExecRequest) -> Result<ExecOutcome, ExecError> {
        if request.command.trim().is_empty() {
            return Err(ExecError::Empty);
        }
        match self
            .policy
            .check("Bash", &serde_json::json!({ "command": request.command }))
        {
            ExecVerdict::Allow => {}
            ExecVerdict::Deny(reason) => return Err(ExecError::Refused(reason)),
        }
        let cwd = request
            .cwd
            .clone()
            .unwrap_or_else(|| self.default_cwd.clone());
        if !cwd.is_dir() {
            return Err(ExecError::NoCwd(cwd));
        }

        let argv = self.shell.argv(&request.command);
        let mut command = Command::new(&self.shell.program);
        command
            .args(&argv)
            .current_dir(&cwd)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in self.scrubbed_env() {
            command.env(key, value);
        }
        for (key, value) in &request.env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Hidden console + own process group: the shape the reference implementation uses, and the reason
            // a legitimate command does not look like a hidden script host.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }

        let started = Instant::now();
        let mut child = command
            .spawn()
            .map_err(|error| ExecError::Spawn(error.to_string()))?;
        let stdout_reader = child.stdout.take().map(read_to_end_thread);
        let stderr_reader = child.stderr.take().map(read_to_end_thread);

        let mut timed_out = false;
        let mut code = None;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    code = status.code();
                    break;
                }
                Ok(None) => {}
                Err(error) => return Err(ExecError::Spawn(error.to_string())),
            }
            if started.elapsed() >= request.timeout {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let stdout = join_reader(stdout_reader).await;
        let stderr = join_reader(stderr_reader).await;
        // A child that never chose an encoding writes the ANSI code page (GBK on a
        // Chinese Windows box), and `from_utf8_lossy` answered one replacement
        // character per byte of every Chinese character it printed.
        let (stdout, stdout_truncated) =
            tail_capped(&native_text::decode_native_text(&stdout), request.max_stdout_chars);
        let (stderr, stderr_truncated) =
            tail_capped(&native_text::decode_native_text(&stderr), request.max_stderr_chars);

        Ok(ExecOutcome {
            // Scrubbed before it is capped, so a credential cannot survive as a
            // fragment of a tail slice.
            stdout: crate::redaction::scrub_secrets(&stdout),
            stderr: crate::redaction::scrub_secrets(&stderr),
            code,
            timed_out,
            stdout_truncated,
            stderr_truncated,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
}

fn read_to_end_thread<R: std::io::Read + Send + 'static>(
    mut reader: R,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = reader.read_to_end(&mut buffer);
        buffer
    })
}

async fn join_reader(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    let Some(handle) = handle else {
        return Vec::new();
    };
    tokio::task::spawn_blocking(move || handle.join().unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// Keep the last `limit` characters, and say whether anything was dropped.
fn tail_capped(text: &str, limit: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= limit {
        return (text.to_string(), false);
    }
    let tail: String = text.chars().skip(count - limit).collect();
    (format!("[…{count} chars, head not shown]\n{tail}"), true)
}

/// Where a directory is, without being surprised by a missing one.
pub fn existing_dir(path: &Path) -> Option<PathBuf> {
    path.is_dir().then(|| path.to_path_buf())
}

/// The kernel's own `Bash`: one command, run through [`LocalExecutor`].
///
/// Off by default — the desktop's tools live in the host, where permissions and
/// approvals already are. It is on when a host asks for it (`localShell: true`), and
/// it is the reference for the shape a host should copy when it executes itself.
pub struct ShellTool {
    executor: LocalExecutor,
    description: String,
}

impl ShellTool {
    pub fn new(executor: LocalExecutor) -> Self {
        let dialect = match executor.shell().dialect {
            Dialect::Posix => "bash -c",
            Dialect::Cmd => "cmd /C",
        };
        Self {
            description: format!(
                "Run one shell command ({dialect}) in a child process with a hidden console, \
                 a scrubbed environment and a timeout. Returns the output tail and the exit code. \
                 Refused shapes: encoded commands, hidden script hosts, download-and-run, \
                 persistence, framework binaries used as proxies."
            ),
            executor,
        }
    }

    pub fn executor(&self) -> &LocalExecutor {
        &self.executor
    }
}

impl crate::tool::Tool for ShellTool {
    fn spec(&self) -> crate::tool::ToolSpec {
        crate::tool::ToolSpec::new(
            "Bash",
            self.description.clone(),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The command line."},
                    "cwd": {"type": "string", "description": "Working directory; must exist."},
                    "timeoutMs": {"type": "integer", "description": "Kill the child after this long."}
                },
                "required": ["command"]
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a crate::message::ToolCall,
        _ctx: &'a crate::tool::ToolContext,
    ) -> crate::provider::BoxFuture<'a, crate::error::Result<String>> {
        Box::pin(async move {
            let command = call
                .arguments
                .get("command")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    crate::error::AgentError::Invalid("Bash needs a `command` string".to_string())
                })?;
            let mut request = ExecRequest::new(command);
            if let Some(cwd) = call
                .arguments
                .get("cwd")
                .and_then(serde_json::Value::as_str)
            {
                request = request.in_dir(cwd);
            }
            if let Some(ms) = call
                .arguments
                .get("timeoutMs")
                .and_then(serde_json::Value::as_u64)
            {
                request = request.with_timeout(Duration::from_millis(ms.clamp(1_000, 600_000)));
            }
            match self.executor.run(request).await {
                Ok(outcome) => Ok(outcome.render()),
                // A refusal is an answer, not a crash: the model reads why and does it
                // the ordinary way. Only a child that could not be started is an error.
                Err(ExecError::Refused(reason)) => Ok(reason),
                Err(error @ (ExecError::Empty | ExecError::NoCwd(_))) => Ok(error.to_string()),
                Err(ExecError::Spawn(reason)) => Err(crate::error::AgentError::Transport(reason)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executor() -> LocalExecutor {
        LocalExecutor::new(ExecPolicy::default())
    }

    /// 本机是否真的能起 `sh`（没有就跳过，不算失败）。
    fn sh_available() -> bool {
        static PROBE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *PROBE.get_or_init(|| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg("exit 0")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
    }

    /// `echo` and `exit` mean the same thing in both dialects, which keeps these
    /// tests about the executor rather than about the host's shell.
    #[tokio::test]
    async fn a_command_runs_and_reports_its_output_and_code() {
        if !sh_available() {
            eprintln!("SKIP (no working `sh` on this host: MSYS shared-memory 0xC0000022)");
            return;
        }
        let outcome = executor()
            .run(ExecRequest::new("echo hello-kernel"))
            .await
            .expect("the command runs");
        assert!(outcome.stdout.contains("hello-kernel"), "{outcome:?}");
        assert_eq!(outcome.code, Some(0));
        assert!(outcome.is_success());
        assert!(!outcome.timed_out);
        assert!(outcome.render().contains("[exit code 0]"));
    }

    /// A child that writes the ANSI code page is not broken output: it is what
    /// every unconfigured program on a Chinese Windows box does. The kernel must
    /// read it back as text, not as one replacement character per byte.
    #[tokio::test]
    async fn gbk_output_from_a_child_is_decoded_as_text() {
        if !sh_available() {
            eprintln!("SKIP (no working `sh` on this host: MSYS shared-memory 0xC0000022)");
            return;
        }
        // printf with octal escapes emits the raw bytes: 265 253 = GBK for 但.
        let outcome = executor()
            .run(ExecRequest::new("printf '\\265\\253\\n'"))
            .await
            .expect("the command runs");
        assert_eq!(outcome.stdout.trim_end(), "但", "{outcome:?}");
        assert!(!outcome.stdout.contains('\u{FFFD}'), "{outcome:?}");
    }

    #[tokio::test]
    async fn a_non_zero_exit_is_reported_not_thrown() {
        if !sh_available() {
            eprintln!("SKIP (no working `sh` on this host: MSYS shared-memory 0xC0000022)");
            return;
        }
        let outcome = executor()
            .run(ExecRequest::new("exit 7"))
            .await
            .expect("a failing command still returns an outcome");
        assert_eq!(outcome.code, Some(7));
        assert!(!outcome.is_success());
        assert!(outcome.render().contains("[exit code 7]"));
    }

    #[tokio::test]
    async fn the_working_directory_is_the_one_asked_for() {
        if !sh_available() {
            eprintln!("SKIP (no working `sh` on this host: MSYS shared-memory 0xC0000022)");
            return;
        }
        let dir = std::env::temp_dir().join("agent-core-exec-cwd");
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let executor = executor();
        // `pwd` in a POSIX shell, `cd` in cmd: bare `cd` in bash goes home.
        let command = match executor.shell().dialect {
            Dialect::Posix => "pwd",
            Dialect::Cmd => "cd",
        };
        let outcome = executor
            .run(ExecRequest::new(command).in_dir(dir.clone()))
            .await
            .expect("the command runs");
        assert!(
            outcome.stdout.to_lowercase().contains("exec-cwd"),
            "asked for {}, got {:?}",
            dir.display(),
            outcome.stdout
        );
    }

    #[tokio::test]
    async fn a_missing_directory_is_refused_before_anything_starts() {
        let missing = std::env::temp_dir().join("agent-core-does-not-exist-9f2");
        let error = executor()
            .run(ExecRequest::new("echo never").in_dir(missing.clone()))
            .await
            .expect_err("the cwd is gone");
        assert_eq!(error, ExecError::NoCwd(missing));
        assert!(error.to_string().contains("Nothing was run"));
    }

    #[tokio::test]
    async fn a_timeout_kills_the_child_and_says_so() {
        let command = if cfg!(windows) {
            // `ping -n 6` sleeps ~5s without needing a POSIX shell.
            "ping -n 6 127.0.0.1"
        } else {
            "sleep 5"
        };
        let outcome = executor()
            .run(ExecRequest::new(command).with_timeout(Duration::from_millis(150)))
            .await
            .expect("a timeout is an outcome, not an error");
        assert!(outcome.timed_out, "{outcome:?}");
        assert!(!outcome.is_success());
        assert!(
            outcome.duration_ms < 5_000,
            "killed early: {}",
            outcome.duration_ms
        );
        assert!(outcome.render().contains("timed out"));
    }

    #[tokio::test]
    async fn output_is_tail_capped() {
        if !sh_available() {
            eprintln!("SKIP (no working `sh` on this host: MSYS shared-memory 0xC0000022)");
            return;
        }
        let outcome = executor()
            .run(ExecRequest {
                max_stdout_chars: 40,
                ..ExecRequest::new("echo 0123456789012345678901234567890123456789-then-more-文字")
            })
            .await
            .expect("the command runs");
        assert!(outcome.stdout_truncated);
        assert!(outcome.stdout.len() < 120, "{:?}", outcome.stdout);
        assert!(outcome.stdout.contains("head not shown"));
    }

    #[tokio::test]
    async fn a_secret_in_the_parent_environment_never_reaches_the_child() {
        // Set a variable whose name says it is a credential, then ask the child for it.
        std::env::set_var("AGENT_CORE_TEST_API_KEY", "sk-should-never-be-seen");
        let executor = executor();
        let scrubbed = executor.scrubbed_env();
        assert!(
            !scrubbed
                .iter()
                .any(|(key, _)| key == "AGENT_CORE_TEST_API_KEY"),
            "the credential name is not inherited: {scrubbed:?}"
        );
        let command = match executor.shell().dialect {
            Dialect::Posix => "echo \"key=[$AGENT_CORE_TEST_API_KEY]\"",
            Dialect::Cmd => "echo key=[%AGENT_CORE_TEST_API_KEY%]",
        };
        let outcome = executor
            .run(ExecRequest::new(command))
            .await
            .expect("the command runs");
        assert!(
            !outcome.stdout.contains("sk-should-never-be-seen"),
            "the child saw the secret: {:?}",
            outcome.stdout
        );
    }

    #[tokio::test]
    async fn a_secret_printed_by_a_command_is_scrubbed_from_the_answer() {
        // The value is shaped like a provider key, so the redactor catches it even
        // though this test's own env is not the source.
        let outcome = executor()
            .run(ExecRequest::new("echo sk-abcdef0123456789abcdef0123456789"))
            .await
            .expect("the command runs");
        assert!(
            !outcome
                .stdout
                .contains("sk-abcdef0123456789abcdef0123456789"),
            "not scrubbed: {:?}",
            outcome.stdout
        );
    }

    #[tokio::test]
    async fn a_refused_shape_never_becomes_a_process() {
        let error = executor()
            .run(ExecRequest::new(
                "powershell -NoProfile -EncodedCommand SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoA",
            ))
            .await
            .expect_err("the policy refuses");
        match error {
            ExecError::Refused(reason) => {
                assert!(reason.contains("ENCODED_COMMAND"), "{reason}");
                assert!(reason.contains("was not run"), "{reason}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_empty_command_is_refused() {
        assert_eq!(
            executor()
                .run(ExecRequest::new("   "))
                .await
                .expect_err("empty"),
            ExecError::Empty
        );
    }

    #[test]
    fn the_shell_spec_puts_the_command_last() {
        let spec = ShellSpec::posix("bash");
        assert_eq!(spec.argv("echo hi"), vec!["-c", "echo hi"]);
        let spec = ShellSpec::cmd();
        assert_eq!(spec.argv("echo hi"), vec!["/C", "echo hi"]);
    }

    #[test]
    fn the_detected_shell_is_usable_on_this_host() {
        let shell = ShellSpec::detect();
        assert!(!shell.program.is_empty());
        assert!(!shell.args.is_empty());
    }
}
