//! The skill catalog and the tool that loads one.
//!
//! Upstream counterpart: `tools/skills_tool.py` and the catalog block of
//! `agent/system_prompt.py`. Desktop counterpart: `plugin-skills.ts`,
//! `plugin-skills-prompt.ts`, `skill-tool.ts`, `skill-catalog-budget.ts`.
//!
//! The split of responsibility is the design, not an accident:
//!
//! * The **catalog** — id, name, description — travels in the system prompt, so
//!   the model can only reach for a skill it knows exists.
//! * The **body** is loaded on demand through the `Skill` tool, so a long
//!   document costs nothing until it is needed.
//! * The **documents** belong to the host. The kernel answers the listing (it
//!   already holds the catalog) and forwards an id lookup to the host tool that
//!   reads the file, so a permission or scope check never lives in two places.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::message::ToolCall;
use crate::provider::BoxFuture;
use crate::tool::{Tool, ToolContext, ToolSpec};

/// Name of the tool that loads a skill document.
pub const SKILL_TOOL_NAME: &str = "Skill";

/// Characters of a description the catalog shows.
///
/// The reference implementation carries the same figure as an authoring standard ("one sentence, 60
/// characters or fewer") because the index truncates there and the index is paid
/// for on every turn. Without a cap one verbose description costs more than the
/// six entries around it, and the body is one `Skill` call away.
pub const SKILL_DESCRIPTION_INDEX_CHARS: usize = 60;

/// What the catalog may cost before the app says something about it.
///
/// Measured on a real library: one entry is ~123 characters, so 50 skills is
/// ~1.8k tokens per turn and 200 skills is ~7k, before a single tool call.
pub const SKILL_CATALOG_BUDGET_CHARS: usize = 8_000;

/// Key prefix of one catalog entry, kept stable so a future incremental prompt
/// update can append only the entry that changed.
pub const SKILL_SECTION_PREFIX: &str = "skill:";

/// Separator, backticks and the em dash an entry carries beyond its text.
const ENTRY_OVERHEAD_CHARS: usize = 6;

/// The sentence a session with no library answers a bare `Skill` call with.
pub const EMPTY_LIBRARY_NOTICE: &str = "The skill library is empty: no skill documents exist yet. Create the first one with `skill_manage` action `create`.";

/// The sentence an id lookup answers with when no loader was published.
pub const NO_LIBRARY_NOTICE: &str = "No skill library is available in this session.";

const SKILL_TOOL_DESCRIPTION: &str = "\
Load one skill's full instructions from the library listed in the Skills section of your system prompt.

Call it with no `id` to list the library as it stands now (id, name, description): the Skills section is a snapshot taken at session start, so a skill created since then is only visible here. Call it with an `id` to get that skill's document, its location, and its reference files.

The library is host-owned: this listing is the whole of it. Do not search the filesystem for skill directories to find out what exists.

When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.";

const SKILLS_HEADER_BODY: &str = "\
Skills available to you, from plugins and from your own library. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.

When a turn teaches you something reusable — a procedure, a pitfall, a decision rule — record it before you finish, with `skill_manage`: `create` for a new skill, `patch` to extend one you already have, or `write_file` to add `references/<topic>.md` beside it. Capture the rule rather than the afternoon, and prefer patching an existing skill over creating a near-duplicate.";

/// One catalog entry as the model sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDef {
    /// `<pluginDir>/<skillId>` for a plugin skill, the bare id for a user skill:
    /// the exact string the `Skill` tool expects.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

impl SkillDef {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        description: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description,
        }
    }

    /// Read one wire entry. An entry without an id or a name is dropped rather
    /// than repaired: the model addresses skills by id, so an entry it cannot
    /// name is one it cannot load.
    pub fn from_value(value: &Value) -> Option<Self> {
        let id = value.get("id")?.as_str()?.trim();
        let name = value.get("name")?.as_str()?.trim();
        if id.is_empty() || name.is_empty() {
            return None;
        }
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        Some(Self {
            id: id.to_string(),
            name: name.to_string(),
            description,
        })
    }
}

/// Parse the `pluginSkills` field of a prompt.
///
/// Sorted by id because the ordering is what makes the prompt prefix stable
/// across turns — a provider's prompt cache is keyed on it — and deduplicated
/// because two plugins claiming one id would otherwise appear twice, with the
/// second copy unreachable.
pub fn parse_catalog(value: Option<&Value>) -> Vec<SkillDef> {
    let Some(entries) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut skills: Vec<SkillDef> = Vec::new();
    for entry in entries {
        let Some(skill) = SkillDef::from_value(entry) else {
            continue;
        };
        if skills.iter().any(|seen| seen.id == skill.id) {
            continue;
        }
        skills.push(skill);
    }
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    skills
}

