# ADR 0409: Token budget defaults are global, and they are sized, not inherited

- Status: Accepted
- Date: 2026-11-26
- Supersedes: nothing
- Related: [ADR 0405](0405-smart-mode-model-pair.md), [ADR 0404](0404-turn-abort-provider-traffic.md)

## Context

One real session (12.5 MB transcript, 35 turns) spent **28,409,542 prompt tokens**
before any of this was measured. Its shape:

| Fact | Value |
| --- | --- |
| Main model steps | 410 |
| Average prompt per step | 65,063 tokens |
| Largest single step | 755,678 tokens |
| Compaction events in the whole transcript | **0** |

Two independent causes, both invisible in the logs:

1. **The guards were addressed through one switch.** Ageing, compaction and the hard
   limit all sat behind `active_limits = model_limits_from(request)`, which is `None`
   when a prompt carries neither `provider.modelConfig` nor a top-level
   `contextWindow`. `None` turned all three off at once and said nothing.
2. **The thresholds were shares of the window.** A 1M-token model planned against the
   200k request ceiling compacted at 75% of it (137,712), so a working turn never
   reached the trigger and every step re-sent the whole transcript.

A third cause cost reliability rather than tokens: the free provider enforces **ten
requests per minute**, reports it as `HTTP 200` with a bare JSON error body, and the
kernel read that as "stream ended without a finish frame" — an unactionable message
that skipped the rate-limit budget and retried into the same wall half a second later.

All three are properties of the **request**, not of smart mode: a single-model session
pays the same per step and fails the same way. Only routing and the orchestrator/worker
split are smart-mode specific.

## Decision

These defaults apply to **every** session, smart mode or not. Each is a size, chosen
against a measured session, not a share of whatever window the provider advertises.

| Knob | Location | Value | Why this number |
| --- | --- | --- | --- |
| Request ceiling | `agent-core/context.rs` `PROMPT_BUDGET_CEILING` | 200,000 | A plan against a 1M window never compacted |
| Auto-compaction trigger | `agent-core/context.rs` `AUTO_COMPACTION_TRIGGER_CEILING_TOKENS` | 60,000 (or the window's own share, whichever is smaller) | The bill is the sum of every step's context; a large window is not a licence to fill it |
| Retained tail | `context.rs` `COMPACTION_KEEP_RECENT_RATIO`, clamped by the trigger | 20% of trigger | A checkpoint that keeps half a 600k window cannot bring the transcript back under it |
| Tool-result ageing | `agent-core/aging.rs` `ToolResultAging::default` | trigger 32k tokens, `keep_recent` 1, `oversize_chars` 8,000, head/tail 400 each | The system prompt alone is ~6k tokens here, so ageing has to start while the request is still small |
| Shell output | `host-core/tools/mod.rs` `BUDGET_SHELL` / `_ERR` | 24KB / 2000 lines (stderr keeps the tail) | Every byte is re-sent on every later step; the 512KB spill file still holds the whole output |
| Read / Glob / Grep | `host-core/tools/mod.rs` `BUDGET_SEARCH` | 40KB / 1500 lines | `Read` averaged 7k characters per call at the old 128KB ceiling — a large share of a request that bought nothing |
| Project instruction files | `agent-core/prompt/instructions.rs` | 20KB per file, 40KB block, head 70% + tail 20% | The tail is where a project's commit, gate and reporting rules live; head-only truncation dropped exactly those |
| Deferred tool catalogue | `agent-core/tool_activation.rs` `MAX_CATALOG_DESCRIPTION_CHARS` | 80 | 61 tools cost 13,301 characters of catalogue per request; a name and a phrase recognises a tool, `ToolSearch` still matches the full description |
| Working style | `agent-core/prompt/mod.rs` `WORKING_STYLE` | every mode | Steps are the multiplier: 2 steps × 8.2k beats 18 steps × 8.2k for the same work |
| Subagent concurrency | `agent-core/delegate.rs` `DEFAULT_MAX_ACTIVE_DELEGATIONS` | 8 | The reference product's own setting; a refusal names the limit and `TaskWait`/`TaskStop` |
| Subagent depth | `agent-core/sidecar.rs` (worker tool set) | 1 | A worker cannot delegate; one paid hand-over must not become a chain |
| Truncated-stream retries | `agent-core/retry.rs` | 4 attempts at 2s/4s/8s/8s | Measured: three attempts inside two seconds all failed; a request nine seconds later succeeded |
| Quota pacing | `agent-core/provider/pacing.rs` | 6s per endpoint after a quota error, cancellable | Ten requests per minute is 6s each; the wait replaces the failure |

Smart mode adds two behaviours on top, and nothing else:

* **Turn routing** — which half a turn runs on (`packages/shared/src/smart-mode.ts`).
* **The orchestrator/worker split** — an orchestrating turn is not declared the
  worker's tools at all, and the gate refuses them until a delegation reports.

## Measured evidence

Same task, run headlessly against the real providers (`nubo-proto serve`, JSON-RPC):

| | Per step | Steps | Per turn |
| --- | --- | --- | --- |
| Before | 575,930 / 694,308 / 755,678 | 100–123 | 6.7M / 17.7M / 28.5M |
| After, single model | 8,228 | 2 | 16,591 |
| After, pair (orchestrator paid / worker free) | 7,720 / 8,223 paid | 2 | 15,943 paid + 19,285 free |

Static prompt composition after the change: `system` 6,141 tokens, `tools` 603 tokens,
8 declared tools and 21 catalogue entries — against 32,822 characters of system prompt
and a 15,471-character catalogue before.

Reliability: a task that previously ended in `INCOMPLETE_STREAM` (quota) now completes
in 15 steps / 259,015 tokens with no error. Declaring worker tools to an orchestrating
turn cost a wasted step and half of that turn's paid tokens (19,214 → 15,943 after the
tools stopped being declared).

