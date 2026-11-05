# ADR 0381: The product is Pi-Workspace, and storage identifiers move with the data

- Status: Accepted
- Date: 2026-11-04
- Amends: [ADR 0278](0278-canonical-application-id.md) (canonical application ID)
- Related: [ADR 0094](0094-single-instance-per-data-directory.md),
  [ADR 0102](0102-publisher-owned-plugin-source-and-git-hosted-artifacts.md)

## Context

The product shipped as **PI-Desktop**, a name that named the upstream fork rather
than this distribution, and that collided with the repository it was forked from.
The display name was also load-bearing: `APP_NAME` fed the window title, the tray
tooltip, the crash reporter, *and* — through `data-root.ts` — the folder on the
data drive and the `userData` directory beside it.

That coupling is what makes a rename expensive. A user's `D:\PI-Desktop` holds
the SQLite database, the Electron profile (single-instance lock, renderer
`localStorage`, plugin partitions), plugin data and the Playwright browsers. Change
`APP_NAME` without an adoption path and the next launch looks in `D:\PiWorkspace`,
finds nothing, and behaves exactly like data loss — while the old tree sits beside
it, untouched and unreachable.

## Decision

### 1. The product is Pi-Workspace

| Surface | Value |
| --- | --- |
| Display name (`APP_NAME`) | `Pi-Workspace` |
| Application ID (`APP_ID`) | `net.aiuo.pi-workspace` (development: `.dev` suffix, unchanged in shape) |
| npm scope | `@pi-workspace/*` |
| Windows executable / shortcut | `Pi-Workspace` |
| Linux `desktopName` / `executableName` / package | `pi-workspace` |
| Release artifacts | `Pi-Workspace-${version}…` |
| Release source | `xiognws/Pi-Workspace` — an installation must never update itself from the upstream fork it renamed away from |

### 2. Storage identity is a separate constant

`DATA_IDENTIFIER = "PiWorkspace"` (`packages/shared/src/protocol.ts`) names the
data drive folder; `.piworkspace` / `.piworkspace-dev` name the home profiles.
None of them derives from `APP_NAME` any more, so the next rebranding moves
nothing. A display name is branding; these names address bytes on disk.

### 3. An existing installation is adopted, not abandoned

`adoptDirectory(target, sources, label)` (`data-paths.ts`) is the single migration
primitive:

- `rename` first — atomic and free on the same volume, and it carries every child
  of the data root at once, which is what a per-directory copy cannot promise;
- a recursive copy as the fallback, which leaves the source in place for a retry.

`data-root.ts` adopts the whole previous root (`D:\PI-Desktop` → `D:\PiWorkspace`)
before it creates the new one, and `installation.ts` adopts a previous home profile
on the machines that never had a data drive. Only a root this build named itself is
adopted — an explicit `PI_DESKTOP_DATA_ROOT` is the user's own directory and is left
alone.

### 4. Retired identifiers

`data-paths.ts` keeps each name an earlier release wrote, so it can still find that
user's data. These strings are **migration sources only**; nothing may create them
again, and a test pins their spelling:

```text
PI-Desktop            PI-Desktop Dev         (data root folder, userData folder)
.pi-desktop           .pi-desktop-dev        (home profiles)
.pi-desktop-dev-main                         (development profile of a main checkout)
```

### 5. Contracts that keep their old spelling

Renaming these would break installed plugins, saved automation or a user's own
scripts, and buys nothing a user can see. They stay as they are:

| Identifier | Why it is frozen |
| --- | --- |
| `window.piDesktop` | preload API namespace; plugins call it |
| `"piDesktop"` in a plugin manifest | minimum-host-version field, a published contract |
| `pi_desktop_invoke`, `min_pi_desktop` | MCP tool name and manifest field |
| plugin ids `pi.browser`, `pi.file-manager`, `pi.prompt-enhancement` | installed plugins are addressed by id |
| `PI_DESKTOP_*`, `PI_*` environment variables | child-process contract of host-core, the plugin host and the E2E harnesses |
| `pi-desktop/…` IPC channels | main ↔ preload ↔ renderer wire names |
| `MCP_SERVER_NAME = "pi-desktop"` | how an MCP client identifies this app |
| `.pi-desktopignore` | a file users create inside their own workspaces |
| `pi-desktop-host-core` | the packed Rust binary's name |
| `pi-desktop://` | deep-link scheme registered with the OS |
| `pi-desktop-overlays` | renderer DOM id referenced by CSS and component tests |

### 6. Documentation

Current documentation, including the ADR set, is written in the new name: the
history of this project is the history of *this* product, and leaving two names in
it costs a reader more than it preserves. The old name is recorded here, and the
identifier tables above are the record of what deliberately did not follow.

## Consequences

- A user upgrading from a `PI-Desktop` build keeps their database, their renderer
  layout, their plugins and their Playwright browsers: the data root is renamed in
  place on first launch.
- `appId` changes, so Windows treats this as a new application for the install
  directory, the uninstall entry and the taskbar identity. The profile itself is
  preserved by § 3.
- A dangling `~/.pi-desktop` symlink may remain on a machine that had one; the data
  it pointed at has moved, and the link is not recreated.
- `packages/i18n` carries the product name in nine locales and must move with it.

## Tests

- `apps/desktop/test/data-adoption.test.mjs` — adopt by rename, never overwrite an
  occupied target, adopt a home profile, fall back to a copy across volumes, and
  pin the retired spellings.
- `apps/desktop/test/development-profile.test.mjs` — the profile names and the
  order in which the identity is established before the single-instance lock.
- `apps/desktop/test/development-branding.test.mjs`,
  `apps/desktop/test/auto-update.test.mjs` — packaged names and the release source.
