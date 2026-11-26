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

## Amendment 2026-11-25 — sub-first routing, strong half orchestrates

The first cut ran quality rules before cheap rules, which put the strong half in
front of most real turns: a shell command, a file path, a first turn or a 700
character prompt each argued for `main`, and the cheap half mostly served
delegates. Measured against a session of ordinary requests that split was closer
to the reverse of what the pair is for.

Two changes, in this order of importance:

1. **Sub-first routing.** The strong half is now paid for judgement
   (`HEAVY_INTENT`), for a prompt too large to be a quick exchange
   (`mainPromptChars`), for attachments, for a staged plan/goal run, and for the
   turn after an escalation. Code markers, file paths, tool verbs, tool
   follow-ups and the first turn start on `sub`; a turn that stalls escalates
   inside itself, which costs one hand-over rather than a strong turn up front on
   every mechanical request. `HEAVY_INTENT` also lost the words that describe
   ordinary work ("implement", "feature", "analy", "实现", "开发", "功能",
   "修复", "分析", "方案") because matching them made most requests look hard.
2. **The strong half orchestrates.** A `main` turn now carries a
   `smart_orchestrator` prompt section: state the goal, decompose into verifiable
   steps, hand the mechanical ones to `sub` through `Task`, verify each result
   before the next step, and correct or take over a step that stalls. The section
   is appended last, so switching tiers never invalidates the cached prefix.

What this costs: a misclassified hard turn now starts cheap and pays for one
hand-over (the sub model's tokens plus a re-send of the transcript) instead of
being right the first time. What it buys: the strong half becomes an orchestrator
whose own tokens are spent on judgement, and the bulk of tool work runs on the
cheap half — the split the pair exists for.

## Amendment 2026-11-25 (second) — supervision is the default, routing is the experiment

Sub-first routing was measured on the long session it was meant for, and it fails
where it matters. A cheap turn that answers with a sentence ("let me look at
…") instead of calling a tool ends the turn — a turn ends when the model stops
calling tools — and nothing escalates, because escalation only watches a turn
that is still running. The strong half, which is supposed to own the work, never
sees it. In that session all six turns were routed to `sub` and two of them ended
that way, with the user typing 继续 to restart work that had never started.

So the pair's supported shape is the one it was designed around: **the main model
supervises, the sub model executes.** `turnRouting` now defaults to `false`.
Every turn stays on `main`, `delegateToSub` stays on, and `Task` without `model`
runs on the cheap half, so execution is the delegated path and every report comes
back to the model that owns the turn. Whole-turn routing stays behind the switch
it always was — a way to measure that trade-off, not the default — and the
orchestrator section gained one rule: never end a turn by announcing the next
step; dispatch the `Task` or call the tool in the same reply.

A session that already carries a snapshot keeps the policy it froze, so the pair
has to be selected again — or the session re-created — before it picks up the new
default.

## Amendment 2026-11-25 (third) — the split is enforced inside the turn

The second amendment made supervision the default and told the orchestrating half
to hand its mechanical steps over with `Task`. Measured on the session it was
written for, that instruction was ignored: three turns routed to `main`, 87 direct
tool calls (54 `Bash`, 11 `Edit`, 8 `Read`, 2 `Grep`, 1 `TodoWrite`), **zero**
`Task` calls and not one mention of delegation in the model's own text. Nothing
reported it either, because the only parts that existed were a prompt section and
an escalation path that `main` turns never receive.

So the split became a rule the kernel holds, instead of advice the prompt gives:

- `TurnConfig.delegate_mechanical` is set when the launch carries both
  `smartTurn.tier == "main"` and a non-empty `delegationDefaultModel`. Either one
  alone is wrong in opposite ways: a pair with no worker would refuse every tool
  in a single-model session, and a routing decision alone would never fire.
- While it is set and no delegate has reported in the turn, every tool outside
  `ORCHESTRATOR_TOOLS` — the `Task*` verbs, `TodoWrite`, `ToolSearch`, `Skill`,
  `memory`, `asktool` — is refused with a tool error that names the fix. The model
  reads the refusal, so "you did the mechanical work yourself" is visible inside
  the turn instead of in a log nobody reads.
- A `Task`/`TaskWait` that returns a report opens the worker's tools again, for
  the remainder the report leaves behind; a delegation that fails does not open
  them.
- A refusal is not counted as a tool-error streak: the turn's own rule is not the
  tool's failure.

What this costs: a model that insists on doing the work itself now spends its
steps on refusals until it delegates — visible, and bounded by the turn's own
end. What it buys: "the mechanical work runs on the cheap half" stops being a
hope. The refusal text is the other half of the contract: it says which tool,
why, and that the fix is `Task` with `model` omitted.

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


### Amendment 2026-11-26: routing is on by default

The default above was set while the only measurement was a session whose routed
turns stalled. A later measurement of the same client changed the balance: with
`turnRouting` off, three turns with 100+ tool calls each cost 2.4M, 775k and 972k
prompt tokens, every step re-sending the whole transcript, and the paid half did
the executing itself (`Task` fired 9 times in 824 tool calls). A switched-off router
means the cheap half never serves a turn, which makes a paid pair cost exactly what
the paid single model costs.

So `turnRouting` now defaults to `on`, together with the request budget, ageing and
Bash-output limits that landed in the same change. The stall risk the original
default was protecting against is handled by what the router does now: a cheap turn
that trips `escalateAfterToolErrors` hands the turn to the main half mid-flight
rather than ending where the model stopped calling tools, and the orchestrator
section still governs every turn that runs on `main`. Turning the switch off
remains supported — it is the explicit choice, not the default.
