use self::curator::{CurationReport, CurationState, CuratorPolicy};
use self::links::{SkillLink, SkillLinkStore};
use self::origin::{SkillOriginStore, AGENT_AUTHOR};
use self::pins::SkillPinStore;
use self::usage::{SkillUsage, SkillUsageStore};
use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, capability_id, copy_directory_tree, display_name_candidate, file_timestamp,
    move_capability_file, normalize_project_path, parse_front_matter, path_stem_for_id,
    set_moved_capability_state, slugify, sorted_files, suffixed_capability_id, valid_capability_id,
    CapabilityLevel, CapabilityState, CapabilityTarget, MAX_ID_SUFFIX,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_SKILLS: usize = 128;
// A skill document has no size cap. The catalog is what reaches a prompt, and the
// catalog carries names and descriptions, never bodies; an oversized document costs
// its own bytes and nothing else. The old 128 KiB cap also *hid* skills: the scan
// skipped a document over it, so a large skill silently vanished from the library.
// A resource file has no per-file cap either: resources are read on demand and never
// become prompt content. Only the package total and its file count are bounded, which
// is about one transfer payload rather than about what a skill may contain.
pub const MAX_SKILL_PACKAGE_FILES: usize = 256;
pub const MAX_SKILL_PACKAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 400;
const SKILL_KIND: &str = "skills";
/// Built-in skills have no scanned document, so their activation lives in a
/// separate state file from user skills. The user-skill scan prunes missing
/// documents and must not erase a built-in preference.
const BUILTIN_SKILL_KIND: &str = "skill-builtins";

/// What one consolidation moved, so a caller can report it instead of guessing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbsorbOutcome {
    /// The document taken out of the catalog.
    pub absorbed: Option<UserSkillRecord>,
    /// The umbrella that received its resources.
    pub into: Option<UserSkillRecord>,
    /// Resource paths moved under the umbrella.
    pub copied: Vec<String>,
    /// Resource paths the umbrella already had; its copy was kept.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
    /// Last time this document was loaded through the `Skill` tool, epoch ms.
    /// Absent means never loaded — the one signal a maintenance pass has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    /// Number of loads. Serialized even when zero, so a reader can tell "never
    /// used" from "this release did not report usage".
    #[serde(default)]
    pub use_count: u32,
    /// Exempt from the maintenance pass (ADR 0387's escape hatch).
    #[serde(default)]
    pub pinned: bool,
    /// The umbrella this document was merged into, when it was (ADR 0389).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absorbed_into: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub level: Option<String>,
    pub project_path: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility. Capability pages use directory level
    /// instead of writing activation scope into a skill document.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
    /// Import mode: `"copy"` (default) keeps a private byte-for-byte replica so
    /// deleting or moving the source does not break the skill; `"link"` places
    /// a symlink so an external editor's updates are picked up on the next
    /// scan. Ignored by `create` and `update`.
    pub mode: Option<String>,
    /// Optional shape hint for `import`. When absent, a directory source is
    /// treated as the `<name>/SKILL.md` convention and a regular file is
    /// treated as `<id>.md`. A caller that pre-scanned the candidate can pass
    /// `"dir"` to require the SKILL.md convention.
    pub shape: Option<String>,
    /// Who wrote this document. `"agent"` marks the skill as the maintenance
    /// pass's to manage; anything else (and absence) means a person wrote it.
    /// Read by `create`, ignored by `update` — an origin is recorded once and
    /// never rewritten by an edit.
    pub created_by: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportMode {
    Copy,
    Link,
}

