# ADR 0393 — A desktop app's own models are a local entry, not a plugin

- Status: Accepted
- Date: 2026-11-11

## Context

Users asked for their local AI desktop app's models (WorkBuddy / Tencent
CodeBuddy today) to appear in Pi-Workspace's model list, discovered from the
machine rather than typed in by hand. Most machines do not have that app, so the
capability has to be optional and invisible when absent.

Three existing surfaces were considered and each leaves part of the job undone:

- **Plugin-declared providers (ADR 0259, ADR 0322).** The model list a plugin
  declares is manifest data, re-read from disk on every load. That catalog is
  account-level and changes with the vendor's releases, so a manifest would ship
  a stale list; the row it produces is also read-only for the user
  (`providers.update` refuses it), so a discovered model could never be added to
  it. A plugin is the wrong owner for state that the *machine* owns.
- **A plain `openai_compatible` provider row pointing at the vendor endpoint.**
  The endpoint is not a well-behaved OpenAI service: it refuses non-streaming
  requests, refuses a `system` message longer than ~20000 characters with
  `11128`, and refuses request features the channel check dislikes. A transport
  that does not implement those behaviours fails on the first long prompt, and
  pi-ai is not the place to grow one vendor's exceptions.
- **Reading the desktop app's stored session.** The app seals its token with its
  own key material, tied to its own version. Extracting it would be a
  credential-circumvention path that breaks on every app update.

## Decision

1. A "local model entry" is an ordinary **provider row** owned by the user, plus
   a **loopback gateway** owned by the Electron main process. Nothing else in the
   app learns a new concept: Settings, the model picker, model discovery,
   connection tests, and session bindings all see a normal provider.
2. Discovery is machine-local and reads no credentials. The entry reads the
   desktop app's account fields and session expiry (both plaintext) to decide
   *installed* and *signed in*, and its cached model catalog to fill the model
   list. Sealed token envelopes are never parsed.
3. The gateway listens on `127.0.0.1` only, on an ephemeral port, speaking
   `GET /v1/models` and `POST /v1/chat/completions`. It owns the vendor's quirks:
   always streaming upstream, splitting a long system prompt into a system head
   plus a user reference message, and a fixed request-shape ladder on `11128`.
4. `/v1/models` answers without a credential, so the account's models reach the
   picker before the user has supplied anything. Chat requires a bearer token,
   and that token **is** the provider's own API key: the user pastes the vendor
   access token once into the ordinary provider dialog, the Host stores it in its
   secret store, and the gateway forwards it upstream per request. The gateway
   stores, caches, and logs no credential.
5. The row is marked with `vendorKey` = the source id (`workbuddy`) so the next
   launch finds the same row instead of adding a second one. A launch where
   neither the endpoint nor the model ids changed writes nothing.
6. Absence is normal. A machine without the app produces no row at all; a row
   whose app was uninstalled is switched off (`enabled = false`) rather than
   deleted, so the stored key survives a reinstall.
7. Sources are a registry (`LocalModelSource`): detection plus a gateway factory
   per vendor. Adding another desktop app is a new module and one registry entry,
   with no change to the service, the row registration, or Settings.
8. Nothing here is an IPC channel or a renderer surface. The entry needs no new
   UI: it is a provider row, and its "needs a key" state is the state every other
   provider already shows.

## Consequences

- Installing the desktop app makes an entry appear on the next launch, with the
  account's chat models and their stated context/output limits. Removing the app
  parks the entry instead of erroring.
- One manual step remains where the vendor seals its token: the user pastes the
  access token once, exactly as they would for any other API-key provider. The
  entry cannot and does not extract it from the app's own store.
- The listener is a local HTTP server inside the main process. It binds loopback
  with an ephemeral port, requires a bearer token for chat, and is closed on quit
  by the shutdown sequence. Another local process that knows the port can read the
  model list; it cannot spend the user's quota without the token.
- A user who deletes the row gets it back on the next launch, because the machine
  still has the app. That is the cost of "discovered" over "configured"; opting
  out is uninstalling the app or disabling the entry.
- Deleting the app's state while the gateway is running is not a crash: discovery
  runs per request, so the next `/v1/models` reports the smaller catalog.

## Alternatives considered

### Give the plugin host a way to write provider models

Rejected: it would make the plugin process a second author of provider rows,
which ADR 0259 deliberately avoided, and the discovered state still belongs to
the machine rather than to an installed plugin.

### Run the gateway as a bundled Node sidecar

Rejected: the packaged app ships no general-purpose Node CLI, so a sidecar would
add a runtime to the installer and a process tree to supervise. In-process costs
one `http` server and keeps lifecycle in the shutdown sequence that already
exists.

### Point the provider row at the vendor endpoint directly

Rejected: the long-system-prompt refusal and the stream-only requirement are not
representable in a provider row, and implementing them inside the model client
would put one vendor's exceptions in every session's transport path.
