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
| `host_bridge` | outbound `host.proxy` calls, `tools.execute` relay, tool declarations from the host | — (desktop contract, from `parent-host-proxy.ts`) |
| `rpc` | NDJSON JSON-RPC 2.0 codec (requests, responses, notifications, error codes) | — (desktop contract, from `sidecar.ts`) |
| `sidecar` | the method surface, session table, one turn per session, `agent.event` notifications | — |
| `turn` | the loop: request → stream → tools → repeat | `agent/conversation_loop.py` |
| `session` | transcript, tool-pair repair | `agent/turn_recovery.py` |
| `skills` | skill catalog (id/name/description + 60-char index cap), catalog budget gate, the `Skill` tool (listing answered here, body loaded by the host) | `tools/skills_tool.py`, catalog block of `agent/system_prompt.py` |
| `memory` | the `memory` tool: `remember` (single and batched), `update`, `forget`, `search` over `memory.*`, scope coherence, procedure gate, credential masking | `tools/memory*.py`, `memory-agent-tool.ts` |
| `memory_context` | per-turn recall rendered as one `<memory_context>` block in the user message | `memory-context.ts` |
| `skill_overlap` | the procedure-versus-fact gate and the "which skill covers this" hint | `memory-skill-overlap.ts` |
| `redaction` | credential vocabulary and the scrub applied on the way out (memory, outbound text) | `packages/shared/src/redaction.ts` |
| `delegate` | subagents: `Task`/`TaskWait`/`TaskList`/`TaskStop`, per-session delegation registry with its own cancel, delegate prompt framing, bounded reports (12,000 chars, both ends kept) | `subagent.ts`, `delegation-chain.ts` |
| `ask` | the `asktool` card: question validation (300 code points, ≤20 questions), duplicate-label collapse, `asktool_request` event, `asktool.resolve` validation, skipped answers on abort | `asktool` in `packages/shared/src/types/agent.ts`, spec `17-asktool-questions.md` |
| `context` | window/hard-limit/trigger arithmetic, token estimate anchored on provider usage | `agent/context_compressor.py` |
| `compaction` | cut point, summary request, retained tail, fallback selection | `agent/context_compressor.py`, `agent/conversation_compression.py` |

## Running it

```bash
cargo test -p agent-core --offline
cargo clippy -p agent-core --all-targets --offline
cargo run -p agent-core --offline -- self-check
cargo run -p agent-core --offline -- serve     # NDJSON JSON-RPC on stdio
```

`self-check` runs a scripted two-step turn through the real loop and prints
every event as NDJSON, then asserts the outcome (tool result recorded, answer is
the tool output, usage accumulated, event order). It is the smoke test the
packaging step runs after a build, and it needs no network, credential or paid
request.

`serve` is the sidecar Electron main spawns. A session needs
`sidecar.configure` before `agent.prompt`; the `scripted` provider kind exists
for harnesses, and `openai`/`anthropic` take `baseUrl` plus `apiKey`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"sidecar.configure","params":{"provider":{"kind":"scripted","text":"hi"},"model":"m"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"agent.prompt","params":{"sessionId":"s","turnId":"t","prompt":"hello"}}' \
  | ./target/debug/pi-desktop-agent-core serve
