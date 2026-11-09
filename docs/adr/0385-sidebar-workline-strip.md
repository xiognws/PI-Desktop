# ADR 0385: Show cross-session worklines in the sidebar

- Status: Accepted for implementation
- Date: 2026-11-09
- Related: ADR 0384 (push-first work deliveries), ADR 0213 (host turn queue),
  ADR 0239 (collaboration ledger), ADR 0107 (task notifications),
  `lib/sidebar-project-runs.ts` (per-project run counts)

## Context

ADR 0384 made a supervising session continue on its own when a worker settled,
so the user no longer has to re-prompt it. What remained is that the user could
not see the work while it ran:

- the sidebar's project header shows a **count** of running and waiting sessions
  (`sidebar-project-runs.ts`), which answers "is anything running under this
  project" but not "which session, started by whom, doing what";
- `SessionHoverCard` answers the second question for **one** session, and only
  while the pointer is over its row;
- the durable inbox row and the native notification fire when work **finishes**.

With two or three parallel workers, answering "what is still running and who
started it" therefore meant hovering each row in turn. The host already holds
every fact needed for the answer — `SessionCollaborationSummary` carries
`status`, `currentTask.text`, and `createdBySession` — and the renderer already
reads it over `pi-desktop/session/collaboration`, so no host capability was
missing. Only a projection was.

`local.pi-bot` ships a mature version of this idea for its own bot teams:
`renderer/member-status.mjs` ranks `queued / launching / running / waiting /
waiting_teammates` and turns a job into "waiting for your approval", "waiting for
teammates", "running a command · 3 tool calls". That vocabulary already exists in
the product, so this projection states the same states rather than inventing a
second one. (pi-bot's data lives in its own `team.json`; its jobs are not
worklines of this app, and this ADR does not read it.)

## Decision

1. **A `WorklineStrip` above the session list.** It renders one row per session
   that is busy right now: title, state badge, the session that started it
   (`createdBySession`), and the first line of `currentTask.text`.
2. **Blocked outranks busy.** State order is `waiting > running > queued`, and a
   pending permission wins even when the store also reports the session as
   running — the turn cannot proceed without the user, and a "running" label
   would hide that.
3. **Only busy sessions are worklines.** A session that reported completion and
   went idle is history: the inbox row and the session itself already carry it,
   so the strip disappears when nothing is running and an idle sidebar keeps its
   existing layout exactly.
4. **No new host surface.** The component reads the store's
   `runningSessions` / `pendingPermissions` to decide which sessions to ask
   about (normally zero to a handful), then reads each one's collaboration
   summary over the existing IPC. Reads refresh every 4 seconds only while the
   document is visible, and a failed read degrades to a row without detail
   rather than a missing row.
5. **The projection is a pure module.** `lib/workline-activity.ts` owns the
   state machine, the ordering, and the detail truncation, so it is testable
   without a renderer (`test/workline-activity.test.mjs`).

## Consequences

- Parallel work is legible at a glance: which sessions, on whose behalf, and
  what each is doing, without hovering anything.
- A session blocked on a permission prompt is the first row, which is the case
  that used to be found by opening sessions until the prompt appeared.
- The strip costs one host read per busy session per 4 seconds, and nothing when
  no session is busy.
- The strings reuse the existing `sessionCollaboration.status*` catalogue plus
  four new keys (`worklineTitle`, `worklineActiveCount`, `worklineAria`,
  `worklineDelegatedBy`) in every shipped locale, so the strip and the hover
  card cannot describe the same state differently.
- No host, IPC, schema, or plugin change: this is a renderer projection over
  data the app already reads.

## Alternatives considered

- **Expand the project badge into a popover.** Rejected: the badge is scoped to
  one project, while worklines cross projects (a worker inherits the parent's
  project, but a user can start one anywhere), and a hover/collapse affordance
  hides the answer exactly when the sidebar group is collapsed.
- **Reuse `local.pi-bot`'s team panel.** Rejected: its jobs live in `team.json`
  and describe its own bots, not this app's sessions. Adopting it would add a
  second task model instead of projecting the one the host owns.
- **Add a host RPC that lists all running worklines.** Rejected for now: the
  store already knows which sessions are busy, so the read set is small and the
  existing per-session IPC is sufficient. A host-side aggregate becomes worth it
  only if the renderer needs worklines for sessions it has not loaded.
- **Poll the collaboration summary for every session.** Rejected: it would read
  hundreds of idle sessions to render a list that only ever shows busy ones.
