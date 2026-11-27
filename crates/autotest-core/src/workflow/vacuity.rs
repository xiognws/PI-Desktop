//! Vacuity sampling: confirm the generated assertion *can fail*.
//!
//! An assertion that cannot fail is not an assertion — it turns the report green
//! while blocking nothing. The check inverts every generated expectation, runs
//! the mutants, and reports the cases whose mutant still passed.
//!
//! The mutants are written into the project's scripts directory (only there do
//! the relative `_support` imports resolve), run in one pytest invocation, and
//! deleted afterwards — they never stay in the project.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::dut_contract::Contract;
use super::{assertion_gen, scripts as script_service};

pub const MUTANT_PREFIX: &str = "_mutant_";

fn mutant_name(script_name: &str) -> String {
    format!("{MUTANT_PREFIX}{script_name}")
}

/// Run the mutants and collect their combined output, killing pytest at the
/// deadline: a hung child must not hold the request thread forever.
fn run_with_timeout(mut command: std::process::Command, timeout: Duration) -> Result<String, String> {
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || read_all(stdout));
    let err_reader = std::thread::spawn(move || read_all(stderr));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let out = out_reader.join().unwrap_or_default();
    let err = err_reader.join().unwrap_or_default();
    Ok(format!("{out}\n{err}"))
}

fn read_all(handle: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut handle) = handle {
        let mut buffer = Vec::new();
        let _ = handle.read_to_end(&mut buffer);
        text = String::from_utf8_lossy(&buffer).into_owned();
    }
    text
}

/// Returns `{checked, vacuous[], skipped[], errors[]}`.
///
/// `vacuous` are the case titles whose inverted expectation still passed — those
/// assertions must be fixed and cannot ship.
pub fn check(
    scripts_dir: &Path,
    cases: &[Value],
    contract: &Contract,
    sdk: &str,
    python: &Path,
    timeout: std::time::Duration,
) -> Value {
    let mut mutants: Vec<(PathBuf, String)> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();

    for case in cases {
        let title = case
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let point = case
            .get("function_point")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(entry) = contract.get(point) else {
            skipped.push(json!({ "title": title, "reason": "missing_contract" }));
            continue;
        };
        let mutant_body = match assertion_gen::invert(case, entry, &contract.driver, &contract.imports)
        {
            Ok(lines) => lines,
            Err(problem) => {
                skipped.push(json!({ "title": title, "reason": problem.0 }));
                continue;
            }
        };
        let script = match script_service::author_script(case, sdk, Some(&mutant_body)) {
            Ok(script) => script,
            Err(problem) => {
                skipped.push(json!({ "title": title, "reason": problem }));
                continue;
            }
        };
        let name = script
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("case.py");
        let path = scripts_dir.join(mutant_name(name));
        let content = script
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("");
        if std::fs::write(&path, content).is_err() {
            skipped.push(json!({ "title": title, "reason": "mutant_write_failed" }));
            continue;
        }
        mutants.push((path, title));
    }

    if mutants.is_empty() {
        return json!({ "checked": 0, "vacuous": [], "skipped": skipped, "errors": [] });
    }

    let mut command = std::process::Command::new(python);
    command.arg("-m").arg("pytest");
    for (path, _) in &mutants {
        command.arg(path);
    }
    command
        .args([
            "-q",
            "--no-header",
            "-p",
            "no:cacheprovider",
            "--tb=no",
            "-rA",
        ])
        .current_dir(scripts_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let text = match run_with_timeout(command, timeout) {
        Ok(output) => output,
        Err(problem) => {
            // Delete the mutants whatever happened: they are scaffolding, not
            // artifacts of the project.
            for (path, _) in &mutants {
                let _ = std::fs::remove_file(path);
            }
            return json!({
                "checked": mutants.len(),
                "vacuous": [],
                "skipped": skipped,
                "errors": mutants.iter().map(|(_, title)| json!(title)).collect::<Vec<_>>(),
                "error": problem,
            });
        }
    };
    for (path, _) in &mutants {
        let _ = std::fs::remove_file(path);
    }

    let mut vacuous: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for (path, title) in &mutants {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let passed = text.contains(&format!("PASSED {name}"));
        let failed = text.contains(&format!("FAILED {name}"));
        if passed {
            // The inverted expectation still passed: this assertion has no
            // discriminating power.
            vacuous.push(json!(title));
        } else if !failed {
            errors.push(json!(title));
        }
    }

    json!({
        "checked": mutants.len(),
        "vacuous": vacuous,
        "skipped": skipped,
        "errors": errors,
    })
}