impl ImportMode {
    fn parse(value: Option<&str>) -> Result<Self> {
        match value.map(str::trim).unwrap_or("copy") {
            "" | "copy" => Ok(Self::Copy),
            "link" | "symlink" => Ok(Self::Link),
            other => bail!("SKILL_INVALID: unknown import mode `{other}`"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportShape {
    File,
    Dir,
}

impl ImportShape {
    fn parse(value: &str) -> Result<Self> {
        match value.trim() {
            "file" => Ok(Self::File),
            "dir" | "directory" => Ok(Self::Dir),
            other => bail!("SKILL_INVALID: unknown import shape `{other}`"),
        }
    }
}

pub struct UserSkillRegistry {
    state: CapabilityState,
    builtins: CapabilityState,
    /// Loads, not edits: what a maintenance pass needs to tell a skill somebody
    /// uses from one nobody has ever opened.
    usage: SkillUsageStore,
    /// Skills the user asked the maintenance pass to leave alone.
    pins: SkillPinStore,
    /// Which documents the agent wrote, so the pass only retires its own.
    origins: SkillOriginStore,
    /// Where an absorbed skill went, so a quiet document can explain itself.
    links: SkillLinkStore,
}

/// Place a single skill file at `target`, either as a copy or a symlink.
///
/// Copy: `fs::copy` — a private byte replica so a moved or deleted source does
/// not break the skill.
/// Link: `symlink` (unix) / `symlink_file` (windows). On platforms or file
/// systems that reject symlinks the caller receives the OS error and must
/// decide whether to retry with `"copy"`.
fn place_file(source: &Path, target: &Path, mode: ImportMode) -> Result<()> {
    if target.exists() {
        bail!(
            "SKILL_INVALID: destination already exists: {}",
            target.display()
        );
    }
    match mode {
        ImportMode::Copy => {
            fs::copy(source, target)
                .with_context(|| format!("copy {} to {}", source.display(), target.display()))?;
        }
        ImportMode::Link => symlink_path(source, target)?,
    }
    Ok(())
}

/// Place a skill directory (Anthropic `<name>/SKILL.md` shape) at `target_dir`.
///
/// Copy: recursive copy so the destination owns every byte, including resources
/// beside `SKILL.md`.
/// Link: one symlink at the root pointing at the source directory. External
/// edits are picked up on the next scan; the caller is responsible for warning
/// the user that a source rename or deletion silently invalidates the skill.
fn place_dir(source_dir: &Path, target_dir: &Path, mode: ImportMode) -> Result<()> {
    if target_dir.exists() {
        bail!(
            "SKILL_INVALID: destination already exists: {}",
            target_dir.display()
        );
    }
    match mode {
        ImportMode::Copy => copy_directory_tree(source_dir, target_dir, false)?,
        ImportMode::Link => symlink_path(source_dir, target_dir)?,
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_path(source: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(source, target)
        .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))
}

#[cfg(windows)]
fn symlink_path(source: &Path, target: &Path) -> Result<()> {
    // Directory vs file must be picked at link time on Windows; falling back to
    // `symlink_file` for a directory would produce a link that resolves to a
    // regular file entry.
    let result = if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, target)
    } else {
        std::os::windows::fs::symlink_file(source, target)
    };
    result.with_context(|| {
        format!(
            "symlink {} -> {} (Windows may require Developer Mode or elevation)",
            target.display(),
            source.display()
        )
    })
}

#[cfg(not(any(unix, windows)))]
fn symlink_path(_source: &Path, _target: &Path) -> Result<()> {
    bail!("SKILL_INVALID: symlink import is not supported on this platform")
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn valid_id(id: &str) -> bool {
    valid_capability_id(id, 64)
}

fn normalize_builtin_skill_id(id: &str) -> Result<String> {
    let id = id.trim();
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment.len() <= 64
            && segment.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && segment
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let Some((namespace, name)) = id.split_once('/') else {
        bail!("SKILL_INVALID: invalid builtin skill id");
    };
    if id.len() > 129 || !valid_segment(namespace) || !valid_segment(name) {
        bail!("SKILL_INVALID: invalid builtin skill id");
    }
    Ok(id.to_string())
}

fn render_document(name: &str, description: Option<&str>, body: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", name.replace('\n', " ")));
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!(
            "description: {}\n",
            description.replace('\n', " ")
        ));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out
}

fn default_body(name: &str) -> String {
    format!("# {name}\n\nDescribe the steps the agent should follow when this skill applies.\n")
}

fn level_and_project(input: &UserSkillInput) -> Result<(CapabilityLevel, Option<String>)> {
    let level = CapabilityLevel::parse(input.level.as_deref())?;
    let project_path = input
        .project_path
        .as_deref()
        .map(normalize_project_path)
        .filter(|value| !value.is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        bail!("CAPABILITY_INVALID: projectPath is required for project skills");
    }
    if level == CapabilityLevel::Global && project_path.is_some() {
        // A project path on a global request is meaningful only for its local
        // enabled override; the file still belongs to the global directory.
        return Ok((level, project_path));
    }
    Ok((level, project_path))
}

fn merge_active_records(
    global: Vec<UserSkillRecord>,
    project: Vec<UserSkillRecord>,
) -> Vec<UserSkillRecord> {
    let mut result = global;
    for record in project {
        result.retain(|existing| {
            existing.id != record.id && !existing.name.eq_ignore_ascii_case(&record.name)
        });
        if record.enabled {
            result.push(record);
        }
    }
    result.retain(|record| record.enabled);
    result.sort_by_key(|record| record.name.to_lowercase());
    result
}

/// The text after the opening `---` line, when `text` really starts frontmatter.
///
/// `parse_front_matter` accepts any first line that trims to `---`, so `--- `,
/// `---\r` and `--- \r\n` all open a block. A stricter check here would send
/// those documents down the "no frontmatter" path and copy the old block into
/// the body of a fresh one, leaving two frontmatter blocks in the file.
fn front_matter_body(text: &str) -> Option<&str> {
    let newline = text.find('\n')?;
    let first = text[..newline].trim_end_matches('\r');
    if first.trim() != "---" {
        return None;
    }
    Some(&text[newline + 1..])
}

/// Give a skill document the display name a destination needs, rewriting the
/// frontmatter `name` line and nothing else.
///
/// A move that has to rename must not reformat the document: `render_document`
/// normalizes prose, drops unknown frontmatter keys, and re-indents the body,
/// which would silently edit a file the user only asked to relocate. Everything
/// outside the rewritten lines — extra fields, whitespace, line endings — is
/// copied through byte for byte.
fn rewrite_document_name(raw: &str, name: &str) -> String {
    let value = name.replace(['\n', '\r'], " ");
    let (bom, text) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", raw),
    };
    let Some(front) = front_matter_body(text) else {
        return with_fresh_frontmatter(bom, text, &value);
    };
    let mut out = String::with_capacity(raw.len() + value.len() + 16);
    out.push_str(bom);
    out.push_str("---\n");
    let mut cursor = 0usize;
    let mut replaced = false;
    while cursor < front.len() {
        let end = match front[cursor..].find('\n') {
            Some(at) => cursor + at + 1,
            None => front.len(),
        };
        let line = &front[cursor..end];
        if line.trim_end_matches(['\n', '\r']).trim() == "---" {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
            }
            // The terminator and everything after it, body included, is copied
            // through untouched.
            out.push_str(&front[cursor..]);
            return out;
        }
        let top_level = !line.starts_with(' ') && !line.starts_with('\t');
        let is_name = top_level
            && line
                .trim_end_matches(['\n', '\r'])
                .split_once(':')
                .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("name"));
        if is_name {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
                replaced = true;
            }
            // A later `name:` line is dropped rather than kept: the parser
            // inserts into a map, so the *last* line wins. Keeping a stale one
            // would silently defeat the rename — the document would keep its
            // old display name while the move claims it was changed.
        } else {
            out.push_str(line);
        }
        cursor = end;
    }
    // An unterminated opening delimiter is not frontmatter (`parse_front_matter`
    // rejects it), so the text becomes the body of a fresh, complete block.
    with_fresh_frontmatter(bom, text, &value)
}

fn with_fresh_frontmatter(bom: &str, text: &str, value: &str) -> String {
    format!(
        "{bom}---\nname: {value}\n---\n\n{}",
        text.trim_start_matches(['\n', '\r'])
    )
}

/// Comparable tokens of a skill id: lowercase, split on separators, and a
/// trailing plural `s` dropped so `scripts` and `script` are the same word.
fn skill_tokens(id: &str) -> HashSet<String> {
    id.split(['-', '_', '.', ' '])
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.len() > 3 && part.ends_with('s') && !part.ends_with("ss") {
                part.trim_end_matches('s').to_string()
            } else {
                part
            }
        })
        .collect()
}

/// True when one id's tokens contain the other's — the shape of `npm-script`
/// beside `add-npm-script`, or `review` beside `code-review`.
///
/// Deliberately containment and not similarity: `deploy-ios` and
/// `deploy-android` share a token and are two legitimate skills; two versions of
/// one procedure (`deploy-ios-17` / `deploy-ios-18`) are likewise legitimately
/// distinct because neither token set contains the other.
fn skill_ids_overlap(left: &str, right: &str) -> bool {
    if left.eq_ignore_ascii_case(right) {
        return false; // the exact-match check owns that case
    }
    let (left, right) = (skill_tokens(left), skill_tokens(right));
    if left.is_empty() || right.is_empty() {
        return false;
    }
    left.is_subset(&right) || right.is_subset(&left)
}

