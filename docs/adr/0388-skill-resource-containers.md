# ADR 0388: A skill owns four resource containers

- Status: Accepted
- Date: 2026-11-09
- Related: [ADR 0379](0379-skill-authoring-is-a-core-tool.md), [ADR 0303](0303-skill-package-resource-limits.md), [ADR 0387](0387-skill-curation-by-idle-days.md)

## Context

`skills.writeFile` accepted exactly `references/<name>.md`. That rule was written
when a skill was prose only: notes the model reads on demand, nothing else. It is
also a security boundary the background review depends on — the path comes from a
model, so the host must decide what it may touch rather than normalise a
surprising path into a safe-looking one.

A real skill is not always prose. Hermes skills ship `templates/` (files a
workflow fills in), `scripts/` (programs a workflow inspects and runs), and
`assets/` (data, schemas, fixtures). A library that refuses all three forces the
workflow to inline a script into markdown, which then has to be copied out by
hand before it can be run — the exact step a skill exists to remove.

## Decision

The writable roots are `references/`, `templates/`, `scripts/` and `assets/`,
each `<root>/<name>`, one level deep, no `.`/`..` segment, no absolute path.

- `references/` keeps its markdown-only rule. Its contents are read into the
  model's context, and a binary blob there is a token bill nobody chose.
- The other three accept any file name, because a template, a script or a data
  file is whatever the task needs.
- **The host never executes anything it stores.** `scripts/` is a place to keep a
  program, not a runtime: the agent inspects it with `Read` and runs it through
  `Bash` like any other file, where the permission model already applies.
- The `Skill` tool's result lists every file under the four roots (references
  first), so a document that says "run `scripts/collect.ps1`" no longer leaves the
  model guessing a name or globbing a directory.

## Consequences

- Packages imported from other agents keep working: their `references/` are
  unchanged, and their extra folders are now addressable rather than inert.
- `skills.tidy` still speaks about references only (an empty or byte-identical
  twin). Extending it to the other containers is a later pass, not part of this
  decision.
- The model can write a file that looks like a program. That is not new — `Write`
  already does it anywhere in the workspace — and it is bounded the same way: the
  host stores bytes, `Bash` is the thing that executes, and it carries the
  permission decision.
