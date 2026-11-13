# Vendored Session Orchestrator: push-first work deliveries

This directory is the actual plugin PI-Desktop loads and packages. It is
tracked in git so the app can carry one local behavior patch without waiting
for an upstream release (ADR 0398).

## Source and distribution provenance

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/vastsa/pi-plugin-session-orchestrator |
| Released reference tag | `v0.7.1` |
| Released reference commit | `cb9037a90218721345e3a7cd9704d8621acf0289` |
| Bundled version | `0.8.0-pi.1` — Desktop patch, not an upstream release |
| License | MIT; the bundled `LICENSE` is the upstream file |
| Marketplace publication | Not published; no upstream release is claimed for this patch |
| Previous bundled version | `0.7.1`, replaced in place (same plugin id) |

## What differs from the release

Exactly one behavior patch, in `actions.js`:

1. `spawn` sends `notifyOnCompletion: true` unless the caller passes a value.
2. `send` does the same for work deliveries, but keeps `false` when
   `kind: "message"` — plain peer messages are not work and must not each turn
   into a queued completion turn in the sender's session.
3. An explicit `notifyOnCompletion` from the caller always wins.

Effect: a supervising session receives the worker's completion and continues on
its own instead of polling `result`. Upstream `0.7.0` chose pull-first to avoid
a callback racing a result read; that race only exists when a caller polls, and
the pull path remains available, so the patch keeps the pull behavior reachable
instead of removing it.

Everything else is the release's own artifact, byte for byte, except the
manifest `version`, `changelog`, and the descriptions that stated the old
default.

## Checksums of the vendored files

Recorded after the patch; `sha256` over the file as committed.

| File | SHA-256 |
| --- | --- |
| `actions.js` | `109ff7a2ee4065d3c0b4847906ce1b759e62e838b9d855b7585243e6ae536cca` |
| `main.js` | `91633aeb420a783baf4c746f7965809c034a2e442bbcf7efbc4480822da8557a` |
| `models.js` | `4e3592ba342b9fc23f4ca1d3c51aeadfdaead177d4c8d260c981c322f6fe9dd6` |
| `runtime.js` | `fa8b957c30308a36177864fbeb9bb239a357e09da7aa60517bf720c0c0d93c4d` |
| `state.js` | `4dc8627b01a6b3256fca500f1276a678b8c91cd3a5cd5df6823dc4d6b8fc6c94` |
| `manifest.json` | `8e5e35737316a8c8b5a5046f169eed5cb00935a6db543990346075955f6938c1` |

The upstream `0.7.1` checksums of the unpatched files were:
`actions.js` `3bdeecd40f90cbb1ea4715851ddc1a540139be956080e7ca33bbc34449507d5c`,
`manifest.json` `8e5e35737316a8c8b5a5046f169eed5cb00935a6db543990346075955f6938c1`;
`main.js`, `models.js`, `runtime.js`, `state.js`, and `LICENSE` are identical
to the release.

## Why it is tracked rather than synced

`scripts/sync-bundled-plugins.mjs` skips every plugin id that `git ls-files`
reports under `apps/desktop/resources/plugins`, so tracking this directory is
the whole integration: the marketplace copy never overwrites the patch, and
`--force` remains the deliberate takeover path.

A future upstream release that adopts push-first deliveries should replace this
directory byte for byte and delete this file, leaving only the version suffix
change in the manifest.
