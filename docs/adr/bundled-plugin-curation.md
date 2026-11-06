# ADR 0382: Curate the Bundled Plugin Set

- Status: Accepted
- Date: 2026-11-06
- Extends: ADR 0241 (the bundled set is whatever sits in `resources/plugins`),
  ADR 0378 (the sync script populates it), ADR 0412 (theme plugins cost a host process)

## Context

A build ships exactly the plugin directories present in
`apps/desktop/resources/plugins` at packaging time; the host reconciles that
directory against its registry on launch, so "what is in the directory" is the
whole product decision. `scripts/sync-bundled-plugins.mjs` fills the directory
from the marketplace catalog, and `scripts/bundled-plugins-excluded.json` is the
only record that survives the next sync.

Two properties of this arrangement turned into a delivery problem.

First, that directory doubles as the development plugin store: a developer who
installs a plugin for their own use leaves it there, `extraResources` copies the
directory without consulting `.gitignore`, and the next release therefore carries
whatever that machine happened to accumulate — 65 plugins in the current
checkout, 90 MiB enabled by default because the host marks every bundled plugin
as builtin and enabled.

Second, two of those plugins bundle prebuilt helper binaries
(`fancy-pty-helper.exe`, `pi-conpty-helper.exe`) that the application launches
from its own resource directory. Endpoint protection on the deployment hosts
runs behaviour analysis, and the recorded detection is exactly this shape: an
unsigned application spawning child processes it shipped itself. The measured
trigger for the verdict is the app's normal command execution, so removing
helpers does not make the verdict impossible — but shipping unsigned executables
that we did not build adds a contributor we can remove at no functional cost.

## Decision

Retire plugins through `scripts/bundled-plugins-excluded.json`, not through a new
build-time allowlist. The exclusion file is the existing single source of truth
for "this build must never bundle that plugin", and the sync script already
deletes a leftover copy of an excluded id from the store.

The added entries fall into five groups:

- Native-helper terminals (`cc.fee.pi-terminal`,
  `io.github.hufangyuan460-blip.windows-terminal`). `local.terminal` provides the
  same feature in pure JavaScript, so the feature is not lost.
- Theme plugins and theme authoring (`adoin.sax-design-theme`,
  `io.github.muzimu217.theme-forge`, `local.miku-theme`, `pi.theme.studio`),
  extending the ADR 0412 retirement: a declarative theme costs a host process
  per launch and built-in colour schemes cover appearance.
- Development fixtures (`local.pi-session-filter`, `local.project-memory-api-probe`),
  which are harness manifests and probes rather than user-facing features.
- Duplicate views (`cc.mcii.session-usage`, `io.github.techd81.pi-desktop-usage`,
  `io.github.muzimu217.usage-dashboard`, `io.github.ldzhouquan.fast-browser`):
  one tracked usage plugin and one tracked browser plugin already cover them.
- Plugins whose function does not exist in this deployment: the catalog
  translator, because the catalog feed is unreachable. The prompt injector stays
  bundled: it is used in this deployment.

Everything else that is present today still ships.

## Alternative rejected

A build-time allowlist manifest plus a staging copy of `resources/plugins`
enforced in `build-desktop-release.mjs`. It works, but it duplicates the
exclusion file: two places decide what is bundled, and they drift. A developer
who adds a plugin to the allowlist would still get the sync script expanding
everything else on the next run.

## Consequences

- The packaged set is 46 plugins and 51 MiB, with no native binaries anywhere in
  the plugin tree.
- Running the sync script removes the 19 retired directories from an existing
  store, so a developer checkout converges to the packaged set instead of
  drifting from it.
- Retiring a plugin is a one-line change plus a rationale comment; adding one
  back requires deleting the entry, which is the deliberate act we want.
- The endpoint-protection verdict is not guaranteed to disappear: the dominant
  behaviour remains "unsigned application executes commands", which is what the
  product does. The remaining mitigation is a trusted-application or code-signing
  configuration on the endpoint side.
