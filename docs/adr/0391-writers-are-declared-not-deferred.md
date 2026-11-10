# ADR 0391 — The two writers are declared, not deferred

Status: Accepted (amends ADR 0048)
Date: 2026-11-09

## Context

ADR 0048 sends an active subset of the tool registry and keeps the rest behind a
`ToolSearch`. `Skill` was explicitly kept in the agent core set, with the reason
written down: "a widget the model has to go looking for is one it will not use."

`memory` and `skill_manage` were not. Both are the write side of the learning
loop — the only way anything a session learned survives it — and both were
deferred.

Measured on a live session (dev client, real provider, no instruction to use any
tool):

| turn | what it carried | tool actually called | what persisted |
| --- | --- | --- | --- |
| 1 | an environment quirk | `memory`, after spending a `ToolSearch` on it | one memory entry |
| 2 | a concurrency pitfall | `memory`, again via `ToolSearch` | one memory entry |
| 3 | a three-step release procedure | `memory`, again via `ToolSearch` | one memory entry; **no skill** |

The library never grew. A procedure — the exact thing a skill is for — landed in
memory because `skill_manage` was one discovery step further away and nothing in
the prompt made that step worth taking.

## Decision

`memory` and `skill_manage` join `AGENT_CORE_TOOL_NAMES`: in agent mode their
schemas are part of the declared request from the first turn, like `Read`,
`Bash`, `Edit`, `Write` and `Skill`. Chat and plan modes still defer
`skill_manage`, where writing to the library is not the point of the turn.

The prompt gains the rule the schema alone could not carry (`SKILL_WRITING_RULES`
in `skill-authoring.ts`): a reusable **procedure** is a skill, a **fact or
preference** is a memory entry, and the difference is procedure-versus-fact, not
durable-versus-temporary. The review fork also has to state, when it created or
patched nothing, whether the session contained a complete procedure.

## Consequences

- Two more schemas ride along on every agent request. They are part of the cached
  prefix, so the steady-state cost is a cached read rather than fresh input
  tokens, and the first turn pays a few hundred tokens more than before. ADR 0048
  exists to keep that number small, which is why this amendment is limited to the
  two writers rather than "everything that writes".
- The agent can now record what it learned in the same turn it learned it,
  without a discovery round-trip. The transcript no longer shows a `ToolSearch`
  row for the two tools that matter most to the loop.
- The behaviour still depends on the model choosing to write; this ADR removes a
  structural obstacle, it does not make the choice automatic. The rules in the
  prompt and the review fork's fallback question are what push the choice.
- Deferral remains the default for everything else, including `Glob`, `Grep`,
  `BrowserPreview`, plugin tools and plugin-development helpers.
