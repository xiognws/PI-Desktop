# Super-agent mapping — design note

What of DeepSeek's ["Super-agent"](https://github.com/deepseek-ai/dsh-superagent-prototype)
(Router/Worker, session-independent, always-on, work arrives from outside) exists
in this product, what does not, and why two attempts to add the missing pieces
were withdrawn.

Written after a review of the current tree, not from the design essay: every
"present" row names the file or ADR that proves it.

## Short version

Most of the *machinery* is already here and was not derived from super-agent —
it grew from ordinary product needs (parallel delegation, permissions, context
compaction). The three ideas that actually make super-agent a different product
are absent, and the decision was to keep them absent:

1. the session stops being the unit of work;
2. work arrives from outside (GitHub, chat) instead of from the operator;
3. an unattended loop closes the delivery (branch, PR) without a human.

This repository is a workbench. Super-agent is a duty robot. They overlap on
parallel delegation and on permission boundaries, and diverge on who starts the
work and how it leaves the building.

## Present, natively

| Super-agent claim | Where it already lives |
| --- | --- |
| Several workers in parallel | `Task` delegation, `MAX_SUBAGENT_CONCURRENCY` 10 (ADR 0089) |
| Supervisor + workers, per-worker model | `lib/subagent-topology.ts`, `features/chat/transcript/SubagentDetail.tsx`; a definition may pin its own model (ADR 0114) |
| A person does not watch every session | focus-aware native notifications and the durable inbox (ADR 0107, ADR 0187); `components/TaskDock.tsx` for a session's own background tasks |
| Scheduler, queue, admission | `packages/agent-host` (`turn-queue.ts`, `approvals.ts`, `event-log.ts`); the queue is persisted in host-core (ADR 0213, schema v15) |
| Context as managed memory (cache/eviction) | turn-boundary compaction and its fallbacks (ADR 0030, 0061, 0064, 0302) |
| Compute/storage separation | bounded host runtime + persistence outbox (ADR 0041) |
| Permission boundary (allowlist / observe) | permission modes, Plan/Goal approval boundary (ADR 0052), plugin permissions, high-risk tool marking |
| Memory that outlives a session | project memory (ADR 0234), memory store (ADR 0371), agent-written memory (ADR 0380), skill learning (ADR 0377) |
| Parallel work isolated per unit | per-session git worktrees (ADR 0329) |
| Work that starts itself | scheduled automations dispatched by host-core (`crates/host-core/src/scheduled/automation.rs`) — but on a clock the user sets, not on an event |

## Absent, deliberately

| Super-agent claim | Reality here | Decision |
| --- | --- | --- |
| The session stops being the unit of work | `turn_queue` is per session; every projection, tab, and notification is session-shaped | not adopted |
| Work arrives from outside | no GitHub/Feishu listener; the PR destination was removed outright (ADR 0308) | not adopted |
| Unattended delivery loop | the app can run a scheduled prompt, not own a branch and a review request | not adopted |

The last row is the load-bearing one. Super-agent's value comes from closing the
loop *outside* the product — a branch and a pull request. This product's delivery
policy is the opposite (AGENTS.md §5: no pull request by default), and it is the
honest boundary between the two shapes.

## What was tried, and what stands

Two additions were made during the review, both optional and both dormant on the
default path:

| Change | Status | Why |
| --- | --- | --- |
| Vendor `pi.session-orchestrator` and default work deliveries to a completion callback (ADR 0384) | shipped, idle | Only matters when a supervisor starts *cross-session* workers; the default delegation path never calls it |
| A sidebar strip listing cross-session worklines (ADR 0385) | **withdrawn** | A permanent sidebar region answered in the wrong place what the transcript can answer at the spawn; it also duplicated `subagent-topology.ts` and `TaskDock` |
| Render a `SessionTask` spawn as a delegation card (ADR 0386) | shipped, idle | Fires only for `toolName === sessiontask`; the built-in `Task` row is untouched |

Measured behaviour of the default path (the one users hit):

```text
user: 开两子会话，一个跑测试，一个看 README
model → Task ×2 (in-process delegates, same turn)
ui    → 主 Agent / 正在协调 2 个委派任务  + one card per delegate
```

Nothing in that path touches `SessionTask`, so ADR 0384/0386 stay dormant.

## If the other shape is ever wanted

It is a second product, not a feature of this one. The parts that exist and
would carry over: the host boundary (`packages/agent-host`), the persisted queue,
the permission model, `session_collaboration`'s durable ledger and completion
callback (`crates/host-core/src/session_collaboration/settlement.rs`). The parts
that do not exist and cannot be faked: an event intake (webhook/poll →
admission), a router that decides *whether* to accept work and with which model,
and a delivery channel. That is a different trust boundary — untrusted input
starting work with no operator present — and deserves its own threat model
before any code.
