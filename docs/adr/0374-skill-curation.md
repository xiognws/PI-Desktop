# ADR 0374: Skill curation proposes, archives, never deletes

- Status: Accepted
- Date: 2026-10-29
- Related: ADR 0373, ADR 0371, spec `04-ux/06-settings-ia.md`, `03-runtime/01-ipc-protocol.md`

## Context

A learned skill library only grows. Nothing in the product decided that a skill
had become redundant: `skill_manage` creates and patches, the user can remove a
row by hand, and `MAX_ACTIVE` caps how many documents load at once — but the
catalog itself was never reviewed. Two failure modes followed.

1. The same procedure gets learned twice under two names, because the agent
   writes a fresh document instead of finding the one it already has.
2. A procedure learned once for a single task stays in the catalog forever,
   costing context in every project it is offered in.

Both are curation problems, and both have a cheap deterministic answer that does
not need a model. What they do not have is a cheap *destructive* answer: a
deleted skill is a procedure the user paid for, and a bad merge rewrites their
own words.

The learning plugin (`cn.star.skill-learning`) already records an activity
ledger — `use_count`, `patch_count`, `pinned`, `last_activity_at` — beside the
library at `<skills root>/.skill-learning/usage.json`. That is enough to tell
"unused" from "used", which is the only signal an archive decision needs.

## Decision

1. Curation is a **host** capability, not a plugin one. Plugin files under
   `apps/desktop/resources/plugins/` are not tracked by git and are re-delivered
   by the marketplace, so a rule that lives there is neither reviewable nor
   durable. The decision function is `crates/host-core/src/user_skills/curator.rs`.
2. The planner is a **pure function**: catalog rows, the activity ledger, a
   policy, and `now`. It reads no clock and touches no filesystem, so a plan is
   reproducible and unit-testable without fixtures.
3. Archiving is proposed for exactly two findings — a **duplicate** of a
   higher-ranked row, and an **idle** row past the policy window with zero uses.
   A **thin** document and a **pinned** row are reported and never archived, so
   a first sweep on an existing library cannot empty it.
4. Duplicate detection is vocabulary overlap (Jaccard over the name and
   description tokens) against a configurable threshold, default 0.72. The
   keeper is chosen by `use_count`, then newest `updated_at`, then document
   size, then id — every tie broken deterministically.
5. Archive is a **move into `<data>/skills-archive/<timestamp>-<id>/`, recorded
   in `<data>/agent-capabilities/skill-archive.json`, and restore puts the exact
   tree back**. A directory-shaped skill moves as one unit, sibling resources
   included. A restore whose original path is occupied refuses with
   `SKILL_ARCHIVE_CONFLICT` instead of overwriting.
6. No automatic merge. Merging two procedures rewrites user content, so it needs
   a model and a review step; it belongs with the memory extraction work that
   follows this, not with a deterministic sweep.
7. The Settings Skills page opens the proposal on demand — the plan is never
   cached, because age and usage move — and offers one Archive button per
   proposed row plus Restore on every archived entry, including the ones already
   restored so the history stays auditable.

## Consequences

- A library can be swept without any risk of loss: the only destructive-looking
  action is a reversible move, and the archive index is the audit log.
- A skill the ledger never recorded is aged by its own document timestamp, so a
  library that predates the plugin still curates.
- The plugin's ledger is read, never written: the host owns the decision, the
  plugin keeps owning the activity record.
- Automatic merge and decay of *memory* stay open. This ADR deliberately stops at
  archive, because that is the largest change that needs no model call and no
  irreversible write.
