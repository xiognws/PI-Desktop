//! Instruction files: the project chain and the custom persona files.
//!
//! Ported from `packages/agent-runtime/src/project-instructions.ts` and
//! `custom-system-prompt.ts`. The rules that matter and are covered by tests:
//!
//! * one file per directory, `AGENTS.override.md` before `AGENTS.md` before
//!   `CLAUDE.md` before `.claude/CLAUDE.md`;
//! * the chain runs from the workspace root down to the directory being worked
//!   in, so a nested file has the last word;
//! * instructions are never read from outside the workspace;
//! * the global file and the project chain have independent byte budgets, so an
//!   oversized global file cannot starve the project's own rules;
//! * a cut is announced in the text, never silent;
//! * `SYSTEM.md` replaces the persona, `APPEND_SYSTEM.md` is appended, project
//!   before global, and a whitespace-only file counts as absent.

use super::{PromptFs, StdFs};

pub const INSTRUCTION_FILE_NAMES: [&str; 4] = [
    "AGENTS.override.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/CLAUDE.md",
];

// 20KB per file and 40KB for the whole block: this block is re-sent with every
// request, and a measured session spent ~20k characters of a 32.8k-character system
// prompt on it. 20KB still holds a long rule set; anything beyond is cut with a
// notice, keeping both ends of the file.
pub const MAX_GLOBAL_INSTRUCTION_BYTES: usize = 20 * 1024;
pub const MAX_PROJECT_INSTRUCTION_BYTES: usize = 20 * 1024;
pub const MAX_PROMPT_BYTES: usize = 40 * 1024;

