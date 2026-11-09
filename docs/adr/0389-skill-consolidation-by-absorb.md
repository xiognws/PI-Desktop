# ADR 0389 — Consolidating skills by absorbing one into another

Status: Accepted
Date: 2026-11-09

## Context

A skill library grows by accretion. The model is told to patch an existing
document rather than create a near-duplicate, but the rule is a heuristic and
the library still accumulates two documents covering one topic: "fix the
Windows file lock" and "rename a locked directory on Windows" are the same
procedure seen twice.

Nothing in the library could express "these became one". A person could delete
one of them, which loses whatever only it knew, or keep both, which leaves the
model choosing between two documents that disagree. The curator (ADR 0387)
deliberately does not solve this: idle-day rules judge *maintenance*, not
*meaning*, and an automatic merge is the most destructive thing a background
pass could do.

## Decision

Add one primitive, `skills.absorb({ id, into })`, and one tool action that
reaches it, `skill_manage action: "absorb"`.

1. **Absorb moves, it does not delete.** Every resource file of the source
   (`references/`, `templates/`, `scripts/`, `assets/`) is copied under the
   umbrella; the umbrella's own file wins any collision and the losing path is
   reported as `skipped`. The source document stays on disk with its body
   untouched and is only switched off, so undoing a merge is one toggle in the
   skills page.
2. **The umbrella's document is not rewritten by the host.** Choosing what the
   umbrella now covers is editorial judgement; the caller (the review fork, or
   the person) patches it first. A host-side rewrite of a document the user wrote
   would be a merge nobody reviewed.
3. **Same scope only.** A merge across global and project is a `transfer`
   followed by an `absorb`; combining the two into one step would move a file
   into a different ownership boundary, which ADR 0387's neighbours already treat
   as a separate decision.
4. **The decision is recorded, not inferred.** `skill-links.json` keeps
   `{ absorbed → into, at }` beside the usage and pin stores, and
   `UserSkillRecord.absorbedInto` exposes it. Without that record an absorbed
   skill is indistinguishable from one the user switched off, and the next
   maintenance pass would propose archiving a skill that a merge already retired.
5. **The background review may merge, under a stated bar.** The review prompt
   allows `absorb` only when the overlap is obvious from what `Skill` returned in
   that same review, requires the umbrella to be patched first, and requires the
   merge to be named in the reply. A partial overlap — two documents that each
   hold something the other lacks — must be reported, not absorbed.

A person reaches the same primitive from the skills page: a row menu action
"Merge into…" opens a target picker listing the other skills at that level, then
applies the merge and refreshes both the list and the maintenance report.

## Consequences

- The library can shrink without losing text: an absorbed document is inert, not
  gone, and `skills.setEnabled` brings it back whole.
- Two records now describe a retired skill (activation and the link), so the UI
  can say *why* a document went quiet. A skill that was absorbed and later
  re-enabled keeps its link, which reads as history rather than state — the
  merge is not undone implicitly by re-enabling.
- Collisions are resolved in favour of the umbrella instead of erroring. That is
  the safe direction (the merge never damages the destination), but it means a
  merge can leave a source file behind that the user expects to see in the
  umbrella. `skipped` is reported in the tool result, the IPC reply and the toast
  so the loss is visible at the moment it happens.
- No automatic consolidation pass exists: nothing runs absorb without a caller
  naming both skills. A library-wide "find the duplicates" pass would need its
  own review surface, and is not implied by this ADR.
