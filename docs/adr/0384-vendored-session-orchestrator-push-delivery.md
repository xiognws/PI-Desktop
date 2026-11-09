# ADR 0384: Vendor Session Orchestrator with push-first work deliveries

- Status: Accepted for implementation
- Date: 2026-11-09
- Related: ADR 0237 (orchestration as a plugin), ADR 0239 (host-owned
  collaboration ledger), ADR 0213 (host-owned turn queue), ADR 0089 /
  ADR 0166 (in-session delegation lifetime), ADR 0241 (vendored first-party
  plugin), ADR 0165 (withdrawn A2A stack)

## Context

ADR 0237 kept orchestration out of the host: `pi.session-orchestrator` spawns
and supervises real durable sessions through the reviewed `desktop.control`
gateway, and the host owns delivery, queue admission, and results. That split is
right and stays.

What the shipped plugin does not do is tell the supervisor when a worker
finishes. Upstream `0.7.0` moved every delivery to pull-first
(`notifyOnCompletion: false`) because a caller that both polls `result` and
receives a completion callback can read the same work twice. The consequence in
this product is that a supervising session ends its turn and never learns the
worker settled: the user returns to a supervisor that is idle while its workers
finished, and must prompt it again. Every other part of the loop already exists
— the host inserts a `task.completed` / `task.failed` inbox row for every
terminal turn (`crates/host-core/src/notifications.rs`), the sidebar shows
per-project running counts, and a session hover card shows one session's
collaboration detail — but the convergence step back into the supervisor is
missing, which is the only reason a user has to keep watching sessions.

The plugin is not in this repository. `apps/desktop/resources/plugins/*` is
ignored and populated from the marketplace by
`scripts/sync-bundled-plugins.mjs`, so a behavior change cannot be delivered
from here at all: the next sync would overwrite it.

## Decision

1. **Track the plugin.** `apps/desktop/resources/plugins/pi.session-orchestrator`
   is added to the tracked allowlist in `.gitignore`, following the vendored
   precedent of ADR 0241 (`pi.file-manager`). `sync-bundled-plugins.mjs` skips
   every id that `git ls-files` reports under `resources/plugins`, so tracking
   the directory is the whole integration; `--force` remains the deliberate
   takeover path. `UPSTREAM.md` records the upstream repository, tag `v0.7.1`,
   commit `cb9037a`, the bundled version `0.8.0-pi.1`, and the checksums.
2. **Work deliveries report back by default.** `spawn` and a `send` that is not
   `kind: "message"` pass `notifyOnCompletion: true` unless the caller passes a
   value. `supervise` inherits that per delivery.
3. **Plain peer messages stay pull-first.** A `send` with `kind: "message"` keeps
   `false`: it is communication, not work, and a completion turn for each one
   would fill the sender's queue — the exact failure upstream was avoiding.
4. **An explicit `notifyOnCompletion` always wins**, in both directions. Pull
   remains reachable and is what the README now documents as the explicit
   alternative, so the race upstream worried about cannot happen by accident:
   it requires a caller that opts into pulling.
5. Everything else in the directory is the release's own artifact. The only
   other edits are the manifest `version` / `changelog` and the description
   strings that stated the old default.

## Consequences

- A supervising session receives the worker's final report as a host completion
  message and continues on its own; the user no longer has to re-prompt it. When
  the supervisor is busy, the host queues the completion through the existing
  durable turn queue (ADR 0213) instead of dropping it.
- The default is a behavior change for anyone who installed the marketplace
  build: a session that spawns workers now gets a follow-up turn per completed
  work delivery. `notifyOnCompletion: false` and `kind: "message"` both restore
  the old behavior, and the README documents the default in every entry point.
- The bundled copy now diverges from the marketplace release. The version
  suffix `-pi.1` marks it, `UPSTREAM.md` carries the provenance, and a future
  upstream release that adopts push-first should replace the directory byte for
  byte and delete that file.
- Pull-mode callers are unchanged: no completion callback is generated, and
  `result` remains the only read.
- No host, IPC, schema, or plugin-SDK change: the patch only chooses a value the
  host contract already accepts.

## Alternatives considered

- **Change the default in the host instead.** Rejected: the host must honor what
  the plugin asks for. Defaulting an omitted value to true would only affect
  callers that omit it, and the plugin always sends an explicit boolean.
- **Wait for an upstream release.** Rejected as a delivery path: it would leave
  the convergence gap in every build from this repository, and the patch is one
  expression in two call sites.
- **Default every delivery to push, including `kind: "message"`.** Rejected: a
  peer message is not work, and its completion turn would land in the sender's
  queue for each message — the queue-filling behavior upstream removed.
- **Add a sidebar workline panel instead.** Rejected as the answer to this
  problem: it makes the state visible but still requires the user to look and
  act. Visibility is a separate, later decision; convergence is what removes the
  watching.