/// Share of an instruction budget kept from the head; the tail keeps the rest.
///
/// A project's commit, gate and reporting rules live at the end of its file, so a
/// head-only cut drops exactly the part that decides how work lands.
pub const INSTRUCTION_HEAD_SHARE: f64 = 0.7;
pub const INSTRUCTION_TAIL_SHARE: f64 = 0.2;
pub const GLOBAL_INSTRUCTION_FILE: &str = "AGENTS.md";
pub const GLOBAL_INSTRUCTION_SOURCE: &str = "~/.pi/agent/AGENTS.md";

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct InstructionEntry {
    /// Stable, workspace-relative label shown to the model.
    pub source: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct ProjectInstructions {
    pub entries: Vec<InstructionEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(default)]
pub struct CustomSystemPrompt {
    /// `SYSTEM.md`: replaces the persona block.
    pub replace: Option<String>,
    /// `APPEND_SYSTEM.md`: appended after the persona, before other context.
    pub append: Option<String>,
}

/// `(kept, kept_bytes, truncated)` — cut on a character boundary so a multi-byte
/// character is never split.
pub fn limit_utf8_bytes(content: &str, max_bytes: usize) -> (String, usize, bool) {
    if content.len() <= max_bytes {
        return (content.to_string(), content.len(), false);
    }
    let mut bytes = 0usize;
    let mut end = 0usize;
    for (index, character) in content.char_indices() {
        let width = character.len_utf8();
        if bytes + width > max_bytes {
            break;
        }
        bytes += width;
        end = index + width;
    }
    (content[..end].to_string(), bytes, true)
}

/// Keep the head and the tail of `content` inside a shared byte budget.
///
/// The cut lands in the middle and is announced, so the model knows the file was
/// longer and that both of its ends are present. Head-only truncation dropped the
/// bottom of every long rule set — which is where the commit and gate rules sit.
fn limit_utf8_bytes_head_and_tail(content: &str, max_bytes: usize) -> (String, usize, bool) {
    if content.len() <= max_bytes {
        return (content.to_string(), content.len(), false);
    }
    let head_budget = (max_bytes as f64 * INSTRUCTION_HEAD_SHARE) as usize;
    let tail_budget = (max_bytes as f64 * INSTRUCTION_TAIL_SHARE) as usize;
    let (head, head_bytes, _) = limit_utf8_bytes(content, head_budget);
    let mut tail_bytes = 0usize;
    let mut start = content.len();
    for (index, character) in content.char_indices().rev() {
        let width = character.len_utf8();
        if tail_bytes + width > tail_budget {
            break;
        }
        tail_bytes += width;
        start = index;
    }
    let tail = &content[start..];
    if head.len() + tail.len() >= content.len() {
        // Never repeat text: for a file just over the budget, one cut is enough.
        let (kept, bytes, _) = limit_utf8_bytes(content, max_bytes);
        return (kept, bytes, true);
    }
    let joined = format!("{head}\n\n\u{2026}\n\n{tail}");
    let kept_bytes = joined.len();
    // `head_bytes + tail_bytes` would undercount by the marker, and callers use the
    // returned byte count as "what is actually in context".
    let _ = (head_bytes, tail_bytes);
    (joined, kept_bytes, true)
}

fn limit_instruction(
    source: &str,
    content: &str,
    max_bytes: usize,
) -> (InstructionEntry, usize, bool) {
    let total = content.len();
    let (kept, bytes, truncated) = limit_utf8_bytes_head_and_tail(content, max_bytes);
    if !truncated {
        return (
            InstructionEntry {
                source: source.to_string(),
                content: content.to_string(),
            },
            bytes,
            false,
        );
    }
    let notice = format!(
        "[Pi-Workspace truncated {source}: kept {bytes} of {total} bytes (head and tail); the middle of this file is not in context.]"
    );
    let kept = kept.trim_end();
    let content = if kept.is_empty() {
        notice
    } else {
        format!("{kept}\n\n{notice}")
    };
    (
        InstructionEntry {
            source: source.to_string(),
            content,
        },
        bytes,
        true,
    )
}

fn to_slashes(path: &str) -> String {
    path.replace('\\', "/")
}

fn trim_trailing_slash(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}

fn join(base: &str, name: &str) -> String {
    if base.is_empty() {
        return name.to_string();
    }
    format!(
        "{}/{}",
        trim_trailing_slash(base),
        name.trim_start_matches('/')
    )
}

fn dirname(path: &str) -> Option<&str> {
    let trimmed = trim_trailing_slash(path);
    let index = trimmed.rfind('/')?;
    if index == 0 {
        return Some("/");
    }
    Some(&trimmed[..index])
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/') || path.get(1..2) == Some(":")
}

fn resolve(base: &str, path: &str) -> String {
    if is_absolute(path) {
        to_slashes(path)
    } else {
        join(&to_slashes(base), path)
    }
}

/// Whether `candidate` is `root` or inside it. Separator-insensitive, so a
/// Windows path and its slash form compare equal.
pub fn is_within_root(root: &str, candidate: &str) -> bool {
    let root = trim_trailing_slash(&to_slashes(root)).to_string();
    let candidate = trim_trailing_slash(&to_slashes(candidate)).to_string();
    if candidate == root {
        return true;
    }
    candidate
        .strip_prefix(&root)
        .map(|rest| rest.starts_with('/'))
        .unwrap_or(false)
}

fn read_instruction(
    fs: &dyn PromptFs,
    workspace_root: &str,
    canonical_root: &str,
    directory: &str,
    remaining: usize,
    windows: bool,
) -> Option<(InstructionEntry, usize, bool)> {
    for name in INSTRUCTION_FILE_NAMES {
        let file = join(directory, name);
        // The canonical check is what keeps a symlinked instruction file from
        // pulling content in from outside the project.
        let canonical = match fs.canonicalize(&file) {
            Some(path) => to_slashes(&path),
            None => continue,
        };
        if !is_within_root(canonical_root, &canonical) {
            continue;
        }
        let Some(content) = fs.read_to_string(&file) else {
            continue;
        };
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        let source = if windows {
            relative_source(workspace_root, &file).replace('/', "\\")
        } else {
            relative_source(workspace_root, &file)
        };
        let (entry, bytes, truncated) = limit_instruction(&source, content, remaining);
        return Some((entry, bytes, truncated));
    }
    None
}

fn relative_source(workspace_root: &str, file: &str) -> String {
    let root = trim_trailing_slash(&to_slashes(workspace_root)).to_string();
    let file = to_slashes(file);
    file.strip_prefix(&format!("{root}/"))
        .unwrap_or(&file)
        .to_string()
}

/// Resolve the project instruction chain for a workspace.
pub fn load_project_instructions(
    fs: &dyn PromptFs,
    workspace_root: Option<&str>,
    workspace_path: Option<&str>,
    max_bytes: usize,
) -> Option<ProjectInstructions> {
    let workspace_root = workspace_root?.trim();
    if workspace_root.is_empty() {
        return None;
    }
    let root = trim_trailing_slash(&to_slashes(workspace_root)).to_string();
    let canonical_root = fs
        .canonicalize(&root)
        .map(|path| to_slashes(&path))
        .unwrap_or_else(|| root.clone());

    let target = match workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => resolve(&root, path),
        None => root.clone(),
    };
    // A path outside the root keeps the root's own chain instead of silently
    // dropping every project instruction.
    let target_directory = if is_within_root(&root, &target) && target != root {
        dirname(&target)
            .map(str::to_string)
            .unwrap_or_else(|| root.clone())
    } else {
        root.clone()
    };

    let mut directories: Vec<String> = Vec::new();
    let mut current = target_directory;
    loop {
        directories.insert(0, current.clone());
        if current == root {
            break;
        }
        match dirname(&current) {
            Some(parent) if is_within_root(&root, parent) => current = parent.to_string(),
            _ => {
                // The target is outside the root's chain: fall back to the root.
                directories = vec![root.clone()];
                break;
            }
        }
    }

    let windows = root.get(1..2) == Some(":");
    let mut entries: Vec<InstructionEntry> = Vec::new();
    let mut remaining = max_bytes;
    for directory in directories {
        if remaining == 0 {
            break;
        }
        if let Some((entry, bytes, truncated)) =
            read_instruction(fs, &root, &canonical_root, &directory, remaining, windows)
        {
            entries.push(entry);
            // A truncated file has used the budget: closer files are not loaded.
            if truncated {
                break;
            }
            remaining = remaining.saturating_sub(bytes);
        }
    }

    if entries.is_empty() {
        None
    } else {
        Some(ProjectInstructions { entries })
    }
}

