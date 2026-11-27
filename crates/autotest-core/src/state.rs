//! Shared service state: where files live, the workspace change a user queued,
//! the environment probe cache, and the executions currently running.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use serde_json::Value;

use crate::config::Paths;
use crate::exec::CancelFlag;

pub struct AppState {
    /// Rebinding the workspace only takes effect on the next start, so a running
    /// process keeps one consistent view of where projects live.
    pub paths: RwLock<Paths>,
    pub pending_workspace: Mutex<String>,
    pub env_cache: Mutex<HashMap<String, (Instant, Value)>>,
    /// `"<project_id>:<execution_id>"` → the flag the runner polls. Execution ids
    /// are per project database, so the key needs both halves.
    pub runs: Mutex<HashMap<String, Arc<CancelFlag>>>,
}

impl AppState {
    pub fn new(paths: Paths) -> Arc<Self> {
        let pending = paths.pending_workspace();
        Arc::new(Self {
            paths: RwLock::new(paths),
            pending_workspace: Mutex::new(pending),
            env_cache: Mutex::new(HashMap::new()),
            runs: Mutex::new(HashMap::new()),
        })
    }

    pub fn paths(&self) -> Paths {
        self.paths.read().expect("paths lock").clone()
    }

    fn run_key(project_id: &str, execution_id: u32) -> String {
        format!("{project_id}:{execution_id}")
    }

    pub fn register_run(&self, project_id: &str, execution_id: u32, flag: Arc<CancelFlag>) {
        self.runs
            .lock()
            .expect("runs lock")
            .insert(Self::run_key(project_id, execution_id), flag);
    }

    pub fn clear_run(&self, project_id: &str, execution_id: u32) {
        self.runs
            .lock()
            .expect("runs lock")
            .remove(&Self::run_key(project_id, execution_id));
    }

    /// Ask a running executor to stop. `false` means it already finished — the
    /// route answers 409 rather than pretending the stop worked.
    pub fn cancel_run(&self, project_id: &str, execution_id: u32) -> bool {
        let flag = self
            .runs
            .lock()
            .expect("runs lock")
            .get(&Self::run_key(project_id, execution_id))
            .cloned();
        match flag {
            Some(flag) => {
                flag.cancel("cancelled by user");
                true
            }
            None => false,
        }
    }

    /// True while any execution of this project is still running: deleting a
    /// project mid-run would move the database out from under the writer.
    pub fn is_project_running(&self, project_id: &str) -> bool {
        let prefix = format!("{project_id}:");
        self.runs
            .lock()
            .expect("runs lock")
            .keys()
            .any(|key| key.starts_with(&prefix))
    }
}
