//! Scripts: the executable artifacts. The row records metadata, the file on disk
//! is the truth, and both are kept in step by these routes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path as UrlPath, Query, State};
use axum::Json;
use serde_json::{json, Value};

use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::exec;
use crate::project;
use crate::script_state;
use crate::state::AppState;

/// The editor talks to the language server over a virtual workspace root: the
/// browser cannot read `file://` paths on disk, so the URI is synthetic and the
/// content is delivered by the editor itself.
const VIRTUAL_WORKSPACE_URI: &str = "file:///workspace/scripts";

fn ensure_db(state: &AppState, project_id: &str) -> ApiResult<std::path::PathBuf> {
    let paths = state.paths();
    project::require_project(&paths.workspace, project_id)?;
    let db_path = paths.project_db(project_id)?;
    if !db_path.exists() {
        db::ensure_project_db(&paths.project_dir(project_id)?)?;
    }
    Ok(db_path)
}

/// `GET /api/projects/{id}/scripts`
pub async fn list(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
) -> ApiResult<Json<Value>> {
    let db_path = ensure_db(&state, &project_id)?;
    let conn = db::open(&db_path)?;
    let rows = db::query_rows(
        &conn,
        "SELECT id, case_id, name, language, status, filepath, created_at, updated_at \
         FROM scripts ORDER BY updated_at DESC",
        [],
    )?;
    let case_ids: Vec<String> = conn
        .prepare("SELECT id FROM test_cases")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut scripts = Vec::with_capacity(rows.len());
    let mut orphan_total = 0i64;
    let mut asserted_total = 0i64;
    let mut skeleton_total = 0i64;
    for row in rows {
        let mut script = row;
        let case_ref = script
            .get("case_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        // A script whose case was deleted stays listed: it may already carry
        // hand-written assertions, so it is an asset, not an orphan to remove.
        let case_missing = !case_ref.is_empty() && !case_ids.contains(&case_ref);
        if case_missing {
            orphan_total += 1;
        }
        let filepath = script
            .get("filepath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let status = script_state::classify(&script_state::read_script_text(&filepath));
        if status.state == "asserted" {
            asserted_total += 1;
        }
        if status.state == "skeleton" {
            skeleton_total += 1;
        }
        let name = script
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Value::Object(ref mut map) = script {
            map.insert("case_missing".to_string(), Value::from(case_missing));
            map.insert("assertion_state".to_string(), Value::from(status.state));
            map.insert(
                "assert_count".to_string(),
                Value::from(status.asserts as i64),
            );
            map.insert(
                "file_uri".to_string(),
                Value::from(format!("{VIRTUAL_WORKSPACE_URI}/{name}")),
            );
            map.insert(
                "workspace_uri".to_string(),
                Value::from(VIRTUAL_WORKSPACE_URI),
            );
        }
        scripts.push(script);
    }

    Ok(Json(json!({
        "scripts": scripts,
        "total": scripts.len(),
        "orphan_total": orphan_total,
        "asserted_total": asserted_total,
        "skeleton_total": skeleton_total,
        "workspace_uri": VIRTUAL_WORKSPACE_URI,
    })))
}

/// `POST /api/projects/{id}/scripts` — writes the file and the row together.
pub async fn create(
    State(state): State<Arc<AppState>>,
    UrlPath(project_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let db_path = ensure_db(&state, &project_id)?;
    let paths = state.paths();
    let script_id = format!("script_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("untitled.py")
        .to_string();

    let scripts_dir = paths.project_dir(&project_id)?.join("scripts");
    std::fs::create_dir_all(&scripts_dir)?;
    let script_path = scripts_dir.join(&name);
    std::fs::write(
        &script_path,
        body.get("content").and_then(Value::as_str).unwrap_or(""),
    )?;
    let absolute = script_path.canonicalize().unwrap_or(script_path);

    let conn = db::open(&db_path)?;
    conn.execute(
        "INSERT INTO scripts (id, case_id, name, language, status, filepath) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            script_id,
            body.get("case_id").and_then(Value::as_str).unwrap_or(""),
            name,
            body.get("language")
                .and_then(Value::as_str)
                .unwrap_or("python"),
            body.get("status").and_then(Value::as_str).unwrap_or("就绪"),
            absolute.to_string_lossy(),
        ],
    )?;

    let mut response = body;
    if let Value::Object(ref mut map) = response {
        map.insert("id".to_string(), Value::from(script_id));
        map.insert("message".to_string(), Value::from("创建成功"));
    }
    Ok(Json(response))
}

/// `GET /api/projects/{id}/scripts/{script_id}/content`
pub async fn content(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, script_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let row = db::query_one(
        &conn,
        "SELECT filepath FROM scripts WHERE id = ?1",
        [&script_id],
    )?
    .ok_or_else(|| ApiError::not_found("脚本不存在"))?;
    let filepath = row
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if filepath.is_empty() || !Path::new(&filepath).exists() {
        return Err(ApiError::not_found("脚本文件不存在"));
    }
    let text = std::fs::read(&filepath)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|_| ApiError::not_found("脚本文件不存在"))?;
    Ok(Json(json!({ "content": text })))
}

/// `PUT /api/projects/{id}/scripts/{script_id}/content`
pub async fn save_content(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, script_id)): UrlPath<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let row = db::query_one(
        &conn,
        "SELECT filepath FROM scripts WHERE id = ?1",
        [&script_id],
    )?
    .ok_or_else(|| ApiError::not_found("脚本不存在"))?;
    let filepath = row
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let path = Path::new(&filepath);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        path,
        body.get("content").and_then(Value::as_str).unwrap_or(""),
    )?;
    Ok(Json(json!({
        "ok": true,
        "path": path.canonicalize().unwrap_or_else(|_| path.to_path_buf()).to_string_lossy(),
    })))
}

