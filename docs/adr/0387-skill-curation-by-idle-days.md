# ADR 0387: Skill curation by idle days

- Status: Accepted
- Date: 2026-11-09
- Related: [ADR 0377](0377-skill-learning-in-core.md), [ADR 0379](0379-skill-authoring-is-a-core-tool.md), [ADR 0371](0371-memory-store.md)

## Context

The library grows on its own: the agent writes skills during a turn
(`skill_manage`) and after one (the review fork), so nothing decides when a
document has stopped earning its place. Hermes answers this with a curator that
moves unused skills to an archive on an inactivity schedule; until now the
library here had no usage signal at all, so "unused" could not even be defined.

Skill usage is now counted (`skills.recordUse`, ADR 0387's prerequisite): every
`Skill` load bumps a per-skill count and timestamp, and `skills.list` carries
them. That makes an idle-day rule expressible for the first time.

## Decision

Curation is a **deterministic** pass over user skills, in
`crates/host-core/src/user_skills/curator.rs`:

| State | Condition |
| --- | --- |
| `archive` | idle ≥ `archiveAfterDays` (default 90) |
| `stale` | idle ≥ `staleAfterDays` (default 30) |
| `keep` | otherwise |

"Idle" is measured from the last load, or from the document's own timestamp when
nothing ever loaded it. Editing a document moves its timestamp, so a skill that
was just improved is not idle.

Three properties are deliberate:

1. **Default is a dry run.** `skills.curate` reports unless the caller passes
   `dryRun: false`. The settings page reads the report on load and only the
   person's own click acts.
2. **Archiving is deactivation, never deletion.** The pass writes the same
   activation flag the row's toggle writes, so one click in the settings page
   brings the skill back. Nothing on disk is touched.
3. **Nothing runs on a timer.** Curation happens when somebody opens the skills
   page (a dry run) and clicks the archive button. A skill that vanishes from the
   catalog because a background timer fired is indistinguishable, from the user's
   side, from a bug or a lost file, and this app has no "why did this turn off"
   surface to explain it — so the pass has one caller: the page in front of the
   person making the decision.

## Consequences

- The library can be tidied without a model call, so the pass is cheap enough to
  run on every page load and testable as pure functions (`classify`, `plan`).
- A skill the user turned off by hand is indistinguishable from an archived one.
  That is acceptable: both mean "not in the catalog right now", and both are one
  toggle away.
- Project-scoped and global documents are classified separately, because they
  are separate records in the store and in usage.
- **Not ported yet:** Hermes' optional AI consolidation fork (merging overlapping
  skills into one umbrella) and a pin that exempts a skill from every
  transition. Neither has a UI here, and a merge the user cannot review would be
  a worse outcome than a library that stays slightly redundant. Both belong in a
  later pass once an archive/restore view exists.
