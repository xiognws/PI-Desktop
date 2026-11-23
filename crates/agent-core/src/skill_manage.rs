//! The `skill_manage` tool: the agent writes its own skill library.
//!
//! Counterpart of `skill-manage-tool.ts`. The same shape as the `memory` tool,
//! one level up: the model names an action and the text to act on, and the app's
//! skill store performs it. Nothing here touches the filesystem — every action is
//! a `skills.*` RPC, so the runtime, the UI and the background review all write
//! through one implementation and one path rule (`<root>/<name>` under
//! `references/`, `templates/`, `scripts/` or `assets/`, validated host-side).
//!
//! `patch` reads the document here and applies the replacement locally rather
//! than asking the host to match a string: "which occurrence did the model mean"
//! is exactly the kind of rule that has to exist once, and it has to be the one
//! the tests cover. The host still owns the write, so a patch cannot race a
//! review pass into a lost update any more than two RPCs can.
//!
//! A refused edit is reported as ordinary refusal text, not a hard failure: the
//! model can fix its own argument and retry in the same turn.

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::error::{AgentError, Result};
use crate::host_bridge::HostError;
use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Name of the tool the model calls.
pub const SKILL_MANAGE_TOOL_NAME: &str = "skill_manage";

/// The quality bar the tool tells the model to write to.
///
/// It lives here rather than in a second prompt section because the schema and
/// the bar are read together: a create that ignores the bar produces a document
/// the catalog cannot index well, and the catalog is what later sessions search.
const SKILL_AUTHORING_GUIDE: &str = r#"SKILL.md quality bar:

Frontmatter:
- name: lowercase-hyphenated, matches the directory.
- description: ONE sentence, <=60 characters, ends with a period. State when to use it, not the implementation: the catalog shows 60 characters of it on every turn.

Required body sections (Chinese headings are fine: 何时使用 / 工作流程 / 陷阱 / 验证):
1. Title + 2-3 sentence intro: what it does, what it does NOT do.
2. ## When to Use — concrete trigger phrases AND a Do-not-use list.
3. ## Procedure — numbered steps. Commands, URLs, flags and error strings MUST be copied verbatim from the session. Never invent flags.
4. ## Pitfalls — things that look like success but are not (for example an HTTP 200 HTML body), plus the correction.
5. ## Verification — one checkable criterion (file exists, UI shows X, command output contains Y).

Depth:
- Capture decision rules, not a recap of this afternoon. Class-level names (openai-compatible-base-url), never fix-issue-12.
- Frame tools as PI: read, write, edit, bash, grep, glob.
- Prefer patching an existing skill over creating a near-duplicate."#;

/// The host surface this tool needs: one RPC call.
pub trait SkillHost: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>>;
}

impl SkillHost for crate::host_bridge::HostBridge {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
        Box::pin(async move { crate::host_bridge::HostBridge::call(self, method, params).await })
    }
}

/// The `skill_manage` tool, bound to one session's project scope.
pub struct SkillManageTool {
    host: Arc<dyn SkillHost>,
    project_path: Option<String>,
}

impl SkillManageTool {
    pub fn new(host: Arc<dyn SkillHost>, project_path: Option<String>) -> Self {
        Self { host, project_path }
    }

    /// The scope fields a resource RPC needs to reach a project skill.
    fn scope(&self) -> Map<String, Value> {
        let mut scope = Map::new();
        if let Some(path) = &self.project_path {
            scope.insert("level".into(), json!("project"));
            scope.insert("projectPath".into(), json!(path));
        }
        scope
    }

