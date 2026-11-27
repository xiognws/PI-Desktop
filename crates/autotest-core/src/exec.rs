//! Runs one script and records the run as a RunEvent stream.
//!
//! The stream (schema v1) is the contract the panel, the report and the log
//! analysis all read, so this module keeps the same event shapes, the same
//! `executions` / `execution_cases` writes, and the same pass/fail/skip rules as
//! the Python executor it replaces — including the one that matters most: a
//! pytest run whose only tests were skipped is a *skip*, not a pass.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use regex::Regex;
use serde_json::{json, Map, Value};

use crate::config;
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub const SCHEMA_VERSION: i64 = 1;
const STEP_ID: &str = "run-script";
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const OUTPUT_LIMIT: usize = 20_000;

/// One run's cancellation handle. The route flips it; the poll loop sees it and
/// kills the child within one poll interval.
#[derive(Debug, Default)]
pub struct CancelFlag {
    cancelled: AtomicBool,
    reason: Mutex<String>,
}

impl CancelFlag {
    pub fn cancel(&self, reason: &str) {
        *self.reason.lock().expect("reason lock") = reason.to_string();
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn reason(&self) -> String {
        self.reason.lock().expect("reason lock").clone()
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `execution_events` writer: stamps `seq`/`ts`, persists the payload.
pub struct EventLog<'a> {
    conn: &'a rusqlite::Connection,
    execution_id: u32,
    next_seq: i64,
}

impl<'a> EventLog<'a> {
    pub fn new(conn: &'a rusqlite::Connection, execution_id: u32) -> Self {
        Self {
            conn,
            execution_id,
            next_seq: 0,
        }
    }

    pub fn next_seq(&self) -> i64 {
        self.next_seq
    }

    pub fn append(&mut self, mut event: Value) -> ApiResult<Value> {
        if let Value::Object(ref mut map) = event {
            map.insert("seq".to_string(), Value::from(self.next_seq));
            map.entry("ts").or_insert_with(|| Value::from(now_iso()));
        }
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        self.conn.execute(
            "INSERT INTO execution_events (execution_id, seq, type, payload) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                self.execution_id,
                self.next_seq,
                event_type,
                serde_json::to_string(&event).unwrap_or_default()
            ],
        )?;
        self.next_seq += 1;
        Ok(event)
    }

    pub fn replay(&self) -> ApiResult<Vec<Value>> {
        let payloads: Vec<String> = self
            .conn
            .prepare("SELECT payload FROM execution_events WHERE execution_id = ?1 ORDER BY seq")?
            .query_map([self.execution_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(payloads
            .into_iter()
            .filter_map(|payload| serde_json::from_str::<Value>(&payload).ok())
            .collect())
    }
}

pub fn read_events(db_path: &Path, execution_id: u32) -> ApiResult<Vec<Value>> {
    let conn = db::open(db_path)?;
    let log = EventLog::new(&conn, execution_id);
    log.replay()
}

fn event_base(event_type: &str, run_id: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("schemaVersion".to_string(), Value::from(SCHEMA_VERSION));
    map.insert("type".to_string(), Value::from(event_type));
    map.insert("runId".to_string(), Value::from(run_id));
    map
}

fn run_start(run_id: &str, project_id: &str, case_id: &str, channel: &str) -> Value {
    let mut map = event_base("run.start", run_id);
    map.insert("projectId".to_string(), Value::from(project_id));
    map.insert("caseIds".to_string(), json!([case_id]));
    map.insert("channel".to_string(), Value::from(channel));
    map.insert("startedAt".to_string(), Value::from(now_iso()));
    Value::Object(map)
}

fn case_start(run_id: &str, case_id: &str) -> Value {
    let mut map = event_base("case.start", run_id);
    map.insert("caseId".to_string(), Value::from(case_id));
    map.insert("attempt".to_string(), Value::from(1));
    map.insert("startedAt".to_string(), Value::from(now_iso()));
    Value::Object(map)
}

fn step_start(run_id: &str, case_id: &str, label: &str, kind: &str) -> Value {
    let mut map = event_base("step.start", run_id);
    map.insert("caseId".to_string(), Value::from(case_id));
    map.insert("stepId".to_string(), Value::from(STEP_ID));
    map.insert("index".to_string(), Value::from(0));
    map.insert("kind".to_string(), Value::from(kind));
    map.insert("label".to_string(), Value::from(label));
    Value::Object(map)
}

fn step_end(run_id: &str, case_id: &str, status: &str, duration_ms: f64, detail: Value) -> Value {
    let mut map = event_base("step.end", run_id);
    map.insert("caseId".to_string(), Value::from(case_id));
    map.insert("stepId".to_string(), Value::from(STEP_ID));
    map.insert("status".to_string(), Value::from(status));
    map.insert("durationMs".to_string(), json!(round1(duration_ms)));
    map.insert("replayHit".to_string(), Value::from(false));
    map.insert("detail".to_string(), detail);
    Value::Object(map)
}

fn case_end(
    run_id: &str,
    case_id: &str,
    status: &str,
    duration_ms: f64,
    failure: Option<&str>,
) -> Value {
    let mut map = event_base("case.end", run_id);
    map.insert("caseId".to_string(), Value::from(case_id));
    map.insert("status".to_string(), Value::from(status));
    map.insert("durationMs".to_string(), json!(round1(duration_ms)));
    map.insert(
        "failure".to_string(),
        failure.map_or(Value::Null, Value::from),
    );
    Value::Object(map)
}

fn run_end(run_id: &str, status: &str, counts: &Counts, duration_ms: f64) -> Value {
    let mut map = event_base("run.end", run_id);
    map.insert("status".to_string(), Value::from(status));
    map.insert(
        "counts".to_string(),
        json!({ "pass": counts.pass, "fail": counts.fail, "skip": counts.skip }),
    );
    map.insert("durationMs".to_string(), json!(round1(duration_ms)));
    map.insert("replayHits".to_string(), Value::from(0));
    map.insert("modelCalls".to_string(), Value::from(0));
    Value::Object(map)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Counts {
    pub pass: i64,
    pub fail: i64,
    pub skip: i64,
}

impl Counts {
    fn total(self) -> i64 {
        self.pass + self.fail + self.skip
    }
}

fn pytest_case_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^def test_").expect("static pattern"))
}

fn pytest_summary_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed|deselected)")
            .expect("static pattern")
    })
}