/// `POST /api/projects/{id}/scripts/{script_id}/gate` — static gate: empty
/// content, a missing `// @target` on e2e scripts, the import that breaks e2e
/// collection, and Python syntax.
pub async fn gate(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, script_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let row = db::query_one(
        &conn,
        "SELECT name, language, filepath FROM scripts WHERE id = ?1",
        [&script_id],
    )?
    .ok_or_else(|| ApiError::not_found("脚本不存在"))?;

    let name = row
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let language = row
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("python")
        .to_string();
    let filepath = row
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut failures: Vec<String> = Vec::new();
    let content = match std::fs::read(&filepath) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => {
            failures.push("脚本文件不存在".to_string());
            String::new()
        }
    };

    if content.trim().is_empty() {
        failures.push("脚本内容为空".to_string());
    } else if language == "e2e" {
        let first = content.lines().next().unwrap_or("");
        if !first.contains("// @target") {
            failures.push("e2e 脚本首行缺少 `// @target <url>`".to_string());
        }
        // Writing `expect` into the `@e2e-dev/web` import passes the type check
        // and then fails collection, burning a whole round.
        if content
            .lines()
            .any(|line| line.contains("@e2e-dev/web") && line.contains("expect"))
        {
            failures.push("expect 必须从 \"e2e\" 导入，@e2e-dev/web 只导出 test".to_string());
        }
    } else if language == "python" {
        if let Some(message) = python_syntax_error(&paths.service_root, Path::new(&filepath)) {
            failures.push(message);
        }
    }

    Ok(Json(json!({
        "scriptId": script_id,
        "name": name,
        "ok": failures.is_empty(),
        "failures": failures,
    })))
}

