//! System prompt composition.
//!
//! Hermes counterpart: `agent/prompt_builder.py` and `agent/system_prompt.py`.
//! The section order is the desktop's own contract
//! (`docs/spec/03-runtime/02-agent-runtime.md` §7) and the sources are the
//! Node runtime's `composeSystemPrompt`, `project-instructions.ts` and
//! `custom-system-prompt.ts` — ported rather than redesigned, so a session gets
//! the same instructions it gets today:
//!
//! ```text
//! [product persona]                     base, replaceable by SYSTEM.md
//! [APPEND_SYSTEM.md]
//! [tool instructions]                   only when the host supplies them
//! [project instruction chain]           AGENTS.md / CLAUDE.md up the tree
//! [mode instructions]                   agent / plan / goal
//! ```
//!
//! Files are read through [`PromptFs`] so discovery is testable without a disk,
//! and every read is bounded: an oversized instruction file is cut on a
//! character boundary and the cut is announced in the text, never silent.

pub mod instructions;
pub mod modes;

use std::sync::Arc;

pub use instructions::{
    load_custom_system_prompt, load_instruction_chain, CustomSystemPrompt, InstructionEntry,
    ProjectInstructions,
};
pub use modes::{compose_mode_system_prompt, mode_instructions, SessionMode};

use crate::tool::ToolSpec;

/// The product persona, verbatim from `mode-prompts.ts`.
pub const DEFAULT_RUNTIME_SYSTEM_PROMPT: &str =
    "You are Pi-Workspace, a coding agent. Answer in the user's language. Be concise, direct, and actionable.";

/// Filesystem the prompt builder reads through. Production uses [`StdFs`];
/// tests use a map, so discovery rules are covered without touching a disk.
pub trait PromptFs: Send + Sync {
    fn read_to_string(&self, path: &str) -> Option<String>;
    /// Canonical path, used to refuse instructions that resolve outside the
    /// workspace. `None` when the path does not exist.
    fn canonicalize(&self, path: &str) -> Option<String>;
}

/// Real filesystem.
pub struct StdFs;

impl PromptFs for StdFs {
    fn read_to_string(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn canonicalize(&self, path: &str) -> Option<String> {
        std::fs::canonicalize(path)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
    }
}

impl<T: PromptFs + ?Sized> PromptFs for Arc<T> {
    fn read_to_string(&self, path: &str) -> Option<String> {
        (**self).read_to_string(path)
    }

    fn canonicalize(&self, path: &str) -> Option<String> {
        (**self).canonicalize(path)
    }
}

/// Everything composition needs. Sections that are absent are omitted rather
/// than filled with invented text.
#[derive(Clone)]
pub struct PromptInputs<'a> {
    /// Directory the session works in; also the root of the instruction chain.
    pub workspace_root: Option<&'a str>,
    /// A file being worked on, so nested instructions closer to it win.
    pub workspace_path: Option<&'a str>,
    /// `~/.pi/agent` (or its equivalent) for the global instruction file and the
    /// global `SYSTEM.md` / `APPEND_SYSTEM.md`.
    pub global_agent_dir: Option<&'a str>,
    pub mode: SessionMode,
    /// Declarations sent to the provider. Kept for callers that also want the
    /// names rendered in prose.
    pub tools: &'a [ToolSpec],
    /// Host-supplied tool guidance. Omitted when the host sends none: the
    /// kernel does not invent operating rules for tools it does not own.
    pub tool_instructions: Option<&'a str>,
    /// Replaces [`DEFAULT_RUNTIME_SYSTEM_PROMPT`] when the host has its own.
    pub product_prompt: Option<&'a str>,
    /// Already-resolved custom prompt files; skipped when `None`.
    pub custom: Option<&'a CustomSystemPrompt>,
    /// Already-resolved instruction chain; skipped when `None`.
    pub project: Option<&'a ProjectInstructions>,
}

impl PromptInputs<'_> {
    /// Inputs for a plain agent-mode session in `workspace_root`.
    pub fn new(workspace_root: Option<&str>) -> PromptInputs<'_> {
        PromptInputs {
            workspace_root,
            workspace_path: None,
            global_agent_dir: None,
            mode: SessionMode::Agent,
            tools: &[],
            tool_instructions: None,
            product_prompt: None,
            custom: None,
            project: None,
        }
    }
}