fn failures_header_regex() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^=+ FAILURES =+$").expect("static pattern"))
}

/// A file declaring `def test_…` is driven through pytest: running it as a
/// script never calls those functions, so every generated case would exit 0 and
/// be recorded as a pass.
fn looks_like_pytest_module(script_path: &Path) -> bool {
    std::fs::read(script_path)
        .map(|bytes| pytest_case_regex().is_match(&String::from_utf8_lossy(&bytes)))
        .unwrap_or(false)
}

/// pytest's `-q` summary line into counts. Only the trailing block is scanned:
/// a test's own output can print numbers before these words.
fn parse_pytest_counts(stdout: &str) -> std::collections::BTreeMap<String, i64> {
    let mut counts = std::collections::BTreeMap::new();
    for line in stdout.trim().lines().rev() {
        let found: Vec<(String, String)> = pytest_summary_regex()
            .captures_iter(line)
            .filter_map(|caps| {
                Some((
                    caps.get(1)?.as_str().to_string(),
                    caps.get(2)?.as_str().to_string(),
                ))
            })
            .collect();
        if found.is_empty() {
            continue;
        }
        for (number, label) in found {
            if let Ok(parsed) = number.parse::<i64>() {
                *counts.entry(label).or_insert(0) += parsed;
            }
        }
        break;
    }
    counts
}

/// Keep the readable traceback: without it the failure message is a bare count.
fn pytest_failure_excerpt(stdout: &str) -> String {
    let start = failures_header_regex()
        .find(stdout)
        .map(|found| found.end())
        .unwrap_or(0);
    let mut block = &stdout[start..];
    if let Some(stop) = block.find("===== short test summary") {
        block = &block[..stop];
    }
    let block = block.trim();
    if block.chars().count() > 1500 {
        block.chars().skip(block.chars().count() - 1500).collect()
    } else {
        block.to_string()
    }
}