/// Compile the script with the bundled interpreter. Python syntax cannot be
/// validated by reading it, and the interpreter is already shipped to run the
/// scripts, so this shells out rather than reimplementing the grammar.
fn python_syntax_error(service_root: &Path, script_path: &Path) -> Option<String> {
    let python = crate::config::python_executable(service_root)?;
    let program = "[import sys,json]\n".to_string()
        + "p=sys.argv[1]\n"
        + "src=open(p,encoding='utf-8',errors='replace').read()\n"
        + "try:\n    compile(src,p,'exec')\nexcept SyntaxError as e:\n"
        + "    print(json.dumps({'msg':e.msg,'line':e.lineno}))\n";
    let output = std::process::Command::new(python)
        .arg("-c")
        .arg(program)
        .arg(script_path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    let message = parsed
        .get("msg")
        .and_then(Value::as_str)
        .unwrap_or("syntax error");
    let line = parsed.get("line").and_then(Value::as_i64).unwrap_or(0);
    Some(format!("Python 语法错误：{message} (line {line})"))
}

/// `POST /api/projects/{id}/scripts/{script_id}/check` — type check with
/// basedpyright. When the tool is absent the answer says so instead of turning a
/// missing executable into a "diagnostic".
pub async fn check(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, script_id)): UrlPath<(String, String)>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let row = db::query_one(
        &conn,
        "SELECT filepath FROM scripts WHERE id = ?1",
        [&script_id],
    )?
    .ok_or_else(|| ApiError::not_found("脚本不存在"))?;
    let filepath = row
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if filepath.is_empty() || !Path::new(&filepath).is_file() {
        return Err(ApiError::not_found("脚本文件不存在"));
    }

    let Some(executable) = find_basedpyright() else {
        return Ok(Json(json!({
            "errors": [],
            "errorCount": 0,
            "unavailable": "basedpyright 未安装（先 pnpm/pip 安装后可用）",
        })));
    };

    let output = std::process::Command::new(&executable)
        .arg(&filepath)
        .arg("--outputjson")
        .output();
    let Ok(output) = output else {
        return Ok(Json(json!({
            "errors": [],
            "errorCount": 0,
            "unavailable": "basedpyright 无法启动",
        })));
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Ok(Json(json!({
            "errors": [],
            "errorCount": 0,
            "unavailable": text.lines().next().unwrap_or("basedpyright 输出无法解析"),
        })));
    };

    let mut errors = Vec::new();
    if let Some(diagnostics) = parsed.get("generalDiagnostics").and_then(Value::as_array) {
        for diagnostic in diagnostics {
            let start = diagnostic.pointer("/range/start");
            errors.push(json!({
                "line": start.and_then(|value| value.get("line")).and_then(Value::as_i64).unwrap_or(0) + 1,
                "column": start.and_then(|value| value.get("character")).and_then(Value::as_i64).unwrap_or(0) + 1,
                "message": diagnostic.get("message").and_then(Value::as_str).unwrap_or(""),
                "severity": diagnostic.get("severity").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    let count = errors.len();
    Ok(Json(json!({ "errors": errors, "errorCount": count })))
}

/// `.venv` first (the developer layout), then `PATH`.
fn find_basedpyright() -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join(".venv").join("Scripts").join("basedpyright.exe"),
        cwd.join(".venv").join("bin").join("basedpyright"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .flat_map(|dir| {
            [
                dir.join("basedpyright.exe"),
                dir.join("basedpyright.cmd"),
                dir.join("basedpyright"),
            ]
        })
        .find(|candidate| candidate.is_file())
}

/// `POST /api/projects/{id}/scripts/{script_id}/run?background=`
pub async fn run(
    State(state): State<Arc<AppState>>,
    UrlPath((project_id, script_id)): UrlPath<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let paths = state.paths();
    let db_path = paths.project_db(&project_id)?;
    if !db_path.exists() {
        return Err(ApiError::not_found("项目数据库不存在"));
    }
    let conn = db::open(&db_path)?;
    let script = db::query_one(&conn, "SELECT * FROM scripts WHERE id = ?1", [&script_id])?
        .ok_or_else(|| ApiError::not_found("脚本不存在"))?;
    let filepath = script
        .get("filepath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if filepath.is_empty() || !Path::new(&filepath).is_file() {
        return Err(ApiError::not_found("脚本文件不存在"));
    }

    let background = query
        .get("background")
        .map(|value| value == "true" || value == "1")
        .unwrap_or(false);

    // An interactive run waits as long as a person would: pytest start-up on a
    // busy machine has been measured from 2 s to 60 s. Background runs of a whole
    // case get the longer budget.
    if background {
        let state_clone = Arc::clone(&state);
        let project = project_id.clone();
        let row = script.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(db) = state_clone.paths().project_db(&project) {
                let _ = exec::execute_script(
                    &state_clone,
                    &db,
                    &project,
                    &row,
                    Duration::from_secs(300),
                );
            }
        });
        return Ok(Json(json!({
            "status": "started",
            "script_id": script_id,
            "project_id": project_id,
        })));
    }

    let result = tokio::task::spawn_blocking(move || {
        exec::execute_script(
            &state,
            &db_path,
            &project_id,
            &script,
            Duration::from_secs(180),
        )
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;

    Ok(Json(result))
}
