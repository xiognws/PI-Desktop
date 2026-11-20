# ADR: The Rust kernel is the agent runtime

- Status: Accepted (implementation in progress: kernel built in this workspace,
  main-process adapter landed, headless e2e green)
- Related: ADR 0054 (command shell catalog), ADR 0057 (portable search),
  `crates/agent-core/`, `apps/desktop/electron/main/kernel/`,
  `apps/desktop/electron/main/agent-sidecar-launch.ts`,
  `scripts/e2e-agent-kernel.mjs`, D315, D701

## Context

The agent has always been a Node sidecar (`packages/agent-runtime`) built on the
pi libraries: `pi-ai` for provider streams and `pi-agent-core` for the turn loop.
It speaks NDJSON JSON-RPC over stdio to Electron main, and reaches everything it
does not own — sessions, tools, permissions, the filesystem — back through a
reverse `host.proxy` channel.

A second implementation of the same protocol exists: `crates/agent-core`, the
Rust kernel of the Nubo agent project. It speaks the same framing, answers the
same method names, and declares its tools with the same vocabulary. It was
written for this desktop, not adapted to it.

Two agent runtimes in one product is a maintainability problem with one honest
resolution: keep one. The questions are which one, where it lives, and who owns
what.

## Decision

### 1. `crates/agent-core` is the runtime, built in this workspace

The kernel is copied into this repository as `crates/agent-core` and built by the
same cargo workspace as `crates/host-core`. This repository is the source of truth
for the binary the desktop ships; the upstream kernel project is no longer a
build-time dependency of the app.

The binary ships at `<resources>/agent-core/nubo-proto[.exe]` and is started with
`serve`. The transport, framing and method names are unchanged from the Node
sidecar, so `AgentSidecar` drives either implementation without knowing which.

`PI_AGENT_CORE=node` keeps the Node sidecar reachable as a rollback for the
duration of the port. Anything else — including unset — selects the kernel. A
build that cannot find the kernel binary falls back to Node and logs why; it never
leaves the user without an agent.

### 2. Ownership does not move

The kernel is a *turn engine*, not a second host. It owns the conversation loop,
prompt composition, provider streams, compaction, plans and its own tool
declarations. It does not own:

| Concern | Owner | How the kernel reaches it |
| --- | --- | --- |
| Session transcript, turns, usage rollups | host-core (SQLite) | `host.proxy` → `session.get` on the first prompt of a session |
| Tool execution, filesystem leases, permissions, approval cards | host-core | `host.proxy` → `tools.execute` / `tools.abort` |
| Persisting agent events | Electron main (`persistence-outbox`) | the kernel only emits `agent.event` frames |
| Providers, secrets, plugins, MCP connections, workspaces | host-core / main | unchanged |

Consequences that matter: a tool call cannot bypass the permission gate, because
the kernel does not execute tools itself; a reopened session gets its history
back, because the transcript lives in host-core and the kernel re-reads it.

### 3. Adaptation lives in one place, on the main-process side

The kernel's wire vocabulary is its own: snake_case fields, `parts` instead of
`content`, epoch-ms timestamps. The renderer, the persistence outbox and the
transcript consume `AgentEventEnvelope`, so exactly one module knows both:

```text
apps/desktop/electron/main/kernel/kernel-adapter.ts   kernel event  -> AgentEventEnvelope
apps/desktop/electron/main/kernel/kernel-prompt.ts    launch params -> kernel params
```

The event translation runs at the single notification choke point
(`runtime/sidecar.ts`); the prompt translation runs inside `AgentSidecar.call`,
so no call site branches on which runtime answered.

Two rules keep the gap honest instead of silent:

* a frame the adapter cannot address is logged and counted, never dropped quietly;
* every launch parameter the kernel has no reader for is reported by name
  (`prompt.params.unsupported`) once per turn, and the list is pinned by a test.

### 4. The React UI is not part of this change

The renderer keeps its contracts. Whatever the desktop showed for a Node turn —
tool cards, transcripts, usage, approvals — must look and behave the same when the
kernel answers. A missing kernel capability is a gap to close in the adapter or
the kernel, not a reason to change the UI.

## Consequences

* Two vocabularies now have to be kept in step by tests, not by memory: the adapter
  fixtures are recorded from the real binary, and `scripts/e2e-agent-kernel.mjs`
  drives host-core + kernel + adapter end to end without starting Electron.
