# Sources

Vendored from the published npm package; no local patches.

| File | Upstream path | Notes |
| --- | --- | --- |
| `vendor/pi/billion-context.mjs` | `billion-context@0.1.215` → `dist/agent/billion-context.js` | re-export shim; only its own extension and that one import specifier were changed, so a CommonJS plugin folder can load it |
| `vendor/pi/pi-native.mjs` | `billion-context@0.1.215` → `dist/agent/pi-native.js` | the pi extension bundle, byte-identical apart from the file extension |

- Package: `billion-context@0.1.215` (npm)
- Tarball: `https://registry.npmjs.org/billion-context/-/billion-context-0.1.215.tgz`
- Repository: <https://github.com/ranxianglei/billion-context>
- Licence: see `vendor/LICENSE`

Only the two files the pi entry needs are vendored: the published `dist/` also
carries the dsh, opencode, omp, claude and codex adapters (45 MB total), which
this plugin never loads.
