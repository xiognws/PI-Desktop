# agent-core

The Rust agent kernel. It is being built as the replacement for the Node sidecar
(`packages/agent-runtime`), and it is a component-by-component port of the
Hermes kernel. The architecture decision is [ADR 0402](../../docs/adr/0402-rust-agent-core.md).

Target topology (unchanged protocol, one fewer runtime):

```text
Electron main  --NDJSON JSON-RPC/stdio-->  pi-desktop-agent-core (Rust)
                                                  |
                                   host-core tool bridge, through main
```

Nothing in the product depends on this crate yet. Until the sidecar swap lands,
each phase is additive on `main`.

## Module map

| Module | Responsibility | Hermes counterpart |
| --- | --- | --- |
| `message` | roles, content parts, tool call/result, usage, stop reason | `agent/agent_messages.py` |
| `event` | turn/stream events in the renderer's vocabulary | `agent/display.py` |
| `cancel` | one token per turn, awaited by every operation | turn abort handling |
| `provider` | provider trait, `StreamEvent`, `ResponseAssembler` | `agent/auxiliary_client.py`, `agent/*_adapter.py` |
| `provider::sse` | incremental SSE framing (split frames, CRLF, comments) | — |
| `provider::openai` | OpenAI-compatible streaming decode | `agent/transports/*` |
| `provider::anthropic` | Anthropic Messages streaming decode | `agent/anthropic_adapter.py` |
| `provider::scripted` | deterministic provider for tests and the self-check | — |
| `tool` | declarations, registry, approval gate, result ceiling | `tools/registry.py`, `agent/tool_executor.py`, `tools/approval.py` |
| `turn` | the loop: request → stream → tools → repeat | `agent/conversation_loop.py` |
| `session` | transcript, tool-pair repair | `agent/turn_recovery.py` |

## Running it

```bash
cargo test -p agent-core --offline
cargo clippy -p agent-core --all-targets --offline
cargo run -p agent-core --offline -- self-check
```

`self-check` runs a scripted two-step turn through the real loop and prints
every event as NDJSON, then asserts the outcome (tool result recorded, answer is
the tool output, usage accumulated, event order). It is the smoke test the
packaging step runs after a build, and it needs no network, credential or paid
request.

## Phase status

| Phase | Contents | Status |
| --- | --- | --- |
| 1 | message model, events, cancellation, SSE + OpenAI/Anthropic decode, tool registry and gate, turn loop, transcript repair, self-check binary | **done** |
| 2 | sidecar RPC surface (`sidecar.*`, `agent.prompt/steer/abort/compact/getStatus/disposeSession`, `native.session.*`), HTTP transports over `reqwest`+`rustls`, provider registry and auth from host config, host-core tool bridge | next |
| 3 | prompt composition and project instructions, context budget and compaction | |
| 4 | filesystem/shell/search tools, permissions, asktool | |
| 5 | memory store and skills | |
| 6 | MCP client, cron/scheduled runs, subagent delegation | |
| 7 | packaging: single exe, switch `runtime/sidecar.ts`, differential parity run, delete `packages/agent-runtime` | |

Sizes being ported are recorded per component in ADR 0402; use that table to
scope a phase, not a guess.

## Conventions

- One module, one responsibility. Business rules do not live in the binary.
- Tool failures are results, not turn failures — the model must be able to
  recover from them.
- No network, clock, filesystem or credential in a unit test: scripted provider
  and in-memory transcript only. Real-provider behaviour is tested at the
  transport phase with recorded fixtures.
- Vendored C/C++ is compiled through `build.rs`; never hand-edit vendored
  sources.
