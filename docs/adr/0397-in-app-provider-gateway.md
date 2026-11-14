# ADR 0397: Run the WorkBuddy gateway as an in-app provider

- Status: Accepted for implementation
- Date: 2026-11-13
- Related: [ADR 0259](0259-plugin-declared-providers.md) (plugin-declared
  provider rows), [ADR 0322](0322-plugin-providers-in-add-service.md) (plugin
  providers in Add Service), [ADR 0383](0383-bundled-plugin-curation.md) (the
  bundled plugin set), ADR 0105 (bundled plugins are ordinary plugins)

## Context

WorkBuddy reaches this product through the bundled plugin
`community.workbuddy-connect` (MIT, `0.4.1`). The plugin holds the whole
capability: a resident service, a dashboard panel, and a loopback gateway
(`bridge/core.cjs`, 117 KB) that reads the desktop client's sealed credentials,
lists the account's models, translates the vendor's transport quirks (a
stream-only upstream, a string-valued `tool_choice`, and a `developer` message
role the upstream refuses), and reads billing. Its routes are `/healthz`,
`/{product}/v1/models`, `/{product}/v1/chat/completions` and
`/{product}/status`, with `product` one of `workbuddy` / `workbuddy-ai`.

Three things were wrong with that arrangement, and none of them were bugs in the
plugin.

**The provider was assembled by hand.** The plugin starts a gateway, but the
user still had to add an AI service of their own and type its base URL. The
obvious value — `http://127.0.0.1:18765/v1` — is wrong: the vendor path segment
is part of the route (`/workbuddy/v1`). A wrong base URL answers 404 on
`/models`, and the product shows that as an empty model list. A capability
whose first step is a URL a user has to guess is not a supported capability.

**Two sources of truth owned one provider.** The plugin's own settings carried
the port and the credential paths; the provider row carried the base URL, the
key and the model choice. Neither could see the other, so changing the port
disabled the provider silently, and there was no place to say which of the two
was authoritative.

**A first-class provider cannot depend on a plugin's lifetime.** Plugin
supervision is designed for optional surfaces: a user may disable or uninstall
one at any time, and it may fail to load. A provider that every session can
select must exist before the first turn, own its port deterministically, and
report a reason when it is unavailable instead of disappearing from the model
list.

## Decision

### The gateway is part of the application

`apps/desktop/electron/main/providers/` holds the gateway and its supervisor:

| File | Responsibility |
| --- | --- |
| `types.ts` | `InAppProvider` descriptor: `id`, `label`, `defaultPort`, `healthPath`, `openaiBasePath`, `product`, optional `creditsPath` |
| `in-app-providers.ts` | supervisor: start in boot order, readiness probe, port resolution, stop, provider-row registration |
| `workbuddy/` | the gateway, copied from the plugin's MIT bridge |

A descriptor plus a module is the whole cost of the next provider; the
supervisor, the row lifecycle and the settings surface are written once. There
is no second mechanism for a second desktop app to reach the model list.

### The provider row is host-registered, idempotently

The row's `owner_plugin_id` is the reserved value `builtin:workbuddy`. The
`builtin:` prefix belongs to the application and is not a plugin namespace:
plugin-declared rows carry the plugin id and the row id
`plugin:<pluginId>:<declaredId>` (ADR 0259), so no manifest can claim it.

Registration runs on every boot before the first turn: create the row when it
is absent, update the fields the app owns when it is present. The user's key,
model choice and bindings are never rewritten, so an upgrade does not reset a
session's model.

While the gateway is running, `providers.delete` refuses the row and the UI
offers disable instead. Deleting it would leave a provider the app recreates on
the next launch, which is worse than a row the user cannot remove. A disabled
row is the supported "off" state, and `inAppProvider.workbuddy.enabled` records
the same choice so the gateway and the row cannot disagree.

### Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `inAppProvider.workbuddy.enabled` | `true` | start the gateway and keep the row |
| `inAppProvider.workbuddy.port` | `18765` | loopback port the gateway binds |

