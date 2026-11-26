# ADR 0410: The window has surfaces, and the chat sidebar is not the window

- **Status:** Accepted
- **Date:** 2026-11-26
- **Related:** 0402 (Rust agent kernel), 0407 (bundled plugins stay plugins), spec
  [04-ux/01-ui-ia](../../spec/04-ux/01-ui-ia.md)

## Context

The shell was built around one interface. `AppState.page` is a single union —
`chat | scheduled | plugins | artifacts | tools | settings` — and the main pane
renders exactly one of them. Every destination is a row in the chat sidebar's
footer or nav strip, every destination is a branch in `AppShell`, and Settings is
the one exception that replaces the whole window.

That works while there is exactly one product inside the window: a conversation
workbench whose smaller pages are places the conversation sends you.

The AutoTest platform is not one of those places. It is a second working
environment with its own navigation (tests, plans, runs), its own data (a local
FastAPI service with one SQLite per project), and its own layout. It already ships
in this repository as a Vue application served over loopback, opened today in a
detached `BrowserWindow` from the application menu. Folding it into `page` would
have meant a fourth kind of value in that union, a second sidebar's worth of
hidden state behind one more `page === "autotest"` branch, and an ever-growing
switch chain for every interface that follows.

Measured before the change: 43 sites test `page` (`interaction-slice` navigation
history, `AppShell` render branches, `useAppShellRuntime` derivations, two sidebar
nav rows, four footer actions, `SearchDialog`'s entry list).

## Decision

The window has **surfaces**: whole interfaces, each owning a sidebar and a main
pane. `packages/shared/src/surfaces.ts` declares the ids and the resolution rule;
`apps/desktop/src/features/surfaces/registry.tsx` declares, per id, its label, its
rail icon, its lazily loaded shell and whether it must stay mounted.

- **Two levels, not one.** `surface` names the interface; `page` remains a
  *destination inside the chat surface*. Leaving chat keeps `page` and returning
  restores it, so a trip to AutoTest does not cost the user their Artifacts view.
  Settings is the exception: it takes over the window, so a surface switch leaves
  it (the same result as Back).
- **A rail, not another footer icon.** A 48px column at the window's left edge
  carries one glyph per surface. It sits outside every surface because switching
  an interface replaces that surface's sidebar; a switcher inside would disappear
  with it. The column's width is reserved in the chat shell's three-column budget
  (`rail-metrics.ts`), so sidebar, main pane and work panel keep their floors.
- **The home surface never unmounts.** Chat is hidden with `hidden` + `inert` —
  the treatment Settings already uses — so a running turn, the work-panel tab set,
  the transcript reading position and the composer draft survive a switch. Other
  surfaces are mounted only while active.
- **A surface's content is the surface's business.** Chat is React inside this
  renderer. AutoTest is a page served by the local service, composited through one
  `WebContentsView` the main process owns; the renderer measures the pane and
  remains the visibility authority, exactly as it does for plugin work-panel
  views, because a native view paints above renderer content.
- **Window-level chrome stays window-level.** Search, toasts, the update banner,
  the backend banners, the dialogs, the splash, the Settings takeover and the
  native window controls live in `AppShell`; a dialog rendered inside a hidden
  surface would not be reachable.
- **Adding an interface is data.** Append to `SURFACE_IDS`, append a descriptor,
  add one keybinding. The rail, the host, the persisted preference and the
  shortcut dispatcher read those lists; no new branch is added to the window.

Persisted surface: `pi.desktop.surface` in localStorage, resolved through
`resolveSurfaceId`, so an id a later build no longer ships opens chat instead of an
empty shell (the rule `resolveSettingsTab` already applies).

## Consequences

- `AppShell` is now the window, not the chat shell: the sidebar, main pane, work
  panel and chat destinations moved to
  `features/surfaces/chat/ChatSurfaceShell.tsx` unchanged.
- The chat shell's width budgets were reduced by the rail's column. No other
  geometry changed; the work panel, sidebar resize and preview mode behave as
  before.
- AutoTest is reachable two ways and they do not fight: the rail composites it in
  the window, the application menu still opens the detached window. Both go through
  one opener for readiness, error prompting and focus.
- Its service still starts lazily. Reaching the surface is the first use; an idle
  launch spawns no interpreter and opens no listener.
- A second native view over renderer content means global search detaches it while
  open. That is a rule the surface implements, and `surface-registry.test.mjs`
  pins it.
- Surfaces are not plugin surfaces. A third-party product still arrives as a
  plugin (ADR 0407); a surface is a first-party interface this build ships.
