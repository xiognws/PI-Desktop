# ADR 0372: One data root per installation, linked from the home directory

- Status: Accepted
- Date: 2026-10-28
- Related: ADR custom-storage-location, ADR 0094, ADR 0011, spec `03-runtime/04-data-storage.md`

## Context

An installed build writes to four unrelated places by default: the host data
directory (`~/.pi-desktop`), the Electron profile (`%APPDATA%\PI-Desktop`), the
Playwright browsers (`%LOCALAPPDATA%\ms-playwright`), and the capability roots
(`~/.agents` for user skills and subagents). All four land on the system drive.

The data directory, the Electron profile and the browsers already move to a
folder on the first fixed drive that is not the system drive. Two problems
remain.

1. The capability root is a user-level directory that the host resolves through
   `global_agents_dir()`, so it moves only when `PI_DESKTOP_AGENTS_DIR` is set —
   and nothing set it.
2. Bundled plugins may resolve their own state with `os.homedir()` instead of a
   host API. `cn.star.skill-learning` writes `~/.agents/skills`, the user-profile
   extension writes `~/.pi/agent/user-profile`, and at least three more write
   `~/.pi-desktop/plugins/data/<id>`. No environment variable reaches them, and
   patching them is not durable: the marketplace and the bundled sync re-deliver
   the plugin files.

## Decision

1. A resolved data root owns five directories: `data/` (the host tree),
   `userdata/` (packaged Electron profile), `userdata-dev/` (development
   profile), `ms-playwright/`, plus `agents/` (global capabilities) and `pi/`
   (agent home state). One folder holds everything the installation produces.
2. The host capability root is repointed by setting `PI_DESKTOP_AGENTS_DIR` to
   `<root>/agents` before any writer resolves a path. An explicit
   `PI_DESKTOP_AGENTS_DIR` still wins, exactly like `PI_DESKTOP_DATA_DIR`.
3. Three home-level directories are replaced by directory links onto the root,
   in this order: `~/.agents` → `<root>/agents`, `~/.pi` → `<root>/pi`, and
   `~/.pi-desktop` → the resolved data directory. A link is the only mechanism
   that reaches a plugin resolving `os.homedir()` itself, and Windows grants a
   junction without elevation.
4. Migration is copy-then-remove, never a move: the data-root copy wins per
   file, so a plugin that kept writing to the old location after the relocation
   cannot overwrite the live copy with a stale one. Files the root lacks are
   carried over.
5. The link is created only when it is safe: a directory that is already a link
   (the user's own choice) is left untouched and reported when it points at a
   different root, a non-directory at that path is reported instead of deleted,
   and a failed copy leaves the original directory in place. A skipped link never
   blocks startup; it is logged and the app falls back to the home-directory
   layout for that directory only. A link whose target has gone — the data drive
   is not mounted this launch — is removed (the link only, never its target) so
   the directory returns to the home layout instead of failing every write.

## Consequences

- Everything this installation writes — database, transcripts, secrets, logs,
  plugin code and data, user skills, subagents, prompt fragments, the user
  profile, browsers, and renderer storage — lives under one folder, and that
  folder is not on the system drive.
- `~/.agents`, `~/.pi` and `~/.pi-desktop` become links. Anything else on the
  machine that used those paths follows them onto the data drive, which is the
  intended effect but is visible outside PI-Desktop.
- A plugin that writes to a home path outside these three still lands on the
  system drive; the list is explicit so this stays observable rather than
  accidental.
- When no non-system fixed drive exists, or linking fails, the previous
  home-directory layout remains and the app still starts. Location is never a
  startup precondition.
- `PI_DESKTOP_AGENTS_DIR` and `PI_DESKTOP_DATA_DIR` remain the isolation
  overrides for tests and side-by-side profiles; a pinned capability root does
  not create the `~/.agents` link.

## Alternatives

- **Patch every plugin to ask the host for its data path.** Durable in-tree, but
  bundled and marketplace plugins are re-delivered on sync, so the fix would be
  overwritten; and it requires a plugin-API change for state the SDK does not
  expose.
- **Set `HOME`/`USERPROFILE` for child processes.** Reaches every plugin at once
  but breaks unrelated tooling that shells out to git, npm, or ssh from the
  agent.
- **Move only the host-owned directories** (the previous state). Leaves user
  skills and four plugins writing to the system drive, which is the reported
  problem.
