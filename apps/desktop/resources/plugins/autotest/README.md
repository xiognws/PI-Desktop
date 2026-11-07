# Autotest

A soft/hardware integration test rail that lives inside the conversation.

Six stages: requirement decomposition -> case generation -> **human review gate**
-> script authoring -> execution -> failure analysis -> report. It ships enabled
by default, contributes no panel and no background service, and registers eight
agent tools plus three renderer slots (eight tool cards, one reply-tail strip,
one fenced-block renderer).

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
cannot see is a dead plugin. The command palette still carries
`Autotest: show the active plan`.
