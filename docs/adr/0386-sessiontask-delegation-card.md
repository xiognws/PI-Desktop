# ADR 0386: Render a spawned session as a delegation card in the transcript

- Status: Accepted for implementation
- Date: 2026-11-09
- Supersedes: ADR 0385
- Related: ADR 0384 (push-first work deliveries), ADR 0062 / ADR 0089
  (in-session delegation presentation), ADR 0237 (session orchestrator),
  ADR 0239 (collaboration ledger)

## Context

ADR 0384 lets a supervising session continue when a worker settles, so a single
conversation can now start several durable worker sessions and collect them.
What the supervisor's own transcript cannot do is show that work.

`SessionTask` calls render as generic tool rows. The delegation presentation
(`lib/subagent-topology.ts`, `features/chat/transcript/SubagentDetail.tsx`) is
keyed by `tool-display.ts`:

```ts
export function isDelegationStartTool(toolName?: string): boolean {
  const bare = bareToolName(toolName);
  return bare === "task" || bare === "subagent";
}
```

`sessiontask` is not in that set, so a spawn — which creates a real durable
session, with a title, a task, a state, and a child transcript the shell already
knows how to render — gets the same generic row as `Read` or `Bash`.

ADR 0385 answered this with a new always-on sidebar strip and was withdrawn the
same day: it pushed the session list down permanently to answer a question the
transcript can answer in place, and it duplicated two mechanisms the product
already ships (the delegation topology above, and `TaskDock` for a session's own
background tasks).

## Decision

1. **A spawn is a delegation row.** A `SessionTask` call whose arguments carry
   `action: "spawn"` is treated as a delegation start by the transcript, and
   renders through the existing delegation presentation. No second row type, no
   second status vocabulary.
2. **State comes from the host's own delivery status**, not from the tool call
   finishing. A spawn returns as soon as the child is admitted, so a completed
   tool call is not a completed worker:
   `queued` / `running` → running, `completed` → completed, `failed` → failed,
   `cancelled` → stopped, `interrupted` → aborted. Without this the card would
   claim "completed" for a worker that had only just started.
3. **The card opens the child session.** The child is a durable session the
   shell already renders better than any card can, so activation selects its
   `sessionId` rather than opening a delegation transcript view. This is the
   DSH rule: draw no transcript of your own.
4. **No new surface.** No sidebar section, no panel, no dock. The card lives in
   the transcript where the spawn happened, collapses with the activity group it
   belongs to, and disappears from view on its own once the turn is history.
5. **A corner count is deferred.** DSH pairs the inline card with a floating
   pill counting a session's subagents. That is worth doing only if the inline
   card proves insufficient in use; it is not part of this change.

## Consequences

- A supervisor's transcript shows what it started: task text, child title, live
  state, and a way in. Reading a turn no longer requires cross-referencing the
  sidebar.
- The state vocabulary stays single: `waiting / running / queued` from ADR 0385
  is dropped in favour of the outcomes the delegation presentation already
  defines (`running / completed / failed / stopped / aborted / denied`).
- `sessiontask` becomes a delegation-shaped tool in `tool-display`. Every other
  action of the same tool (`send`, `status`, `result`, `wait`, `accept`,
  `cancel`, `list`, `models`) keeps its generic row: they drive existing work
  and must not inflate a subagent count, the same rule ADR 0089 applies to
  `TaskWait` / `TaskList` / `TaskStop`.
- No host, IPC, schema, or plugin change: the arguments and the delivery status
  are already in the transcript the renderer holds.

## Alternatives considered

- **A sidebar strip (ADR 0385).** Withdrawn: see above. It answered in a new
  permanent region what the transcript can answer at the point of use.
- **A floating pill only.** Rejected as the primary surface: a count tells the
  user work exists but not what it is; the transcript card carries the task and
  the child. The pill remains a possible supplement.
- **Open a delegation detail view on click.** Rejected: the child is a real
  session, so a detail view would re-implement session rendering inside a card.
  Selecting the session keeps one renderer for one concept.
- **Derive state from the tool call's own status.** Rejected: a spawn settles as
  soon as the child is admitted, so the tool status would report every worker as
  complete the moment it began.
