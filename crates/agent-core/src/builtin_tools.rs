//! The built-in tools the runtime declares to the model.
//!
//! The Node runtime ships these declarations itself and dispatches every call to
//! the host, which executes them; Electron main sends no declaration for them at
//! all. A kernel that waited for the host to declare `Bash` would offer the model
//! nothing to call — so this module owns the declarations, and the host stays the
//! only place a tool actually runs.
//!
//! These bytes are re-sent with **every** request, before the model has read a
//! single word of the conversation, so the set is held to the smallest form that
//! still lets the model choose correctly:
//!
//! - A description is a verb phrase — what the tool does — and nothing else. *When*
//!   to use a tool is the model's judgement; restating it in prose is paid for on
//!   every turn and read once.
//! - A parameter's name carries its meaning (`path`, `pattern`, `old_string`), so
//!   only the two whose meaning is genuinely ambiguous keep a word of explanation
//!   (`offset`, `include`).
//! - Only the tools the current mode may use are declared. Plan and Goal negotiate
//!   a contract before touching anything, so they get the read-only half.
//!
//! The ceiling is enforced by a test: a declaration set that grows back into a
//! manual is a regression, not a preference.
//!
//! The names and argument names are the host's, not invented here: `Read` takes
//! `path`, `Edit` takes `old_string`/`new_string`, `Grep` takes `pattern`. A
//! declaration the host cannot execute is worse than no declaration.

use serde_json::{json, Value};

use crate::prompt::SessionMode;

/// How the host should run a shell command for this session.
///
/// `Bash` is the one tool whose execution depends on session configuration: the
/// host refuses the call unless the shell identity it is told matches the one it
/// resolved, because running a command in a different shell changes what it means.
///
/// The identity is a *label*, never a permission: it says which shell the command
/// was written for, and the host applies its own exec and approval policy to the
/// call either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellIdentity {
    pub id: String,
    /// `None` when the caller named a shell without saying which dialect it
    /// speaks and it is not one this kernel knows. Sending a guessed dialect
    /// would be worse than sending none: the host compares it against the shell
    /// it actually resolved, and a wrong answer fails the call outright.
    pub dialect: Option<String>,
}

impl ShellIdentity {
    pub fn new(id: impl Into<String>, dialect: Option<String>) -> Self {
        Self {
            id: id.into(),
            dialect,
        }
    }

    /// The dialect a well-known shell id speaks.
    ///
    /// Mirrors `tools::shell::dialect_for_id` in host-core (which this crate
    /// cannot depend on): the host's catalog and the kernel's label have to agree
    /// on the same four ids or every `Bash` call is refused as a changed shell.
    pub fn dialect_for_id(id: &str) -> Option<&'static str> {
        match id {
            "powershell" | "pwsh" => Some("powershell"),
            "cmd" | "cmd.exe" => Some("cmd"),
            "git-bash" | "bash" | "sh" | "posix" => Some("posix"),
            _ => None,
        }
    }

    /// Read the shell a prompt or a configure names.
    ///
    /// Two spellings reach the kernel: the catalog row main resolved
    /// (`commandShell: {id, dialect, label, …}`) and, from a launcher or a test,
    /// the bare id (`commandShell: "git-bash"`). Reading only the first silently
    /// drops the identity for the second, and the host then refuses every `Bash`
    /// call with "expectedCommandShellId is required".
    pub fn from_params(params: &Value) -> Option<Self> {
        Self::from_value(params.get("commandShell")?)
    }

    /// The same reading, for a value that is already the shell rather than a
    /// parameter bag holding one.
    pub fn from_value(value: &Value) -> Option<Self> {
        match value {
            Value::String(id) => {
                let id = id.trim();
                if id.is_empty() {
                    return None;
                }
                Some(Self::new(id, Self::dialect_for_id(id).map(str::to_string)))
            }
            Value::Object(_) => {
                let id = value.get("id")?.as_str()?.trim();
                if id.is_empty() {
                    return None;
                }
                let dialect = value
                    .get("dialect")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|dialect| !dialect.is_empty())
                    .map(str::to_string)
                    .or_else(|| Self::dialect_for_id(id).map(str::to_string));
                Some(Self::new(id, dialect))
            }
            _ => None,
        }
    }

    /// The identity of a shell this process runs itself, from
    /// `sidecar.configure`'s `localShell`.
    ///
    /// The program path is the best id available there — there is no catalog id
    /// in that configuration — and the dialect comes from the executor that was
    /// actually built, so the label matches what the command will run in.
    pub fn for_local_shell(program: &str, dialect: &str) -> Self {
        Self::new(program, Some(dialect.to_string()))
    }
}

