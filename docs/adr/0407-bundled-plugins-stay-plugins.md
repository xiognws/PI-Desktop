# ADR 0407: Bundled plugins stay plugins

- **Status:** Accepted
- **Date:** 2026-11-24
- **Related:** 0383 (bundled plugin curation), 0402 (the agent kernel is a Rust crate), 0406 (Windows runs commands in Git Bash by default)

## Context

The application's binaries were quarantined on a managed host under
`PDM:Trojan.Win32.Generic`. Bringing the product's behaviour in line with its
reference implementation is a standing requirement in this repository, and one
proposal that follows from it is to reimplement the bundled plugins inside the
product and ship none of them: less third-party code in the tree, fewer
capabilities the host cannot reason about, and — it was assumed — fewer
behavioural shapes for an endpoint agent to score.

Two measurements decide whether that assumption holds.

**Plugins no longer cost processes.** The shared plugin host
(`apps/desktop/electron/main/plugin-shared-host.ts`) runs every plugin inside one
`node.mojom.NodeService` utility process. On this host the change took
`electron.exe` from 54 processes to 9 and `node.mojom.NodeService` from 46 to 2.
Moving one plugin's code into the core therefore removes no process, no
listener and no interpreter start — the parts an endpoint agent actually scores.

**Almost all of the remaining signal was not signal.** The bundled set was
audited rule by rule (48 files, 44 plugins) and then verified by hand. Three
capabilities had a real shape, and each was addressed where it lived:

| Capability | Shape | Resolution |
| --- | --- | --- |
| `local.pi-bot` microphone recorder | hidden PowerShell child compiling C# at load, holding an open microphone device | files deleted at packaging time, plugin switched off by default on Windows |
| `billion-context` | detached node proxy daemon, loopback listener, global `fetch`/`WebSocket` interception, request-body rewriting | retired: the kernel already ages tool results (`crates/agent-core/src/aging.rs`) and compacts with a model-written checkpoint (`crates/agent-core/src/compaction.rs`) |
| `task-dida`, `session-notify` foreground probe, terminal `-Command -` | inline `powershell -Command <script>`, interpreters reading stdin | rewritten to fixed `-File` scripts / removed / run through bash |

Every other high-scoring hit was a false positive: `getUserMedia` signatures in a
`.d.ts` type bundle, the string `powershell` inside a syntax-highlighting grammar,
`windowsHide: true` on a signed `git.exe`, a plugin manifest's prose, and a
plugin-internal map lookup named `lookupRegistryKey`.

## Decision

A capability may move into the core only when all three hold:

1. **Universality.** Every installation needs it; it is not an optional extra.
2. **Unfixable in plugin form.** Its implementation is itself the scored shape (a
   separate process, a resident listener, a hidden interpreter, input injection)
   and cannot be reshaped into a benign one while it stays a plugin.
3. **Core can express it with fewer shapes.** The kernel, host or renderer
   already owns, or can own, the same capability with no additional process,
   listener or interpreter.

Failing (1) or (2) the answer is to fix or retire the capability inside the
plugin, not to relocate it. Failing (3) relocating it would preserve the shape
while losing the process boundary, which is strictly worse.

No bundled capability currently meets all three. `billion-context` met them and
was removed rather than ported, because the kernel already implemented its
function.

## Consequences

- Plugins keep the utility-process boundary they were designed around. Agent
  execution stays out of the renderer and out of the host, per the frozen process
  model.
- The repository does not maintain forks of third-party plugin code. Upstream
  updates keep arriving as packaged artifacts, and a plugin whose behaviour is
  unacceptable is retired or switched off instead of patched in place.
- `apps/desktop/electron/main/index.ts` and the other ratchet hotspots are not
  asked to absorb a plugin's responsibilities; the advisory module-size limits
  stay meaningful.
- A future "port plugin X into the core" request has to show measurements for
  (1)–(3) before any code is written, and an ADR of its own if it goes ahead.
- What actually reduced the scored surface was shaping processes and
  interpreters: no self-copied tool runner, no inline PowerShell, no
  stdin-reading interpreter, fixed `-File` scripts, signed binaries, bash for
  commands. Bundle curation (`scripts/bundled-plugins-excluded.json`,
  `-default-disabled.json`, `-retired-capabilities.json`) is the lever for
  everything else, and it is a product decision, not a security one.
