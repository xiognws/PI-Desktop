# ADR: Capability packages run in the agent sidecar

- Status: Implemented candidate
- Related: D691, D687 (tool packages), ADR 0214, ADR 0215, spec 07-plugins/16, spec 07-plugins/19

## Context

Users want to extend the product with code they write themselves and can hand to
someone else. The two existing extension surfaces do not fit that shape. A tool
package (D687) is declarative metadata plus assets shipped in the same image — no
runtime, nothing that runs. A trusted extension (ADR 0214) is a hook inside the
agent process: it registers tools, commands, providers and event handlers, and it
is granted because the *plugin* asked for `agent.extension`, which means the
plugin registry owns install, versioning and the marketplace lifecycle.

What a widget package needs instead is: a folder the user drops in their own
data directory, scanned at launch, with a callable surface and the ability to call
back into the host — more reach than a hook, without the marketplace machinery of
a plugin.

## Decision

Widget packages live at `<userData>/widgets/<folder>/widget.json`
plus an entry module, and are **loaded and executed in the agent sidecar**, not in
Electron main and not in the renderer.

- host-core owns discovery, permission grants and trust state. It computes a
  SHA-256 digest over the package's relative paths and bytes; first sight is
  `untrusted`, acceptance pins *that digest*, a later change withdraws the grant
  and marks the row `modified`. Re-accepting a digest that no longer matches
  answers `changed on disk since it was reviewed`.
- The sidecar owns execution. A `CapabilityRegistry` is process-level, not
  session-level, so two windows cannot load one package twice and double its side
  effects. Actions run under a 30 s deadline.
- Two directions: renderer → IPC → `widget.invoke`; and inside an action,
  `call(method, params)` → `ParentHostProxy` → main's normal RPC path, restricted
  to `CAPABILITY_HOST_METHODS` and gated on the `host` permission.
- The agent reaches packages through a `Capability` tool (`list` / `invoke`),
  registered in agent mode only.
- Permissions are `read`, `write`, `net`, `agent`, `host`. An untrusted package
  is sandboxed to `read` + `write`; `host` is never granted by default.

## Alternatives

Running packages in Electron main would give them the host's own privileges by
accident and put user code on the thread that owns persistence and IPC. Running
them in the renderer would hand user code the DOM and the session, and the frozen
process model already forbids executing anything there.

Reusing the plugin registry would have been less code, but it would also have
imported install, versioning, marketplace and signing semantics the feature does
not have, and made a hand-copied folder look like an installed product.

A full cryptographic signature scheme was considered and deferred. Signing needs a
key distribution story and a publisher identity the product does not have yet, and
it would still answer the wrong question for a user who copies a folder in
themselves: *is this the code I reviewed?* The digest freeze answers that one
directly, and it is the check a signature would ultimately feed.

A per-invocation deadline with no process isolation was rejected for the same
reason trusted extensions keep one: a JS wait can be cancelled, a busy loop
cannot. The existing sidecar-crash path is the containment.

## Consequences

A crashing or hanging package degrades to a failed session, not a dead window.
Permissions are coarser than the plugin matrix — `host` is one switch, not a list
of methods — and can be split later without changing the manifest. Nothing signs a
package, so trust is local and per-machine by construction; distributing a zip
means the recipient reviews a digest of their own copy. There is no unload hook in
v1, so a package that installs process-level state keeps it until the sidecar
restarts.