/// Stable fingerprint of a catalog, so a caller can tell whether the prompt has
/// to be rebuilt. Bodies are excluded: they are read on each `Skill` call.
pub fn digest(skills: &[SkillDef]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let triples: Vec<Value> = skills
        .iter()
        .map(|skill| {
            json!([
                skill.id,
                skill.name,
                skill.description.clone().unwrap_or_default()
            ])
        })
        .collect();
    Value::Array(triples).to_string()
}

/// One catalog line: ``- `id` — Name: description``, with the description cut at
/// [`SKILL_DESCRIPTION_INDEX_CHARS`].
pub fn entry(skill: &SkillDef) -> String {
    let raw = skill.description.as_deref().unwrap_or("").trim();
    let description = if raw.chars().count() > SKILL_DESCRIPTION_INDEX_CHARS {
        let kept: String = raw
            .chars()
            .take(SKILL_DESCRIPTION_INDEX_CHARS - 1)
            .collect();
        format!("{}…", kept.trim_end())
    } else {
        raw.to_string()
    };
    if description.is_empty() {
        format!("- `{}` — {}", skill.id, skill.name)
    } else {
        format!("- `{}` — {}: {}", skill.id, skill.name, description)
    }
}

fn entry_chars(skill: &SkillDef) -> usize {
    skill.id.chars().count()
        + skill.description.as_deref().unwrap_or("").chars().count()
        + ENTRY_OVERHEAD_CHARS
}

/// Characters the catalog costs in the prompt.
pub fn catalog_chars(skills: &[SkillDef]) -> usize {
    skills.iter().map(entry_chars).sum()
}

/// What the catalog costs, and whether that cost has stopped being free.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkillCatalogBudget {
    pub chars: usize,
    pub limit: usize,
    pub skills: usize,
    /// Over the limit. Reported, never acted on: a skill silently dropped from
    /// the catalog is worse than an expensive one, because the model cannot ask
    /// for what it cannot see.
    pub over: bool,
}

pub fn catalog_budget(skills: &[SkillDef], limit: usize) -> SkillCatalogBudget {
    let chars = catalog_chars(skills);
    SkillCatalogBudget {
        chars,
        limit,
        skills: skills.len(),
        over: chars > limit,
    }
}

/// The Skills section, or `None` when the library is empty.
pub fn prompt_section(skills: &[SkillDef]) -> Option<String> {
    if skills.is_empty() {
        return None;
    }
    let entries: Vec<String> = skills.iter().map(entry).collect();
    Some(format!(
        "# Skills\n\n{SKILLS_HEADER_BODY}\n\n{}",
        entries.join("\n")
    ))
}

/// Sections keyed by stable name: `skills` for the header, `skill:<id>` for one
/// entry. A caller that appends incrementally uses these keys.
pub fn sections(skills: &[SkillDef]) -> Vec<(String, String)> {
    let Some(section) = prompt_section(skills) else {
        return Vec::new();
    };
    // The header section carries the prose only; entries are separate so an
    // update can replace one line instead of the whole block.
    let header = section
        .split_once("\n\n")
        .map(|(_, rest)| {
            rest.rsplit_once("\n\n")
                .map(|(prose, _)| format!("# Skills\n\n{prose}"))
                .unwrap_or_else(|| section.clone())
        })
        .unwrap_or_else(|| section.clone());
    let mut out = vec![("skills".to_string(), header)];
    for skill in skills {
        out.push((format!("{SKILL_SECTION_PREFIX}{}", skill.id), entry(skill)));
    }
    out
}

/// The library as the model can read it *now*.
///
/// The Skills section is a snapshot frozen at session start, so a skill created
/// mid-session is not in it. A `Skill` call with no id answers from the live
/// catalog instead.
pub fn library_listing(skills: &[SkillDef]) -> String {
    if skills.is_empty() {
        return EMPTY_LIBRARY_NOTICE.to_string();
    }
    let mut lines = vec![
        format!(
            "# Skill library ({} skill{})",
            skills.len(),
            if skills.len() == 1 { "" } else { "s" }
        ),
        String::new(),
        "This is the live library. The Skills section of your system prompt is a snapshot taken at session start, so a skill created since then appears only here.".to_string(),
        String::new(),
    ];
    lines.extend(skills.iter().map(entry));
    lines.join("\n")
}

/// The catalog this session was launched with, shared with the `Skill` tool.
///
/// A prompt refreshes it in place, so a tool call that lands mid-turn sees the
/// catalog the turn started with rather than a stale copy from an earlier turn.
#[derive(Debug, Default)]
pub struct SkillCatalog {
    skills: Mutex<Vec<SkillDef>>,
}