/// The directory a `<skill>/SKILL.md` document owns, when the document really is
/// the directory shape.
///
/// A skill may ship sibling resources next to its `SKILL.md`, so moving one
/// document is not enough — the directory is the unit. The guard matters: a
/// loose `SKILL.md` sitting directly in the skills directory has the skills
/// directory itself as its parent, and treating that as the unit would move
/// every skill at once.
fn directory_skill_root(path: &Path, skills_dir: &Path) -> Option<PathBuf> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        return None;
    }
    let dir = path.parent()?;
    if dir == skills_dir {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Is this path a link or a reparse point (Windows junction)?
///
/// `remove_dir_all` follows both, so a poisoned tree inside the library could
/// otherwise delete a directory somewhere else entirely.
fn is_redirect(path: &Path) -> bool {
    let Ok(metadata) = path.symlink_metadata() else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    is_reparse_point(&metadata)
}

/// FILE_ATTRIBUTE_REPARSE_POINT: covers junctions, which Rust does not report as
/// symlinks.
#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// Remove one skill's files, refusing anything that is not a real skill inside a
/// skills root.
///
/// The same last-line guard Hermes' delete path uses, for the same reason: a symlink
/// or junction makes a recursive delete follow the link out of the library, and a
/// path that resolves outside every known root — or to a root itself — would take
/// every installed skill with it. A directory skill goes as a package, because the
/// document and the resources beside it are one skill: leaving `references/` behind
/// would only hand the tidy pass a set of orphans.
fn delete_skill_files(document: &Path, roots: &[PathBuf]) -> Result<()> {
    let resolve = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    // Links are checked before the root test, and on the package directory as well as
    // the document: `canonicalize` resolves *through* a link, so a redirected skill
    // would otherwise be refused as "outside the root" — true, but not the thing to
    // fix — and a junction directory holding a real SKILL.md would send
    // `remove_dir_all` out of the library entirely.
    if is_redirect(document) {
        bail!(
            "SKILL_INVALID: refusing to delete {}: it is a symlink or junction",
            document.display()
        );
    }
    let is_package = document
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"));
    let package = is_package.then(|| document.parent().unwrap_or(document));
    if let Some(dir) = package {
        if is_redirect(dir) {
            bail!(
                "SKILL_INVALID: refusing to delete {}: the skill directory is a symlink or junction",
                dir.display()
            );
        }
    }
    let resolved = resolve(document);
    let containing = roots.iter().find(|root| {
        let root = resolve(root);
        resolved != root && resolved.starts_with(&root)
    });
    let Some(containing) = containing else {
        bail!(
            "SKILL_INVALID: refusing to delete {}: it does not resolve inside a skills root",
            document.display()
        );
    };
    // `<root>/SKILL.md` is not a skill package: it is a stray document sitting
    // directly in the library, and its package would be the root itself.
    if let Some(dir) = package {
        if dir == containing.as_path() || resolve(dir) == resolve(containing) {
            bail!(
                "SKILL_INVALID: refusing to delete {}: the document sits directly in the skills root",
                document.display()
            );
        }
        fs::remove_dir_all(dir)
            .map_err(|error| anyhow::anyhow!("remove {}: {error}", dir.display()))?;
        return Ok(());
    }
    // The flat form `<root>/<id>.md` is a real skill: only the document goes, and the
    // library it sits in obviously stays. A failure is reported rather than swallowed,
    // so a delete that could not happen never comes back as `true`.
    fs::remove_file(document)
        .map_err(|error| anyhow::anyhow!("remove {}: {error}", document.display()))?;
    Ok(())
}

/// The containers a skill may own beside its `SKILL.md` (ADR 0388).
///
/// Modelled on the shape a skill is expected to have: notes it reads
/// (`references/`), files it fills in (`templates/`), programs it runs
/// (`scripts/`), and anything else it needs (`assets/`).
const RESOURCE_ROOTS: [&str; 4] = ["references", "templates", "scripts", "assets"];

/// Accept `<root>/<name>` resource paths under one of the four known roots.
///
/// The review loop writes model-produced paths, so this is a security boundary,
/// not a convenience: `..`, absolute paths and anything outside those roots are
/// rejected rather than normalised into something surprising. `references/` keeps
/// its markdown-only rule — it is prose the model reads into context — while the
/// other three carry whatever the skill needs (a template, a script, a data
/// file). The host never executes anything it stores here.
fn normalize_resource_path(raw: &str) -> Result<String> {
    let trimmed = raw.trim().replace('\\', "/");
    let trimmed = trimmed.trim_start_matches('/');
    if trimmed.is_empty() {
        bail!("SKILL_INVALID: resource path is required");
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|part| !part.is_empty()).collect();
    if parts.iter().any(|part| *part == "." || *part == "..") {
        bail!("SKILL_INVALID: resource path may not traverse");
    }
    let allowed = parts
        .first()
        .is_some_and(|root| RESOURCE_ROOTS.contains(root));
    if parts.len() < 2 || !allowed {
        bail!(
            "SKILL_INVALID: resource path must be one of {}",
            RESOURCE_ROOTS
                .iter()
                .map(|root| format!("{root}/<name>"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if parts[0] == "references"
        && !parts
            .last()
            .is_some_and(|part| part.to_ascii_lowercase().ends_with(".md"))
    {
        bail!("SKILL_INVALID: a reference must end with .md");
    }
    Ok(parts.join("/"))
}

/// Where an arriving skill document should land, and under which display name.
struct SkillPlacement {
    name: String,
    stem: String,
}

/// The document a skill with `stem` occupies inside the skills directory.
///
/// Directory-shape skills live at `<stem>/SKILL.md` because the scan gives that
/// document the *directory* name as its path-derived id; flat skills are one
/// `<stem>.md` file. The two shapes are why the landing path cannot be derived
/// from the stem alone.
fn skill_document_path(directory: &Path, stem: &str, shared_directory: bool) -> PathBuf {
    if shared_directory {
        directory.join(stem).join("SKILL.md")
    } else {
        directory.join(format!("{stem}.md"))
    }
}

/// Choose the name and file stem an arriving skill must use at a destination.
///
/// The scan, not the move, decides the arriving document's id: it derives the
/// id from the frontmatter name first and only then from the path. Planning
/// against the file stem alone therefore mismatches every document whose name
/// slugs to something else — a Chinese name, or a name whose slug happens to be
/// another document's id — and a mismatch hides documents: the source is
/// already gone while the arrival is either not found or loses the scan's
/// `seen` de-duplication. So every candidate is put through the real
/// `capability_id` for the exact path it would land on, and only a placement
/// the scan lists as its own record is accepted. `shared_directory` selects the
/// destination's shape, because that shape decides what `path_stem_for_id`
/// reads.
fn plan_skill_placement(
    source: &UserSkillRecord,
    directory: &Path,
    shared_directory: bool,
    existing: &[UserSkillRecord],
) -> Option<SkillPlacement> {
    let taken_names = existing
        .iter()
        .map(|record| record.name.to_lowercase())
        .collect::<HashSet<_>>();
    // Ids are compared lowercased, like the filesystem that will hold them.
    let taken_ids = existing
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect::<HashSet<_>>();
    for ordinal in 1..=MAX_ID_SUFFIX {
        let name = display_name_candidate(&source.name, ordinal, MAX_NAME_CHARS);
        // A duplicate display name makes shadowing merge two records on the
        // next scan, so the destination may not already have it.
        if name.is_empty() || taken_names.contains(&name.to_lowercase()) {
            continue;
        }
        // The scan prefers the name's slug, so a valid slug *is* the id the
        // document will carry and the file stem has to match it.
        let from_name = slugify(&name, 64);
        let stem = if valid_capability_id(&from_name, 64) {
            from_name
        } else {
            suffixed_capability_id(&source.id, &taken_ids, 64)?.0
        };
        let document_path = skill_document_path(directory, &stem, shared_directory);
        // Something already on disk at this path is either a listed document
        // (caught again below) or one the scan refuses to list; never write
        // over it.
        if document_path.exists() {
            continue;
        }
        // Simulate the real scan: `capability_id` can still land on an id the
        // name slug did not predict (the path fallback), and an id collision
        // makes one of the two documents disappear from the catalog.
        let id = capability_id(&name, &document_path, 64);
        if !valid_capability_id(&id, 64) || taken_ids.contains(&id.to_lowercase()) {
            continue;
        }
        return Some(SkillPlacement { name, stem });
    }
    None
}

/// True when a scanned record path names the document a move just wrote.
///
/// The record path comes back from a directory scan and the planned path from a
/// join, so the comparison is normalized and case-insensitive — the same rules
/// project paths use, and the only rules that hold on a volume that ignores
/// case.
fn same_document(record_path: &str, planned: &Path) -> bool {
    normalize_project_path(record_path)
        .eq_ignore_ascii_case(&normalize_project_path(&planned.to_string_lossy()))
}

fn package_root(
    record: &UserSkillRecord,
    level: CapabilityLevel,
    project_path: Option<&str>,
) -> Result<Option<PathBuf>> {
    let skills_dir = capability_dir(level, project_path, SKILL_KIND)?;
    let path = PathBuf::from(&record.path);
    if !path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
    {
        return Ok(None);
    }
    let Some(root) = path.parent() else {
        return Ok(None);
    };
    if root == skills_dir {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(root)
        .with_context(|| format!("inspect skill package {}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("SKILL_INVALID: skill package root must be a real directory");
    }
    Ok(Some(root.to_path_buf()))
}

fn package_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("SKILL_INVALID: package path escapes its root"))?;
    let mut components = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(value) = component else {
            bail!("SKILL_INVALID: package path contains traversal");
        };
        let value = value
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: package path is not UTF-8"))?;
        if value.is_empty() || value.contains(['/', '\\']) {
            bail!("SKILL_INVALID: package path contains an unsafe name");
        }
        components.push(value.to_string());
    }
    if components.is_empty() {
        bail!("SKILL_INVALID: package path is empty");
    }
    Ok(components.join("/"))
}

/// Write `relative` under `root`, creating parents. Refuses a symlinked
/// destination so a resource write can never escape the skill directory.
fn write_bytes(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let destination = root.join(relative);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() {
            bail!("SKILL_INVALID: skill resources cannot be symbolic links");
        }
    }
    fs::write(&destination, bytes)?;
    Ok(())
}

fn collect_package_files(
    root: &Path,
    current: &Path,
    result: &mut Vec<(String, Vec<u8>)>,
    total: &mut usize,
) -> Result<()> {
    if result.len() > MAX_SKILL_PACKAGE_FILES {
        bail!("SKILL_LIMIT_EXCEEDED: skill package contains too many files");
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("SKILL_INVALID: skill packages cannot contain symbolic links");
        }
        if metadata.is_dir() {
            collect_package_files(root, &path, result, total)?;
            continue;
        }
        if !metadata.is_file() {
            bail!("SKILL_INVALID: skill package contains a non-file entry");
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
        {
            continue;
        }
        let relative = package_relative_path(root, &path)?;
        let bytes = fs::read(&path)?;
        *total = total.saturating_add(bytes.len());
        if *total > MAX_SKILL_PACKAGE_BYTES {
            bail!("SKILL_LIMIT_EXCEEDED: skill package is too large");
        }
        result.push((relative, bytes));
        if result.len() > MAX_SKILL_PACKAGE_FILES {
            bail!("SKILL_LIMIT_EXCEEDED: skill package contains too many files");
        }
    }
    Ok(())
}

fn package_destination(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.starts_with('\\')
        || relative.contains('\\')
    {
        bail!("SKILL_INVALID: package path is unsafe");
    }
    let mut target = root.to_path_buf();
    let mut count = 0usize;
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            bail!("SKILL_INVALID: package path contains traversal");
        }
        count += 1;
        target.push(component);
    }
    if count == 0
        || target
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
    {
        bail!("SKILL_INVALID: package path targets the skill document");
    }
    Ok(target)
}

fn ensure_no_symlink_path(root: &Path, target: &Path) -> Result<()> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("SKILL_INVALID: package path escapes its root"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(value) = component else {
            bail!("SKILL_INVALID: package path contains traversal");
        };
        current.push(value);
        if current.exists() {
            let metadata = fs::symlink_metadata(&current)?;
            if metadata.file_type().is_symlink() {
                bail!("SKILL_INVALID: skill package path cannot traverse a symbolic link");
            }
        }
    }
    Ok(())
}

