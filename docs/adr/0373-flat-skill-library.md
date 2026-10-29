# ADR 0373: One flat skill library — skills have no project level

- Status: Accepted
- Date: 2026-10-28
- Related: ADR 0372, ADR 0056, ADR 0011, spec `04-ux/06-settings-ia.md`, `03-runtime/04-data-storage.md`

## Context

Skills shipped as a two-level catalog: a global directory (`~/.agents/skills`)
and a project directory (`<project>/.agents/skills`), with a project row able
to shadow a global row of the same id, plus a `skills.transfer` move between the
two and a per-project enablement override.

That model fits capabilities a repository owns and reviews with the code — MCP
servers, subagents — because the project file travels with the checkout. A skill
is different: it is a procedure the agent carries from task to task, and the
same procedure is wanted in every project. In practice the project level
produced three problems.

1. The catalog was split in two for no benefit. A user who taught the agent
   something had to answer "global or this project?" on every save, and the
   wrong answer silently hid the skill from every other project.
2. A project skill is a file inside the repository, so it showed up in diffs
   and reviews of projects that never meant to vendor it.
3. Two rows could carry the same id, so every read path needed a shadow rule
   and every write path needed to know which of the two it meant.

The agent does not need a level to find a skill: it searches a catalog by name
and description. One directory answers that search as well as two.

## Decision

1. The skill catalog is one flat directory, resolved once from the host
   capability root: `capability_dir(CapabilityLevel::Global, "skills")`. The
   installed build repoints that root to `<data root>/agents/skills` (ADR 0372);
   a development build reads `~/.agents/skills`.
2. `active_for()` scans only the global level. `find()` takes a flat id. There
   is no merge, no shadowing, and no per-project enablement override, so
   `merge_active_records()` is gone.
3. `skills.create` and `skills.import` refuse `level: "project"` with
   `SKILL_PROJECT_LEVEL_REMOVED` rather than downgrading to global. A caller
   that asked to write into a project must not be told the write succeeded in a
   directory it did not name.
4. `skills.transfer` keeps its entry point and refuses a project endpoint with
   the same code. The RPC surface is unchanged, so an older renderer gets a
   stated error instead of a wrong write.
5. `skills.list` and `skills.setEnabled` parse their level through a
   skills-only `parse_skill_query()`. MCP and subagents keep
   `parse_capability_query()` and their project level: a different project
   using a different MCP server is a real product case, and flattening it would
   be a separate change of a different size.
6. The Settings Skills page drops the project picker, the project group, the
   level badge beyond Global, and the Move menu item. `CapabilityToolbar` gained
   an optional `levels` list (default all three) so the Skills page offers only
   All and Global while MCP keeps all three; the toolbar itself stays shared.

## Consequences

- A learned skill is available in every project with no decision at save time,
  and one directory is the entire catalog: no shadow rule, one enabled bit per
  id, no path resolution against a project root.
- Existing project skills are not migrated. A `<project>/.agents/skills`
  directory simply stops being read; the files stay where the repository put
  them. Users who want a project skill keep the document and import it into the
  global library, which is one menu action.
- The `CapabilityLevel` type still has `Project` because MCP and subagents use
  it. The skills page, the skills RPC parsing, and the skills registry are the
  three places that enforce the flat rule.
- Config sync follows the flat rule on both ends: capture walks the global
  library once instead of every registered project, and apply forces the global
  level so a bundle written by an older build still lands in the one directory
  the catalog reads. A project-scoped skill that two projects once shared can
  therefore collide on id during that apply; the later document wins.
- Tests that pinned "a project row shadows a global row" now pin the opposite
  invariant: the registry has no merge, and a project request is refused.
