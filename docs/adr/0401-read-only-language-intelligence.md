# ADR 0401: Read-only language intelligence, not an IDE

## Status

Proposed. Stage 1 (wire framing) is implemented in
`crates/host-core/src/tools/lsp/`; process lifecycle and the tools themselves are
the next stages.

## Context

`docs/spec/01-product/02-non-goals.md` rules out a full IDE: no LSP, no debugger,
no multi-file editor workspace. That decision is about the *product surface* — the
desktop app is a conversation, and building an editor inside it would duplicate
VS Code badly and permanently.

The agent's problem is different. Grep tells it where a string appears; it cannot
tell it where a symbol is *defined*, which of twelve `run` methods the caller meant,
or that the file it just wrote does not compile because a parameter was renamed.
Those answers already exist: `rust-analyzer`, `pyright`, `gopls` and the TypeScript
server compute them for every editor the user already has installed.

So the useful line is not "LSP or no LSP". It is:

```text
editor surface          → stays a non-goal
symbol-level queries    → in scope, read-only, agent-invoked
```

## Decision

Add a **read-only** language-intelligence capability, exposed as tools rather than
as UI:

| Query | LSP method | Why the agent needs it |
| --- | --- | --- |
| Definition | `textDocument/definition` | "which `run` is this?" before editing a call site |
| References | `textDocument/references` | the real blast radius of a rename, not a grep count |
| Diagnostics | `textDocument/publishDiagnostics` | whether the edit it just made actually compiles |

Explicitly **not** included: hover, completion, formatting, rename edits, code
actions, symbols outline, and any persistent editor state. A tool that offers
rename would let the model rewrite a workspace without a diff anyone reviewed; that
is what `AstEdit` + `Edit` are for, with their own approval gate.

Staged delivery, each stage useful on its own:

1. **Wire** — frame codec, tested without a server (done).
2. **Session** — spawn one server per language per session, `initialize` handshake,
   request/response correlation by id, bounded timeouts, deterministic shutdown.
3. **Tools** — `LspDefinition`, `LspReferences`, `LspDiagnostics` with output shaped
   like the existing search tools (path, line, symbol), permission risk `Low`
   because they read and never write.

## Placement: the client belongs where the tools live

Stages 1 and 2 were written in `crates/host-core/src/tools/lsp/`, and that was the
wrong layer. Agent tools execute in the Node sidecar: `Read`, `Grep`, `Write` and the
`AstEdit` pair are all `setLocalTool` registrations in
`apps/desktop/electron/main/runtime/sidecar.ts`, and host-core owns persistence, native
state and permissions rather than agent execution (AGENTS §4). A language client in
host-core would have to be reached over an RPC invented for it, adding a protocol hop
and a second process boundary for no benefit - the sidecar can spawn the server itself.

So stage 3 is built in TypeScript beside the other tools, and the Rust module is a
prototype to be deleted rather than extended. What carries over is the design and its
tests: framing that asks for more bytes on a partial frame, correlation by id rather
than arrival order, orphaned responses dropped instead of misrouted, three separate
timeouts, and shutdown that cannot leave a server behind. Those properties are the
content of stages 1 and 2; their language is an implementation detail.

## Consequences

* Language servers are external binaries. A missing server is a normal state, not an
  error: the tool reports which server it looked for and where, and the agent falls
  back to grep. Nothing is downloaded at runtime.
* A server indexes the workspace, which costs CPU and memory for as long as the
  session lives. One server per language, reused across turns, shut down with the
  session — never one per query.
* Diagnostics are pushed, not pulled, and arrive on the server's schedule. The tool
  asks for a file's diagnostics with a bounded wait and reports "not ready yet"
  rather than hanging the turn.
* `02-non-goals.md` is amended to say that the *editor* is out of scope while
  read-only symbol queries are in scope, so the two documents cannot be read as
  contradicting each other.
* Path confinement is unchanged: queries are resolved against the session's file
  roots, exactly like `Read` and `Grep`.

## Alternatives considered

* **Tree-sitter index built in-process.** Rejected for the first version: it answers
  definition/references approximately, and "approximately correct navigation" is
  worse than grep for a model that cannot see the file it is being pointed at.
* **Shell out to `rg` for references.** Rejected: it cannot distinguish a definition
  from a mention, which is the entire question.
* **LSP servers managed per query.** Rejected: startup cost (rust-analyzer indexes
  for seconds to minutes) would make every call feel broken.
* **Full IDE integration.** Rejected by product scope; see non-goals.

## References

* `docs/spec/01-product/02-non-goals.md` — amended by this decision.
* `crates/host-core/src/tools/lsp/framing.rs` — stage 1.
* ADR 0400 — stream rules; the other half of "catch the mistake closer to when it
  happens".