impl UserSkillRegistry {
    /// Move one skill between the global directory and a project's.
    ///
    /// The document moves instead of being copied: a copy would leave the old
    /// level holding a skill the user just said belongs somewhere else. When the
    /// destination already owns the same id or display name the arriving skill
    /// is renamed, so both survive under names that tell them apart. The
    /// arriving document's id is read back from a scan by path, because a
    /// skill's id can come from its name rather than its file stem, and the
    /// state is written only once that record exists. A landing the scan would
    /// hide is rolled back to the source instead of stranding the skill.
    pub fn transfer(
        &mut self,
        id: &str,
        from: &CapabilityTarget,
        to: &CapabilityTarget,
    ) -> Result<UserSkillRecord> {
        let Some(source) = self.find(id, Some(from.level), from.project_path.as_deref())? else {
            bail!("SKILL_INVALID: unknown skill \"{id}\"");
        };
        if from.same_directory(to) {
            return Ok(source);
        }
        let source_path = PathBuf::from(&source.path);
        let raw = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        let existing = self.list(to.level, to.project_path.as_deref())?;
        if existing.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }

        let source_dir = capability_dir(from.level, from.project_path.as_deref(), "skills")?;
        let directory = capability_dir(to.level, to.project_path.as_deref(), "skills")?;
        let owned_dir = directory_skill_root(&source_path, &source_dir);
        let shared_directory = owned_dir.is_some();
        let placement = plan_skill_placement(&source, &directory, shared_directory, &existing)
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: no free name at the destination"))?;
        let document_path = skill_document_path(&directory, &placement.stem, shared_directory);
        let source_unit = owned_dir.clone().unwrap_or_else(|| source_path.clone());
        let target_unit = if shared_directory {
            match document_path.parent() {
                Some(parent) => parent.to_path_buf(),
                None => directory.join(&placement.stem),
            }
        } else {
            document_path.clone()
        };
        let rewritten = placement.name != source.name;

        if !rewritten {
            move_capability_file(&source_unit, &target_unit)?;
        } else {
            let document = rewrite_document_name(&raw, &placement.name);
            if shared_directory && target_unit.exists() {
                // The destination id is unique at this level, so `<stem>/` is a
                // directory this move creates. Anything already sitting there
                // is not this skill's to overwrite or merge into.
                bail!(
                    "SKILL_INVALID: destination already exists: {}",
                    target_unit.display()
                );
            }
            if let Some(parent) = document_path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Written before the source is removed, so a failure in between
            // leaves a shadowed duplicate rather than no skill at all.
            fs::write(&document_path, document)
                .with_context(|| format!("write {}", document_path.display()))?;
            if let Some(dir) = &owned_dir {
                // Only the document travelled; resources beside it are part of
                // the skill, so the rest of the directory follows. The landing
                // directory is new, so overwriting a same-named leftover from
                // an interrupted move is safe.
                copy_directory_tree(dir, &target_unit, true)?;
                fs::remove_dir_all(dir)
                    .map_err(|error| anyhow::anyhow!("remove {}: {error}", dir.display()))?;
            } else {
                fs::remove_file(&source_path).map_err(|error| {
                    anyhow::anyhow!("remove {}: {error}", source_path.display())
                })?;
            }
        }

