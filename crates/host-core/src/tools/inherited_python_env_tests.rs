//! The desktop injects `PYTHONHOME`/`PYTHONPATH`/`PYTHONNOUSERSITE` so the Office
//! tools find the bundled 3.12 interpreter. Everything host-core spawns inherits
//! the host environment, so a user command that keeps those variables runs their
//! own `python` against the bundled standard library: on a 3.11 interpreter every
//! `pytest` run dies with `module '_thread' has no attribute
//! 'daemon_threads_allowed'`. These tests pin the stripping, not the mechanism.

use tokio::process::Command;

/// A shell that prints the three variables it received, so the assertion is about
/// what a real child process sees rather than about the builder's internal state
/// (tokio's `Command` has no `get_envs`).
fn echo_variables(expression: &str) -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/c", expression]);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-c", expression]);
        command
    }
}

#[tokio::test]
async fn user_commands_do_not_inherit_the_bundled_python_variables() {
    // Explicit sentinels rather than the process environment: the point is that a
    // variable the desktop *set* is gone from the child, whatever this test
    // process happens to inherit.
    let mut command = echo_variables("echo [%PYTHONHOME%][%PYTHONPATH%][%PYTHONNOUSERSITE%]");
    command
        .env("PYTHONHOME", "sentinel-home")
        .env("PYTHONPATH", "sentinel-path")
        .env("PYTHONNOUSERSITE", "sentinel-usersite");

    super::strip_inherited_python_env(&mut command);

    let output = command.output().await.expect("the shell starts");
    let text = String::from_utf8_lossy(&output.stdout);
    for sentinel in ["sentinel-home", "sentinel-path", "sentinel-usersite"] {
        assert!(
            !text.contains(sentinel),
            "a user command still sees {sentinel}: {text}"
        );
    }
}

#[tokio::test]
async fn the_strip_leaves_every_other_variable_alone() {
    let mut command = echo_variables("echo [%PI_SCRATCH_DIR%]");
    command
        .env("PYTHONHOME", "sentinel-home")
        .env("PI_SCRATCH_DIR", "scratch-kept");

    super::strip_inherited_python_env(&mut command);

    let output = command.output().await.expect("the shell starts");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("scratch-kept"),
        "unrelated variables stay: {text}"
    );
}

#[test]
fn the_variable_list_matches_what_the_desktop_injects() {
    // Kept next to `pythonEnv()` in apps/desktop/electron/main/python-runtime.ts.
    assert_eq!(
        super::INHERITED_PYTHON_ENV_VARS,
        ["PYTHONHOME", "PYTHONPATH", "PYTHONNOUSERSITE"]
    );
}