/// Byte ceiling for the whole built-in declaration set.
///
/// Every request carries these, so this is a budget, not a preference: it fails
/// the build's tests when a description grows back into a paragraph. Raised twice
/// as tools landed — 1 250 → 1 500 for `VisionAnalyze`, → 1 750 for `ExecuteCode`
/// (the set measures 1 676). Adding a tool is the one change allowed to raise it;
/// buying room by deleting another tool's parameter hints is not, because those
/// hints are what keep a model from calling the tool wrongly.
pub const DECLARATION_BUDGET_BYTES: usize = 2_300;

fn read() -> Value {
    json!({
        "name": "Read",
        "description": "Read a file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "0-based"},
                "limit": {"type": "integer"}
            },
            "required": ["path"]
        }
    })
}

fn glob() -> Value {
    json!({
        "name": "Glob",
        "description": "List files matching a glob.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "limit": {"type": "integer"}
            },
            "required": ["pattern"]
        }
    })
}

fn grep() -> Value {
    json!({
        "name": "Grep",
        "description": "Search file contents by regex.",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "include": {"type": "string", "description": "e.g. *.ts"},
                "caseInsensitive": {"type": "boolean"}
            },
            "required": ["pattern"]
        }
    })
}

fn vision() -> Value {
    json!({
        "name": "VisionAnalyze",
        "description": "Ask a vision model about an image",
        "parameters": {
            "type": "object",
            // `question` is not required: the host falls back to a description
            // request, so the declaration must not claim otherwise.
            "properties": {
                "image_url": {"type": "string", "description": "path or URL"},
                "question": {"type": "string"}
            },
            "required": ["image_url"]
        }
    })
}

/// A snippet runner rather than a shell, so it is declared as its own tool: the
/// caller writes source and never has to quote it.
///
/// The description carries the one boundary a model would otherwise discover by
/// failing: there is no tool bridge in v1, so a program that needs another tool
/// becomes two calls.
fn execute_code() -> Value {
    json!({
        "name": "ExecuteCode",
        "description": "Run python/node; no tools.",
        // `language` is declared even though it costs bytes: without it a model
        // writes JavaScript, the host runs it as python, and the turn fails for a
        // reason the schema could have prevented. `timeoutMs` is not declared — the
        // default is right for almost every snippet and the error names it.
        "parameters": {
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "language": {"type": "string", "enum": ["python", "node"]}
            },
            "required": ["code"]
        }
    })
}

/// A browser is the only way to see a page after it ran: a fetcher gets the shell a
/// single-page app starts from. The description says it is slow because it is — a
/// model that reaches for this when a plain fetch would do pays half a minute for
/// text that was already there.
fn browser_exec() -> Value {
    json!({
        "name": "BrowserExec",
        "description": "Render JS page in browser; slow, ~30s.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) or file://"},
                "mode": {"type": "string", "enum": ["dom", "text", "screenshot"]}
            },
            "required": ["url"]
        }
    })
}