        // The record is resolved by path, never by the planned stem: the scan
        // derives the arriving document's id from its name, and the name's slug
        // is not necessarily the file stem this move chose.
        let landed = self
            .list(to.level, to.project_path.as_deref())?
            .into_iter()
            .find(|record| same_document(&record.path, &document_path));
        let Some(moved) = landed else {
            // The document is on disk but the scan will not list it (empty
            // body, over the byte limit, or shadowed by a same-id document).
            // The source is already gone, so the move has to be undone: put the
            // unit back where it came from and restore the original bytes,
            // because the rewritten name would give the restored document a
            // different id. State was never written, so nothing else changes.
            move_capability_file(&target_unit, &source_unit).map_err(|error| {
                anyhow::anyhow!(
                    "SKILL_INVALID: the moved skill was not found and could not be restored to {}: {error}",
                    source_unit.display()
                )
            })?;
            fs::write(&source_path, &raw)
                .with_context(|| format!("restore {}", source_path.display()))?;
            bail!("SKILL_INVALID: moved skill was not found");
        };
        set_moved_capability_state(
            &mut self.state,
            SKILL_KIND,
            from.level,
            &source.id,
            source.project_path.as_deref(),
            to,
            &moved.id,
            source.enabled,
        )?;
        self.find(&moved.id, Some(to.level), to.project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: moved skill was not found"))
    }
}