The port is local and configurable because a machine can already own 18765; the
base URL is derived from it, so a user never types an endpoint.

### The endpoints are the contract

- Base URL: `http://127.0.0.1:<port>/workbuddy/v1`.
- `/healthz` is the readiness probe. The supervisor reports the provider ready
  only after it answers; until then the row exists and reports why it is not
  usable.
- Models: `GET {base}/models`, the ordinary OpenAI-compatible discovery call.
- Credits: `GET /{product}/v1/credits`, present only for a provider whose
  descriptor carries `creditsPath`.

### Credit reads fail visibly

The gateway's credits route reads the same two billing endpoints the plugin's
core already read: the CN-enterprise cycle quota
(`/v2/billing/meter/get-enterprise-user-usage`) for an enterprise account in
the CN region, and the package list
(`/v2/billing/meter/get-user-resource`) for everyone else. A response whose
quota or usage field is not recognised is an error, not a `0`: a plausible
wrong number is how the reported empty `Accounts` list stayed invisible for a
whole release (the bridge's issue #31).

The surface hides rather than degrades: an indicator appears only for a metered
account that still has credit, and disappears — with no placeholder and no
reserved space — when the provider has no `creditsPath`, the account is
unlimited, or the remaining total is `0`. A failed read renders as an error
state, never as a number.

### The plugin is retired

`community.workbuddy-connect` is listed in
`scripts/bundled-plugins-excluded.json`, so the marketplace sync neither bundles
it nor keeps an expanded copy. Shipping both was the first design — the plugin
arrived switched off — but it does not survive contact with an install that had
enabled it before this ADR: the plugin's bridge boots first, binds the loopback
port this supervisor wants, and the provider row is then left pointing at a
gateway whose loopback key it does not hold (observed as `EADDRINUSE 18765` plus a
`401` on every model call). One account gets one gateway, and the gateway is the
app's. A user who still has the plugin installed keeps it until the next launch
reconciles the registry against the bundled set (ADR 0105 / ADR 0241).

The supervisor is not the only place a busy port can appear, so a start that
hits `EADDRINUSE` moves to the next free port and rewrites the row there rather
than failing.

## Alternatives rejected

**A pure-Rust upstream client.** The gateway's work is credential handling and
protocol translation, not request forwarding: reading the client's sealed
credentials, hooking its renderer for the access token, normalising a
stream-only upstream, the `developer`-role rewrite the channel check demands,
and two billing shapes. `bridge/core.cjs` is 117 KB of measured behaviour.
Rewriting it in Rust is three to five times the work of moving it, and it would
add a second failure surface — a Rust client that disagrees with the Node one
about the same upstream — in exchange for nothing the user can see.

**Keep it plugin-only.** Then the same provider has two owners: the plugin's
settings and the hand-made row. Every port change and every reinstall would be
a chance for them to disagree, and "why is the model list empty" stays a
question a user has to answer by reading a plugin manifest.

## Consequences

- The reserved `owner_plugin_id` value `builtin:workbuddy` exists today without
  a first-class owner column. Ownership is a string the host compares, and
  `builtin:` is refused to plugins by construction. A dedicated column is
  deferred until a second in-app provider needs to be told apart from a plugin
  in SQL; the plugin-declared path is unchanged.
- Every boot performs one idempotent upsert per in-app provider. The write is
  cheap and the alternative — trusting a row that may predate a schema change —
  is how a provider ends up pointing at a stale path.
- The port is a user setting, so the supervisor must survive "the port I want is
  busy": the gateway fails to bind, the row stays disabled, and the reason is
  visible in Settings rather than in a log.
- Adding provider N is one descriptor and one registry line. Nothing in the
  settings surface, the row lifecycle or the credit read is provider-specific
  except the descriptor's own path fields.
- The plugin's own `port` setting no longer decides anything for a user who
  runs the built-in gateway; it governs the plugin only when the plugin is
  switched on, which is the state the default-disabled flag leaves it in.
