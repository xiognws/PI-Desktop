# Autotest

A soft/hardware integration test rail that lives inside the conversation.

Six stages: requirement decomposition -> case generation -> **human review gate**
-> script authoring -> execution -> failure analysis -> report. It ships enabled
by default, runs no background service, and exposes three surfaces: eight agent
tools, three renderer slots (eight tool cards, one reply-tail strip, one
fenced-block renderer) and **one work-panel view**, the workbench, for browsing
and reviewing plans without replaying a conversation.

## Why this shape

The earlier generation of this plugin was a standalone panel with one tab per
database table and a review step where you approved a case set you could not
see. Three things are different here:

1. **The gate is a card, not a button.** `autotest_cases` returns
   `awaiting_review` and the review card in the conversation renders every case
   as an editable row. Approval is recorded with an actor, a note and a
   per-case revision snapshot. Two rules follow from that snapshot:
   - an approval only covers the rows it actually saw - a case missing from the
     approved card is deselected, not silently kept;
   - editing a case and approving it in the **same** call is refused: the edited
     row carries content no reviewer has seen yet, so the approval is dropped and
     the gate stays shut until that revision is approved on its own.
2. **Failure analysis is its own stage.** `autotest_diagnose` classifies every
   failure as environment / script / assertion / product / flaky / unknown.
   Environment and product failures block repair outright, so a missing device
   can no longer masquerade as a broken script.
3. **Nothing is written before approval.** `autotest_author` and `autotest_run`
   both consult the gate, so a stale approval cannot leak a script.

## Stages

| stage | tool | gate |
| --- | --- | --- |
| requirements | `autotest_requirement` | - |
| cases | `autotest_cases` | opens the review gate |
| scripts | `autotest_author` | requires approval |
| run | `autotest_run` | requires approval |
| verdict | `autotest_diagnose` | requires a run |
| report | `autotest_report` | - |

## Layout

```
manifest.json        id, permissions, eight agent tools, renderer slots
main.js              tool implementations, onLoad/onUnload/onRendererCall
lib/schema.js        stage ids, statuses, failure classes, id helpers
lib/store.js         plan folders, atomic state.json, artifacts
lib/llm.js           JSON-mode model calls, prompt assembly, mock mode
lib/runner.js        shell-free script execution with timeout and output cap
lib/diagnose.js      deterministic failure classification
lib/stages.js        stage order, block reasons, review gate, coverage
lib/report.js        summary projection and markdown report
lib/plan.js          the eight orchestration entry points
renderer/            review gate, tool cards, stage rail, report block
views/               the workbench: a sandboxed page served by the host
skills/autotest.md   how an agent is told to drive the rail
tests/               node --test units for every module above
```

## Data

`pi.plugin.getDataPath()` -> `autotest/plans/<plan-id>/` with
`state.json`, `artifacts/`, `scripts/`, `runs/` and `report.md`.
State writes go through a temp file and a rename, so a crash mid-write leaves
the previous state readable.

## Model access

Pure API. `pi.agent.complete` is the only model path; there is no local model
and no embedding service. Set `AUTOTEST_MOCK_MODE=1` (or `mockMode: true` in
plugin settings) to run the whole rail deterministically without spending a
token - useful for demoing the gate and for separating orchestration bugs from
model quality problems.

## Execution safety

- `spawn` with an argument array, `shell: false`, `windowsHide: true`.
- 120 s default per script, 64 KiB captured output per stream (the tail is kept
  and the result is flagged `truncated`).
- A script with no configured runner command is reported `skipped` with a
  reason. Skipped never counts as passed.

## Where the UI shows up

Three renderer slots, and one of them exists because of how the transcript folds:

| slot | anchor | what it shows |
| --- | --- | --- |
| `toolCard` | one per agent tool | the result of that one call: features, the editable case set, scripts, run, diagnosis, report |
| `entryExtra` | tail of the assistant reply | the six-stage rail, plus **the same review gate** while the plan still needs a decision |
| `blockRenderer` | a fenced block tagged `pi.autotest:report` | a scrollable report preview |

The last two matter because tool cards live inside the activity group, and the
transcript folds settled groups by default
(`apps/desktop/src/lib/transcript-display-mode.ts` falls back to `fully-folded`).
A gate that only existed as a tool card would sit behind a collapsed
"processed in N s" header, which is the worst possible place for the one control
that unlocks script authoring. The reply tail is always visible, so the gate is
offered there too, driven by the same `status` projection — the strip never
re-implements the approval rules, it renders `gate.ok === false` and calls
`approve`.

