//! Fixed prompts: "what each stage must produce" as versioned files in the
//! repository.
//!
//! Why this layer exists: every stage (parse / cases / review / scripts / log /
//! report) used to carry its rules only in code, so two runs on one requirement
//! could produce different things. The rules now live in
//! `services/autotest/prompts/*.md` as markdown with frontmatter, each output
//! records `id@version`, and changing a rule means bumping the version —
//! traceable, and testable.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::hashes;

/// Stage → file. A stage is only recognised when it is registered here, so
/// "any random markdown file" cannot take effect.
pub const STAGES: [(&str, &str); 6] = [
    ("prd-parse", "prd-parse.md"),
    ("case-design", "case-design.md"),
    ("case-review", "case-review.md"),
    ("script-author", "script-author.md"),
    ("log-analyze", "log-analyze.md"),
    ("report", "report.md"),
];

pub const REQUIRED_KEYS: [&str; 3] = ["id", "version", "stage"];

#[derive(Debug, Clone)]
pub struct Prompt {
    pub stage: String,
    pub prompt_id: String,
    pub version: String,
    pub updated: String,
    pub body: String,
}

impl Prompt {
    /// Stable reference for payloads: `autotest.case-design@1.0.0`.
    pub fn reference(&self) -> String {
        format!("{}@{}", self.prompt_id, self.version)
    }

    /// Body fingerprint: catches "version not bumped but content changed".
    pub fn digest(&self) -> String {
        hashes::sha256_prefix(self.body.as_bytes(), 12)
    }

    pub fn marker(&self) -> Value {
        json!({
            "stage": self.stage,
            "id": self.prompt_id,
            "version": self.version,
            "ref": self.reference(),
            "digest": self.digest(),
            "updated": self.updated,
        })
    }
}

/// Where the prompt files live.
///
/// In the packaged app they ship next to the binary (`<resources>/autotest/prompts`);
/// in a source checkout they sit at `services/autotest/prompts`. Both are tried,
/// plus an explicit override, because a stage silently running without its rules
/// is worse than a loud failure.
fn prompt_dir(service_root: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("AUTOTEST_PROMPTS_DIR") {
        let path = PathBuf::from(explicit);
        if path.is_dir() {
            return Some(path);
        }
    }
    let mut candidates: Vec<PathBuf> = vec![
        service_root.join("prompts"),
        service_root.join("..").join("prompts"),
    ];
    if let Ok(cwd) = std::env::current_dir() {
        let mut current: Option<&Path> = Some(cwd.as_path());
        while let Some(dir) = current {
            candidates.push(dir.join("services").join("autotest").join("prompts"));
            candidates.push(dir.join("prompts"));
            current = dir.parent();
        }
    }
    candidates.into_iter().find(|path| path.is_dir())
}

/// Split `---` frontmatter from the body, the way the Python loader does:
/// `text.split("---", 2)`.
fn parse_document(text: &str) -> Result<(Vec<(String, String)>, String), String> {
    if !text.starts_with("---") {
        return Err("提示词缺少 frontmatter".to_string());
    }
    let parts: Vec<&str> = text.splitn(3, "---").collect();
    if parts.len() < 3 {
        return Err("提示词 frontmatter 没有闭合".to_string());
    }
    let mut meta: Vec<(String, String)> = Vec::new();
    for line in parts[1].trim().split('\n') {
        if line.trim().is_empty() || !line.contains(':') {
            continue;
        }
        let (key, value) = line.split_once(':').expect("checked above");
        meta.push((key.trim().to_string(), value.trim().to_string()));
    }
    Ok((meta, parts[2].trim().to_string()))
}

pub fn load(service_root: &Path, stage: &str) -> Result<Prompt, String> {
    let Some(filename) = STAGES
        .iter()
        .find(|(name, _)| *name == stage)
        .map(|(_, file)| *file)
    else {
        let known: Vec<&str> = STAGES.iter().map(|(name, _)| *name).collect();
        return Err(format!(
            "未知阶段 {stage}；已登记：{}",
            known.join(", ")
        ));
    };
    let Some(directory) = prompt_dir(service_root) else {
        return Err(format!("提示词目录不存在（找过 {filename}）"));
    };
    let path = directory.join(filename);
    let text = std::fs::read_to_string(&path)
        .map_err(|_| format!("提示词文件不存在：{}", path.display()))?;
    let (meta, body) = parse_document(&text)?;
    let get = |key: &str| -> Option<String> {
        meta.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    let missing: Vec<&str> = REQUIRED_KEYS
        .iter()
        .filter(|key| get(key).is_none())
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{filename} 缺少 frontmatter 字段：{}",
            missing.join(", ")
        ));
    }
    let found_stage = get("stage").unwrap_or_default();
    if found_stage != stage {
        return Err(format!(
            "{filename} 的 stage 写成 {found_stage}，与注册的 {stage} 不一致"
        ));
    }
    Ok(Prompt {
        stage: stage.to_string(),
        prompt_id: get("id").unwrap_or_default(),
        version: get("version").unwrap_or_default(),
        updated: get("updated").unwrap_or_default(),
        body,
    })
}

/// The `id@version` marker an output carries; a missing file is reported in the
/// payload instead of failing the whole stage, so the run stays traceable.
pub fn marker_or_error(service_root: &Path, stage: &str) -> Value {
    match load(service_root, stage) {
        Ok(prompt) => prompt.marker(),
        Err(problem) => json!({ "stage": stage, "error": problem }),
    }
}

/// Every stage's current version — what the panel shows as "which rules ran".
pub fn catalog(service_root: &Path) -> Vec<Value> {
    STAGES
        .iter()
        .filter_map(|(stage, _)| load(service_root, stage).ok())
        .map(|prompt| prompt.marker())
        .collect()
}