/// Images are written into the workspace, so this is an Agent-mode tool like
/// `Write`: a contract mode proposes before it touches anything.
///
/// `model` is not declared. The host's default is the image model the configured
/// gateway serves, and a model id in the schema would be billed on every turn of
/// every session for the rare caller that wants another one.
fn generate_images() -> Value {
    json!({
        "name": "GenerateImages",
        "description": "Draw images from a prompt.",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "n": {"type": "integer", "description": "1-4"}
            },
            "required": ["prompt"]
        }
    })
}

fn write() -> Value {
    json!({
        "name": "Write",
        "description": "Write a file.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"}
            },
            "required": ["path", "content"]
        }
    })
}

fn edit() -> Value {
    json!({
        "name": "Edit",
        "description": "Replace a span that occurs once.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"}
            },
            "required": ["path", "old_string", "new_string"]
        }
    })
}

fn bash(shell: Option<&ShellIdentity>) -> Value {
    // The dialect decides what a command means; naming it prevents a command
    // written for one shell from being run by another.
    let description = match shell {
        Some(shell) => format!("Run a shell command ({}).", shell.id),
        None => "Run a shell command.".to_string(),
    };
    json!({
        "name": "Bash",
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string"}
            },
            "required": ["command"]
        }
    })
}

/// The built-in declarations for a mode.
///
/// Writes are withheld from Plan and Goal: those modes propose a contract before
/// anything is touched, and a tool the mode cannot use is pure cost.
pub fn declarations(mode: SessionMode, shell: Option<&ShellIdentity>) -> Vec<Value> {
    // Vision reads a file and asks the provider the turn already talks to, so it is
    // offered in every mode: refusing it in a read-only session would hide the one
    // tool that answers "what is in this picture?" without touching anything.
    let mut tools = vec![read(), glob(), grep(), vision(), bash(shell)];
    if mode == SessionMode::Agent {
        tools.insert(3, write());
        tools.insert(4, edit());
        // Arbitrary code execution: an Agent-mode tool only. Plan and Goal
        // negotiate before touching anything, and this tool runs whatever a
        // model writes.
        tools.insert(5, execute_code());
        // Both land files in the workspace (objects drawn, or a rendered page), so
        // they belong where Write does, not in a mode that proposes first.
        tools.insert(6, generate_images());
        tools.insert(7, browser_exec());
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell() -> ShellIdentity {
        ShellIdentity::new("git-bash", Some("posix".into()))
    }

    #[test]
    fn agent_mode_offers_the_tools_the_host_can_run() {
        let tools = declarations(SessionMode::Agent, Some(&shell()));
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            [
                "Read",
                "Glob",
                "Grep",
                "Write",
                "Edit",
                "ExecuteCode",
                "GenerateImages",
                "BrowserExec",
                "VisionAnalyze",
                "Bash"
            ]
        );
        for tool in &tools {
            assert!(
                tool["parameters"]["required"].is_array(),
                "{} needs required args",
                tool["name"]
            );
        }
    }

    #[test]
    fn a_contract_mode_gets_no_writes() {
        // Plan and Goal propose before they act; a write tool there is a tool the
        // model must be trusted not to use, and it costs tokens on every turn.
        for mode in [SessionMode::Plan, SessionMode::Goal] {
            let label = format!("{mode:?}");
            let names: Vec<String> = declarations(mode, Some(&shell()))
                .iter()
                .filter_map(|tool| tool["name"].as_str().map(str::to_string))
                .collect();
            assert!(
                !names.iter().any(|name| matches!(
                    name.as_str(),
                    "Write" | "Edit" | "ExecuteCode" | "GenerateImages" | "BrowserExec"
                )),
                "{label}: {names:?}"
            );
            assert!(names.iter().any(|name| name == "Read"));
        }
    }

    #[test]
    fn the_declaration_set_stays_within_its_budget() {
        // Re-sent with every request: the budget is the point of the descriptions
        // being one sentence each.
        let size = serde_json::to_string(&declarations(SessionMode::Agent, Some(&shell())))
            .expect("serializes")
            .len();
        // Printed so a growing set reports its real size, not just a red test.
        println!("declarations: {size} bytes of {DECLARATION_BUDGET_BYTES}");
        assert!(
            size <= DECLARATION_BUDGET_BYTES,
            "declarations grew to {size} bytes (budget {DECLARATION_BUDGET_BYTES})"
        );
    }

    #[test]
    fn no_description_is_longer_than_a_verb_phrase() {
        // The failure mode this guards is a description that becomes documentation:
        // every extra sentence is billed on every turn of every session.
        for tool in declarations(SessionMode::Agent, Some(&shell())) {
            let description = tool["description"].as_str().unwrap_or_default();
            assert!(
                description.chars().count() <= 40,
                "{}: {description:?}",
                tool["name"]
            );
        }
    }

    #[test]
    fn bash_names_the_shell_it_will_run_in() {
        let tools = declarations(SessionMode::Agent, Some(&shell()));
        let bash = tools
            .iter()
            .find(|tool| tool["name"] == "Bash")
            .expect("a Bash declaration");
        assert!(bash["description"].as_str().unwrap().contains("git-bash"));
    }

    #[test]
    fn the_shell_identity_comes_from_the_prompt() {
        let shell = ShellIdentity::from_params(&json!({
            "commandShell": {"id": "cmd", "dialect": "cmd", "label": "cmd", "available": true, "isDefault": false}
        }))
        .expect("a shell");
        assert_eq!(shell.id, "cmd");
        assert_eq!(shell.dialect.as_deref(), Some("cmd"));
        assert!(ShellIdentity::from_params(&json!({})).is_none());
    }

    /// A launcher or a harness may name the shell by id alone. The identity still
    /// has to reach the host: dropping it makes every `Bash` call fail with
    /// "expectedCommandShellId is required".
    #[test]
    fn a_bare_shell_id_is_read_and_its_dialect_derived() {
        let shell = ShellIdentity::from_params(&json!({"commandShell": "git-bash"}))
            .expect("a bare id is a shell");
        assert_eq!(shell.id, "git-bash");
        assert_eq!(shell.dialect.as_deref(), Some("posix"));

        assert_eq!(
            ShellIdentity::from_value(&json!("pwsh")).unwrap().dialect.as_deref(),
            Some("powershell")
        );
        assert_eq!(
            ShellIdentity::from_value(&json!("cmd")).unwrap().dialect.as_deref(),
            Some("cmd")
        );
    }

    /// An id this kernel cannot classify keeps the identity and sends no dialect
    /// rather than guessing one: the host compares the dialect against the shell
    /// it resolved, so a guess fails the call just as surely as a wrong id.
    #[test]
    fn an_unknown_shell_id_keeps_the_id_and_no_dialect() {
        let shell = ShellIdentity::from_value(&json!("my-custom-sh")).expect("an id");
        assert_eq!(shell.id, "my-custom-sh");
        assert!(shell.dialect.is_none());

        let from_row = ShellIdentity::from_value(&json!({"id": "my-custom-sh"}))
            .expect("an unlabelled row");
        assert_eq!(from_row.id, "my-custom-sh");
        assert!(from_row.dialect.is_none());

        // A row that states its dialect is believed, even when the id is unknown.
        let stated = ShellIdentity::from_value(&json!({"id": "weird", "dialect": "cmd"}))
            .expect("a labelled row");
        assert_eq!(stated.dialect.as_deref(), Some("cmd"));
    }

    #[test]
    fn a_shell_without_an_id_is_not_an_identity() {
        for value in [
            json!({"commandShell": ""}),
            json!({"commandShell": "   "}),
            json!({"commandShell": {"dialect": "posix"}}),
            json!({"commandShell": {"id": ""}}),
            json!({"commandShell": null}),
            json!({"commandShell": 7}),
        ] {
            assert!(
                ShellIdentity::from_params(&value).is_none(),
                "{value} is not a shell"
            );
        }
    }
}
