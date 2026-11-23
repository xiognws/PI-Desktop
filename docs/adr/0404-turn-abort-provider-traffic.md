# ADR: Abort releases tools, but the provider loop can still run

- Status: Accepted (limitation recorded; not fixed in this repository)
- Related: ADR `tool-abort-abandons-host-call`, issue #1767,
  `packages/agent-runtime/src/runtime.ts` (`abortTurn`, `streamFn`,
  `afterToolCall`), `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`,
  `scripts/e2e-read-only-stop.mjs`

## Context

Stopping a running turn has two obligations that pull in opposite directions:

1. **The UI must stop immediately.** A renderer that keeps showing "processing"
   after a Stop is a worse failure than a slow stop, so `abortTurn` drives the
   tools itself (`runtime.ts`, the `activeToolAborts` loop). Before #1767, a
   single tool that never yielded pinned the entire session, because the
   renderer awaits the abort RPC before it clears its state.
2. **The provider must stop being billed.** A turn that keeps sending requests
   after Stop spends real money on an answer nobody asked for.

Releasing the tool satisfies the first obligation and, by design of the agent
library, breaks the second.

### Measured behaviour

A real conversation through the local `wk` gateway
(`wk-deepseek-v4.1-flash-011`, no credential needed), with a counting loopback
proxy in front of it and a tool deliberately held open:

```
#1 messages=2   ← the initial prompt
#2 messages=5   ← one more request immediately after abort returned
#3 messages=7   ← another round (tool call + error result)
#4 messages=5   ← the loop rebuilds
#5 messages=7
```

`agent.getStatus()` already reported `isRunning: false` after `#2`. The turn was
"stopped" while the provider loop kept producing billable requests roughly every
two seconds for the rest of the observation window.

## Root cause

The agent library decides whether a tool batch ends by looking at the results it
receives (`agent-loop.js`, `shouldTerminateToolBatch`: every result must carry
`result.terminate === true`). Two properties of its abort path defeat that:

- When the run signal is already aborted, the library **constructs the error
  result itself** and returns it, bypassing `finalizeExecutedToolCall` — so the
  `afterToolCall` hook the runtime registers is never consulted, and the
  synthesized result carries no `terminate`.
- `hasMoreToolCalls = !executedToolBatch.terminate` then keeps the loop alive,
  and the follow-up request is issued from inside the library rather than
  through the `streamFn` the runtime injected.

## Attempts that did not work

| Attempt | Outcome |
| --- | --- |
| `afterToolCall` returns `{ terminate: true }` while cancelled | Hook never invoked on the abort path |
| `createProviderRetryStream`'s attempt callback throws `AbortError` | Never executed; traffic continued |
| `streamFn` entry throws `AbortError` | Never executed; `streamFn` logged twice while five requests were forwarded |

All three were reverted; none of them is present in the code.

## Decision

Do not work around this inside the desktop runtime. Keep #1767's guarantee —
Stop always releases a pinned tool — and record the provider-traffic cost as a
known limitation to be fixed where it originates, in the agent library.

A runtime-side workaround would have to either let the tool result reach the
library (which is what restarts the loop) or withhold it (which restores the
pinned-session failure #1767 removed). Neither is acceptable.

## Consequences

- A stopped turn can spend a small number of extra provider calls before the
  library's loop settles. The desktop cannot prevent it and must not pretend the
  session is idle in its own bookkeeping: `agent.getStatus()` reporting
  `isRunning: false` while requests continue is a **reporting** inaccuracy that
  goes away with the upstream fix.
- `scripts/e2e-read-only-stop.mjs` asserts the correct behaviour
  (`requests === 2`) and therefore fails until the library is fixed. That failure
  is honest and should stay hard.
- The follow-up belongs upstream: either the library marks synthesized abort
  results with `terminate: true`, or it routes the follow-up request through the
  injected `streamFn` so the host can refuse it. Either fix removes the loop.
- When the library is upgraded, re-run the local-gateway measure above
  (`wk-abort-test.mjs`, kept as a scratch probe): the count must stop at 1.
