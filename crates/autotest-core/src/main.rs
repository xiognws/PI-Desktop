//! AutoTest platform service.
//!
//! A loopback HTTP service the workbench UI talks to: projects, cases, scripts,
//! runs and their event streams. It owns no model calls — reasoning belongs to
//! the desktop agent, and this process stores what the agent produced and runs
//! what the user asked for.
//!
//! Started by the Electron host as `pi-autotest --host 127.0.0.1 --port <n>` with
//! `AUTOTEST_WORKSPACE` and `AUTOTEST_PLATFORM_DB` pointing into the user's data
//! directory. It exits when the host goes away, so a leftover process cannot keep
//! holding the port and make the next start look broken.

mod api;
mod config;
mod db;
mod error;
mod exec;
mod knowledge;
mod project;
mod schema;
mod script_state;
mod state;
mod static_assets;
mod workflow;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use tracing_subscriber::EnvFilter;

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let argv: Vec<String> = std::env::args().collect();
    let paths = config::Paths::load(argv.clone());
    db::ensure_platform_db(&paths.platform_db)
        .map_err(|error| anyhow::anyhow!("platform database: {}", error.detail))?;
    std::fs::create_dir_all(&paths.workspace).context("workspace")?;

    let host = argv
        .windows(2)
        .find(|pair| pair[0] == "--host")
        .map(|pair| pair[1].clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let address = format!("{host}:{}", paths.port);

    let state = state::AppState::new(paths.clone());
    let app = api::build(Arc::clone(&state));

    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .with_context(|| format!("bind {address}"))?;
    tracing::info!(
        workspace = %paths.workspace.display(),
        platform_db = %paths.platform_db.display(),
        "backend ready on {address}"
    );

    start_parent_watchdog();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve")?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Exit when the host process that spawned us is gone.
///
/// Without this a crashed host leaves an orphan holding the port, and the next
/// launch talks to the old build — the failure reads as "the plugin is broken"
/// rather than "a stale process answered".
fn start_parent_watchdog() {
    let Ok(raw) = std::env::var("AUTOTEST_PARENT_PID") else {
        return;
    };
    let Ok(parent) = raw.trim().parse::<u32>() else {
        return;
    };
    std::thread::Builder::new()
        .name("parent-watchdog".to_string())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(3));
            if !process_alive(parent) {
                tracing::info!(parent, "host process exited; stopping the service");
                std::process::exit(0);
            }
        })
        .ok();
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Cannot inspect it (access denied) — assume alive rather than
            // killing a service that is fine.
            return true;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}
