# ADR 0405: Smart mode runs a conversation on a model pair

- Status: Accepted for implementation
- Date: 2026-11-24
- Related: ADR 0334 (session `/fast`), ADR subagent-model-opt-in, ADR subagent-model-fallback, D278

## Context

Every conversation today runs on exactly one model. Two facts make that wasteful:

1. Most turns are mechanical — a translation, a summary, a short question — and a
   cheap model answers them as well as an expensive one.
2. The expensive model spends its context on work that produces a paragraph of
   conclusion from a lot of raw output: file sweeps, test runs, read-only reviews.

The app already has the pieces for (2). `Task.model` lets the parent agent name a
delegation model from a catalog main builds out of `availableForSubagents`
bindings, and the kernel refuses any key outside it. What is missing is that the
user has to opt each model in by hand, the parent has to remember to pass `model`
on every call, and nothing at all addresses (1).

Token cost is the product constraint here. A design that pays for a classifier
request per turn to save a cheap-model turn elsewhere is not a saving, and a
design that re-sends the transcript to a second model to "fix" a weak answer
costs twice.

## Decision

A session may run on a **pair**: a `main` binding (plans, judges, answers) and a
`sub` binding (the cheap one), plus the policy that routes turns. The pair is one
app-wide setting (`smartModeMainProviderId/ModelId`, `smartModeSubProviderId/ModelId`,
`smartModeTurnRouting`, `smartModeDelegateToSub`); selecting the composer's
`Smart mode` entry writes a **snapshot** of it into the session
(`sessions.smart_mode_json`, schema v34). A snapshot, not a reference: editing the
pair afterwards must not rewrite a conversation that already ran.

Four rules make it a saving rather than a coin flip:

1. **Routing is deterministic and free.** `decideTurnTier` reads only signals
   already in hand before dispatch — prompt text, attachment count, staged mode,
   turn index, whether the previous turn called a tool, whether the cheap binding
   resolved. No request, no classifier prompt, no extra tokens. Every rule that
   argues for quality runs before any rule that argues for cheapness, so the
   cheap model only ever gets a turn nothing objected to.
2. **The cheap half is authorized by being chosen.** The pair's `sub` binding
   enters the delegation catalog without the model's own `availableForSubagents`
   opt-in: the user selected the pair, and asking twice is asking the same
   question. `delegationDefaultModel` makes `Task` without `model` run there, so
   delegation is the path of least resistance for the orchestrator. `Task.model`
   names a key outside the catalog and is refused exactly as before.
3. **Escalation is evidence-driven.** A cheap turn that fails or answers nothing
   keeps the next turns on `main` (`stickyMainTurns`). Quality is protected by
   the rules that never route the hard case down, not by hoping the small model
   notices it is out of its depth.
4. **One provider resolution path.** A `sub` turn rewrites the launch overrides,
   so `resolveAgentRuntimeLaunch` resolves the cheap binding exactly as it
   resolves any session model — credential, vendor account, base URL, thinking
   clamp, model config. There is no second, cheaper copy of that logic to drift.

Smart mode is off unless both halves are configured and resolve; `null` in the
session column is the whole meaning of off, and picking a plain model clears it
(`smartMode: null`), so a chat cannot be "smart" while showing one model.

## Landing record

The change was written in a checkout another session was also committing from, and
it first landed in two commits that also carried that session's work. The commit
messages were corrected afterwards on the user's instruction (trees unchanged,
messages only): `7bb845d90` (the feature itself, originally committed under the
delegation-accessor subject) and `259f01385` (the session row's missing field,
which is what made `host-core` build again). Read those two commits together
when bisecting this decision; the pre-relabel SHAs `49b46c649` and `10e37dc01`
appear only in older checkouts of this branch.

## Consequences

- New optional column `sessions.smart_mode_json` (v33→v34, additive, NULL=off) and
  three new optional launch parameters (`delegationDefaultModel`, `smartTurn`, and
  the existing `subagentModelKeys` path). Old documents, old sessions and remote
  sessions keep single-model behaviour with no backfill.
- `turn.providerId/modelId` already records the model that served each turn, so the
  saving is measurable per turn without new storage.
- A misclassification costs one cheap turn's tokens, not the answer: the kernel
  hands the rest of a stuck cheap turn to the strong half — same transcript, one
  re-send, no replay of tools that already ran. The evidence is repeated tool
  failures or a spent step budget, and the hand-over happens once, so a strong
  model that also struggles ends the turn instead of looping.
- The turn's own row records the model it *started* on; the hand-over is logged
  (`smart-mode turn escalated`, with both models and the reason) rather than
  modelled as a second row. Splitting usage per model inside one turn is a
  separate change to the accounting, not to this decision.
