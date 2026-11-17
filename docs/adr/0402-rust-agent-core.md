# 0402 — The agent kernel is a Rust crate, not the Node sidecar

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amends:** 0002 (use the pi agent harness) for the *execution* layer only; the
  process topology in `docs/spec/03-runtime/07-process-model.md` is unchanged.

## Context

The desktop's agent loop today lives in a Node sidecar:

```text
Electron main  --NDJSON JSON-RPC/stdio-->  packages/agent-runtime  --> @earendil-works/pi-*1.5.0
```

That has three costs we no longer want to pay:

1. **A runtime on the user's machine.** The sidecar needs Node, a bundled
   `node_modules` tree and the pi packages. The product requirement is a single
   executable: no Python, no Node, no pip/pnpm at install or launch time.
2. **The reference kernel is Python.** The agent behaviour we actually want to
   match (turn recovery, tool pairing, compaction, memory, skills, cron,
   delegation) is implemented in Hermes as ~271k lines of Python across
   `agent/`, `tools/`, `cron/` and `hermes_state_*.py`. Matching it from
   TypeScript means re-deriving that behaviour in a third language.
3. **The kernel is not testable on its own.** `packages/agent-runtime` is
   85,396 lines that mix loop, providers, plugins, widgets and Electron-era
   concerns; the loop cannot be exercised without a sidecar harness.

Measured kernel size we are migrating (Hermes, Python, lines):

| Component | Lines |
| --- | --- |
| gateway (channels, rooms, delivery) | 127,382 |
| session state (`hermes_state_*.py`) | 25,703 |
| providers + adapters + transports | 24,765 |
| cron / scheduled runs | 19,272 |
| agent loop + turn context/recovery/finalizer | 18,205 |
| context compaction | 11,049 |
| tools: filesystem, shell, processes | 10,450 |
| tools: registry, executor, approvals, toolsets | 7,507 |
| skills | 5,545 |
| tools: browser, vision, image, tts | 5,072 |
| tools: code execution, kanban, session search | 4,004 |
| MCP client | 3,837 |
| prompt composition | 3,635 |
| subagent delegation | 3,429 |
| memory | 930 |
| **Total** | **270,785** |

Native C/C++ is small and is **copied, not rewritten**: `native/fts5_cjk/fts5_cjk.c`
(252 lines) plus the vendored SQLite extension headers, and the X11 HUD
modifier monitor in the Hermes Electron app. Both compile into the binary; no
system library is introduced.

## Decision

1. A new crate, `crates/agent-core`, is the home of the agent kernel. Its
   modules claim the same responsibilities as the Hermes modules they port, so
   a reviewer can read one beside the other.
2. The crate becomes the sidecar process. The executable is
   `pi-desktop-agent-core` and it speaks the *existing* NDJSON JSON-RPC
   protocol and the *existing* [`AgentEvent`](../../packages/shared/src/types/agent.ts)
   vocabulary. Electron main changes its spawn target, not its protocol, and the
   renderer changes nothing.
3. The migration is component by component. Until the sidecar swap lands,
   nothing in the product depends on the crate; every phase is additive and can
   land on `main` on its own.
4. Native C/C++ sources are vendored verbatim and built with `cc` in
   `build.rs`; Rust wraps them. No reimplementation of shipped native code.
5. Dependencies stay statically linkable and buildable offline: `rustls` for
   TLS, `rusqlite`/bundled for SQLite, no OpenSSL, no system service. The
   release artefact is one file.

## Consequences

- The product gains one executable and loses the Node/pi dependency tree; the
  Electron bundle shrinks by `packages/agent-runtime` and its `node_modules`.
- Behaviour parity is the risk, not code style. During migration both runtimes
  exist, so the parity gate is a differential harness: the same recorded
  session replayed through the Node sidecar and through `pi-desktop-agent-core`,
  compared on transcript, event order and usage. That harness is the acceptance
  test for the sidecar phase; the crate's own tests are the gate for each
  component.
- The crate inherits the workspace licence (`LGPL-3.0-or-later`).
- `docs/spec/03-runtime/07-process-model.md` and `02-agent-runtime.md` keep
  describing the Node sidecar until the swap lands; they change in the same
  commit that switches `runtime/sidecar.ts`, not before. Recording the target
  here in advance is deliberate so the spec does not claim a state the product
  is not in.
- `packages/agent-runtime` is deleted in the final phase, together with its
  pi dependencies. Until then it stays the shipping implementation.
