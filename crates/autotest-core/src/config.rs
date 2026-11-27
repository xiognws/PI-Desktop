//! Where the service keeps things.
//!
//! Every location is supplied by the host (`apps/desktop/electron/autotest`):
//! the workspace holds one directory per project, the platform database holds
//! the cross-project tables, and `platform-settings.json` remembers the
//! workspace choice a user made on the settings page — a value that must only
//! take effect on the *next* start, because running services hold the current
//! path.

use std::path::{Path, PathBuf};

pub const APP_VERSION: &str = "0.2.0";
pub const PLATFORM_STAGES: [(&str, &str); 3] = [
    ("analyze", "需求分析"),
    ("design", "用例设计"),
    ("author", "脚本工程"),
];
pub const MCP_HARDWARE_SERVERS: [(&str, &str, &str); 3] = [
    ("mcp_can", "CAN 总线适配", "http://127.0.0.1:9100/mcp"),
    ("mcp_hmi", "座舱 HMI 适配", "http://127.0.0.1:9101/mcp"),
    ("mcp_logger", "日志采集适配", "http://127.0.0.1:9102/mcp"),
];

#[derive(Debug, Clone)]
pub struct Paths {
    pub workspace: PathBuf,
    pub platform_db: PathBuf,
    pub settings_file: PathBuf,
    pub service_root: PathBuf,
    pub port: u16,
}

impl Paths {
    /// `service_root` is where `ui/dist` and the Python runtime live. The host
    /// launches this binary from `<resources>/autotest`, so the executable's
    /// own directory is the anchor — never the process working directory.
    pub fn load(argv: Vec<String>) -> Self {
        let service_root = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));

        let mut workspace = std::env::var("AUTOTEST_WORKSPACE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("workspace/projects"));

        let settings_file = std::env::var("AUTOTEST_SETTINGS_FILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("platform-settings.json"));

        // A saved workspace only wins when the host did not pass one: the host's
        // explicit value is authoritative.
        if std::env::var("AUTOTEST_WORKSPACE").map_or(true, |value| value.trim().is_empty()) {
            if let Some(saved) = read_saved_workspace(&settings_file) {
                workspace = PathBuf::from(saved);
            }
        }

        let platform_db = std::env::var("AUTOTEST_PLATFORM_DB")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data/autotest.db"));

        Self {
            workspace,
            platform_db,
            settings_file,
            service_root,
            port: resolve_port(&argv),
        }
    }

    pub fn pending_workspace(&self) -> String {
        read_saved_workspace(&self.settings_file).unwrap_or_default()
    }

    pub fn dist_dir(&self) -> PathBuf {
        self.service_root.join("ui").join("dist")
    }

    pub fn shell_dir(&self) -> PathBuf {
        self.service_root.join("ui-shell")
    }

    pub fn project_dir(&self, project_id: &str) -> Result<PathBuf, crate::error::ApiError> {
        crate::project::safe_project_dir(&self.workspace, project_id)
    }

    pub fn project_db(&self, project_id: &str) -> Result<PathBuf, crate::error::ApiError> {
        Ok(self.project_dir(project_id)?.join("data.db"))
    }
}

/// `--port` on the command line beats the environment: the host passes the port
/// it opened, and a second backend must land on that same port.
fn resolve_port(argv: &[String]) -> u16 {
    let mut iter = argv.iter();
    while let Some(item) = iter.next() {
        if item == "--port" {
            if let Some(value) = iter.next() {
                if let Ok(port) = value.parse::<u16>() {
                    return port;
                }
            }
        } else if let Some(rest) = item.strip_prefix("--port=") {
            if let Ok(port) = rest.parse::<u16>() {
                return port;
            }
        }
    }
    std::env::var("AUTOTEST_PORT")
        .or_else(|_| std::env::var("PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4000)
}

fn read_saved_workspace(settings_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(settings_file).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let saved = parsed.get("workspace")?.as_str()?.trim().to_string();
    if saved.is_empty() {
        None
    } else {
        Some(saved)
    }
}

pub fn write_platform_settings(paths: &Paths, pending_workspace: &str) -> std::io::Result<()> {
    let payload = serde_json::json!({ "workspace": pending_workspace });
    std::fs::write(
        &paths.settings_file,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

/// Path to the bundled interpreter, when this build ships one. Reported by
/// `/api/platform` (the settings page shows it) and used by the script gate for
/// Python syntax checks and by the executor to run pytest.
pub fn python_executable(service_root: &Path) -> Option<PathBuf> {
    let candidates = [
        service_root
            .join("..")
            .join("python")
            .join("runtime")
            .join("python.exe"),
        service_root.join("python").join("python.exe"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}
