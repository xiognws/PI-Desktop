# 0392 — A procedure lives in the skill, and memory says so

- Status: Accepted
- Date: 2026-11-11
- Amends: ADR 0391 (writers are declared, not deferred)

## Context

ADR 0391 gave the agent both writers on the first turn and a prompt rule:
a *procedure* (two or more steps, still true next month, independent of this
machine) belongs in the skill library, a *fact* belongs in memory.

Measured on a live session with that rule in place, the same four-step "add a
desktop IPC channel" procedure ended up in **three** places:

```
skill    D:\PiWorkspace\agents\skills\add-desktop-ipc-channel.md
memory   memory_entries[memory#5]   "本仓库加新 IPC 通道（前端链路）固定四步：…"
memory   memory_entries[user#2]     "给本仓库加新 IPC 通道的固定流程…"
```

Two different writers were responsible — the main turn wrote memory, the review
fork created the skill — and neither can see the other's writes. A prompt rule is
advisory and blind; it cannot enforce "one place".

Two smaller defects surfaced in the same session:

1. `Skill` recorded `skills.recordUse` **before** the document resolved, so
   loading an id that does not exist produced a real "used once" badge on a skill
   nobody wrote.
2. The self-improvement review of a finished turn rendered as the transcript's
   *trailing slot*, i.e. **above** the live turn (`TranscriptTail`), so a review
   that had already finished was reported before the reply it reviewed.

## Decision

1. **The memory tool refuses a procedure a skill already covers.** Before any
   write, `memory` compares each entry being *added* against the skill catalogue
   (`name + description + id`):
   - an entry is a procedure when it has a numbered pair, two arrows, or an
     explicit ordering pair (先…再/然后, or two English sequence words);
   - it is *covered* when at least three topic tokens are shared **and**
     `shared / min(|entry|, |skill|) ≥ 0.25`.
   On a hit the write is rejected with `MEMORY_COVERED_BY_SKILL` and the skill id,
   and the tool text points at `skill_manage` `patch`. Entries already stored
   before the skill existed are never re-judged, so a session can always free
   space and a skill created later does not lock the store.
2. **Coverage is judged on added entries only**, and on a coverage coefficient
   rather than Jaccard: a skill description is short and a procedure is long, so
   the question is "does the skill cover these words", not "are the texts equal".
3. `Skill` returns a "no skill has the id" error **before** recording use.
4. The review row renders **after** `TranscriptTail`, at the end of the turn.

## Consequences

- "One lesson, one place" is enforced by code at the only point both writers are
  visible, instead of by a prompt rule neither can verify.
- A fact that merely shares vocabulary with a skill ("this machine blocks TCP 22"
  next to a skill about publishing branches) is still accepted: the procedure test
  and the three-shared-token floor both have to pass.
- The rejection is actionable, not silent: the model is told which skill to patch,
  so the failure costs one turn instead of losing the lesson.
- A procedure the model *wants* to keep verbatim in memory now has to be stated as
  the fact alone. That is the intended pressure.
- Token overlap is a lexical heuristic: a procedure rephrased with none of the
  skill's vocabulary is not caught. The prompt rule remains, as the first line.

## Alternatives considered

- **Delete the duplicate memory entries after the fact.** Rejected: deleting what
  the model just judged worth keeping hides the disagreement instead of surfacing
  it, and the next turn repeats it.
- **Only prompt harder.** Rejected by measurement — the rule was already in the
  prompt and the triple write happened anyway.
- **Deduplicate at read time (prompt assembly).** Rejected: memory and skills have
  different budgets and different readers; hiding an entry in one view leaves a
  second source of truth on disk.
