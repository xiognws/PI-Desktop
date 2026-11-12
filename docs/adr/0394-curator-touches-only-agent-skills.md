# ADR 0394: The maintenance pass touches only skills the agent wrote

- Status: Accepted
- Date: 2026-11-12
- Related: [ADR 0387](0387-skill-curation-by-idle-days.md), [ADR 0377](0377-skill-learning-in-core.md), [ADR 0379](0379-skill-authoring-is-a-core-tool.md), [ADR 0389](0389-skill-consolidation-by-absorb.md)

## Context

ADR 0387 gave the library an idle-day rule: `archive` past 90 idle days, `stale`
past 30, `keep` otherwise, with a pin as the way to opt one skill out. The rule
is applied to **every** record the library lists.

That is wrong for a library with two kinds of document. Some skills the agent
wrote while working (`skill_manage`, the review fork). Others a person wrote by
hand, or imported from a source they trust. Idle days say nothing about whether
hand-written work still matters: a deployment procedure consulted twice a year
is doing its job precisely by being quiet, and reporting it as "archivable"
invites the one click that takes a person's own document out of the catalog.

Hermes, whose curator this pass is modelled on, does not have this problem
because its rule is narrower: the curator manages only the skills the agent
itself created, marked explicitly on the record (`created_by: agent`), it only
ever archives and never deletes, and pinned skills are exempt. Ownership decides
what may be retired; age only decides when.

## Decision

1. **Origin is recorded, never inferred.** A new store,
   `crates/host-core/src/user_skills/origin.rs`, keeps
   `<data>/agent-capabilities/skill-origins.json` — the same shape, key (level +
   id + normalized project path), whole-file write, and corrupt-file tolerance as
   `skill-pins.json`. It sits beside the pin store in `UserSkillRegistry` and is
   swept by the scan (`retain`) and on an intentional delete (`forget`).
2. **`createdBy: "agent"` is the only claim.** `UserSkillInput` gains
   `created_by`; `skills.create` passes it through (it already deserializes the
   whole payload, so no second parsing path appears) and `create` records the
   origin when the marker is exactly `agent`, case-insensitively. Absence, a
   typo, or any other value means a person wrote it. `update` ignores the field:
   an origin is recorded once and is not rewritten by an edit.
3. **Curation classifies by ownership first.** `curator::plan` reports a
   non-agent-authored document as `keep` with
   `reason: "not-agent-authored"` whatever its idle days, and never as
   `stale`/`archive`; the dry run and the acting run both read the same
   classification. `CurationEntry` gains `reason`
   (`idle` / `pinned` / `not-agent-authored`), because `state` alone could not
   explain a skill that stays despite its age. A pin still wins over everything
   and keeps its existing behaviour.
4. **The failure direction is "keep".** A missing or unreadable origins file
   reads as "nothing is agent authored", so the pass leaves the library alone
   rather than guessing. Every document that predates this file is therefore
   uncurated until something records it — an uncurated library is a nuisance, an
   archived hand-written skill is a loss.

## Consequences

- The idle-day rule now applies to the documents whose lifecycle the agent
  actually owns, which is what makes the one-click archive button safe to keep
  in the settings page.
- **Existing libraries stop being curated** for skills created before this
  release, and for skills created through the UI without the marker. That is
  intended: the alternative is a heuristic ("this one looks machine-written")
  deciding whether a person's document gets retired.
- Only `agent-runtime`'s `skill_manage` tool sends the marker, so a skill
  created by a person through the settings page is theirs to retire, and a skill
  the agent wrote stays the pass's even after a person edits it.
- `packages/shared`'s `SkillCurationEntry` type does not yet carry `reason`; the
  field is additive on the wire and the settings page ignores it. Typing it is a
  follow-up, not a contract change.
- Still not ported from Hermes: deleting rather than archiving, and an
  AI-consolidation fork. Both stay out until there is a surface to review them.