impl SkillCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn replace(&self, skills: Vec<SkillDef>) {
        if let Ok(mut current) = self.skills.lock() {
            *current = skills;
        }
    }

    pub fn snapshot(&self) -> Vec<SkillDef> {
        self.skills
            .lock()
            .map(|skills| skills.clone())
            .unwrap_or_default()
    }

    pub fn is_empty(&self) -> bool {
        self.snapshot().is_empty()
    }
}

/// The `Skill` tool.
///
/// A listing is answered here; an id lookup is forwarded to `load`, which is the
/// host's own `Skill` handler. A session with no catalog and no loader still gets
/// an answer — "no library" — instead of a schema rejection, which is what the
/// background review needs when its job is to create the first skill.
pub struct SkillTool {
    catalog: Arc<SkillCatalog>,
    load: Option<Arc<dyn Tool>>,
}

impl SkillTool {
    pub fn new(catalog: Arc<SkillCatalog>, load: Option<Arc<dyn Tool>>) -> Self {
        Self { catalog, load }
    }
}

impl Tool for SkillTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec::new(
            SKILL_TOOL_NAME,
            SKILL_TOOL_DESCRIPTION,
            json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Skill id exactly as listed in the Skills section. Omit the id entirely to list the library."
                    }
                },
                "additionalProperties": false
            }),
        )
    }

    fn call<'a>(
        &'a self,
        call: &'a ToolCall,
        ctx: &'a ToolContext,
    ) -> BoxFuture<'a, crate::Result<String>> {
        let id = call
            .arguments
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            let listing = library_listing(&self.catalog.snapshot());
            return Box::pin(async move { Ok(listing) });
        }
        match &self.load {
            Some(load) => load.call(call, ctx),
            None => Box::pin(async move { Ok(NO_LIBRARY_NOTICE.to_string()) }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(id: &str, name: &str, description: Option<&str>) -> SkillDef {
        SkillDef::new(id, name, description.map(str::to_string))
    }

    fn catalog() -> Vec<SkillDef> {
        vec![
            skill("pi/one", "One", Some("does the first thing")),
            skill("two", "Two", None),
        ]
    }

    #[test]
    fn a_wire_catalog_is_sorted_by_id_and_deduplicated() {
        let parsed = parse_catalog(Some(&json!([
            {"id": "two", "name": "Two"},
            {"id": "pi/one", "name": "One", "description": "does one thing"},
            {"id": "two", "name": "Two again"},
        ])));
        let ids: Vec<&str> = parsed.iter().map(|skill| skill.id.as_str()).collect();
        assert_eq!(ids, vec!["pi/one", "two"], "sorted, one entry per id");
        assert_eq!(parsed[1].name, "Two", "the first claim on an id wins");
    }

    #[test]
    fn an_entry_without_an_id_or_a_name_is_dropped() {
        let parsed = parse_catalog(Some(&json!([
            {"name": "no id"},
            {"id": "no-name"},
            {"id": "  ", "name": "blank id"},
            {"id": "ok", "name": "Fine", "description": ""},
        ])));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "ok");
        assert_eq!(
            parsed[0].description, None,
            "an empty description is no description"
        );
    }

    #[test]
    fn a_missing_catalog_field_is_an_empty_catalog() {
        assert!(parse_catalog(None).is_empty());
        assert!(parse_catalog(Some(&json!("not a list"))).is_empty());
    }

    #[test]
    fn a_long_description_is_cut_at_the_index_cap() {
        let long = "x".repeat(120);
        let rendered = entry(&skill("pi/long", "Long", Some(&long)));
        let description = rendered
            .split_once(": ")
            .expect("a description separator")
            .1;
        assert_eq!(
            description.chars().count(),
            SKILL_DESCRIPTION_INDEX_CHARS,
            "60 characters including the ellipsis"
        );
        assert!(description.ends_with('…'));
    }

    #[test]
    fn an_entry_without_a_description_is_just_id_and_name() {
        assert_eq!(entry(&skill("two", "Two", None)), "- `two` — Two");
    }

    #[test]
    fn the_catalog_section_lists_every_entry_under_the_header() {
        let section = prompt_section(&catalog()).expect("a section");
        assert!(section.starts_with("# Skills\n\n"));
        assert!(section.contains("- `pi/one` — One: does the first thing"));
        assert!(section.contains("- `two` — Two"));
        assert!(prompt_section(&[]).is_none(), "an empty library is silent");
    }

    #[test]
    fn sections_are_keyed_by_entry_id_for_incremental_updates() {
        let named = sections(&catalog());
        let keys: Vec<&str> = named.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, vec!["skills", "skill:pi/one", "skill:two"]);
        assert!(named[0].1.contains("Skills available to you"));
        assert_eq!(named[1].1, "- `pi/one` — One: does the first thing");
    }

    #[test]
    fn the_budget_reports_a_library_that_has_stopped_being_free() {
        let small = catalog_budget(&catalog(), SKILL_CATALOG_BUDGET_CHARS);
        assert!(!small.over);
        assert_eq!(small.skills, 2);
        assert_eq!(small.chars, catalog_chars(&catalog()));

        // Same catalog, a limit under what it costs: the gate reports, and does
        // not trim the entries it was given.
        let tight = catalog_budget(&catalog(), 10);
        assert!(tight.over);
        assert_eq!(tight.skills, 2);
    }

    #[test]
    fn the_digest_changes_only_when_the_catalog_does() {
        assert_eq!(digest(&[]), "");
        let one = vec![skill("a", "A", Some("first"))];
        let same = vec![skill("a", "A", Some("first"))];
        assert_eq!(digest(&one), digest(&same));
        let changed = vec![skill("a", "A", Some("second"))];
        assert_ne!(digest(&one), digest(&changed), "a new description rebuilds");
    }

    #[test]
    fn the_listing_answers_from_the_live_catalog() {
        assert_eq!(library_listing(&[]), EMPTY_LIBRARY_NOTICE);
        let listing = library_listing(&catalog());
        assert!(listing.starts_with("# Skill library (2 skills)"));
        assert!(listing.contains("- `two` — Two"));
        let single = library_listing(&catalog()[1..]);
        assert!(
            single.starts_with("# Skill library (1 skill)"),
            "no plural s"
        );
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

    fn call(arguments: Value) -> ToolCall {
        ToolCall {
            id: "call_1".into(),
            name: SKILL_TOOL_NAME.into(),
            arguments: arguments.clone(),
            raw_arguments: Some(arguments.to_string()),
        }
    }

    /// Stands in for the host's own `Skill` handler.
    struct Loader;

    impl Tool for Loader {
        fn spec(&self) -> ToolSpec {
            ToolSpec::new(SKILL_TOOL_NAME, "host loader", json!({"type": "object"}))
        }

        fn call<'a>(
            &'a self,
            call: &'a ToolCall,
            _ctx: &'a ToolContext,
        ) -> BoxFuture<'a, crate::Result<String>> {
            let id = call.arguments["id"].as_str().unwrap_or("").to_string();
            Box::pin(async move { Ok(format!("document body for {id}")) })
        }
    }

    #[tokio::test]
    async fn a_bare_skill_call_lists_the_library_without_reaching_the_host() {
        let catalog = Arc::new(SkillCatalog::new());
        catalog.replace(catalog_under_test());
        // A loader that would panic if it were called: the listing is local.
        let tool = SkillTool::new(catalog, Some(Arc::new(Loader)));
        let listing = tool
            .call(&call(json!({})), &context())
            .await
            .expect("a listing");
        assert!(listing.contains("- `pi/one` — One"));
    }

    fn catalog_under_test() -> Vec<SkillDef> {
        catalog()
    }

    #[tokio::test]
    async fn an_id_lookup_goes_to_the_host_loader() {
        let catalog = Arc::new(SkillCatalog::new());
        catalog.replace(catalog_under_test());
        let tool = SkillTool::new(catalog, Some(Arc::new(Loader)));
        let body = tool
            .call(&call(json!({"id": "pi/one"})), &context())
            .await
            .expect("a document");
        assert_eq!(body, "document body for pi/one");
    }

    #[tokio::test]
    async fn a_session_without_a_loader_says_so_instead_of_failing_the_turn() {
        let tool = SkillTool::new(Arc::new(SkillCatalog::new()), None);
        let answer = tool
            .call(&call(json!({"id": "pi/one"})), &context())
            .await
            .expect("an answer, not an error");
        assert_eq!(answer, NO_LIBRARY_NOTICE);
        let listing = tool
            .call(&call(json!({})), &context())
            .await
            .expect("a listing");
        assert_eq!(listing, EMPTY_LIBRARY_NOTICE);
    }

    #[test]
    fn the_tool_spec_makes_the_id_optional() {
        let tool = SkillTool::new(Arc::new(SkillCatalog::new()), None);
        let spec = tool.spec();
        assert_eq!(spec.name, SKILL_TOOL_NAME);
        let schema = &spec.parameters;
        assert!(schema["properties"]["id"].is_object());
        let required = schema.get("required");
        assert!(
            required.is_none(),
            "a bare call has to be schema-valid: {schema}"
        );
    }
}