fn pytest_case_status(
    counts: &std::collections::BTreeMap<String, i64>,
    returncode: i32,
) -> (&'static str, Option<String>) {
    let failed = counts.get("failed").copied().unwrap_or(0)
        + counts.get("error").copied().unwrap_or(0)
        + counts.get("errors").copied().unwrap_or(0);
    let passed =
        counts.get("passed").copied().unwrap_or(0) + counts.get("xpassed").copied().unwrap_or(0);
    let skipped =
        counts.get("skipped").copied().unwrap_or(0) + counts.get("xfailed").copied().unwrap_or(0);
    if failed > 0 {
        return ("fail", Some(format!("{failed} 条用例失败")));
    }
    if passed > 0 {
        return ("pass", None);
    }
    if skipped > 0 {
        return ("skip", None);
    }
    if returncode == 5 {
        return (
            "fail",
            Some("pytest 没有收集到任何用例（文件里没有 test_ 开头的函数）".to_string()),
        );
    }
    if returncode == 0 {
        ("pass", None)
    } else {
        ("fail", Some(format!("pytest 退出码 {returncode}")))
    }
}

/// Run one script row. Returns the legacy response shape (`stdout`/`stderr`/
/// `returncode`/`success`) plus the run identity, counts and stored events.
pub fn execute_script(
    state: &AppState,
    db_path: &Path,
    project_id: &str,
    script: &Value,
    timeout: Duration,
) -> ApiResult<Value> {
    let script_id = script
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let script_name = script
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let filepath = script
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let script_path = PathBuf::from(&filepath);
    if !script_path.is_file() {
        return Err(ApiError::not_found("脚本文件不存在"));
    }
    let language = script
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("python")
        .to_lowercase();
    let (executor_name, channel) = if language == "e2e" {
        ("e2e-node", "ui")
    } else {
        ("python-native", "ui")
    };

    let conn = db::open(db_path)?;
    conn.execute_batch(crate::schema::PROJECT_SCHEMA)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS execution_events (\
         id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id INTEGER NOT NULL, \
         seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, \
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);\
         CREATE INDEX IF NOT EXISTS idx_execution_events_run ON execution_events (execution_id, seq);",
    )?;
    for (name, ddl) in crate::schema::EXECUTION_EXTRA_COLUMNS {
        let columns = db::table_columns(&conn, "executions")?;
        if !columns.iter().any(|column| column == name) {
            conn.execute(ddl, [])?;
        }
    }
    conn.execute(
        "INSERT INTO executions (name, status, total, executor, channel) VALUES (?1, ?2, 1, ?3, ?4)",
        rusqlite::params![script_name, "执行中", executor_name, channel],
    )?;
    let execution_id = conn.last_insert_rowid() as u32;

    let run_id = format!("run_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let case_id = script
        .get("case_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&script_id)
        .to_string();

    let cancel = Arc::new(CancelFlag::default());
    state.register_run(project_id, execution_id, Arc::clone(&cancel));

    let started = Instant::now();
    let mut log = EventLog::new(&conn, execution_id);
    log.append(run_start(&run_id, project_id, &case_id, channel))?;
    let first_seq = log.next_seq();
    log.append(case_start(&run_id, &case_id))?;

    let pytest_mode = looks_like_pytest_module(&script_path);
    let label = format!(
        "{} {}",
        if pytest_mode { "pytest" } else { "python" },
        script_name
    );
    log.append(step_start(
        &run_id,
        &case_id,
        &label,
        if pytest_mode { "driver" } else { "act" },
    ))?;

    let step_started = Instant::now();
    let outcome = run_child(
        &script_path,
        pytest_mode,
        timeout,
        &cancel,
        state,
        project_id,
        execution_id,
    );
    let duration_ms = step_started.elapsed().as_secs_f64() * 1000.0;

    let mut counts = Counts::default();
    let (status, failure): (&str, Option<String>) =
        if pytest_mode && !outcome.timed_out && !outcome.cancelled {
            let pytest_counts = parse_pytest_counts(&outcome.stdout);
            let (status, failure) = pytest_case_status(&pytest_counts, outcome.returncode);
            if status == "fail" {
                let excerpt = pytest_failure_excerpt(&outcome.stdout);
                let text = if excerpt.is_empty() {
                    if outcome.stderr.trim().is_empty() {
                        failure
                    } else {
                        Some(outcome.stderr.trim().to_string())
                    }
                } else {
                    Some(excerpt)
                };
                (status, text)
            } else {
                (status, failure)
            }
        } else {
            let passed = outcome.returncode == 0 && !outcome.timed_out && !outcome.cancelled;
            let status = if passed {
                "pass"
            } else if outcome.cancelled {
                "skip"
            } else {
                "fail"
            };
            let failure = if passed {
                None
            } else if !outcome.stderr.trim().is_empty() {
                Some(outcome.stderr.trim().to_string())
            } else {
                Some(format!("exit code {}", outcome.returncode))
            };
            (status, failure)
        };

    log.append(step_end(
        &run_id,
        &case_id,
        status,
        duration_ms,
        json!({
            "returncode": outcome.returncode,
            "stdout": tail(&outcome.stdout, OUTPUT_LIMIT),
            "stderr": tail(&outcome.stderr, OUTPUT_LIMIT),
            "timedOut": outcome.timed_out,
            "cancelled": outcome.cancelled,
            "driver": if pytest_mode { "pytest" } else { "script" },
            "counts": if pytest_mode && !outcome.timed_out && !outcome.cancelled {
                json!(parse_pytest_counts(&outcome.stdout))
            } else {
                json!({})
            },
        }),
    ))?;
    log.append(case_end(
        &run_id,
        &case_id,
        status,
        duration_ms,
        failure.as_deref(),
    ))?;

    // Measured counts win when pytest actually counted cases; a plain script run
    // stays "one script = one result".
    if pytest_mode && !outcome.timed_out && !outcome.cancelled {
        let measured = parse_pytest_counts(&outcome.stdout);
        let mapped = map_counts(&measured);
        if mapped.total() > 0 {
            counts = mapped;
        }
    }
    if counts.total() == 0 {
        counts = match status {
            "pass" => Counts {
                pass: 1,
                fail: 0,
                skip: 0,
            },
            "skip" => Counts {
                pass: 0,
                fail: 0,
                skip: 1,
            },
            _ => Counts {
                pass: 0,
                fail: 1,
                skip: 0,
            },
        };
    }

    let final_status = if outcome.cancelled {
        "cancelled"
    } else {
        status
    };
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    log.append(run_end(&run_id, final_status, &counts, total_ms))?;

    let stored_events = log.replay()?;
    let first_index = first_seq as usize;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut returncode = -1i64;
    let mut success = false;
    for event in stored_events.iter().skip(first_index) {
        match event.get("type").and_then(Value::as_str) {
            Some("step.end") => {
                if let Some(detail) = event.get("detail") {
                    stdout = detail
                        .get("stdout")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    stderr = detail
                        .get("stderr")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    returncode = detail
                        .get("returncode")
                        .and_then(Value::as_i64)
                        .unwrap_or(-1);
                }
            }
            Some("case.end") => {
                success = event.get("status").and_then(Value::as_str) == Some("pass");
            }
            _ => {}
        }
    }
    if final_status == "cancelled" {
        success = false;
    }

    let finished_status = match final_status {
        "pass" => "已完成",
        "fail" => "失败",
        "error" => "异常",
        "cancelled" => "已取消",
        _ => "已完成",
    };
    let case_result_text = match final_status {
        "pass" => "通过",
        "fail" => "失败",
        "error" => "异常",
        "cancelled" => "已取消",
        _ => "未执行",
    };

    if !case_id.is_empty() && case_id != script_id {
        conn.execute(
            "INSERT INTO execution_cases (execution_id, case_id, result, duration_ms, error_message) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                execution_id,
                case_id,
                case_result_text,
                round1(total_ms),
                failure
            ],
        )?;
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM test_cases WHERE id = ?1",
                [&case_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if exists > 0 {
            conn.execute(
                "UPDATE test_cases SET status = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                rusqlite::params![case_result_text, case_id],
            )?;
        }
    }
    conn.execute(
        "UPDATE executions SET status = ?1, finished_at = CURRENT_TIMESTAMP, total = ?2, \
         passed = ?3, failed = ?4, running = 0, replay_hits = 0, model_calls = 0 WHERE id = ?5",
        rusqlite::params![
            finished_status,
            counts.total(),
            counts.pass + counts.skip,
            counts.fail,
            execution_id
        ],
    )?;

    state.clear_run(project_id, execution_id);

    Ok(json!({
        "stdout": stdout,
        "stderr": stderr,
        "returncode": returncode,
        "success": success,
        "executor": executor_name,
        "channel": channel,
        "execution_id": execution_id,
        "run_id": run_id,
        "status": final_status,
        "counts": { "pass": counts.pass, "fail": counts.fail, "skip": counts.skip },
        "total": counts.total(),
        "status_label": case_result_text,
        "failure": failure,
        "duration_ms": round1(total_ms),
        "events": stored_events,
    }))
}

fn map_counts(measured: &std::collections::BTreeMap<String, i64>) -> Counts {
    Counts {
        pass: measured.get("pass").copied().unwrap_or(0)
            + measured.get("passed").copied().unwrap_or(0),
        fail: measured.get("fail").copied().unwrap_or(0)
            + measured.get("failed").copied().unwrap_or(0)
            + measured.get("error").copied().unwrap_or(0)
            + measured.get("errors").copied().unwrap_or(0),
        skip: measured.get("skip").copied().unwrap_or(0)
            + measured.get("skipped").copied().unwrap_or(0)
            + measured.get("xfailed").copied().unwrap_or(0),
    }
}

fn tail(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    chars[chars.len() - limit..].iter().collect()
}

struct ChildOutcome {
    stdout: String,
    stderr: String,
    returncode: i32,
    timed_out: bool,
    cancelled: bool,
}

/// Spawn, then wait with the cancel flag and the timeout checked on a short
/// poll: the same 0.1 s granularity the Python executor used, so "stop" feels
/// the same and a runaway script cannot outlive the request.
fn run_child(
    script_path: &Path,
    pytest_mode: bool,
    timeout: Duration,
    cancel: &CancelFlag,
    _state: &AppState,
    _project_id: &str,
    _execution_id: u32,
) -> ChildOutcome {
    let python = python_executable(script_path);
    let mut command = Command::new(&python);
    if pytest_mode {
        command
            .arg("-m")
            .arg("pytest")
            .arg(script_path)
            .arg("-q")
            .arg("--no-header")
            .arg("-p")
            .arg("no:cacheprovider");
    } else {
        command.arg(script_path);
    }
    if let Some(parent) = script_path.parent() {
        command.current_dir(parent);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ChildOutcome {
                stdout: String::new(),
                stderr: error.to_string(),
                returncode: -1,
                timed_out: false,
                cancelled: false,
            }
        }
    };

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut cancelled = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if cancel.is_cancelled() {
            let _ = child.kill();
            cancelled = true;
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            timed_out = true;
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        let mut buffer = Vec::new();
        let _ = out.read_to_end(&mut buffer);
        stdout = String::from_utf8_lossy(&buffer).into_owned();
    }
    if let Some(mut err) = child.stderr.take() {
        let mut buffer = Vec::new();
        let _ = err.read_to_end(&mut buffer);
        stderr = String::from_utf8_lossy(&buffer).into_owned();
    }
    // Normalise line endings: the interpreter writes CRLF on Windows, and the
    // event stream (and every excerpt cut out of it) is read as LF text.
    stdout = stdout.replace("\r\n", "\n");
    stderr = stderr.replace("\r\n", "\n");
    let status = child.wait().ok();
    let mut returncode = status.and_then(|status| status.code()).unwrap_or(-1);

    if timed_out {
        stderr = format!("脚本执行超时（{}秒）", timeout.as_secs());
        returncode = -1;
    } else if cancelled {
        stderr = format!("已取消：{}", cancel.reason());
        returncode = -1;
    }

    ChildOutcome {
        stdout,
        stderr,
        returncode,
        timed_out,
        cancelled,
    }
}

/// The interpreter that runs user scripts: the host-provided one when present,
/// else the copy shipped next to this binary.
fn python_executable(script_path: &Path) -> PathBuf {
    if let Ok(explicit) = std::env::var("AUTOTEST_PYTHON") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    let root = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    if let Some(found) = config::python_executable(&root) {
        return found;
    }
    let _ = script_path;
    PathBuf::from("python")
}

/// `GET /api/projects/{id}/executions/{execution_id}` payload helper: the run
/// row plus its event stream.
pub fn execution_with_events(db_path: &Path, execution_id: u32) -> ApiResult<Option<Value>> {
    let conn = db::open(db_path)?;
    let Some(execution) = db::query_one(
        &conn,
        "SELECT * FROM executions WHERE id = ?1",
        [execution_id],
    )?
    else {
        return Ok(None);
    };
    let events = EventLog::new(&conn, execution_id).replay()?;
    Ok(Some(json!({ "execution": execution, "events": events })))
}
