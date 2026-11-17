# Billion Context

Context compression for the agent loop, shipped as a core plugin so every
install has it: the model decides what to compact instead of the runtime cutting
at a fixed point, a small context window stays usable, and a long session spends
a fraction of the tokens it would otherwise re-send on every request.

This plugin is a **packaging shell** around the upstream pi extension
(`billion-context@0.1.215`). Nothing in the compression code is modified: the
vendored files are the published package's own entry and bundle.

## What it contributes

| Field | Value |
| --- | --- |
| extension entry | `agent-extension.mjs` → `vendor/pi/billion-context.mjs` |
| permission | `agent.extension` |
| upstream pi entry | `./dist/agent/billion-context.js` (from its `package.json` `pi.extensions`) |

## Notes

- Vendored files use `.mjs`: the plugin host treats a plugin folder as CommonJS
  (`ensureCommonJsPackage`), and a `.js` file carrying ESM syntax fails to load
  there (`Failed to load the ES module`).

- It ships enabled (`enabledByDefault: true`): a machine that has never seen the
  plugin starts with it on. Disabling it in Settings is remembered across app
  updates, the same as any other preinstalled plugin.
- The upstream bundle is self-contained — its pi entry imports only Node
  builtins — so no `node_modules` is vendored. The upstream `mysql2` storage
  backend is therefore unavailable; sqlite (the default) is unaffected.
- Provenance, checksums and licence: `SOURCES.md`, `THIRD_PARTY_NOTICES.md`,
  `vendor/LICENSE`.