/// Global defaults precede project instructions; the two budgets are separate.
pub fn load_instruction_chain(
    fs: &dyn PromptFs,
    workspace_root: Option<&str>,
    workspace_path: Option<&str>,
    global_agent_dir: Option<&str>,
) -> Option<ProjectInstructions> {
    let mut entries: Vec<InstructionEntry> = Vec::new();
    if let Some(dir) = global_agent_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        let file = join(dir, GLOBAL_INSTRUCTION_FILE);
        if let Some(content) = fs.read_to_string(&file) {
            let content = content.trim();
            if !content.is_empty() {
                let (entry, _, _) = limit_instruction(
                    GLOBAL_INSTRUCTION_SOURCE,
                    content,
                    MAX_GLOBAL_INSTRUCTION_BYTES,
                );
                entries.push(entry);
            }
        }
    }
    let project = load_project_instructions(
        fs,
        workspace_root,
        workspace_path,
        MAX_PROJECT_INSTRUCTION_BYTES,
    );
    if let Some(project) = project {
        entries.extend(project.entries);
    }
    if entries.is_empty() {
        None
    } else {
        Some(ProjectInstructions { entries })
    }
}

fn read_first(fs: &dyn PromptFs, dirs: &[Option<String>], file_name: &str) -> Option<String> {
    for dir in dirs.iter().flatten() {
        let file = join(dir, file_name);
        if let Some(content) = fs.read_to_string(&file) {
            let content = content.trim();
            if !content.is_empty() {
                let (kept, _, _) = limit_utf8_bytes(content, MAX_PROMPT_BYTES);
                return Some(kept);
            }
        }
    }
    None
}

