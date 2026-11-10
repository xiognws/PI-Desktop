# 19-widget-packages.md

Widget packages are runnable code the user drops in, not code the build ships.
A tool package (`07-plugins/01`…): metadata plus assets, listed and switched on
the Tools page, no runtime. A plugin (`07-plugins/01`): installed, versioned,
permission-gated by the plugin registry. An widget package sits in between: a
folder the user copies into their data directory, scanned at launch, loaded in the
agent sidecar, invoked over RPC. It gets *more* reach than a plugin — a plugin
extension is a hook inside the agent, an widget is a program the agent calls and
that can call back into the host.

## 1. Where packages live

`<userData>/widgets/<folder>/` — one folder per package, one manifest per
folder. Nothing is bundled: an empty directory is an empty Tools entry. The host
scans one level deep at launch and on every `widgets.list`; a folder without
a readable manifest keeps its row and says why (same rule as tool packages,
`host-core/src/tool_packages.rs`).

Paths are resolved by host-core (`widgets_packages_dir`), never by the
renderer. The renderer only ever sees summaries over IPC.

## 2. Manifest

`widget.json`, schema version 1:

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.tide-probe",
  "name": "Tide probe",
  "version": "0.1.0",
  "description": "Reads a clock and remembers a note.",
  "author": "optional",
  "permissions": ["read", "host"],
  "actions": [
    { "name": "now", "description": "Returns the current time.", "params": {} }
  ]
}
```

- `id` is the primary key; a second folder with the same id keeps its row marked
  `duplicate id <id>`.
- `apiVersion` gates the runner's API surface. A version the build does not know
  is a load error, not a silent downgrade.
- `permissions` is a request, not a grant. Unknown names are dropped.
- `actions` is the only callable surface. An action not listed here cannot be
  invoked even if the module registered it.

Limits: 64 packages, 512 files and 8 MB per package.

## 3. Entry module

`index.js` / `index.mjs` / `index.cjs`, resolved in that order. The module
**default-exports a function** — the activate hook. It receives the widget
API and registers actions:

```js
export default async function activate(api) {
  api.log("tide-probe activated");
  api.action("now", async () => ({ now: new Date().toISOString() }));
  api.action("remember", async ({ args, call }) => {
    const listed = await call("memory.list", {});
    return { requested: typeof args?.note === "string" };
  });
}
```

A module that registers no actions loads and reports zero actions; a module whose
activate hook throws is reported as an error row and never half-registers.

## 4. Where it runs

In the **agent sidecar** (`packages/agent-runtime`), in the sidecar's own process
— not in Electron main, not in the renderer. Consequences worth stating:

- A crashing package takes a sidecar down, not the window; the existing
  `settleCrashedSession` path already handles that.
- The registry is **process-level, not session-level**: two windows would
  otherwise load the same module twice and double its side effects.
- The sidecar is torn down on app quit; packages get no unload hook in v1.

## 5. Two directions

**Client → package.** Renderer → IPC `pi-desktop/widgets/invoke` → sidecar
`widget.invoke` `{ widgetId, action, args }` → runner → action handler.
The result is `{ value, durationMs, logs }`, bounded by
`WIDGET_INVOKE_TIMEOUT_MS` (30 s). An unknown widget or action is an
error, not an empty result.

**Package → host.** Inside an action, `call(method, params)` reaches back through
the sidecar's `ParentHostProxy` into main's normal RPC path. This is the same
channel the agent itself uses, so host-core's validation applies unchanged.
Only the methods in `CAPABILITY_HOST_METHODS` (`memory.recall`, `memory.list`,
`memory.stats`, `workspace.get`, `app.health`) are reachable in v1, and only
with the `host` permission granted; everything else is refused before leaving the
sidecar.

**The agent → package.** The `Capability` agent tool (`action: list | invoke`,
plus `widgetId` / `actionName` / `args`) lets the model enumerate installed
packages and call their actions in a turn. It is registered only in agent mode,
like the extension tool set it sits next to (`runtime.ts` `activeTools()`).

## 6. Permissions

Five levels: `read`, `write`, `net`, `agent`, `host`. The manifest requests;
host-core decides what is granted:

| Level | Grants |
| --- | --- |
| `read` | reads files inside the package folder |
| `write` | writes inside the package folder and its data directory |
| `net` | outbound network |
| `agent` | `call` into agent-scoped host methods |
| `host` | `call` into `CAPABILITY_HOST_METHODS` |

An untrusted package is sandboxed to `read` + `write`. An action that calls a
host method without `host` fails with
`widget <id> has no host permission` and the host side sees no call at all —
that is asserted in `packages/agent-runtime/src/widgets/index.test.ts`.

## 7. Trust, and why the digest exists

Nothing signs a widget package and nothing verifies a signature in v1. The
substitute is a **digest freeze**:

- host-core computes SHA-256 over the package's relative paths, lengths and bytes
  (dot-directories skipped).
- First sight: the row is `untrusted`, and the enabled toggle is refused until
  the user accepts that digest from the widget page.
- Accepted: `trusted`, and the accepted digest is persisted in
  `<data>/widgets/state.json`.
- Files changed afterwards: `modified` — the grant is withdrawn, permissions fall
  back to the sandbox, and the row turns warning-coloured.
- Re-accepting sends the digest the user is looking at; if the files changed again
  in the meantime host-core answers `changed on disk since it was reviewed`
  instead of trusting whatever is there now.

That last check is the point: acceptance pins *specific bytes*, not a path. It
stops a silent swap between review and click, and it makes "I copied a new version
in" a visible event rather than an invisible privilege escalation.

## 8. State

`<data>/widgets/state.json`: `{ "disabled": [id…], "trusted": { "<id>": "<digest>" } }`,
written temp-file-then-rename. Corrupt state is replaced by defaults rather than
blocking the list.

## 9. Surface

| Layer | Items |
| --- | --- |
| host-core | `widgets.list`, `setEnabled`, `setTrusted`, `dir` |
| IPC | `pi-desktop/widgets/{list,runtime,setEnabled,setTrust,reveal,invoke}` |
| Renderer | `pages/CapabilitiesPage.tsx`, entry button on `pages/ToolsPage.tsx` |
| Sidecar | `widget.{sync,list,invoke,logs,clear}` |

The Tools page keeps the entry button (package count, opens the page). The
widget page owns enable, trust, reveal and action listing; it never touches
the filesystem directly.

## 10. Distribution

Zip the package folder and hand it over; the receiving side drops the folder into
its own `widgets` directory. No marketplace, no version negotiation, no
update channel in v1 — see `14-plugin-roadmap.md` for the plugin counterpart and
ADR 0384 for why this stays out of the plugin registry.