## Failure behaviour: the pair never silently becomes one model

The token savings above assume the cheap half does the work. The failure paths matter for
the same reason: a "saving" that quietly reruns the turn on the expensive model is not a
saving, and a pair whose second half can be swapped without telling the caller is not a
decision anyone can reason about. So the rule is stated once and implemented in three
places — **a failure costs the turn it happened in, never the model identity behind it.**

### The cheap tier (the model that answers conversation turns)

| Stage | Behaviour | Where |
| --- | --- | --- |
| Dispatch | A provider that is disabled, has no base URL, does not list the model, or cannot sign a request cannot serve a turn. The turn is planned on `main` with `downgraded: true` instead of being sent to a model that would fail it. | `apps/desktop/electron/main/runtime/smart-routing.ts` `providerCanServe` / `planTurn` |
| Turn failed or produced no text | The next `stickyMainTurns` turns (default 1) stay on `main`, then the ladder unwinds one turn at a time. Failure and silence count the same: a cheap turn that said nothing is evidence, not a guess. | `smart-routing.ts` `closeTurn`; policy in `packages/shared/src/smart-mode.ts` |
| Tool errors / budget consumed | Routing escalates after `escalateAfterToolErrors` (default 2) tool errors, or when `escalateAfterBudgetUsed` (default 0.6) of the turn's budget is gone. | same policy object |
| Provider error inside the turn | Retried on the retry budgets below. When they are exhausted the turn ends in error — there is **no** mid-turn swap to `main`, and no code path that re-runs the turn on it. | `crates/agent-core/src/retry.rs`, `turn.rs` |

### The main model

| Stage | Behaviour | Where |
| --- | --- | --- |
| Provider error | Same retry budgets; exhausted means the turn fails with the provider's code. | `retry.rs`, `provider/http.rs` |
| Never | Fall back to the cheap model. `tier: "main"` is the session's own binding, not a slot that can be filled by the other half. | `smart-routing.ts` `planTurn` |

### A delegated worker