/// Project `.pi/` wins over the global agent directory, per file kind.
pub fn load_custom_system_prompt(
    fs: &dyn PromptFs,
    workspace_root: Option<&str>,
    global_agent_dir: Option<&str>,
) -> Option<CustomSystemPrompt> {
    let project = workspace_root
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(|root| join(&to_slashes(root), ".pi"));
    let global = global_agent_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(str::to_string);
    let dirs = [project, global];

    let replace = read_first(fs, &dirs, "SYSTEM.md");
    let append = read_first(fs, &dirs, "APPEND_SYSTEM.md");
    if replace.is_none() && append.is_none() {
        None
    } else {
        Some(CustomSystemPrompt { replace, append })
    }
}

/// Render the chain as one prompt section.
pub fn render_project_instructions(instructions: &ProjectInstructions) -> Option<String> {
    if instructions.entries.is_empty() {
        return None;
    }
    let mut out = String::from(
        "# Project instructions\n\nThe following instructions are loaded by Pi-Workspace. Follow them when they apply to the task; entries later in this section are closer to the file being worked on and take precedence.\n\n",
    );
    for entry in &instructions.entries {
        out.push_str(&format!("## {}\n\n{}\n\n", entry.source, entry.content));
    }
    Some(out.trim_end().to_string())
}

