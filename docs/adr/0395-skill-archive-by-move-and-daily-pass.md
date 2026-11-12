# ADR 0395: Archive by moving, and run the pass at most once a day

- Status: Accepted
- Date: 2026-11-12
- Related: [ADR 0387](0387-skill-curation-by-idle-days.md),
  [ADR 0394](0394-curator-touches-only-agent-skills.md),
  [ADR 0389](0389-skill-consolidation-by-absorb.md)

## Context

ADR 0387 defined the idle-day rule and made archiving mean *deactivation*: the
pass wrote the same activation flag the row's toggle writes, so the document
stayed in the library and in every prompt. Two things that seemed right then
turned out not to hold:

1. **A deactivated skill still costs the thing the pass exists to reclaim.** The
   catalog enters the prompt; "archived" rows stayed in the directory the scan
   reads, so retiring a skill freed nothing. The only real retirement was the
   user deleting a file by hand — which is not a maintenance pass.
2. **The pass had exactly one caller, the settings page.** That was a deliberate
   guard against a skill vanishing without explanation, but it means the library
   only gets tidied by somebody who happens to open that page. A library that
   needs a manual visit to stay readable is not maintained, and the review fork
   keeps adding to it every turn.

The escape hatch that made (1) tolerable is now weak as well: re-enabling a
skill that had been off for a quarter brings back a document nobody has opened
since, so the next pass flags it again immediately.

## Decision

### Archiving moves the document

`skills.curate` with `dryRun: false` moves an archivable document into
`<skills root>/.archive/`:

| Shape | Live | Archived |
| --- | --- | --- |
| flat | `<id>.md` | `.archive/<id>.md` |
| package | `<id>/SKILL.md` + resources | `.archive/<id>/` |

- The scan skips `.archive` entirely, so an archived skill is out of the
  catalog, out of `skills.list`, and out of the `Skill` tool's listing. That is
  what makes archiving measurable.
- Nothing is deleted and nothing is rewritten: `fs::rename` on the same file
  system, a copy-then-delete fallback across mounts.
- The archive is named by record id, so no stored path can send a restore
  somewhere else.
- The scan's sweep that drops state for deleted documents unions the archived
  ids, so activation, counters, the pin and the origin survive the move. Pins
  and origins were already keyed by level + id + project path, and the id does
  not change.
- A link or junction is never archived: its bytes belong to the directory it
  points at, and the cross-device fallback would delete them. A destination the
  archive already holds is never overwritten.

### `skills.restore` is the way back

A new RPC moves `<archive>/<id>` (or `<archive>/<id>.md`) to where it came from
and switches the skill on. An id the archive does not hold and a destination
that is already occupied are `SKILL_INVALID` — two documents must never fight
over one name. The restore also moves the document's timestamp to now: the user
just asked for it, and a restored document that the next pass takes out again
would make the undo a no-op.

### The automatic pass runs in Electron main, at most once a day

`runtime/curator-runner.ts` rides the existing scheduled runner's tick instead
of owning a timer. Before running it checks, cheapest first:

1. no session is running a turn (or still finishing one);
2. `curateAutomatically` is not `false` in settings (default on);
3. `curatorLastRunAt`, in the app settings document, is at least 24h old.

A successful pass writes `curatorLastRunAt` and logs one line
(`curator.auto_applied`) with the archived and scanned counts. A failed pass
logs `curator.auto_failed`, leaves the timestamp unwritten so the next tick
retries, and never propagates — a tick that stops polling is a worse outage
than a missed pass.

The threshold itself is unchanged: 90 idle days, agent-authored documents only
(ADR 0394), pins exempt.

## Consequences

- The daily cadence is a preference, so it lives in settings rather than in a
  file of its own; it travels with the other preferences and needs no separate
  lifecycle.
- An archived document is invisible to the product but fully intact on disk,
  which is why the archive can be reached by id alone and why the pass may act
  without a second confirmation.
- Two surfaces still owe the user a view: nothing in the settings page lists the
  archive or offers `skills.restore` yet, so today the way back is the RPC. A
  restore button is the obvious next step and needs no new host behaviour.
- `.archive` is a reserved name in the library. A skill directory by that name
  would be skipped by the scan; ids are slugs and cannot start with a dot, so a
  skill cannot collide with it.
- Absorbed skills (ADR 0389) are unaffected: absorb still only deactivates,
  because it keeps a document the umbrella refers to.