impl UserSkillRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SKILL_KIND),
            builtins: CapabilityState::new(data_dir, BUILTIN_SKILL_KIND),
            usage: SkillUsageStore::new(data_dir),
            pins: SkillPinStore::new(data_dir),
            origins: SkillOriginStore::new(data_dir),
            links: SkillLinkStore::new(data_dir),
        }
    }

    /// Built-in skill ids switched off by the user. They are global and default
    /// to enabled; ids remain stored if a later release temporarily omits one.
    pub fn disabled_builtins(&self) -> Vec<String> {
        self.builtins
            .disabled_ids(BUILTIN_SKILL_KIND, CapabilityLevel::Global)
    }

    /// Set one built-in skill's global activation state.
    pub fn set_builtin_enabled(&mut self, id: &str, enabled: bool) -> Result<String> {
        let id = normalize_builtin_skill_id(id)?;
        self.builtins.set_enabled(
            BUILTIN_SKILL_KIND,
            CapabilityLevel::Global,
            &id,
            None,
            enabled,
        )?;
        Ok(id)
    }

    fn scan_level(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        effective_project: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let directory = capability_dir(level, project_path, "skills")?;
        let mut paths = sorted_files(&directory, "md");
        // Support the conventional `<skill>/SKILL.md` shape without making a
        // directory import necessary. Direct markdown files remain the shape
        // produced by the single-file importer.
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let skill_file = path.join("SKILL.md");
                    if skill_file.is_file() {
                        paths.push(skill_file);
                    }
                }
            }
        }
        paths.sort();

        let owner_project_path = if level == CapabilityLevel::Project {
            project_path.map(normalize_project_path)
        } else {
            None
        };
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in paths {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                _ => continue,
            };
            let (front, body) = parse_front_matter(&raw);
            if body.trim().is_empty() {
                continue;
            }
            let fallback = path_stem_for_id(&path);
            let name = clip(
                front.get("name").map(String::as_str).unwrap_or(&fallback),
                MAX_NAME_CHARS,
            );
            if name.is_empty() {
                continue;
            }
            let id = capability_id(&name, &path, 64);
            if !valid_id(&id) || !seen.insert(id.clone()) {
                continue;
            }
            let scope = scope_for(level, owner_project_path.as_deref());
            let enabled = self
                .state
                .enabled(SKILL_KIND, level, &id, effective_project);
            let description = front
                .get("description")
                .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
                .filter(|value| !value.is_empty());
            let updated_at = file_timestamp(&path);
            let usage = self.usage.get(level, &id, owner_project_path.as_deref());
            let pinned = self
                .pins
                .is_pinned(level, &id, owner_project_path.as_deref());
            let absorbed_into = self
                .links
                .get(level, &id, owner_project_path.as_deref())
                .map(|link| link.into);
            records.push(UserSkillRecord {
                id,
                name,
                level: Some(level.as_str().to_string()),
                project_path: owner_project_path.clone(),
                description,
                enabled,
                scope,
                source: "imported".into(),
                path: path.to_string_lossy().to_string(),
                size_bytes: raw.len() as u64,
                created_at: updated_at.clone(),
                updated_at,
                last_used_at: usage.map(|usage| usage.last_used_at),
                use_count: usage.map(|usage| usage.use_count).unwrap_or(0),
                pinned,
                absorbed_into,
            });
        }
        let ids: HashSet<String> = records.iter().map(|record| record.id.clone()).collect();
        self.state.prune(SKILL_KIND, level, project_path, &ids)?;
        // Same sweep for the counters: a document that no longer exists must not
        // hand its "used twice" badge to whatever is created next under that name.
        self.usage
            .retain(level, owner_project_path.as_deref(), &ids)?;
        self.pins
            .retain(level, owner_project_path.as_deref(), &ids)?;
        self.origins
            .retain(level, owner_project_path.as_deref(), &ids)?;
        self.links
            .retain(level, owner_project_path.as_deref(), &ids)?;
        records.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(records)
    }

    pub fn list(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let selected = project_path.map(normalize_project_path);
        self.scan_level(level, project_path, selected.as_deref())
    }

    /// Return the effective user skill catalog. A project document shadows a
    /// global document with the same normalized name.
    pub fn active_for(&mut self, project_path: Option<&str>) -> Result<Vec<UserSkillRecord>> {
        let selected = project_path.map(normalize_project_path);
        let global = self.scan_level(CapabilityLevel::Global, None, selected.as_deref())?;
        let project = selected
            .as_deref()
            .map(|path| self.scan_level(CapabilityLevel::Project, Some(path), Some(path)))
            .transpose()?
            .unwrap_or_default();
        Ok(merge_active_records(global, project))
    }

    fn find(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
        if let Some(level) = level {
            return Ok(self
                .list(level, project_path)?
                .into_iter()
                .find(|record| record.id == id));
        }
        if let Some(project) = project_path {
            if let Some(record) = self
                .list(CapabilityLevel::Project, Some(project))?
                .into_iter()
                .find(|record| record.id == id)
            {
                return Ok(Some(record));
            }
        }
        Ok(self
            .list(CapabilityLevel::Global, project_path)?
            .into_iter()
            .find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserSkillInput) -> Result<UserSkillRecord> {
        let (level, project_path) = level_and_project(&input)?;
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        let name = clip(input.name.as_deref().unwrap_or_default(), MAX_NAME_CHARS);
        if name.is_empty() {
            bail!("SKILL_INVALID: name is required");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| slugify(&name, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: invalid id");
        }
        if self
            .list(level, project_path.as_deref())?
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        // A near-duplicate is the expensive kind: `npm-script` beside
        // `add-npm-script` splits one lesson across two skills, and nothing
        // notices later because the ids differ. An exact match is caught above;
        // a token container is caught here. Containment rather than similarity:
        // `deploy-ios` and `deploy-android` share a token but neither contains
        // the other, and two variants of a real procedure are a legitimate pair.
        if let Some(existing) = self
            .list(level, project_path.as_deref())?
            .into_iter()
            .find(|record| skill_ids_overlap(&record.id, &id))
        {
            bail!(
                "SKILL_INVALID: '{name}' overlaps the existing skill '{}' ({}); \
                 patch that skill instead of creating a second one",
                existing.id,
                existing.name
            );
        }
        if self.list(level, project_path.as_deref())?.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }
        let body = input
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_body(&name));
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .filter(|value| !value.is_empty());
        let document = render_document(&name, description.as_deref(), &body);
        fs::create_dir_all(&directory)?;
        let path = if input
            .shape
            .as_deref()
            .is_some_and(|shape| matches!(shape, "dir" | "directory"))
        {
            let package = directory.join(&id);
            fs::create_dir_all(&package)?;
            package.join("SKILL.md")
        } else {
            directory.join(format!("{id}.md"))
        };
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if input.enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, &id, project_path.as_deref(), false)?;
        }
        let record = self
            .find(&id, Some(level), project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: created skill was not found"))?;
        // Only an explicit marker makes the document the pass's: a caller that
        // says nothing is treated as a person, which is the side that never
        // loses a file. Recorded after the scan above so the sweep cannot drop
        // the entry it has just been given.
        if agent_authored(input.created_by.as_deref()) {
            self.origins.record_agent_authored(
                level,
                &record.id,
                record.project_path.as_deref(),
            )?;
        }
        Ok(record)
    }

    /// Write one sibling resource inside a skill's own directory.
    ///
    /// A skill document may ship resources next to its `SKILL.md`
    /// (`references/<topic>.md`, `templates/<name>`, `scripts/<name>`,
    /// `assets/<name>`). That is how the background review appends what
    /// a session taught without rewriting the whole document — the same shape
    /// the imported Anthropic packages use, and the reason a review can be
    /// incremental instead of all-or-nothing.
    ///
    /// A flat `<id>.md` skill is promoted to `<id>/SKILL.md` first: a loose
    /// document has nowhere to keep siblings without dropping files next to
    /// every other skill in the same folder. The id is the directory name in the
    /// directory shape, so the promotion keeps the skill's identity.
    pub fn write_resource(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
        relative_path: &str,
        content: &str,
    ) -> Result<String> {
        let Some(record) = self.find(id, level, project_path)? else {
            bail!("SKILL_INVALID: no skill with id {id}");
        };
        let relative = normalize_resource_path(relative_path)?;
        let skills_dir = capability_dir(CapabilityLevel::Global, None, "skills")?;
        let document = PathBuf::from(&record.path);
        let root = match directory_skill_root(&document, &skills_dir) {
            Some(dir) => dir,
            None => {
                let parent = document.parent().ok_or_else(|| {
                    anyhow::anyhow!("SKILL_INVALID: skill has no parent directory")
                })?;
                let target_dir = parent.join(&record.id);
                fs::create_dir_all(&target_dir)?;
                fs::rename(&document, target_dir.join("SKILL.md"))
                    .with_context(|| format!("promote {}", document.display()))?;
                target_dir
            }
        };
        write_bytes(&root, &relative, content.as_bytes())
            .with_context(|| format!("write {} resource {relative}", record.id))?;
        Ok(relative)
    }

    /// Write one sibling resource from raw bytes.
    ///
    /// The merge path moves whatever the source skill shipped, and an asset is
    /// not text; sharing this with `write_resource` keeps one path rule and one
    /// symlink-free write for both callers.
    pub fn write_resource_bytes(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
        relative_path: &str,
        bytes: &[u8],
    ) -> Result<String> {
        let Some(record) = self.find(id, level, project_path)? else {
            bail!("SKILL_INVALID: no skill with id {id}");
        };
        let relative = normalize_resource_path(relative_path)?;
        let skills_dir = capability_dir(CapabilityLevel::Global, None, "skills")?;
        let document = PathBuf::from(&record.path);
        let root = match directory_skill_root(&document, &skills_dir) {
            Some(dir) => dir,
            None => {
                let parent = document.parent().ok_or_else(|| {
                    anyhow::anyhow!("SKILL_INVALID: skill has no parent directory")
                })?;
                let target_dir = parent.join(&record.id);
                fs::create_dir_all(&target_dir)?;
                fs::rename(&document, target_dir.join("SKILL.md"))
                    .with_context(|| format!("promote {}", document.display()))?;
                target_dir
            }
        };
        write_bytes(&root, &relative, bytes)
            .with_context(|| format!("write {} resource {relative}", record.id))?;
        Ok(relative)
    }

    /// Delete one sibling resource from a directory-shaped skill.
    ///
    /// The exact mirror of `write_resource`: same `<root>/<name>` path rule and
    /// the same promotion-free lookup, so a model-produced path can
    /// never reach outside the skill's own resource directory. Only the
    /// resource goes; the skill document and every other resource stay.
    pub fn remove_resource(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
        relative_path: &str,
    ) -> Result<String> {
        let Some(record) = self.find(id, level, project_path)? else {
            bail!("SKILL_INVALID: no skill with id {id}");
        };
        let relative = normalize_resource_path(relative_path)?;
        let skills_dir = capability_dir(CapabilityLevel::Global, None, "skills")?;
        let document = PathBuf::from(&record.path);
        let Some(root) = directory_skill_root(&document, &skills_dir) else {
            bail!("SKILL_INVALID: skill has no sibling resources");
        };
        let destination = root.join(&relative);
        if !destination.is_file() {
            bail!("SKILL_INVALID: no resource at {relative}");
        }
        fs::remove_file(&destination)
            .with_context(|| format!("remove {}", destination.display()))?;
        Ok(relative)
    }

    /// Import a Markdown skill from an external location.
    /// between the single-file (`<id>.md`) form and the Anthropic-style
    /// directory form (`<name>/SKILL.md` plus resources); when absent, a
    /// directory source is treated as `"dir"` and a regular file as `"file"`.
    /// `input.mode` chooses between `"copy"` (default, byte-for-byte replica)
    /// and `"link"` (symlink so external edits are picked up on next scan).
    /// The catalog cap and the per-document byte cap are enforced up front so a
    /// batch import never leaves partial state.
    pub fn import(&mut self, source: &str, input: UserSkillInput) -> Result<UserSkillRecord> {
        let source_path = PathBuf::from(source);
        let mode = ImportMode::parse(input.mode.as_deref())?;
        let shape = match input.shape.as_deref() {
            Some(value) => ImportShape::parse(value)?,
            None => {
                if source_path.is_dir() {
                    ImportShape::Dir
                } else if source_path.is_file() {
                    ImportShape::File
                } else {
                    bail!("SKILL_INVALID: import source does not exist");
                }
            }
        };
        let (level, project_path) = level_and_project(&input)?;
        let existing = self.list(level, project_path.as_deref())?;
        if existing.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        fs::create_dir_all(&directory)?;

        match shape {
            ImportShape::File => self.import_file(
                &source_path,
                &input,
                level,
                project_path.as_deref(),
                mode,
                &directory,
                &existing,
            ),
            ImportShape::Dir => self.import_dir(
                &source_path,
                &input,
                level,
                project_path.as_deref(),
                mode,
                &directory,
                &existing,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn import_file(
        &mut self,
        source_path: &Path,
        input: &UserSkillInput,
        level: CapabilityLevel,
        project_path: Option<&str>,
        mode: ImportMode,
        directory: &Path,
        existing: &[UserSkillRecord],
    ) -> Result<UserSkillRecord> {
        if !source_path.is_file() {
            bail!("SKILL_INVALID: import file source does not exist");
        }
        let raw = fs::read_to_string(source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        let (front, body) = parse_front_matter(&raw);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let fallback = path_stem_for_id(source_path);
        let name = clip(
            front.get("name").map(String::as_str).unwrap_or(&fallback),
            MAX_NAME_CHARS,
        );
        if name.is_empty() {
            bail!("SKILL_INVALID: the file needs a name");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| capability_id(&name, source_path, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: the file needs a name or a valid id");
        }
        if existing
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        let target = directory.join(format!("{id}.md"));
        place_file(source_path, &target, mode)?;
        self.finish_import(&id, level, project_path, input.enabled)
    }

    #[allow(clippy::too_many_arguments)]
    fn import_dir(
        &mut self,
        source_dir: &Path,
        input: &UserSkillInput,
        level: CapabilityLevel,
        project_path: Option<&str>,
        mode: ImportMode,
        directory: &Path,
        existing: &[UserSkillRecord],
    ) -> Result<UserSkillRecord> {
        if !source_dir.is_dir() {
            bail!("SKILL_INVALID: import directory source does not exist");
        }
        let skill_file = source_dir.join("SKILL.md");
        if !skill_file.is_file() {
            bail!("SKILL_INVALID: directory import needs a SKILL.md at the root");
        }
        let raw = fs::read_to_string(&skill_file)
            .with_context(|| format!("read {}", skill_file.display()))?;
        let (front, body) = parse_front_matter(&raw);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: SKILL.md is empty");
        }
        // Directory name is the natural fallback id; file stem "SKILL" is not.
        let dir_name = source_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let name = clip(
            front.get("name").map(String::as_str).unwrap_or(dir_name),
            MAX_NAME_CHARS,
        );
        if name.is_empty() {
            bail!("SKILL_INVALID: SKILL.md needs a name");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| {
                // Prefer the directory basename so nested resources keep their
                // relative paths intact under `<capability_dir>/skills/<id>/`.
                let fallback_path = source_dir.join(&name);
                capability_id(&name, &fallback_path, 64)
            });
        if !valid_id(&id) {
            bail!("SKILL_INVALID: the directory needs a name or a valid id");
        }
        if existing
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        let target_dir = directory.join(&id);
        if target_dir.exists() {
            bail!(
                "SKILL_INVALID: destination already exists: {}",
                target_dir.display()
            );
        }
        place_dir(source_dir, &target_dir, mode)?;
        self.finish_import(&id, level, project_path, input.enabled)
    }

    fn finish_import(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<UserSkillRecord> {
        if enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, id, project_path, false)?;
        }
        self.find(id, Some(level), project_path)?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: imported skill was not found"))
    }

    pub fn update(&mut self, id: &str, input: UserSkillInput) -> Result<Option<UserSkillRecord>> {
        let level = input
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?;
        let record = self.find(id, level, input.project_path.as_deref())?;
        let Some(record) = record else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        let (front, old_body) = parse_front_matter(&raw);
        let name = input
            .name
            .as_deref()
            .map(|value| clip(value, MAX_NAME_CHARS))
            .filter(|value| !value.is_empty())
            .or_else(|| front.get("name").cloned())
            .unwrap_or(record.name.clone());
        let description = match input.description.as_deref() {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(value, MAX_DESCRIPTION_CHARS)),
            None => record.description.clone(),
        };
        let body = input.body.unwrap_or(old_body);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let document = render_document(&name, description.as_deref(), &body);
        fs::write(&record.path, document)?;
        if let Some(enabled) = input.enabled {
            self.state.set_enabled(
                SKILL_KIND,
                record
                    .level
                    .as_deref()
                    .and_then(|value| CapabilityLevel::parse(Some(value)).ok())
                    .unwrap_or(CapabilityLevel::Global),
                id,
                record.project_path.as_deref(),
                enabled,
            )?;
        }
        self.find(id, level, record.project_path.as_deref())
    }

    pub fn read(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<(UserSkillRecord, String)>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    /// Read bounded sibling resources from a directory-shaped skill. The
    /// skill document itself is captured separately so its body can retain the
    /// existing update/import semantics.
    pub fn package_files(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        let Some(record) = self.find(id, Some(level), project_path)? else {
            return Ok(Vec::new());
        };
        let Some(root) = package_root(&record, level, project_path)? else {
            return Ok(Vec::new());
        };
        let mut result = Vec::new();
        let mut total = 0usize;
        collect_package_files(&root, &root, &mut result, &mut total)?;
        result.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(result)
    }

    /// Seed fixtures without overwriting existing resource contents.
    #[cfg(test)]
    pub fn write_package_files(
        &mut self,
        id: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
        files: &[(String, Vec<u8>)],
    ) -> Result<()> {
        let existing = self.package_files(id, level, project_path)?;
        let mut desired = existing
            .iter()
            .cloned()
            .collect::<std::collections::BTreeMap<_, _>>();
        for (path, bytes) in files {
            if desired.get(path).is_some_and(|old| old != bytes) {
                bail!("CONFIG_SYNC_CONFLICT: skill package resource was edited locally");
            }
            desired.insert(path.clone(), bytes.clone());
        }
        self.replace_package_files(
            id,
            level,
            project_path,
            &existing,
            &desired.into_iter().collect::<Vec<_>>(),
        )
    }

    pub fn remove(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<bool> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(false);
        };
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        let mut roots = vec![capability_dir(CapabilityLevel::Global, None, "skills")?];
        if record_level == CapabilityLevel::Project {
            if let Some(project) = record.project_path.as_deref() {
                if let Ok(dir) = capability_dir(CapabilityLevel::Project, Some(project), "skills") {
                    roots.push(dir);
                }
            }
        }
        delete_skill_files(&PathBuf::from(&record.path), &roots)?;
        let level = record_level;
        // The counters belonged to that document. Dropping them here is the
        // *intentional* delete; the scan's sweep covers files removed on disk.
        let owner = Some(
            record
                .project_path
                .as_deref()
                .unwrap_or_else(|| project_path.unwrap_or("")),
        )
        .filter(|path| !path.is_empty());
        self.usage.forget(level, &record.id, owner);
        // The origin belonged to that document too, and a same-named successor
        // must not inherit "the agent wrote this".
        self.origins.forget(level, &record.id, owner);
        let _ = self.find(id, Some(level), record.project_path.as_deref())?;
        Ok(true)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        self.state.set_enabled(
            SKILL_KIND,
            record_level,
            &record.id,
            project_path.or(record.project_path.as_deref()),
            enabled,
        )?;
        self.find(
            &record.id,
            Some(record_level),
            project_path.or(record.project_path.as_deref()),
        )
    }

    /// Record one load of a user skill.
    ///
    /// The id alone is enough to mean "the document the model would load": the
    /// lookup is the same one `read` uses, so a project document is recorded
    /// against its own project. A built-in or plugin skill is not in this
    /// library and returns `None` — the caller records what it can, and a load
    /// the library cannot identify costs nothing.
    pub fn record_use(
        &mut self,
        id: &str,
        project_path: Option<&str>,
    ) -> Result<Option<(UserSkillRecord, SkillUsage)>> {
        let Some(record) = self.find(id, None, project_path)? else {
            return Ok(None);
        };
        let level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        let owner_project = record.project_path.as_deref().or(project_path);
        let usage = self.usage.record(level, &record.id, owner_project)?;
        Ok(Some((record, usage)))
    }

    /// Merge one skill into another: move its resources under the umbrella, take
    /// it out of the catalog, and record where it went.
    ///
    /// Nothing is deleted. The absorbed document stays on disk with its own body,
    /// so an absorb the user regrets is one toggle away from being undone — which
    /// is the only reason this may act on a library without asking twice.
    /// Resources the umbrella already has are kept as the umbrella's and reported
    /// as skipped: a merge must never silently overwrite the document it merges
    /// *into*.
    pub fn absorb(
        &mut self,
        id: &str,
        into: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<AbsorbOutcome> {
        let Some(source) = self.find(id, level, project_path)? else {
            bail!("SKILL_INVALID: no skill with id {id}");
        };
        let Some(target) = self.find(into, level, project_path)? else {
            bail!("SKILL_INVALID: no skill with id {into}");
        };
        if source.id == target.id {
            bail!("SKILL_INVALID: a skill cannot absorb itself");
        }
        if source.level != target.level || source.project_path != target.project_path {
            bail!("SKILL_INVALID: merging across scopes is a transfer, not an absorb");
        }
        let scope = source
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        let source_project = source.project_path.as_deref();

        let existing: std::collections::HashSet<String> = self
            .package_files(&target.id, scope, target.project_path.as_deref())?
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        let mut copied = Vec::new();
        let mut skipped = Vec::new();
        for (path, bytes) in self.package_files(&source.id, scope, source_project)? {
            if path.eq_ignore_ascii_case("SKILL.md") {
                continue;
            }
            if existing.contains(&path) {
                skipped.push(path);
                continue;
            }
            self.write_resource_bytes(&target.id, Some(scope), source_project, &path, &bytes)?;
            copied.push(path);
        }

        self.set_enabled(&source.id, false, Some(scope), source_project)?;
        self.links.set(
            scope,
            &source.id,
            source_project,
            SkillLink {
                into: target.id.clone(),
                at: chrono::Utc::now().timestamp_millis(),
            },
        )?;

        Ok(AbsorbOutcome {
            absorbed: self.find(&source.id, Some(scope), source_project)?,
            into: self.find(&target.id, Some(scope), target.project_path.as_deref())?,
            copied,
            skipped,
        })
    }

    /// Pin or unpin one skill, so the maintenance pass leaves it alone.
    ///
    /// A pin is stored apart from activation: it says "keep this ready for me",
    /// not "this one is off", and the two must not overwrite each other.
    pub fn set_pinned(
        &mut self,
        id: &str,
        pinned: bool,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        self.pins.set(
            record_level,
            &record.id,
            record.project_path.as_deref().or(project_path),
            pinned,
        )?;
        self.find(
            &record.id,
            Some(record_level),
            record.project_path.as_deref(),
        )
    }

    /// Decide which skills stopped earning their place, and — when asked to act —
    /// switch the archivable ones off.
    ///
    /// Nothing is deleted and nothing is moved: "archived" is the same
    /// activation flag the row's toggle writes, so the user can bring a skill
    /// back from the settings page in one click. `dry_run` is the default at the
    /// RPC boundary and the only mode the daily pass uses.
    pub fn curate(
        &mut self,
        project_path: Option<&str>,
        policy: CuratorPolicy,
        dry_run: bool,
    ) -> Result<CurationReport> {
        let records = self.active_for(project_path)?;
        let mut report =
            crate::user_skills::curator::plan(&records, &self.usage, &self.origins, policy)?;
        report.dry_run = dry_run;
        if !dry_run {
            let archivable: Vec<(CapabilityLevel, String, Option<String>)> = report
                .entries
                .iter()
                .filter(|entry| entry.state == CurationState::Archive)
                .map(|entry| {
                    let level = CapabilityLevel::parse(Some(&entry.level))
                        .unwrap_or(CapabilityLevel::Global);
                    (level, entry.id.clone(), entry.project_path.clone())
                })
                .collect();
            for (level, id, owner) in archivable {
                self.state.set_enabled(
                    SKILL_KIND,
                    level,
                    &id,
                    owner.as_deref().or(project_path),
                    false,
                )?;
                report.archived.push(id);
            }
        }
        Ok(report)
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<UserSkillRecord>> {
        // Scope is no longer persisted in capability files. Keep this RPC
        // harmless for older callers and return the scanned record.
        let _ = scope;
        self.find(id, None, None)
    }
}

/// Does this marker claim "the agent wrote it"?
///
/// Only the explicit word counts, and case does not matter: a caller that
/// capitalized the constant still made the same claim. Everything else — a
/// missing field, `"user"`, `"imported"`, a typo — reads as "a person wrote
/// this", which is the side that never archives a document.
fn agent_authored(created_by: Option<&str>) -> bool {
    created_by
        .map(str::trim)
        .is_some_and(|author| author.eq_ignore_ascii_case(AGENT_AUTHOR))
}

fn scope_for(level: CapabilityLevel, project_path: Option<&str>) -> ActivationScope {
    match level {
        CapabilityLevel::Global => ActivationScope::default(),
        CapabilityLevel::Project => ActivationScope {
            mode: crate::activation::ActivationMode::Projects,
            projects: project_path.into_iter().map(str::to_string).collect(),
        },
    }
}

pub mod curator;
pub mod links;
pub mod origin;
mod package_sync;
/// Package bounds are asserted in their own module: `tests.rs` is close to the
/// rust file-size limit, and these tests share one fixture.
#[cfg(test)]
mod package_tests;
pub mod pins;
pub mod tidy;
mod usage;

#[cfg(test)]
mod tests;