| Stage | Behaviour | Where |
| --- | --- | --- |
| Requested an unauthorized model | The `Task` call returns an error. An explicit `model` argument is a spend decision; it is never a hint for a lookup that falls through to another model. | `crates/agent-core/src/delegate.rs` |
| Ran and failed | `DelegationStatus::Failed` (also `Aborted`, `Stopped`), settled onto the same tool-call id as `failed after N turn(s) and M tool call(s) — CODE (message)`, so the transcript, the stored snapshot and the topology badge all agree. | `delegate.rs` `settled_tool_result`, `failure_reason` |
| Hit its step ceiling | The report says so and names the ways forward: continue it yourself, rerun with a larger `stepBudget`, or narrow the task. | `delegate.rs` `failure_reason` |
| Finished without a report | `SUBAGENT_NO_REPORT` — an empty success would read as work nobody did. | `crates/agent-core/src/sidecar.rs` |
| Provider error inside the worker | Inherits the session's `infiniteProviderRetry` and the same retry budgets. | `sidecar.rs` |

`fallbackModels` on a subagent definition is **not** a runtime chain that swaps a worker's
model: it exists so every pinned provider is resolved once and handed to the kernel up
front (`packages/shared/src/subagent-definition.ts`), so an unresolvable pin is a missing
entry rather than a silent substitution. Recovering from a failed worker is the
orchestrator's decision — do it itself, delegate again, or narrow the task — and `TaskWait`
/ `TaskStop` are how it converges.

### Retry budgets, per failure class

| Class | Attempts | Spacing | Why |
| --- | --- | --- | --- |
| Rate limited (429, or a bare quota body) | `PROVIDER_MAX_RETRIES` (10) | 2 s, exponential, capped at 30 s, ±25 % jitter | A quota reply is not an outage; waiting is the only cure, and jitter keeps a fleet from retrying in lockstep. |
| Transient (dropped socket, upstream 502) | 10 | 1 s, 2 s, 4 s, 8 s, capped | Long enough to ride out a restart, short enough that a dead provider does not hold the turn. |
| Truncated body (`INCOMPLETE_STREAM`) | `TRUNCATED_MAX_RETRIES` (4) | 2 s, 4 s, 8 s, 8 s | Measured: three attempts inside two seconds all died, while a request nine seconds later completed. Spacing matters more than the count, and each retry re-sends the prompt. |

A turn that exhausts its budget fails with the provider's own code, and the user sees the
failure rather than a silent model substitution. That is the trade this ADR accepts: the
savings come from *what runs*, and the failure story stays one model per turn.

## Consequences

* Every session — smart mode or single model — starts from these numbers. Changing one
  is a product decision that must be re-measured the same way, not tuned by feel.
* The guards are no longer silent: a prompt without a model window logs
  `prompt carries no model window: no ageing, no compaction, no budget`, and every step
  logs its window, hard limit, trigger and composition.
* Ageing and compaction change **what the model is shown**, never the stored
  transcript: a checkpoint installs a summary row, and an aged tool result keeps both
  its ends plus a path back to the spill file.
* A 60k trigger is deliberate for large windows and irrelevant for small ones: the
  rule is `min(window share, 60k)`, so a 32k-window model still compacts at its own
  ratio (~12k) rather than being told to hold 60k of context it cannot.
* Provider-side limits stay provider-side: the kernel recognises a quota and paces to
  it, but it does not guess a provider's quota before the provider states one.

## References

* `crates/agent-core/src/{context,aging,retry,delegate,turn,sidecar}.rs`
* `crates/agent-core/src/prompt/{mod,instructions,smart}.rs`
* `crates/agent-core/src/provider/{http,openai,pacing}.rs`
* `crates/host-core/src/tools/mod.rs`
* `packages/shared/src/smart-mode.ts`
* Headless validation harness: `references/headless-kernel-harness.md` in the
  `pi-desktop-dev` skill (how to drive the kernel without the client).
