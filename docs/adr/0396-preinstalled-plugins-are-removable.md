# ADR 0396: Preinstalled plugins are the user's to remove

- Status: Accepted
- Date: 2026-11-12
- Extends: [ADR 0241](0241-vendored-updatable-file-view-plugin.md) (vendored,
  updatable bundled plugin), [ADR 0383](0383-bundled-plugin-curation.md) (curated
  bundled set), [ADR 0104](0104-plugin-contributed-work-panel-views.md)
- Supersedes: ADR 0241 §4, second sentence — "A bundled plugin cannot be
  uninstalled"

## Context

ADR 0241 made the bundled plugin set *default and non-removable*: the row is
rebuilt from the shipped manifest on every launch, the user may disable or update
it, and `PluginManager::uninstall` refused it with
`PLUGIN_INVALID: a bundled plugin cannot be uninstalled`.

That rule was written for a set the application could not work without. In
practice the set is a **pre-installation convenience**: the install image carries
48 plugins so a first launch is not an empty product, and every one of them is an
ordinary plugin on the same public contribution channel a third party uses. None
of them is load-bearing; the host, the agent runtime and the file view the user
actually depends on do not need any specific entry in
`apps/desktop/resources/plugins`.

Two consequences followed from treating them as non-removable:

1. **The user could not get rid of something they did not ask for.** Disabling
   leaves the row, its contributions, its host process, and its place in the
   plugin list. A user who does not want the WeChat bridge, a session recorder,
   or a second usage panel had no way to say so once.
2. **"Bundled" leaked into product semantics it does not deserve.** A plugin that
   ships in the image is not thereby better, supported longer, or privileged. The
   first-party surfaces already go through the ordinary channel (ADR 0104); the
   only thing "bundled" legitimately describes is where the copy came from.

The reason the refusal existed is real, though: without a record, an app update
would seed a removed plugin straight back, and the user's decision would be
undone on every launch. The rule to keep is **"the image does not get to overrule
a removal"**, not "removal is forbidden".

## Decision

### 1. `bundled` describes origin, not permission

The registry row's `source` for a plugin this image ships becomes `preinstalled`
(rows written by earlier builds carry `builtin` and are rewritten on read).
`bundled: true` means *this copy came from the install image*. It no longer
implies anything about what the user may do: preinstalled plugins can be
disabled, updated from the marketplace, replaced by an installed copy, and
uninstalled like any other.

### 2. A removal is remembered, in its own file

`<data>/plugins/preinstalled-state.json`:

```json
{
  "schemaVersion": 1,
  "seededFrom": "0.21.0",
  "plugins": {
    "pi.notes": { "seededVersion": "1.0.0", "state": "removed" },
    "pi.view":  { "seededVersion": "1.0.0", "state": "modified" }
  }
}
```

Three states, one rule each:

| State | Meaning | What the next launch does |
| --- | --- | --- |
| `untouched` | the user never changed it | rebuild the row from the shipped manifest, so an app update refreshes version and contributions |
| `modified` | the user installed or updated this id | keep their copy; only a *strictly newer* shipped version replaces it (ADR 0241) |
| `removed` | the user uninstalled it | do not seed it back, not even from a newer image |

The file is separate from `registry.json` on purpose: the registry is a cache of
what is loaded, this is the user's decision, and a corrupted registry must not
take the decisions with it.

### 3. Restoring is a first-class action

`plugins.restorePreinstalled` clears the record and rebuilds the row, so what
comes back is the image's *current* version rather than the one that was removed.
The Plugins page lists removed preinstalled ids under the installed list, which is
what keeps "removed" from meaning "gone without a trace".

### 4. Directories are lists, and the user may add their own

`PI_DESKTOP_PREINSTALLED_DIRS` replaces `PI_DESKTOP_BUILTIN_PLUGINS_DIR` (still
read, for a shell older than this host). Every existing candidate is passed, so a
distribution can layer its own set in front of a vendored one; the first manifest
for an id wins.

`PI_DESKTOP_EXTRA_PLUGIN_DIRS` carries directories the *user* pointed at, listed
in `<data>/plugin-paths.json` (`{ "extraDirs": [...] }`, absolute paths only, at
most 20). Rows from there are `source: "external"`: read in place, never copied,
never deleted — removing one removes the row. An external copy wins over the
image's copy and over a marketplace install under the same id, because naming a
directory is a deliberate act.

Precedence, highest first: `external` → `installed`/`marketplace`/`dev` →
`preinstalled`.

### 5. What is never deleted

`uninstall` deletes only what lives under the data directory
(`plugins/installed/<id>`, `plugins/data/<id>`, `plugins/logs/<id>.log`). A
preinstalled plugin's directory belongs to the installation and an external one
belongs to the user; in both cases removal is a registry decision, not a
filesystem one.

## Consequences

- A user can reach an empty plugin list. That is the point; the Plugins page
  keeps the marketplace and the removed-preinstalled section in reach.
- A shipped security fix reaches every user who did not touch that plugin, and
  nobody else. A user who pinned their own version stays pinned until the image
  ships something strictly newer.
- `plugins/preinstalled-state.json` is machine-local. It is not part of config
  sync: two devices have different images and different plugin directories, and
  syncing "I removed this" across them would be wrong.
- The state file must be pruned the other way too: a decision about an id this
  build no longer ships is dropped, because there is no image left to reconcile.
- Disabling stays the right action for "less surface, same installation".
  Removing now exists for "I do not want this at all".