    async fn create(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(name) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required to create a skill.".into(),
            ));
        };
        let mut skill = Map::new();
        skill.insert("name".into(), json!(name));
        // The curation pass may only retire what the agent wrote, so the marker
        // travels with the create. `patch` does not resend it: an origin is
        // recorded once, not re-claimed on every edit.
        skill.insert("createdBy".into(), json!("agent"));
        if let Some(description) = trimmed(raw, "description") {
            skill.insert("description".into(), json!(description));
        }
        if let Some(body) = raw.get("body").and_then(Value::as_str) {
            skill.insert("body".into(), json!(body));
        }
        let reply = self
            .host
            .call("skills.create", json!({ "skill": Value::Object(skill) }))
            .await
            .map_err(|error| AgentError::Refused(describe_create_failure(&error.to_string())))?;
        let id = reply
            .get("skill")
            .and_then(|skill| skill.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .to_string();
        Ok(format!(
            "Created skill `{id}`. It is listed in your Skills section from the next session; patch it now to keep refining it."
        ))
    }

    async fn patch(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required to patch a skill.".into(),
            ));
        };
        let Some(old_string) = raw.get("old_string").and_then(Value::as_str) else {
            return Err(AgentError::Refused(
                "`old_string` is required to patch a skill.".into(),
            ));
        };
        if old_string.is_empty() {
            return Err(AgentError::Refused(
                "`old_string` is required to patch a skill.".into(),
            ));
        }
        let Some(new_string) = raw.get("new_string").and_then(Value::as_str) else {
            return Err(AgentError::Refused(
                "`new_string` is required to patch a skill (pass an empty string to delete)."
                    .into(),
            ));
        };
        let read = self
            .host
            .call("skills.read", json!({ "id": id }))
            .await
            .map_err(|error| {
                AgentError::Refused(format!("The skill could not be read: {error}"))
            })?;
        let found = read
            .get("skill")
            .map(|skill| !skill.is_null())
            .unwrap_or(false);
        let body = read.get("body").and_then(Value::as_str);
        let Some(body) = body.filter(|_| found) else {
            return Err(AgentError::Refused(format!(
                "No skill with id `{id}` in the library. Use `create` for a new one."
            )));
        };
        let occurrences = body.matches(old_string).count();
        if occurrences == 0 {
            return Err(AgentError::Refused(format!(
                "`old_string` does not occur in `{id}`. Read the skill and copy an exact span from it."
            )));
        }
        if occurrences > 1 {
            return Err(AgentError::Refused(format!(
                "`old_string` occurs {occurrences} times in `{id}`; it must select exactly one span. Include more surrounding text."
            )));
        }
        let patched = body.replacen(old_string, new_string, 1);
        self.host
            .call(
                "skills.update",
                json!({ "id": id, "skill": { "body": patched } }),
            )
            .await
            .map_err(|error| AgentError::Refused(format!("The patch was not saved: {error}")))?;
        Ok(format!("Patched skill `{id}`."))
    }

    async fn write_file(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required to write a reference file.".into(),
            ));
        };
        let Some(path) = trimmed(raw, "file_path") else {
            return Err(AgentError::Refused(
                "`file_path` is required; it must look like `references/<topic>.md`, `templates/<name>`, `scripts/<name>` or `assets/<name>`.".into(),
            ));
        };
        let Some(content) = raw.get("content").and_then(Value::as_str) else {
            return Err(AgentError::Refused(
                "`content` is required to write a reference file.".into(),
            ));
        };
        let mut params = Map::new();
        params.insert("id".into(), json!(id));
        params.insert("path".into(), json!(path));
        params.insert("content".into(), json!(content));
        for (key, value) in self.scope() {
            params.insert(key, value);
        }
        let reply = self
            .host
            .call("skills.writeFile", Value::Object(params))
            .await
            .map_err(|error| {
                AgentError::Refused(describe_path_failure(
                    &error.to_string(),
                    "The reference file was not written",
                ))
            })?;
        let written = reply
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(&path)
            .to_string();
        Ok(format!("Wrote `{written}` into skill `{id}`."))
    }

    async fn remove_file(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required to remove a reference file.".into(),
            ));
        };
        let Some(path) = trimmed(raw, "file_path") else {
            return Err(AgentError::Refused(
                "`file_path` is required; it must look like `references/<topic>.md`, `templates/<name>`, `scripts/<name>` or `assets/<name>`.".into(),
            ));
        };
        let mut params = Map::new();
        params.insert("id".into(), json!(id));
        params.insert("path".into(), json!(path));
        for (key, value) in self.scope() {
            params.insert(key, value);
        }
        self.host
            .call("skills.removeFile", Value::Object(params))
            .await
            .map_err(|error| {
                AgentError::Refused(describe_path_failure(
                    &error.to_string(),
                    "The reference file was not removed",
                ))
            })?;
        Ok(format!("Removed `{path}` from skill `{id}`."))
    }

    async fn delete(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required to delete a skill.".into(),
            ));
        };
        let reply = self
            .host
            .call("skills.remove", json!({ "id": id }))
            .await
            .map_err(|error| AgentError::Refused(format!("The skill was not deleted: {error}")))?;
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(AgentError::Refused(format!(
                "No skill with id `{id}` in the library."
            )));
        }
        Ok(format!("Deleted skill `{id}`."))
    }

    async fn absorb(&self, raw: &Map<String, Value>) -> Result<String> {
        let Some(id) = trimmed(raw, "name") else {
            return Err(AgentError::Refused(
                "`name` is required: the skill that should be absorbed.".into(),
            ));
        };
        let Some(into) = trimmed(raw, "into") else {
            return Err(AgentError::Refused(
                "`into` is required: the umbrella skill that keeps the content.".into(),
            ));
        };
        if id == into {
            return Err(AgentError::Refused("A skill cannot absorb itself.".into()));
        }
        let mut params = Map::new();
        params.insert("id".into(), json!(id));
        params.insert("into".into(), json!(into));
        for (key, value) in self.scope() {
            params.insert(key, value);
        }
        // The host method exists (`skills.absorb`); reaching it also needs the
        // entry in main's sidecar allowlist, which is the one place this can
        // still fail for an environmental reason.
        let reply = self
            .host
            .call("skills.absorb", Value::Object(params))
            .await
            .map_err(|error| {
                AgentError::Refused(describe_path_failure(
                    &error.to_string(),
                    "The merge did not happen",
                ))
            })?;
        let copied: Vec<String> = reply
            .get("copied")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let skipped: Vec<String> = reply
            .get("skipped")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut parts = vec![format!("Merged `{id}` into `{into}`.")];
        parts.push(if copied.is_empty() {
            "No files needed moving.".to_string()
        } else {
            format!("Moved {} file(s): {}.", copied.len(), copied.join(", "))
        });
        if !skipped.is_empty() {
            parts.push(format!(
                "Kept the umbrella's own copy of: {}.",
                skipped.join(", ")
            ));
        }
        parts.push(
            "The absorbed skill is out of the catalog; its document is still on disk, so a person can re-enable it."
                .to_string(),
        );
        Ok(parts.join(" "))
    }
}

