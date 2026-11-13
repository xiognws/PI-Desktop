# Example widget package (D699)

A widget package is a folder with a `widget.json` manifest and one entry
module. Pi-Workspace loads it from `<userData>/widgets/<folder>/` — not
from the application image — so a package is added, replaced, or removed without
rebuilding the client.

```text
<userData>/widgets/tide-probe/
  widget.json
  index.mjs        # or index.js / index.cjs, once it default-exports a function
```

To try the sample, copy this directory into the user data folder and reload the
Widgets page (Tools → widget entry). A package is **untrusted** when it
first appears: it does not load until the digest the client computed is accepted
on the page. Any later edit to a file changes the digest, revokes trust, and
marks the package `modified`, so accepted code is the code that runs.

## widget.json

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.tide-probe",
  "name": "Tide probe",
  "version": "0.1.0",
  "description": "Reports the local time and remembers one note, to show a package talking back to the host.",
  "author": "Pi-Workspace",
  "permissions": ["read", "memory"],
  "actions": [
    {
      "name": "now",
      "description": "Return the current local time as ISO-8601.",
      "params": {}
    },
    {
      "name": "remember",
      "description": "Store one note through the host memory RPC and return the list size.",
      "params": {
        "note": { "type": "string", "description": "Text to remember." }
      }
    }
  ]
}
```

- `schemaVersion` — manifest shape. Version 1 is the only shape the client reads.
- `apiVersion` — extension API the entry module was written against.
- `permissions` — requested widgets. The client grants a subset; anything
  in `read` / `write` is granted by default, and `net`, `agent`, `host` are
  only granted when the user allows them.
- `actions` — the names the client (and the `Widget` agent tool) may
  invoke. An action that is not declared here cannot be reached, even if the
  module registers it.

## index.mjs

The entry module **default-exports a function** — the activate hook. It receives
an `api` object and registers actions on it. A module that only sets
`module.exports = {...}` will not load: the loader reads the default export.

```js
export default async function activate(api) {
  api.log("tide-probe activated");

  api.action("now", async () => ({ now: new Date().toISOString() }));

  api.action("remember", async ({ args, call }) => {
    // Host calls travel main's normal RPC path and are gated by "host".
    const listed = await call("memory.list", {});
    const entries = Array.isArray(listed?.entries) ? listed.entries : [];
    return { requested: typeof args?.note === "string", entries: entries.length };
  });
}
```

- `api.log(message)` — bounded diagnostics, visible under the package in the
  client.
- `api.action(name, handler)` — registers one invocable action. The handler
  receives `{ args, dir, call, log }` and returns any JSON value, or throws to
  fail the invocation.
- `call(method, params)` — one host RPC on the user's behalf (also available as
  `api.call`). Only reachable with the `host` permission; without it the call
  rejects instead of running.

## Packaging

A package is a folder, so distribution is a zip of that folder. There is no
installer and no registry: the recipient drops it into
`<userData>/widgets/` and accepts the digest on the Widgets page.
