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
| `skill_manage` | the skill library's writer: `create` (marks `createdBy: agent`), `patch` (one exact span, counted locally), `write_file`/`remove_file` (project-scoped), `delete`, `absorb`, with the SKILL.md quality bar in the tool description | `skill-manage-tool.ts` |
| `mcp` | MCP tool selection: exact server/tool identity resolution, never a name-prefix match, with `INVALID_ARGUMENT`/`COMPOSER_MCP_UNAVAILABLE`/`TOOL_DENIED` | `mcp-tool-selection.ts` |
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
| 5c | `skill_manage`: the model writes its own library — `create` carrying `createdBy: agent` so curation may only retire what the agent wrote, `patch` that counts occurrences locally (0 → "copy an exact span", >1 → "occurs N times"), reference files under `references/`/`templates/`/`scripts/`/`assets/` with the session's project scope, `delete`, and `absorb` | **done** |
| 5b | memory: the `memory` tool over `memory.remember/update/forget/recall` (single and 50-item batch writes, scope coherence, procedure gate naming the skill to patch, credential masking), per-turn `<memory_context>` recall injected into the user message, `AgentError::Refused` for model-fixable tool refusals | **done** |
| 6a | subagent delegation: `Task` starts a bounded delegate turn (own prompt, own transcript, only its declared tools, 24 steps) and returns at once; `TaskWait` converges and reads the report once, `TaskList` reports state, `TaskStop` settles one delegate without touching the parent turn; reports bounded to 12,000 characters keeping both ends; every delegate event carries `parentToolCallId`/`agentName` | **done** |
| 6b | delegation resume: a delegate that is still working (or settled with a report nobody read) keeps the parent turn open, its report is handed over as one resumed user turn — `DELEGATION_RESUME_PROMPT` plus `## agent (id) — status` blocks bounded at 50k characters, marked delivered before the request goes out — and a stopped or aborted delegate never keeps the turn open | **done** |
| 6b- | delegation gaps left open on purpose: model overrides and configured fallbacks, `resume` chains, and the scratch spill file for oversized reports | note |
| 6c | MCP selection: a composer's `mcpServerIds`/`mcpToolNames` resolve to the exact tool set those names authorize (exact identity, never a prefix match) and an unsatisfiable selection refuses the prompt with `COMPOSER_MCP_UNAVAILABLE`/`TOOL_DENIED`. The MCP *client* stays where it already is: host-core owns the server records (`crates/host-core/src/mcp_servers.rs`), Electron main owns the processes, handshakes and `callTool`, and the kernel only ever sees MCP tools as host-declared tools | **done** |
| 6d | cron/scheduled runs: **no kernel work**. Host-core owns the records, the cadence and the automation pass (`crates/host-core/src/scheduled.rs`, 741 lines + `automation`/`timing`/`project`), and a run is an ordinary prompt against a session — which the kernel already serves. Nothing here spawns the agent itself | verified |
| 7a | packaging, measured on commit `0a4b56b02`: `cargo build -p agent-core --release --offline` → **6.34 MiB** `pi-desktop-agent-core.exe`; imports only Windows system libraries (KERNEL32, ADVAPI32, bcrypt, bcryptprimitives, ntdll, ws2_32, dbghelp, api-ms-win-core-synch) — no Node, Python, OpenSSL or VC++ redistributable; `self-check` 6/6; a scripted NDJSON session over real stdio returns 3 responses and the full `agent_start…agent_end` event sequence | **done** |
| 7b | switchable launch: `agent-sidecar-launch.ts` picks this binary when `PI_AGENT_CORE=rust`, otherwise the Node sidecar, and falls back to Node when the binary is absent; `scripts/agent-core-differential.mjs` runs one identical conversation through both and diffs the result | **in progress** |
| 7c | parity items the differential found and this crate now matches: history restore (`session.get`), the system-prompt journal (`session.appendMessage`), memory recall on every Agent prompt, `status` events | **done** |
| 7d | what the differential still reports, all documented: the background `skill_review` pass, `tools.fileBatchCapabilities` read batching, and the kernel's incremental `message_update` (a superset). Then delete `packages/agent-runtime` | next |

Sizes being ported are recorded per component in ADR 0402; use that table to
scope a phase, not a guess.

## Parity notes

Two shapes the Node sidecar has and this kernel did not, both found by
`scripts/agent-core-differential.mjs` rather than by a user:

- **Provider wire.** Main sends a `RuntimeProviderConfig`: the wire is
  `apiStyle` (`openai-completions`, `anthropic_messages`, `responses`, …) and the
  model is `modelId`. There is no `kind` field. A kernel that requires `kind`
  rejects every real prompt, which is exactly what it did.
- **`agent.getStatus`.** The answer is `{ status: { sessionId, isRunning,
  pendingToolConfirmations } }`. The renderer destructures `status`, so a flat
  object reads as `undefined` and an idle session never looks idle.

Two host calls a turn makes before it dispatches, both learned from the same
run: `session.get` (host-core owns history; a reopened session has none here) and
`session.appendMessage` (the composed system prompt is journaled, once per
distinct prompt, before the request goes out). A host that *refuses* the journal
write fails the prompt — a turn the store never saw cannot be reproduced — while
a host that does not answer at all degrades after ten seconds, because a prompt
that never returns is worse than a missing row.

Run the harness before claiming parity:

```bash
node scripts/agent-core-differential.mjs          # exits 1 on divergence
node scripts/agent-core-differential.mjs --verbose
```

## Packaging

```bash
cargo build -p agent-core --release --offline   # -> target/release/pi-desktop-agent-core.exe
./target/release/pi-desktop-agent-core.exe self-check
printf '%s
' '{"jsonrpc":"2.0","id":1,"method":"sidecar.health","params":{}}'   | ./target/release/pi-desktop-agent-core.exe serve
```

Measured on Windows 11 / rustc 1.98 (release, `--offline`):

- size **6.34 MiB**, one file, no installer;
- imports only Windows system DLLs (KERNEL32, ADVAPI32, bcrypt, bcryptprimitives,
  ntdll, ws2_32, dbghelp, api-ms-win-core-synch): nothing needs installing on the
  target machine — TLS is `rustls`, and SQLite is host-core's, not this binary's;
- `self-check` passes all 6 assertions, and a scripted NDJSON session over stdio
  produces the three responses plus the full event sequence
  (`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`,
  `usage`, `turn_end`, `agent_end`).

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