* The kernel is forked into this repository. Upstream improvements must be ported
  deliberately; there is no shared dependency to pull from.
* Parity is measurable and currently incomplete: part of the RPC surface
  (`agent.stop`, `agent.modeTurnNotice`, `widget.*`, `native.session.*`,
  `extensions.command.run`) and a set of prompt parameters (`scratchDir`,
  `projectMemory`, `permissionMode`, `subagentProviders`, …) still have no kernel
  reader. Each is closed by teaching the kernel the parameter and deleting it from
  the reported list in the same change.
* `agent.stopSubagents` is closed: the renderer's subagent stop button reaches it.
  The rule lives in one place — `DelegationRegistry::stop` — and both the `TaskStop`
  tool and the RPC phrase its outcomes for their own reader. The remaining RPC gaps
  have no renderer caller today, so they are surface parity, not user-visible
  breakage; `agent.stop` in particular is dead surface, because the stop button
  sends `agent.abort`, which the kernel already answers.
* `mode` and `pluginTools` are closed. Dropping `mode` had the kernel run a Plan or
  Goal session as Agent — the wrong rules in the prompt, and Write/Edit still in its
  own declarations; the adapter now forwards it. `pluginTools` is the one renamed
  parameter: it reaches the kernel as `tools`, because one declaration array covers
  both plugin agent tools and the user's MCP tools. `risk` and `planSafeActions`
  describe the plugin to host-core and have nowhere to live in a kernel declaration,
  so a Plan-mode plugin tool is still denied by host-core's contract rule until
  `planSafeActions` is carried on `tools.execute` as well.
* An approved plan runs again: `agent.executeApprovedPlan` turns the approval into
  the turn's instruction and runs the ordinary prompt path, and `SubmitPlan` exists
  in Plan mode — the mode prompt named a tool that was not registered. Both follow
  the Node runtime's argument names and instruction text, because a second
  execution path beside the first is a second set of bugs. Two differences remain:
  the kernel's `Tool` trait has no `terminate` flag, so an accepted submission does
  not end the turn the way Node's does, and the kernel keeps its checklist in
  `PlanState` (`Todo`) while the checklist the user sees is host-core's `TodoWrite`
  rows — one concept, two owners, still to be merged.
* `planning_state` is emitted; `tool_update` needs nothing, because this app has no
  partial tool-result channel for it to report: tools run as one `tools.execute`
  round trip, so the Node runtime only emitted it from an executor this product does
  not use.
* Prompt `attachments` are closed. The payload carries a path, not bytes: the kernel
  reads the file, inlines it as base64 when the launch declares the model can see it,
  and keeps a text reference otherwise (no vision, missing file, or past the
  per-image and per-turn ceilings). An image that travels alone also gets a system
  message, because the local gateway classifies `hasImagePart && msgs.len() <= 1` as
  image generation and answers with no `choices`.
* Approval does not need a kernel event: the permission card is driven by
  host-core's `permissions.request` notification, which Electron main already
  handles and the kernel never sees (`electron/main/runtime/host.ts`). Verified in
  the packaged app: a `Bash` call raised the card, the click released the call, and
  the command ran.
* Upstream's newer tools (browser, image generation, code execution, vision) live in
  its `agent-host` crate, which owns a second SQLite store and six sibling crates.
  Vendoring it would give this app two persistence owners, so those tools are ported
  one at a time into `host-core`, which is where tools execute here.
* The Node sidecar stays in the tree until the port is closed, then follows the
  usual removal path (surface, settings, tests, spec) rather than being left as a
  half-wired alternative.

## Verification

```bash
cargo build --offline -p agent-core --bin nubo-proto
cargo test  --offline -p agent-core
node scripts/e2e-agent-kernel.mjs             # 12 checks: session, events, persistence, history restore
node scripts/e2e-agent-kernel-parity.mjs      # 9 checks: mode, plugin tool declarations, approved plan
pnpm --filter @pi-workspace/desktop typecheck
```

The e2e run is the acceptance gate for the port: it proves the kernel streams a
turn, that its frames survive adaptation and land in host-core, and that a fresh
kernel process restores that transcript on the next prompt. The parity run covers
what a scripted turn cannot show — which tools a mode declares, whether the
adapter honours a renamed parameter, and whether the approved-plan call is still
unknown to the kernel.