fn trimmed(raw: &Map<String, Value>, key: &str) -> Option<String> {
    raw.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A duplicate name and an over-long description are both the model's to fix, so
/// both keep the sentence that tells it what to do instead.
fn describe_create_failure(detail: &str) -> String {
    let lower = detail.to_lowercase();
    if lower.contains("already exists") {
        return format!("{detail} Patch that skill instead of creating a second one.");
    }
    if detail.contains("SKILL_INVALID") && lower.contains("description") {
        return detail.to_string();
    }
    format!("The skill was not created: {detail}")
}

fn describe_path_failure(detail: &str, prefix: &str) -> String {
    if detail.contains("SKILL_INVALID") {
        return detail.to_string();
    }
    format!("{prefix}: {detail}")
}

impl Tool for SkillManageTool {
    fn spec(&self) -> ToolSpec {
        let description = format!(
            "Read and edit your skill library: the SKILL.md documents later sessions load.\n\nWrite the moment a turn teaches something reusable — a procedure, a pitfall, a decision rule, a command sequence — at class level, not for one afternoon.\n\n- `create`: `name` (lowercase-hyphenated), `description` (when to use it), `body` (the document); an existing name is refused — patch it.\n- `patch`: ONE span, `old_string` verbatim and occurring exactly once — the usual way to extend a skill.\n- `write_file`: one file beside SKILL.md — `references/<topic>.md` for prose the model reads, `templates/`, `scripts/`, `assets/` for what a procedure runs; prefer it to a rewrite, which can damage the document.\n- `remove_file`: one such file, wrong or superseded.\n- `delete`: a whole skill, only when its content lives somewhere better.\n- `absorb`: merge into another — resource files move under the umbrella (existing kept), it leaves the catalog, nothing is deleted; `name` = the redundant one, `into` = the umbrella, patched first to describe what it now covers.\n\nNever a near-duplicate: patch it, or add a reference.\n\n{SKILL_AUTHORING_GUIDE}"
        );
        ToolSpec::new(
            SKILL_MANAGE_TOOL_NAME,
            description,
            json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["create", "patch", "write_file", "remove_file", "delete", "absorb"],
                        "description": "What to do with the library."
                    },
                    "name": {
                        "type": "string",
                        "description": "Skill id; for `create`, the new name."
                    },
                    "description": {
                        "type": "string",
                        "description": "create only."
                    },
                    "body": {"type": "string", "description": "create only. Without frontmatter."},
                    "old_string": {
                        "type": "string",
                        "description": "patch only. Verbatim, exactly once."
                    },
                    "new_string": {"type": "string", "description": "patch only. The replacement."},
                    "file_path": {
                        "type": "string",
                        "description": "write_file / remove_file. `<root>/<name>`."
                    },
                    "content": {"type": "string", "description": "write_file only. Markdown."},
                    "into": {"type": "string", "description": "absorb only. The umbrella."}
                },
                "required": ["action", "name"],
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        _ctx: &'a ToolContext,
    ) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let raw = call.arguments.as_object().cloned().unwrap_or_default();
            match raw.get("action").and_then(Value::as_str).unwrap_or("") {
                "create" => self.create(&raw).await,
                "patch" => self.patch(&raw).await,
                "write_file" => self.write_file(&raw).await,
                "remove_file" => self.remove_file(&raw).await,
                "delete" => self.delete(&raw).await,
                "absorb" => self.absorb(&raw).await,
                _ => Err(AgentError::Refused(
                    "`action` must be one of create, patch, write_file, remove_file, delete, absorb."
                        .into(),
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::RpcError;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeHost {
        calls: Mutex<Vec<(String, Value)>>,
        reply: Mutex<Value>,
        failure: Mutex<Option<String>>,
    }

    impl FakeHost {
        fn answering(reply: Value) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.reply.lock().unwrap() = reply;
            host
        }

        fn failing(message: &str) -> Arc<Self> {
            let host = Arc::new(Self::default());
            *host.failure.lock().unwrap() = Some(message.to_string());
            host
        }

        fn calls(&self) -> Vec<(String, Value)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl SkillHost for FakeHost {
        fn call<'a>(
            &'a self,
            method: &'a str,
            params: Value,
        ) -> BoxFuture<'a, std::result::Result<Value, HostError>> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let failure = self.failure.lock().unwrap().clone();
            let reply = self.reply.lock().unwrap().clone();
            Box::pin(async move {
                match failure {
                    Some(message) => Err(HostError::Rpc(RpcError::app("SKILL_ERROR", message))),
                    None => Ok(reply),
                }
            })
        }
    }

    fn manage_tool(host: Arc<dyn SkillHost>) -> SkillManageTool {
        SkillManageTool::new(host, None)
    }

    fn context() -> ToolContext {
        ToolContext {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            tool_call_id: "call_1".into(),
            steering: None,
            cancel: crate::CancelToken::new(),
        }
    }

    async fn run(tool: &SkillManageTool, arguments: Value) -> Result<String> {
        let call = ToolCall {
            id: "call_1".into(),
            name: SKILL_MANAGE_TOOL_NAME.into(),
            arguments,
            raw_arguments: None,
        };
        tool.call(&call, &context()).await
    }

    fn refused(result: Result<String>) -> String {
        match result {
            Ok(text) => panic!("expected a refusal, got {text}"),
            Err(error) => error.to_string(),
        }
    }

    #[tokio::test]
    async fn create_sends_the_agent_origin_and_returns_the_id() {
        let host = FakeHost::answering(json!({"skill": {"id": "pi-release", "name": "Release"}}));
        let tool = manage_tool(host.clone());
        let answer = run(
            &tool,
            json!({
                "action": "create",
                "name": "pi-release",
                "description": "Use when cutting a release.",
                "body": "# Release\n\nSteps."
            }),
        )
        .await
        .expect("created");
        assert!(answer.contains("Created skill `pi-release`"));
        let calls = host.calls();
        assert_eq!(calls[0].0, "skills.create");
        assert_eq!(calls[0].1["skill"]["name"], "pi-release");
        assert_eq!(
            calls[0].1["skill"]["createdBy"], "agent",
            "the curation pass may only retire what the agent wrote"
        );
        assert_eq!(
            calls[0].1["skill"]["description"],
            "Use when cutting a release."
        );
    }

    #[tokio::test]
    async fn create_without_a_name_is_refused_without_a_host_call() {
        let host = FakeHost::answering(json!({}));
        let tool = manage_tool(host.clone());
        let message = refused(run(&tool, json!({"action": "create", "body": "x"})).await);
        assert!(message.contains("`name` is required to create"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_duplicate_name_tells_the_model_to_patch_instead() {
        let host = FakeHost::failing("SKILL_INVALID: a skill named pi-release already exists");
        let tool = manage_tool(host);
        let message = refused(run(&tool, json!({"action": "create", "name": "pi-release"})).await);
        assert!(message.contains("already exists"));
        assert!(message.contains("Patch that skill instead"));
    }

    #[tokio::test]
    async fn an_over_long_description_is_passed_through_with_its_code() {
        let host = FakeHost::failing("SKILL_INVALID: description exceeds 60 characters");
        let tool = manage_tool(host);
        let message = refused(
            run(
                &tool,
                json!({"action": "create", "name": "x", "description": "long"}),
            )
            .await,
        );
        assert!(message.contains("description exceeds 60"));
    }

    #[tokio::test]
    async fn patch_replaces_exactly_one_span() {
        let host = FakeHost::answering(
            json!({"skill": {"id": "pi-release"}, "body": "# Release\n\nRun the build.\n"}),
        );
        let tool = manage_tool(host.clone());
        let answer = run(
            &tool,
            json!({
                "action": "patch",
                "name": "pi-release",
                "old_string": "Run the build.",
                "new_string": "Run the build, then the tests."
            }),
        )
        .await
        .expect("patched");
        assert_eq!(answer, "Patched skill `pi-release`.");
        let calls = host.calls();
        assert_eq!(calls[0].0, "skills.read");
        assert_eq!(calls[1].0, "skills.update");
        assert_eq!(
            calls[1].1["skill"]["body"],
            "# Release\n\nRun the build, then the tests.\n"
        );
    }

    #[tokio::test]
    async fn a_missing_span_is_refused_with_the_next_step() {
        let host = FakeHost::answering(json!({"skill": {"id": "s"}, "body": "alpha"}));
        let tool = manage_tool(host);
        let message = refused(
            run(
                &tool,
                json!({"action": "patch", "name": "s", "old_string": "beta", "new_string": "x"}),
            )
            .await,
        );
        assert!(message.contains("does not occur in `s`"));
        assert!(message.contains("copy an exact span"));
    }

    #[tokio::test]
    async fn an_ambiguous_span_is_refused_with_its_count() {
        let host = FakeHost::answering(json!({"skill": {"id": "s"}, "body": "x x"}));
        let tool = manage_tool(host);
        let message = refused(
            run(
                &tool,
                json!({"action": "patch", "name": "s", "old_string": "x", "new_string": "y"}),
            )
            .await,
        );
        assert!(message.contains("occurs 2 times"));
        assert!(message.contains("exactly one span"));
    }

    #[tokio::test]
    async fn patching_an_unknown_skill_says_to_create_one() {
        let host = FakeHost::answering(json!({"skill": null, "body": null}));
        let tool = manage_tool(host);
        let message = refused(
            run(
                &tool,
                json!({"action": "patch", "name": "nope", "old_string": "a", "new_string": "b"}),
            )
            .await,
        );
        assert!(message.contains("No skill with id `nope`"));
        assert!(message.contains("`create`"));
    }

    #[tokio::test]
    async fn patch_without_a_new_string_is_refused_and_an_empty_one_deletes() {
        let host = FakeHost::answering(json!({"skill": {"id": "s"}, "body": "alpha beta"}));
        let tool = manage_tool(host.clone());
        let message = refused(
            run(
                &tool,
                json!({"action": "patch", "name": "s", "old_string": "alpha"}),
            )
            .await,
        );
        assert!(message.contains("`new_string` is required"));
        let answer = run(
            &tool,
            json!({"action": "patch", "name": "s", "old_string": "alpha ", "new_string": ""}),
        )
        .await
        .expect("deletes the span");
        assert_eq!(answer, "Patched skill `s`.");
    }

    #[tokio::test]
    async fn a_reference_write_carries_the_project_scope() {
        let host = FakeHost::answering(json!({"path": "references/pitfalls.md"}));
        let tool = SkillManageTool::new(host.clone(), Some("D:/repo".into()));
        let answer = run(
            &tool,
            json!({
                "action": "write_file",
                "name": "pi-release",
                "file_path": "references/pitfalls.md",
                "content": "# Pitfalls"
            }),
        )
        .await
        .expect("written");
        assert!(answer.contains("references/pitfalls.md"));
        let calls = host.calls();
        assert_eq!(calls[0].0, "skills.writeFile");
        assert_eq!(calls[0].1["level"], "project");
        assert_eq!(calls[0].1["projectPath"], "D:/repo");
        assert_eq!(calls[0].1["content"], "# Pitfalls");
    }

    #[tokio::test]
    async fn an_invalid_reference_path_is_passed_through_as_the_model_s_words() {
        let host = FakeHost::failing(
            "SKILL_INVALID: path must start with references/, templates/, scripts/ or assets/",
        );
        let tool = manage_tool(host);
        let message = refused(
            run(
                &tool,
                json!({"action": "write_file", "name": "s", "file_path": "../escape.md", "content": "x"}),
            )
            .await,
        );
        assert!(message.contains("must start with references/"));
    }

    #[tokio::test]
    async fn write_file_requires_a_path_and_content() {
        let host = FakeHost::answering(json!({}));
        let tool = manage_tool(host.clone());
        let message = refused(
            run(
                &tool,
                json!({"action": "write_file", "name": "s", "content": "x"}),
            )
            .await,
        );
        assert!(message.contains("`file_path` is required"));
        let message = refused(
            run(
                &tool,
                json!({"action": "write_file", "name": "s", "file_path": "references/a.md"}),
            )
            .await,
        );
        assert!(message.contains("`content` is required"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn delete_reports_an_unknown_skill_as_not_found() {
        let host = FakeHost::answering(json!({"ok": false}));
        let tool = manage_tool(host);
        let message = refused(run(&tool, json!({"action": "delete", "name": "nope"})).await);
        assert!(message.contains("No skill with id `nope`"));

        let host = FakeHost::answering(json!({"ok": true}));
        let tool = manage_tool(host.clone());
        let answer = run(&tool, json!({"action": "delete", "name": "gone"}))
            .await
            .expect("deleted");
        assert_eq!(answer, "Deleted skill `gone`.");
        assert_eq!(host.calls()[0].0, "skills.remove");
    }

    #[tokio::test]
    async fn absorb_moves_resources_and_reports_what_it_kept() {
        let host = FakeHost::answering(json!({
            "copied": ["references/a.md", "scripts/run.sh"],
            "skipped": ["references/shared.md"]
        }));
        let tool = manage_tool(host.clone());
        let answer = run(
            &tool,
            json!({"action": "absorb", "name": "leaf", "into": "umbrella"}),
        )
        .await
        .expect("merged");
        assert!(answer.contains("Merged `leaf` into `umbrella`."));
        assert!(answer.contains("Moved 2 file(s): references/a.md, scripts/run.sh."));
        assert!(answer.contains("Kept the umbrella's own copy of: references/shared.md."));
        assert_eq!(host.calls()[0].0, "skills.absorb");
    }

    #[tokio::test]
    async fn a_skill_cannot_absorb_itself() {
        let host = FakeHost::answering(json!({}));
        let tool = manage_tool(host.clone());
        let message = refused(
            run(
                &tool,
                json!({"action": "absorb", "name": "same", "into": "same"}),
            )
            .await,
        );
        assert!(message.contains("cannot absorb itself"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_action_lists_the_six() {
        let host = FakeHost::answering(json!({}));
        let tool = manage_tool(host);
        let message = refused(run(&tool, json!({"action": "rename", "name": "s"})).await);
        assert!(message.contains("create, patch, write_file, remove_file, delete, absorb"));
    }

    #[test]
    fn the_spec_declares_every_action_and_the_required_name() {
        let tool = SkillManageTool::new(FakeHost::answering(json!({})), None);
        let spec = tool.spec();
        assert_eq!(spec.name, SKILL_MANAGE_TOOL_NAME);
        let actions: Vec<&str> = spec.parameters["properties"]["action"]["enum"]
            .as_array()
            .expect("an enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            actions,
            vec![
                "create",
                "patch",
                "write_file",
                "remove_file",
                "delete",
                "absorb"
            ]
        );
        assert!(spec.description.contains("SKILL.md quality bar"));
    }
}