Two host contracts the renderer depends on, both easy to break silently:

- `plugin.call` arguments go under `payload.args`, not `payload.payload`
  (`renderer-host/dispatch.ts`). Sending the wrong key still resolves — with
  `undefined` arguments — so `tests/renderer.test.js` asserts the key directly.
- `toolCard` registers the **bare** tool name; the host derives the lookup key
  with `pluginToolName(pluginId, toolName)`. Registering the qualified name is
  refused as `PLUGIN_SLOT_NOT_OWNED`.

## The workbench view

`views/workbench.html` is a real panel page the host loads with
`win.loadURL(pathToFileURL(...))` in a sandboxed renderer with its own
persisted partition, so it has no `require`, no `pi` object and no direct file
access. Everything it shows arrives over one bridge:

- page side: `window.pluginBridge.invoke(channel, payload)`
- plugin side: `onPanelInvoke(channel, payload)`, exported from `main.js`
- channels: `autotest.snapshot`, `.appearance`, `.status`, `.approve`,
  `.select`, `.reveal`, `.report`, `.trace`

The split between the two surfaces is deliberate. The panel may read anything and
may approve or select cases — the same three powers the renderer bridge has — but
it cannot author scripts, start a run, diagnose or reach the model. Those stay on
the agent side, where the approval gate and the 110 s host budget are enforced.
`tests/panel.test.js` asserts that absence by name.

Facts a view has to respect, each one learned the hard way:

- `contributes.views[].icon` accepts only the tokens in `PLUGIN_VIEW_ICONS`
  (`branch` is documented but absent; unknown tokens degrade to a letter tile).
- The page is not docked the same way twice: read
  `--pi-plugin-titlebar-height` (0 px docked, 46 px standalone) instead of
  assuming 0. The view also gets no `appearance:changed` push, so it polls
  `pi.app.getAppearance()` — here through the `autotest.appearance` channel.
- `pi-plugin check` does **not** verify that `views[].entry` exists. The host
  does, at startup, with `existsSync`; a missing file shows up as an empty panel
  and nothing in the plugin log.
- A view has no build step, so a page-side type error is a runtime death, not a
  compile error. Two of them shipped and were only caught by clicking through
  every tab in a live host: `el()` refuses a non-Node child, so `group()` must
  flatten an array body before appending it; and `panelSnapshot()` already
  answers the `reviewPlan()` projection, so reaching for a nested `.plan`
  silently emptied every tab. `tests/panel.test.js` guards both by reading
  `views/workbench.js`.
- The panel is a `WebContentsView`, not an iframe, so nothing about it is
  reachable from the shell's DOM. It is also not openable over IPC — the only
  routes are the `autotest.open` command (`pi.ui.revealView`) and the work-panel
  tool list, and both refuse without an active session.

- A plan root resolved from a promise is not a plan root. Every reader in
  `lib/store.js` compares strings, and Windows answers the same directory as
  `C:\Users\ADMINI~1\...` to one caller and `C:\Users\Administrator\...`
  to another — a plan the panel had just listed answered `PLAN_NOT_FOUND` for
  its own click. `main.js` now realpaths the root once and honours
  `PI_AUTOTEST_PLAN_ROOT` for callers that cannot await.

## Tests

```
node --test "tests/*.test.js"
```

Pass the glob as a quoted string; `node --test tests` treats the directory as a
single test file and fails.

`scripts/smoke.cjs` walks all six stages through the same `toolContext` the host
builds, in mock mode and in a temp data dir, and is wrapped by
`tests/smoke.test.js` so the suite covers it. Run it by hand while wiring the
host:

```
node scripts/smoke.cjs                          # mock model, temp data dir
AUTOTEST_DATA=F:\scratch node scripts/smoke.cjs  # keep the plans
```

It deliberately does not import `lib/*` directly: an unawaited `getSettings()`,
an unawaited `getDataPath()` and an `extra` that overwrote `pi` all lived in that
seam, and a smoke that skips it proves nothing.

## Enabling

Enabled by default (`enabledByDefault: true`), because a bundled plugin the user
cannot see is a dead plugin. The command palette carries
`Autotest: open the workbench`, which calls `pi.ui.revealView({ viewId:
'workbench' })` (permission `ui.view`). The workbench also always appears in the
work panel's own tool list, so the command is a shortcut rather than the only
door.