/// One composed section, in the order it appears in the prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptSection {
    /// Stable name, used by diagnostics and by cache-key comparisons.
    pub name: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComposedPrompt {
    pub system: String,
    pub sections: Vec<PromptSection>,
}

impl ComposedPrompt {
    pub fn section(&self, name: &str) -> Option<&str> {
        self.sections
            .iter()
            .find(|section| section.name == name)
            .map(|section| section.text.as_str())
    }
}

/// Compose the system prompt for one request.
///
/// A `SYSTEM.md` replaces the persona block only. The operational blocks —
/// tool guidance, project instructions, mode instructions — are separate
/// sections and always survive, which is what keeps a custom persona from
/// removing the rules the desktop depends on.
pub fn compose_system_prompt(inputs: &PromptInputs<'_>) -> ComposedPrompt {
    let base = inputs
        .custom
        .and_then(|custom| custom.replace.as_deref())
        .or(inputs.product_prompt)
        .unwrap_or(DEFAULT_RUNTIME_SYSTEM_PROMPT)
        .trim()
        .to_string();

    let mut context_parts: Vec<String> = Vec::new();
    if let Some(append) = inputs
        .custom
        .and_then(|custom| custom.append.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        context_parts.push(append.to_string());
    }
    if let Some(tools) = inputs
        .tool_instructions
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        context_parts.push(tools.to_string());
    }
    if let Some(project) = inputs.project {
        if let Some(rendered) = instructions::render_project_instructions(project) {
            context_parts.push(rendered);
        }
    }

    let mode_text = compose_mode_system_prompt(
        inputs.mode.clone(),
        "",
        &mode_instructions(inputs.mode.clone()),
    );

    let mut sections = Vec::new();
    if !base.is_empty() {
        sections.push(PromptSection {
            name: "runtime",
            text: base,
        });
    }
    if !context_parts.is_empty() {
        sections.push(PromptSection {
            name: "context",
            text: context_parts.join("\n\n"),
        });
    }
    if !mode_text.trim().is_empty() {
        sections.push(PromptSection {
            name: "mode",
            text: mode_text.trim().to_string(),
        });
    }

    let system = sections
        .iter()
        .map(|section| section.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");

    ComposedPrompt { system, sections }
}

/// Resolve the files that feed composition, then compose. One call for the
/// sidecar: discovery is bounded and never fails — a missing or unreadable file
/// is an expected first-run state, not an error.
pub fn build_system_prompt(fs: &Arc<dyn PromptFs>, inputs: &PromptInputs<'_>) -> ComposedPrompt {
    let custom = load_custom_system_prompt(fs, inputs.workspace_root, inputs.global_agent_dir);
    let project = load_instruction_chain(
        fs,
        inputs.workspace_root,
        inputs.workspace_path,
        inputs.global_agent_dir,
    );
    let mut resolved = inputs.clone();
    resolved.custom = custom.as_ref();
    resolved.project = project.as_ref();
    compose_system_prompt(&resolved)
}