/// Convenience for callers that do not need a custom `PromptFs`.
pub fn load_all(
    workspace_root: Option<&str>,
    global_agent_dir: Option<&str>,
) -> (Option<CustomSystemPrompt>, Option<ProjectInstructions>) {
    let fs = StdFs;
    (
        load_custom_system_prompt(&fs, workspace_root, global_agent_dir),
        load_instruction_chain(&fs, workspace_root, None, global_agent_dir),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Filesystem double: exact path lookup, with an optional canonical map so
    /// symlink-style escapes can be simulated.
    #[derive(Default)]
    struct MapFs {
        files: Mutex<HashMap<String, String>>,
        canonical: Mutex<HashMap<String, String>>,
    }

    impl MapFs {
        fn new(files: &[(&str, &str)]) -> Self {
            let map = MapFs::default();
            for (path, content) in files {
                map.files
                    .lock()
                    .unwrap()
                    .insert((*path).to_string(), (*content).to_string());
                map.canonical
                    .lock()
                    .unwrap()
                    .insert((*path).to_string(), (*path).to_string());
            }
            map
        }

        fn escape(&self, path: &str, canonical: &str) {
            self.canonical
                .lock()
                .unwrap()
                .insert(path.to_string(), canonical.to_string());
        }
    }

    impl PromptFs for MapFs {
        fn read_to_string(&self, path: &str) -> Option<String> {
            self.files.lock().unwrap().get(path).cloned()
        }

        fn canonicalize(&self, path: &str) -> Option<String> {
            self.canonical.lock().unwrap().get(path).cloned()
        }
    }

    #[test]
    fn the_override_file_wins_inside_one_directory() {
        let fs = MapFs::new(&[
            ("/w/AGENTS.md", "plain agents"),
            ("/w/AGENTS.override.md", "override agents"),
            ("/w/CLAUDE.md", "claude"),
        ]);
        let chain = load_project_instructions(&fs, Some("/w"), None, MAX_PROJECT_INSTRUCTION_BYTES)
            .expect("a chain");
        assert_eq!(chain.entries.len(), 1);
        assert_eq!(chain.entries[0].content, "override agents");
        assert_eq!(chain.entries[0].source, "AGENTS.override.md");
    }

    #[test]
    fn claude_is_used_when_no_agents_file_exists() {
        let fs = MapFs::new(&[("/w/CLAUDE.md", "claude rules")]);
        let chain = load_project_instructions(&fs, Some("/w"), None, MAX_PROJECT_INSTRUCTION_BYTES)
            .expect("a chain");
        assert_eq!(chain.entries[0].content, "claude rules");
        assert_eq!(chain.entries[0].source, "CLAUDE.md");
    }

    #[test]
    fn the_chain_runs_root_to_nested_so_nested_wins() {
        let fs = MapFs::new(&[
            ("/w/AGENTS.md", "root rules"),
            ("/w/pkg/AGENTS.md", "package rules"),
            ("/w/pkg/src/AGENTS.md", "source rules"),
        ]);
        let chain = load_project_instructions(
            &fs,
            Some("/w"),
            Some("/w/pkg/src/lib.rs"),
            MAX_PROJECT_INSTRUCTION_BYTES,
        )
        .expect("a chain");
        let contents: Vec<&str> = chain
            .entries
            .iter()
            .map(|entry| entry.content.as_str())
            .collect();
        assert_eq!(
            contents,
            vec!["root rules", "package rules", "source rules"]
        );
        let sources: Vec<&str> = chain
            .entries
            .iter()
            .map(|entry| entry.source.as_str())
            .collect();
        assert_eq!(
            sources,
            vec!["AGENTS.md", "pkg/AGENTS.md", "pkg/src/AGENTS.md"]
        );
    }

    #[test]
    fn an_instruction_outside_the_root_is_refused() {
        let fs = MapFs::new(&[
            ("/w/AGENTS.md", "root rules"),
            ("/etc/AGENTS.md", "foreign"),
        ]);
        fs.escape("/w/AGENTS.md", "/etc/AGENTS.md");
        let chain = load_project_instructions(&fs, Some("/w"), None, MAX_PROJECT_INSTRUCTION_BYTES);
        assert!(chain.is_none(), "a symlinked escape must not be read");
    }

    #[test]
    fn an_oversized_file_is_cut_with_a_notice_and_stops_the_chain() {
        let big = "x".repeat(MAX_PROJECT_INSTRUCTION_BYTES + 100);
        let fs = MapFs::new(&[
            ("/w/AGENTS.md", big.as_str()),
            ("/w/pkg/AGENTS.md", "package rules"),
        ]);
        // The root file alone fills the budget; the nested one is not loaded.
        let chain = load_project_instructions(
            &fs,
            Some("/w"),
            Some("/w/pkg/lib.rs"),
            MAX_PROJECT_INSTRUCTION_BYTES,
        )
        .expect("a chain");
        assert_eq!(chain.entries.len(), 1);
        assert!(chain.entries[0]
            .content
            .contains("Pi-Workspace truncated AGENTS.md"));
        assert!(chain.entries[0].content.contains("not in context"));
    }

    #[test]
    fn whitespace_only_files_are_absent() {
        let fs = MapFs::new(&[("/w/AGENTS.md", "   \n\t \n")]);
        assert!(
            load_project_instructions(&fs, Some("/w"), None, MAX_PROJECT_INSTRUCTION_BYTES)
                .is_none()
        );
    }

    #[test]
    fn global_instructions_precede_project_ones() {
        let fs = MapFs::new(&[
            ("/data/agent/AGENTS.md", "global rules"),
            ("/w/AGENTS.md", "project rules"),
        ]);
        let chain =
            load_instruction_chain(&fs, Some("/w"), None, Some("/data/agent")).expect("a chain");
        let contents: Vec<&str> = chain
            .entries
            .iter()
            .map(|entry| entry.content.as_str())
            .collect();
        assert_eq!(contents, vec!["global rules", "project rules"]);
        assert_eq!(chain.entries[0].source, GLOBAL_INSTRUCTION_SOURCE);
    }

    #[test]
    fn custom_prompt_project_wins_and_kinds_are_independent() {
        let fs = MapFs::new(&[
            ("/w/.pi/SYSTEM.md", "project persona"),
            ("/data/agent/SYSTEM.md", "global persona"),
            ("/data/agent/APPEND_SYSTEM.md", "global append"),
        ]);
        let custom =
            load_custom_system_prompt(&fs, Some("/w"), Some("/data/agent")).expect("custom files");
        assert_eq!(custom.replace.as_deref(), Some("project persona"));
        assert_eq!(custom.append.as_deref(), Some("global append"));
    }

    #[test]
    fn a_blank_custom_file_falls_through_to_the_next_directory() {
        let fs = MapFs::new(&[
            ("/w/.pi/SYSTEM.md", "   \n"),
            ("/data/agent/SYSTEM.md", "global persona"),
        ]);
        let custom =
            load_custom_system_prompt(&fs, Some("/w"), Some("/data/agent")).expect("custom files");
        assert_eq!(custom.replace.as_deref(), Some("global persona"));
    }

    #[test]
    fn a_cut_keeps_the_head_and_the_tail() {
        // The bottom of a long rule set is where commit / gate / reporting rules sit,
        // so a cut that keeps only the head drops the part that decides how work lands.
        let head = "H".repeat(3_000);
        let middle = "M".repeat(40_000);
        let tail = "T".repeat(3_000);
        let content = format!("{head}{middle}{tail}");
        let (kept, bytes, truncated) = limit_utf8_bytes_head_and_tail(&content, 20 * 1024);
        assert!(truncated);
        assert!(bytes <= 20 * 1024, "kept {bytes} bytes");
        assert!(kept.starts_with("HHHH"), "the head survives");
        assert!(kept.ends_with("TTTT"), "the tail survives");
        // The middle is what went: only the head and tail edges can carry its bytes.
        assert!(
            kept.matches('M').count() < 15_000,
            "most of the middle must be gone, kept {} of 40,000",
            kept.matches('M').count()
        );
        assert!(kept.contains('\u{2026}'), "the cut is visible in the text");
    }

    #[test]
    fn a_cut_never_repeats_text() {
        // A file just over the budget would otherwise let head and tail overlap.
        let content = "x".repeat(21 * 1024);
        let (kept, bytes, truncated) = limit_utf8_bytes_head_and_tail(&content, 20 * 1024);
        assert!(truncated);
        assert!(kept.len() <= 20 * 1024, "kept {} bytes against a 20KB budget", kept.len());
        assert_eq!(bytes, kept.len());
    }

    #[test]
    fn utf8_limits_never_split_a_character() {
        let content = "中".repeat(10); // 3 bytes each
        let (kept, bytes, truncated) = limit_utf8_bytes(&content, 7);
        assert!(truncated);
        assert_eq!(bytes, 6);
        assert_eq!(kept, "中中");
    }

    #[test]
    fn rendering_keeps_precedence_wording_and_entry_order() {
        let chain = ProjectInstructions {
            entries: vec![
                InstructionEntry {
                    source: "AGENTS.md".into(),
                    content: "root".into(),
                },
                InstructionEntry {
                    source: "pkg/AGENTS.md".into(),
                    content: "nested".into(),
                },
            ],
        };
        let rendered = render_project_instructions(&chain).expect("rendered");
        assert!(rendered.starts_with("# Project instructions"));
        assert!(rendered.contains("## AGENTS.md\n\nroot"));
        assert!(rendered.contains("## pkg/AGENTS.md\n\nnested"));
        assert!(rendered.find("root").unwrap() < rendered.find("nested").unwrap());
    }

    #[test]
    fn an_empty_chain_renders_nothing() {
        assert!(render_project_instructions(&ProjectInstructions::default()).is_none());
    }

    #[test]
    fn root_membership_is_separator_insensitive() {
        assert!(is_within_root("D:/Code/w", "D:/Code/w/a.md"));
        assert!(is_within_root("D:/Code/w/", "D:/Code/w/a.md"));
        assert!(!is_within_root("D:/Code/w", "D:/Code/wx/a.md"));
        assert!(is_within_root("D:\\Code\\w", "D:/Code/w/nested/a.md"));
    }
}