```

## Phase status

| Phase | Contents | Status |
| --- | --- | --- |
| 1 | message model, events, cancellation, SSE + OpenAI/Anthropic decode, tool registry and gate, turn loop, transcript repair, self-check binary | **done** |
| 2a | NDJSON JSON-RPC codec, sidecar method surface (`sidecar.health/configure`, `agent.prompt/abort/getStatus/disposeSession`, `native.session.get`), HTTP transports over `reqwest`+`rustls` for both wires, `serve` mode over stdio | **done** |
| 2b | host-core tool bridge: declarations arrive on `sidecar.configure`, each call travels back as `host.proxy` → `tools.execute`, answers map onto tool results | **done** |
| 2c | per-prompt provider (`params.provider`), `content`/`userMessageId` prompt fields, `agent.steer` + `agent.steeringContext` drained between steps, `native.session.list/fork/search`, abort addressed at a turn | **done** |
| 3a | system prompt composition: persona (`SYSTEM.md` replaces it), `APPEND_SYSTEM.md`, host tool guidance, the `AGENTS.md`/`CLAUDE.md` chain with per-directory precedence and separate global/project byte budgets, verbatim mode prompts | **done** |
| 2d | remaining gap for a real session: `agent.compact` (needs 3b), persistence so `native.session.*` reads a store instead of live sessions, `sidecar.configure` network proxy actually applied to the HTTP client | next |
| 3b-1 | context budget: window ceiling, `hardLimit`, headroom, trigger at half, retained-tail target, usage-anchored token estimate | **done** |
| 3b-2 | compaction plan: cut point per mode, summary request sized the way it is sent, bounded reduction, chunk splitting, retained-tail fallback | **done** |
| 3b-3 | loop integration (gate before every step, compact in place), provider-written summary with retry on transient failure, `agent.compact`, `compaction_start`/`compaction_end` events | **done** |
| 4a | `asktool`: bounded questions asked of the user (Agent/Plan/Goal), `asktool_request` event and `asktool.resolve` RPC with the wire's error codes, every open card settled as skipped when its turn stops | **done** |
| 4b | where the rest of phase 4 actually lives: file/shell/search tools execute in the host (`tools.execute`), their per-class result budgets are host-enforced (spec 16), and `permissions.request` never reaches the kernel — main forwards it to the renderer itself, so `Permission::Ask` here only covers kernel-registered tools | note |
| 5a | skills: catalog parsing (sorted, deduplicated), 60-character index cap, 8k catalog budget gate, Skills prompt section, `Skill` tool with a kernel-answered listing and host-delegated body load | **done** |
| 5b | memory: the `memory` tool over `memory.remember/update/forget/recall` (single and 50-item batch writes, scope coherence, procedure gate naming the skill to patch, credential masking), per-turn `<memory_context>` recall injected into the user message, `AgentError::Refused` for model-fixable tool refusals | **done** |
| 6a | subagent delegation: `Task` starts a bounded delegate turn (own prompt, own transcript, only its declared tools, 24 steps) and returns at once; `TaskWait` converges and reads the report once, `TaskList` reports state, `TaskStop` settles one delegate without touching the parent turn; reports bounded to 12,000 characters keeping both ends; every delegate event carries `parentToolCallId`/`agentName` | **done** |
| 6b | delegation gaps left open on purpose: model overrides and configured fallbacks, `resume` chains, the scratch spill file for oversized reports, and automatic delivery of a report into a turn that already stopped calling tools (today `TaskWait` in the next turn is what reads it) | note |
| 6c | MCP client, cron/scheduled runs | |
| 7 | packaging: single exe, switch `runtime/sidecar.ts`, differential parity run, delete `packages/agent-runtime` | |

Sizes being ported are recorded per component in ADR 0402; use that table to
scope a phase, not a guess.

## Conventions

- One module, one responsibility. Business rules do not live in the binary.
- Tool failures are results, not turn failures — the model must be able to
  recover from them. A refusal the model can fix (`AgentError::Refused`) reaches
  it as its own sentence, with no wrapper.
- Memory recall is opt-in per prompt: `agent.prompt` carries `memoryRecall: true`
  when the host offers memory, and the kernel then issues one bounded
  `memory.recall` (`<memory_context>` into the user message, never the system
  prompt). Without the flag no recall request is made at all, which is what keeps
  an older host's request sequence unchanged.
- No network, clock, filesystem or credential in a unit test: scripted provider
  and in-memory transcript only. Real-provider behaviour is tested at the
  transport phase with recorded fixtures.
- Vendored C/C++ is compiled through `build.rs`; never hand-edit vendored
  sources.

## Host tool contract

The kernel implements no filesystem, shell or search tool. Main declares the
tool set and serves every call, which keeps permissions, approvals and the audit
trail in the place that already owns them.

```text
sidecar.configure {provider, model, tools:[{name, description, parameters}]}

kernel -> main   {"jsonrpc":"2.0","id":"<uuid>","method":"host.proxy",
                  "params":{"method":"tools.execute","params":{
                    "sessionId","turnId","toolCallId","toolName","args"}}}
main  -> kernel  {"jsonrpc":"2.0","id":"<uuid>",
                  "result":{"ok":true,"content":...}}          # or "error"
```

- `ok: false`, `isError: true` and `errorCode: "PERMISSION_DENIED"` become an
  error tool result, and the turn continues so the model can react.
- An unanswered call times out (600 s default) and a closed channel fails every
  waiter — neither may hang the turn.
- A late answer to a call that already timed out is dropped, not mis-delivered.
