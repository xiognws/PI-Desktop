# Bundled plugins

Some plugins ship inside the application image instead of the user data
directory. This document defines what that changes and what it does not.

The inventory of what ships today, with versions, authors, licences and verified
checksums, lives next to the packages themselves in
`apps/desktop/resources/plugins/BUNDLED.md`.

## 1. Why bundle at all

A plugin installed from the marketplace lives under
`<data dir>/plugins/installed/` — next to the SQLite database and the transcript
store, inside the directory a user may reset, relocate or lose with a new
machine. A bundled plugin lives inside the application installation, so:

- a fresh install already has it, with no network round trip;
- resetting the data directory does not remove it;
- it cannot be uninstalled, only disabled.

That makes bundling the right home for the toolset a distribution is *built
around*, and the wrong home for anything a user is expected to choose, replace
or remove.

## 2. Identity

The host reports a bundled plugin as:

| Field | Value |
|---|---|
| `source` | `"builtin"` |
| `bundled` | `true` |
| `status` | `"ready"` on a healthy load |

`bundled` is recomputed from disk on every launch and never persisted
(ADR 0241): a plugin this build stops shipping stops being protected
immediately, whatever the surviving registry row says. A bundled plugin can
still be updated from the marketplace; the update is written to the data
directory and shadows the bundled copy.

## 3. Where the host looks

Electron resolves the directory and passes it as
`PI_DESKTOP_BUILTIN_PLUGINS_DIR`, because only Electron knows whether the build
runs from `resources/` or a source checkout. host-core reconciles its registry
against that directory and nothing else — it never guesses a path.

| Build | Directory |
|---|---|
| packaged | `<install>/resources/plugins` |
| source checkout | `apps/desktop/resources/plugins` |

Packaging carries the tree through electron-builder's `extraResources`
(`resources/plugins` → `plugins`), so a plugin added to the checkout appears in
the installer without further configuration.

## 4. Do not overwrite the maintained plugins

`pi.browser` and `pi.file-manager` are maintained in this repository.
`pi.file-manager` is the `-pi` fork (`0.5.3-pi.1`), carrying `UPSTREAM.md`, its
`LICENSE` and local patches. The marketplace also publishes a `pi.file-manager`
built from upstream; installing it over the bundled copy silently drops all
three. Treat those two ids as local sources.

## 5. Adding or refreshing an entry

1. Take the package from the official catalog, not from a working data
   directory: an installed copy may be patched.
2. Verify the archive's sha256 against the catalog's `shasum` before unpacking.
3. Unpack into `resources/plugins/<id>/` so `manifest.json` sits at the root.
4. Record the version, author, licence and checksum in `BUNDLED.md`.
5. Confirm the row reports `source: "builtin"`, `bundled: true`,
   `status: "ready"` against an empty data directory.

A plugin with no declared licence is recorded as "not declared". Redistributing
it outside the organisation is a licensing question, not an engineering one.

## 6. Networks that cannot reach the artifact host

Some networks read the catalog but cannot reach the artifact host it names.
`PI_DESKTOP_PLUGIN_ARTIFACT_BASE` puts a prefix in front of every resolved
package URL, so the same checksummed package is fetched through a reachable
mirror without re-hosting the catalog:

```text
PI_DESKTOP_PLUGIN_ARTIFACT_BASE=https://gh-proxy.com/
→ https://gh-proxy.com/https://raw.githubusercontent.com/.../x.piplug
```

Rules:

- the prefix applies to relative **and** absolute package URLs, because a
  cached catalog rewrites package URLs to absolute form;
- `file://` packages are never prefixed — a local package stays local;
- blank or unset means the catalog's own answer, unchanged.

Bundled plugins never consult this setting: they are already on disk.