/// Names of the tools in the prompt, for diagnostics and prompt-cache keys.
pub fn declared_tool_names(tools: &[ToolSpec]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name.as_str()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(name: &str) -> ToolSpec {
        ToolSpec::new(name, "does a thing", json!({"type": "object"}))
    }

    #[test]
    fn default_persona_is_used_when_nothing_overrides_it() {
        let inputs = PromptInputs::new(None);
        let composed = compose_system_prompt(&inputs);
        assert!(composed.system.starts_with(DEFAULT_RUNTIME_SYSTEM_PROMPT));
        assert_eq!(
            composed.section("runtime"),
            Some(DEFAULT_RUNTIME_SYSTEM_PROMPT)
        );
    }

    #[test]
    fn a_system_md_replaces_the_persona_but_keeps_operational_sections() {
        let custom = CustomSystemPrompt {
            replace: Some("You are Terse Bot.".into()),
            append: Some("Always cite files.".into()),
        };
        let project = ProjectInstructions {
            entries: vec![InstructionEntry {
                source: "AGENTS.md".into(),
                content: "Run the tests.".into(),
            }],
        };
        let mut inputs = PromptInputs::new(Some("/work"));
        inputs.custom = Some(&custom);
        inputs.project = Some(&project);
        inputs.mode = SessionMode::Agent;

        let composed = compose_system_prompt(&inputs);
        assert_eq!(composed.section("runtime"), Some("You are Terse Bot."));
        let context = composed.section("context").expect("a context section");
        assert!(context.contains("Always cite files."));
        assert!(context.contains("## AGENTS.md"));
        assert!(context.contains("Run the tests."));
        // The mode instructions survive a custom persona.
        assert!(composed.system.contains("Agent mode"));
    }

    #[test]
    fn section_order_is_persona_then_context_then_mode() {
        let custom = CustomSystemPrompt {
            replace: None,
            append: Some("APPENDED".into()),
        };
        let mut inputs = PromptInputs::new(Some("/work"));
        inputs.custom = Some(&custom);
        inputs.tool_instructions = Some("TOOL RULES");
        inputs.mode = SessionMode::Plan;

        let composed = compose_system_prompt(&inputs);
        let names: Vec<&str> = composed
            .sections
            .iter()
            .map(|section| section.name)
            .collect();
        assert_eq!(names, vec!["runtime", "context", "mode"]);
        let context = composed.section("context").unwrap();
        let append_at = context.find("APPENDED").unwrap();
        let tools_at = context.find("TOOL RULES").unwrap();
        assert!(append_at < tools_at, "append precedes tool guidance");
        assert!(composed.system.contains("Plan mode"));
    }

    #[test]
    fn empty_optional_sections_are_omitted_not_blank() {
        let mut inputs = PromptInputs::new(None);
        inputs.tool_instructions = Some("   \n  ");
        let composed = compose_system_prompt(&inputs);
        assert!(composed.section("context").is_none());
        assert_eq!(composed.sections.len(), 2, "runtime + mode only");
        assert!(!composed.system.contains("\n\n\n"));
    }

    #[test]
    fn tools_are_declared_but_not_narrated() {
        // The provider receives declarations; the prompt only carries host
        // guidance. This guards against the kernel inventing tool rules.
        let tools = vec![tool("Bash"), tool("Read")];
        let mut inputs = PromptInputs::new(None);
        inputs.tools = &tools;
        let composed = compose_system_prompt(&inputs);
        assert!(!composed.system.contains("Bash"));
        assert_eq!(declared_tool_names(&tools), vec!["Bash", "Read"]);
    }

    /// Filesystem double for the end-to-end composition test.
    struct Files(std::collections::HashMap<String, String>);

    impl PromptFs for Files {
        fn read_to_string(&self, path: &str) -> Option<String> {
            self.0.get(path).cloned()
        }

        fn canonicalize(&self, path: &str) -> Option<String> {
            self.0.get(path).map(|_| path.to_string())
        }
    }

    fn files(entries: &[(&str, &str)]) -> Arc<dyn PromptFs> {
        Arc::new(Files(
            entries
                .iter()
                .map(|(path, content)| ((*path).to_string(), (*content).to_string()))
                .collect(),
        ))
    }

    #[test]
    fn build_reads_the_files_and_composes_the_whole_prompt() {
        let fs = files(&[
            ("/w/.pi/SYSTEM.md", "You are Terse Bot."),
            ("/w/.pi/APPEND_SYSTEM.md", "APPENDED RULES"),
            ("/data/agent/AGENTS.md", "global rules"),
            ("/w/AGENTS.md", "root rules"),
            ("/w/pkg/AGENTS.md", "package rules"),
        ]);
        let mut inputs = PromptInputs::new(Some("/w"));
        inputs.workspace_path = Some("/w/pkg/lib.rs");
        inputs.global_agent_dir = Some("/data/agent");
        inputs.mode = SessionMode::Agent;

        let composed = build_system_prompt(&fs, &inputs);
        assert_eq!(composed.section("runtime"), Some("You are Terse Bot."));

        let context = composed.section("context").expect("context section");
        let appended = context.find("APPENDED RULES").unwrap();
        let global = context.find("global rules").unwrap();
        let root = context.find("root rules").unwrap();
        let package = context.find("package rules").unwrap();
        assert!(appended < global, "append precedes project chain");
        assert!(global < root && root < package, "chain runs root to nested");
        assert!(composed.system.contains("Agent mode"));
    }

    #[test]
    fn build_without_any_files_still_produces_persona_and_mode() {
        let fs = files(&[]);
        let inputs = PromptInputs::new(Some("/w"));
        let composed = build_system_prompt(&fs, &inputs);
        assert!(composed.system.starts_with(DEFAULT_RUNTIME_SYSTEM_PROMPT));
        assert!(composed.section("context").is_none());
        assert!(composed.system.contains("Agent mode"));
    }
}
