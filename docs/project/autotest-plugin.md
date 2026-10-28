# Autotest platform as a Desktop plugin

Status: implementation plan, P0 in progress
Owner: plugin `autotest` (separate package), no Desktop core change expected

## 1. Scope

Deliver the electrical/vehicle test platform (ECU diagnosis, cockpit HMI, API) as a
Desktop **plugin**, so the released Desktop binary is the self-contained shell:

- platform UI (Vue 3 build, 17 views) as an isolated plugin panel plus docked
  work-panel views;
- platform backend (FastAPI, one SQLite per project) supervised as a resident
  plugin service;
- agent capability through plugin agent tools (no MCP stdio dependency for long
  runs);
- UI execution (Web / mobile / cockpit HMI) through an engine that follows the
  `e2e` engine contract;
- ECU / HIL / protocol execution through a Python driver that emits the same run
  event contract.

Non-goals for this plan:

- changing the frozen process model, IPC contracts, or Host-owned SQLite;
- shipping the platform runtime inside the plugin package;
- real CAN hardware (M6 prerequisite) or iOS simulators;
- replacing the existing Desktop E2E suite (`scripts/e2e-*.mjs`).

## 2. Constraints (measured, not assumed)

| # | Constraint | Evidence |
|---|---|---|
| C1 | Renderer must not reach SQLite; Host owns persistence | `AGENTS.md` §4 |
| C2 | Plugin package: ≤ 2,000 files, ≤ 50 MiB, `node_modules` never packaged | `docs/spec/07-plugins/06-plugin-packaging.md` §2–3 |
| C3 | Panel is an isolated page inside the plugin directory; no Node in the panel | `docs/spec/07-plugins/01-plugin-system.md`, `plugin-sdk` `PluginManifest.ui.panel` |
| C4 | Plugin egress is an allowlist; loopback must be declared | `docs/spec/07-plugins/04-plugin-security.md` §8 |
| C5 | stdio MCP `command` must be a bare PATH name or plugin-relative path; 100 s per `tools/call`, 4 MiB per line | same, §8.1 |
| C6 | `e2e` requires Node ≥ 22.22.3; the doc says Windows runs inside WSL; this host has **no WSL distribution** | measured: `node -v` → v22.23.3; `wsl.exe -l -v` → no installed distribution |
| C7 | `web()` accepts `browser` / `connect` (CDP attach) but **no `channel` / `executablePath`** | `node_modules/@e2e-dev/web/dist/surface.d.ts:74-100` |
| C8 | First `e2e run` needs Playwright chromium headless shell **118.1 MiB**; from `cdn.playwright.dev` it reached 10 % in ~7 min, but `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` finished the same payload in < 45 s | measured 2026-10-27 |

C2 and C8 together decide the distribution split: the plugin package carries UI,
manifest, plugin main and skills; the runtime (Python venv, Node + e2e, browser
payload) lives in userData and is placed there by the installer.

## 3. Target architecture

Everything lives in this repository. The platform source is small (< 1 MiB, ~150
files), so it ships inside the plugin package; only the Python venv and the
project data live outside it.

```text
Desktop (unchanged)
├── plugins/autotest/                      packaged, ≤ 50 MiB
│   ├── manifest.json                      ui.panel, views, services, agentTools,
│   │                                      net.domains, skills, settings
│   ├── main.js                            service supervisor, agent tools
│   ├── renderer/                          built Vue app (index.html + assets),
│   │                                      diagnostics.html, runs.html
│   ├── build-panel.mjs                    vite build → renderer/ + API-base inject
│   ├── skills/autotest.md                 case format, read-only tool rules
│   └── platform/                          the platform itself (copied source)
│       ├── src/autotest/                  FastAPI, storage, executors, agents
│       ├── tests/                         pytest: contract, executors, migration
│       ├── config/                        settings.yaml, agents.yaml
│       ├── scripts/                       legacy launchers (restart endpoint)
│       └── ui/                            Vue 3 source (built into renderer/)
│
├── <plugin data>/workspace/               project data (dataRoot setting)
└── venv                                   pythonPath setting: an existing venv
                                           in development, provisioned in P4
```

The supervisor starts the backend as
`<pythonPath> -m uvicorn autotest.api.server:app` with `cwd=plugins/autotest/platform`,
`PYTHONPATH=<platform>/src` and `AUTOTEST_WORKSPACE=<dataRoot>`, so the same
source runs from the plugin directory in development and after install.

One event contract for both channels: the panel, the report page and the flake
statistics never branch on which channel produced a result.

## 4. Decisions

| ID | Decision | Rationale |
|---|---|---|
| D1 | Engine follows the **`e2e` engine contract**. **Default is A1: the e2e runtime as a Node sidecar**, because P0 proved it runs natively on this Windows host (exit 0, 7.86 s test, no WSL). A2 (`pi.browser` CDP engine) is kept as a later zero-payload option for cockpit targets that must live inside the host | P0 evidence below; A1 costs ~170 MiB of runtime payload but needs no engine work |
| D2 | Platform source ships **inside the plugin package** (`plugins/autotest/platform`, < 1 MiB); only the Python venv and project data live outside it, addressed by the `pythonPath` and `dataRoot` settings | C2 leaves room for the source; keeps one source of truth in this repository instead of a second checkout |
| D3 | This cycle covers Web/mobile UI plus the run-event contract; ECU/HIL enters as simulated-CAN driver only | real hardware is an M6 prerequisite |
| D5 | The **pipeline lives in the plugin, the rules live in the backend**. The plugin main runs the stage machine and calls `pi.agent.complete` (the Desktop model the user already has); Python owns stage order, output contracts, checkpoint policy and the `agent_calls` ledger | the platform can now execute requirement→cases→scripts on its own without a second key/config, and every model answer is still validated by code that the model cannot edit |
| D4 | **No model layer inside the platform**: the bundled agents, LLM client, Hindsight memory, chat endpoint and requirement-analysis mocks were deleted. Reasoning, case authoring and repair come from the Desktop agent through the plugin's `agentTools` + skill | one agent runtime, one set of keys, one chat surface; the platform stays testable offline and its package stays small |

## 5. Run event contract v1

Seven events, one JSON object per line (NDJSON), `schemaVersion: 1`.

| Event | Required fields | Notes |
|---|---|---|
| `run.start` | `runId`, `projectId`, `caseIds[]`, `channel` (`ui`\|`ecu`\|`api`), `startedAt` | emitted once |
| `case.start` | `runId`, `caseId`, `attempt`, `startedAt` | one per case attempt |
| `step.start` | `runId`, `caseId`, `stepId`, `index`, `kind` (`act`\|`assert`\|`driver`), `label` | |
| `step.end` | `runId`, `caseId`, `stepId`, `status` (`pass`\|`fail`\|`skip`), `durationMs`, `replayHit` (bool), `detail?` | `replayHit` is the cost metric |
| `artifact` | `runId`, `caseId`, `kind` (`screenshot`\|`video`\|`trace`\|`report`), `path`, `bytes?` | path is workspace-relative |
| `case.end` | `runId`, `caseId`, `status`, `durationMs`, `failure?` | |
| `run.end` | `runId`, `status` (`pass`\|`fail`\|`error`\|`cancelled`), `counts{pass,fail,skip}`, `durationMs`, `replayHits`, `modelCalls` | |

Storage: `executions` and a new `execution_events` table in the project database
(`src/autotest/storage/sqlite.py`), appended through a migration. The panel
streams the same events over SSE.

## 6. Phases

Each phase: goal → steps → acceptance checklist (command + expected evidence) →
rollback.

### P0 — runtime kill gate (0.5–1 day)

Goal: decide D1 on evidence, not documentation.

Steps:

1. In a scratch directory (never the repo), `npx --yes e2e@0.21.3 init --yes`.
2. Replace the generated config with a target-only config (no `agents`), serve a
   static page on loopback, run `npx e2e run` with `E2E_TELEMETRY_DISABLED=1`.
3. Record: exit code, run report path, wall time, browser payload size, whether
   any step needed WSL.

Acceptance checklist:

- [x] `e2e init` completes on Windows without WSL (measured 2026-10-27)
- [x] `e2e run` exits 0 against a loopback page without WSL — 1 test passed in 7.86 s, run duration 10.39 s
- [x] report JSON written (`.e2e/report.json`, 3 017 B) and readable by a non-Node consumer
- [x] total first-run time and download size recorded in §8
- [x] A1/A2 decision recorded in §4

Rollback: nothing in the repo depends on P0; the scratch directory is disposable.

### P1 — plugin skeleton (2–3 days)

Goal: the platform opens inside Desktop and its backend starts and stops with the
plugin.

Steps:

1. `plugins/autotest/` (or a sibling package) with `manifest.json`
   (`schemaVersion: 1`), `main.js`, `renderer/index.html`.
2. Build the platform UI into `renderer/` (`vite build`, relative asset base,
   `<meta name="pi-plugin-chrome" content="v2">`).
3. `contributes.services: [{ id: "backend", autoRestart: true }]`; `main.js`
   `start()` spawns `<userData>/autotest/runtime/python/python.exe -m uvicorn
   autotest.api.server:app --port 4000` with a readiness poll and bounded
   backoff; `stop()` terminates the tree.
4. `contributes.agentTools`: `list_projects`, `run_cases`, `get_execution`,
   `get_report` — each proxies to the backend; no long call inside the tool.
5. `pi-plugin check` passes; load as a development plugin.

Acceptance checklist:

- [x] `pi-plugin check` reports no blocking error — `OK com.autotest.platform@0.1.0 — 6 files, 27.0 KB` (3 advisory warnings: high-risk grants, loopback domain, resolved after dropping `shell.openExternal`)
- [ ] panel renders the project list from the live backend (screenshot artifact)
- [ ] disabling the plugin stops the backend process (process list before/after)
- [ ] killing the backend makes the service restart within 10 s, logged
- [ ] closing the panel does not orphan the backend; closing Desktop does
- [x] panel strings ship `en` + `zh-CN` (`navigator.language` switch, verified rendering in `zh-CN`)

Verified outside Desktop (2026-10-27): backend on 127.0.0.1:4000 answers
`/api/health` → `{"status":"ok","version":"0.1.0"}` and `/api/projects` with 2
live rows; both `renderer/index.html` and `renderer/runs.html` render those rows
with zero console errors. Remaining items need a Desktop run with the plugin
loaded, which the user performs.

Rollback: disable the plugin; no core file is touched.

### P2 — first real case (3–5 days)

Goal: one real case runs end to end inside Desktop and produces a report.

Steps:

1. Extract execution dispatch out of `src/autotest/api/server.py`
   (`run_script`, currently 46 lines of `subprocess.run`) into
   `src/autotest/executors/{base,python_native,e2e_node}.py`.
2. Emit RunEvent v1 from `python_native`; add the `execution_events` migration.
3. Implement the engine: `defineEngine` handle with `observe` (semantic tree from
   `pi.browser.snapshot()`), `locate`, `perform` (`click`, `fill`, `cdp`), for
   web targets; A1 wrapper only if P0 passed.
4. Panel: streaming step list plus report link (`pi.fs.openInBrowser`).

Acceptance checklist:

- [x] one real case passes with all seven event kinds observed in the log — python channel: `run.start → case.start → step.start → step.end → case.end → run.end` through the live HTTP route (`success=true`, `counts={pass:1}`); UI channel: real e2e case against the platform UI, `✓ home shows the platform shell` in 3.76 s, 10 events, `success=true`
- [x] a failing case reports the failing step and its artifact — failing assertion → `step.end step-1 fail 5003ms`, `failure="ASSERTION_FAILED expect.toContainText failed"`, artifacts copied next to the case (`screenshots/001-failure.png`, 54 963 B + `screen-at-failure.txt`)
- [x] run cancels within 5 s and emits `run.end: cancelled` — live: cancel answered 200, run ended `cancelled` **1.58 s** later, `counts={pass:0,fail:0,skip:1}`, row `已取消`; a second cancel on the finished run → `409`
- [x] SPA execution detail reads real events (steps, durations, artifacts, cancel button) — deep link `/project/<id>/executions/<eid>` returns 200 and renders the step list; unknown `/api/*` paths still 404
- [x] `run_script` behaviour for plain Python scripts is unchanged (existing suite green) — `tests/test_api_contract.py` 12 passed; response keeps `stdout`/`stderr`/`returncode`/`success`
- [x] e2e channel refuses to fake a pass where the runtime is missing — `e2e runtime not provisioned: …` surfaces as `case.end: error`

Two platform defects were found while wiring P2 and fixed in the platform repo:
the project schema never declared `scripts.filepath` although all four script
routes select it (500 on any project created by the current build), and
`create_script` stored a relative path that the run route resolved twice.
`storage/migrations.py` adds the column, backfills it, and `get_project_db`
now migrates on read.

Rollback: revert the executors extraction; the API surface is unchanged.

### P3 — replay and artifacts (3 days)

Goal: the second run of the same case makes zero model calls.

Steps:

1. Port the replay cache: a step records an action sequence only when a later
   assertion verified it; cache key from target, viewport, case revision.
2. Persist `replayHit` per step; expose it in the panel and the report.
3. Store screenshots and traces under the workspace; link them from the report.

Acceptance checklist:

- [ ] run 1: `modelCalls > 0`; run 2: `modelCalls == 0` and `replayHits == steps`
- [ ] changing the case revision invalidates the cache (run 3 calls the model)
- [ ] a failing assertion never writes a cache entry

Rollback: cache is opt-in per project flag.

### P4 — distribution (2–3 days)

Goal: a clean Windows machine runs it after one install.

Steps:

1. `pi-plugin pack` → store-only `.piplug`; assert size and file count (C2).
2. Installer step copies the runtime payload into `<userData>/autotest/runtime`,
   versioned, with a checksum manifest and a repair path.
3. Browser payload: pre-place the headless shell (C8) or use `connect` against a
   host-provided endpoint; document the chosen mode.

Acceptance checklist:

- [ ] `.piplug` ≤ 50 MiB and ≤ 2,000 files (`pi-plugin check` output)
- [ ] clean machine: install → panel opens → case runs, no Python/Node installed
      by the user
- [ ] runtime upgrade replaces the versioned directory and keeps workspace data
- [ ] uninstall leaves workspace data unless the user opts out

Rollback: installer keeps the previous runtime version directory.

### P5 — ECU channel (3 days, contract only)

Steps: simulated-CAN driver emits RunEvent v1; one diagnostic case appears in the
same execution and report as a UI case.

Acceptance checklist:

- [ ] mixed channel run: one UI case and one diagnostic case in one report
- [ ] the panel shows channel per case without branching the report renderer

## 7. Manifest draft

```json
{
  "schemaVersion": 1,
  "id": "autotest",
  "name": "Autotest",
  "version": "0.1.0",
  "main": "main.js",
  "ui": { "panel": "renderer/index.html", "title": { "en": "Autotest", "zh-CN": "自动化测试" } },
  "permissions": [
    "ui.panel", "ui.view", "background.service", "agent.tool.register",
    "net.fetch", "fs.read", "fs.write", "browser.cdp", "shell.openExternal"
  ],
  "net": { "domains": ["127.0.0.1"] },
  "fs": { "read": ["workspace/**"], "write": ["workspace/**"] },
  "contributes": {
    "services": [{ "id": "backend", "autoRestart": true }],
    "agentTools": [
      { "name": "list_projects", "description": "List platform projects", "risk": "low" },
      { "name": "run_cases", "description": "Start a case run and return the run id", "risk": "medium" },
      { "name": "get_execution", "description": "Read a run's events and status", "risk": "low" },
      { "name": "get_report", "description": "Return the report path for a run", "risk": "low" }
    ],
    "views": [{ "id": "runs", "title": { "en": "Runs", "zh-CN": "执行" } }],
    "skills": ["skills/autotest/SKILL.md"]
  },
  "engines": { "piDesktop": ">=0.21.0" }
}
```

`browser.cdp` is declared only when channel A2 ships; drop it if A1 wins.

## 8. Verification log

| Date | Phase | Command | Result |
|---|---|---|---|
| 2026-10-27 | P0 | `npx --yes e2e@0.21.3 init --yes` (scratch) | exit 0, config + test + skills written, no WSL |
| 2026-10-27 | P0 | `npx e2e run` (loopback page, telemetry off) | **exit 0** — `✓ web tests/example.e2e.ts (1 test) 7.86s`, run duration 10.39 s, `.e2e/report.json` 3 017 B. No WSL involved |
| 2026-10-27 | P0 | same, first attempt against `cdn.playwright.dev` | stalled at 10 % of 118.1 MiB after ~7 min |
| 2026-10-27 | P0 | `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` | 118.1 MiB + ffmpeg + winldd finished in < 45 s; `ms-playwright` cache 278 MiB |
| 2026-10-27 | C7 | `surface.d.ts:74-100` | `web({ browser, connect })` only; no `channel`/`executablePath` |
| 2026-10-27 | P1 | `pnpm pi-plugin check plugins/autotest` | `OK com.autotest.platform@0.1.0 — 6 files, 27.0 KB` |
| 2026-10-27 | P1 | backend `uvicorn` on 127.0.0.1:4000 | `/api/health` → `{"status":"ok","version":"0.1.0"}`; `/api/projects` → 2 rows (`proj_674df344`, `proj_992e1639`) |
| 2026-10-27 | P1 | panel + view rendered with Playwright against the live backend | `index.html` 2 project rows, `runs.html` 3 execution rows, 0 console errors, zh-CN copy |
| 2026-10-27 | P2 | `pytest tests/test_executors.py tests/test_project_schema.py tests/test_api_contract.py` | 23 passed (event contract, pass/fail/timeout, unprovisioned e2e, stream translation, storage order, migration); platform baseline committed as `759bd1a`, executor work as `c7f7b02` |
| 2026-10-27 | P2 | live route `POST /api/projects/{id}/scripts/{sid}/run` (uvicorn :4001) | `success=true`, `executor=python-native`, 6 events, `counts={pass:1,fail:0,skip:0}`, stdout captured |
| 2026-10-27 | P2 | `GET …/executions/2/events` | 6 events replayed, `seq 0..5` |
| 2026-10-27 | P2 | same route with `language="e2e"`, runtime absent | `status=error`, `failure="e2e runtime not provisioned: …"` — no false pass |
| 2026-10-27 | P2 | platform source copied into `plugins/autotest/platform` (src, tests, config, scripts, ui) | 146 files / 870 KB in the package, well under the 2 000 files / 50 MiB bound |
| 2026-10-27 | P2 | copied platform started from the plugin dir with an **existing** venv (`pythonPath` reuse) | `/api/health` → ok; create project + script + run → `success=true`, 6 events, stdout captured; project written under `AUTOTEST_WORKSPACE`, not inside the package |
| 2026-10-27 | P2 | `pytest` from `plugins/autotest/platform` | 23 passed (`test_executors`, `test_project_schema`, `test_api_contract`) |
| 2026-10-27 | P1 | `node build-panel.mjs` (vite build into `renderer/`) | build 11.8 s; package 273 files / 19.06 MB (monaco dominates); `pi-plugin check` OK |
| 2026-10-27 | P1 | built SPA served by the same backend (`/`), 2 live projects | panel text renders「AI 测试平台」+ project rows 深蓝S7 ECU 诊断 / 深蓝S7 座舱HMI, **0 console errors**; `?api=` override works, same-origin keeps relative `/api` |
| 2026-10-27 | P1 | observation | the Home view still shows static demo content (「长安深蓝 S7 ECU 测试 · 10 分钟前」etc.) that is not backed by the API — only the project list is live |
| 2026-10-27 | P2 | `runner/run.mjs` + `// @target` case, real e2e against the platform UI | `success=true`, `executor=e2e-node`, e2e 3.76 s, run 10.4 s; steps `step-0`(open `/`, 783 ms) `step-1`(locator body, 71 ms) both pass; 10 events incl. `run.end count={pass:1}` |
| 2026-10-27 | P2 | failing case (`toContainText` on absent copy) | `step-1 fail 5012 ms`, `failure=ASSERTION_FAILED expect.toContainText failed`, 2 artifacts kept: `screenshots/001-failure.png` (54 963 B) + `screen-at-failure.txt` |
| 2026-10-27 | P2 | `GET /executions/{id}/events` wired into `renderer/runs.html` | 5 execution rows, clicking one loads its 10 events with step ids, durations and statuses; 0 console errors |
| 2026-10-27 | P2 | `pytest tests` from the plugin platform | 23 passed, 1 skipped (live-LLM test now opt-in via `AUTOTEST_LIVE_LLM=1`) |
| 2026-10-27 | P2 | live cancel: run a 40 s script, `POST …/executions/1/cancel` | 200 `cancelling`; run ended `cancelled` in **1.58 s**, `counts={0,0,1}`, row `已取消`; repeat cancel → `409`; pytest 25 passed (adds cancel + finished-run cases) |
| 2026-10-27 | P2 | `GET …/executions/{id}` (detail) + SPA detail page | deep link 200; page shows `quick_pass.py · 耗时 1.7s · python-native · 已完成 · 通过 1`, 6 events, step `python quick_pass.py pass 1.10s`; cancelled run shows `已取消 / 跳过 1 / 结束原因`; 0 console errors |
| 2026-10-27 | P2 | SPA deep-link support | `SPAStaticFiles` falls back to `index.html` for page routes only; `/api/*` and `/ws/*` keep 404 (API-contract tests caught the first, over-broad version) |
| 2026-10-27 | P2 | AI layer removed from the platform | deleted `agents/`, `models/`, `tools/` (LLM + Hindsight + MCP client), `workflow/`, `main.py`, `config/`, chat + requirement-analysis + `/api/test/run` endpoints, `chat_messages` tables, 3 AI-only tests; pyproject deps cut to fastapi/uvicorn/pydantic/pytest/httpx/sse-starlette/websockets |
| 2026-10-27 | P2 | plugin grew from 4 to 9 agent tools (`list_scripts`, `create_script`, `run_case`, `get_execution`, `cancel_run`) | a background run through the tool path: `run?background=true` → `started` → poll `executions` → `已完成`, 6 events, `run.end pass` in 6.7 s |
| 2026-10-27 | P2 | UI de-AI pass, probed page by page | home / executions / requirements / settings: no `AI 测试助手`, `Hermes`, `Hindsight` or `大模型配置` strings, **0 console errors**; removed the mock module tree, recent visits, favourites, running tasks and the fake pass-rate |
| 2026-10-27 | P2 | removed endpoints | `POST /api/chat` → **404**, `POST …/requirements/analyze` → **404** (added a catch-all `/api/*` 404 so the static mount cannot answer 405/HTML); health reports `version 0.2.0` |
| 2026-10-27 | P2 | pipeline engine, stub model, real backend (`pipeline/selftest.mjs`) | `auto` policy: analyze→design→author→gate→ready 全绿，2 条用例 + 2 个脚本（`python` 与 `e2e` 各一，`case_id` 已绑定），`gate={ok:true}`，账本 3 行 |
| 2026-10-27 | P2 | checkpoint policy `analyze` | 分析后 `status=waiting`；`POST …/approve` 后继续跑到 `done`；`analyze_author` 在 author 后二次暂停 |
| 2026-10-27 | P2 | fail-closed rules | 空 `function_points`→400；e2e 缺 `// @target`→400；乱序回报→400；坏 python 脚本过闸门→**流水线 failed**，`error` 写明语法错误 |
| 2026-10-27 | P2 | panel pipeline page (Playwright, 1440×1000) | 首屏自动选中最新流水线，阶段时间线/用例脚本摘要/闸门结论/账本 3 行全部渲染，**0 console error**；待确认时"确认继续"→`进行中 · 当前 用例设计` |
| 2026-10-27 | P2 | 修掉阻塞事件循环的老 bug | `env-status` 原在 `async def` 里做 3 次 2s `urlopen`，把整个后端卡 6 秒（流水线页因此白屏）；改为 `asyncio.to_thread` + 15s 缓存 + 1s 超时，`pipelines` 列表 9ms、详情 9ms |
| 2026-10-27 | P3 | 全链路执行（真进程，模型打桩） | `execute #1` 跑 2 个 python 用例：`pipeline_bad.py → fail #1`、`pipeline_ok.py → pass #2`；`judge #1` 通过1失败1 → `repair #1` 改一处 → `execute #2` 两个都 pass → `judge #2` 通过2 → `report`；`status=done` |
| 2026-10-27 | P3 | 证据链完整性 | `execution_cases` 4 行（含失败那次的 1801ms 与 `assert expected 1 got 0`）、`test_cases.status=通过`、`reports` 一行 `100.0%`、`reports/<pipeline>.md` 834 B；`pipeline_stages` 里 `execute/judge` 各有 attempt 1 与 2，两轮不被覆盖 |
| 2026-10-27 | P3 | 面板全链路（Playwright，1440×1100） | 10 个阶段行（含两轮执行/判定）、执行摘要 `pipeline_bad.py→fail #1`、修复摘要带 note、`查看报告` 渲染 markdown，**0 console error** |
| 2026-10-27 | P3 | e2e 全链路（真 Playwright） | 首轮断言故意写错 → `fail`（`ASSERTION_FAILED expect.toContainText`），保留 `001-failure.png`（36 KB，截图为平台首页）+ `screen-at-failure.txt`；repair 只改断言文案 → 重跑 `pass`；报告 878 字符，含「证据（两轮）」「产物」「修复记录」 |
| 2026-10-27 | P3 | 报告页接流水线报告 | `/api/projects/{id}/reports` 现返回 `kind: pipeline|execution`；页面统计来自 `reports` 行（1/1/0/100.0%），行内有「流水线」标签、`查看`（展开 markdown）、`下载 .md`；**0 console error** |
| 2026-10-27 | P3 | 去重 | 发现 `/projects/{id}/reports` 有两条同名路由（旧路由先注册，`kind` 被吞）→ 合并为一条，旧路由补 `kind` 字段 |
| 2026-10-27 | P4 | 定时计划（后端 + 面板） | `daily 02:00` 建好后把 `next_run_at` 改到过去 → `/api/pipelines/due` 立刻返回它；`fire` 产出 `checkpoint_policy=auto` 的流水线，跑完 `done` + 报告 340 字符，`last_run_at/next_run_at/last_pipeline_id` 全部推进，之后不再出现在 due |
| 2026-10-27 | P4 | 面板「定时计划」区块 | 2 条计划（每天 02:00 / 每 5 分钟）、停用→启用往返生效、`立即运行` 建出 `pipe_743ebf07fc` 并自动选中，**0 console error** |
| 2026-10-27 | P4 | 结束汇报 | 插件按终态调用 `notifyPipelineFinished`：机械摘要 + 可选模型两句话 → 原生通知 + toast；`agent.complete` 不可用时退回机械摘要（桌面端验证项，非本机可测） |
| 2026-10-27 | P4 | `pytest tests` + `pi-plugin check` | **50 passed**（+7 计划用例）；包 **268 files / 19.36 MB** |

## 8.5 Pipeline (requirement → cases → scripts)

The gap this closes: the platform used to have 7 in-process agents and a fixed
pipeline; both were deleted (D4), leaving "you write the case in chat". The
pipeline restores automation **without** a second model configuration.

Roles now:

| Layer | Owns |
| --- | --- |
| Panel (`/project/:id/pipeline`) | create a run, choose the checkpoint policy, watch stages, approve / retry / cancel |
| Plugin main (`pipeline/engine.mjs`) | stage machine, prompt, retry-within-stage, side effects (create cases/scripts), model access via `pi.agent.complete` |
| Backend (`autotest/pipelines/service.py`) | stage order, output validation, checkpoint policy, `pipelines` / `pipeline_stages` / `agent_calls` |

Stages: `analyze → design → author → gate → execute → judge → report`, with a
`repair → execute` loop when the judge finds failures.

| 阶段 | 谁做 | 产出 |
| --- | --- | --- |
| analyze / design / author | 模型（宿主 `pi.agent.complete`） | 功能点 / 用例 / 脚本 |
| gate / execute / judge / report | 平台（无模型） | 闸门结论 / 执行记录 / 判定 / `report.md`（含每轮证据、产物路径、修复记录） |
| repair | 模型只改失败脚本 | 补丁 + 重跑（最多 2 轮） |

Rules the model cannot bypass:

| Rule | Where |
| --- | --- |
| `function_points` non-empty, ≤200,每个必须有 `name` | `validate_analyze` |
| cases: 标题唯一、`steps`/`expected` 必填、≤200 | `validate_design` |
| scripts: `language ∈ {python,e2e}`，e2e 首行必须 `// @target` | `validate_author` |
| 闸门未通过 = 整条流水线失败（不存在"带病进入待执行"） | `report_stage` |
| 阶段乱序回报 → 400 | `report_stage` |
| `judge` 有 fail/error 才进 repair；repair 轮次 ≤ `MAX_REPAIR_ROUNDS`（2），到顶就带着失败进报告 | `successor()` |
| repair 补丁必须带 `content` **和** `note`（note 要指明依据哪条失败） | `validate_repair` |
| repair 之后必须回到 `execute` 重跑；重复进入同一段 `attempt` 递增，两轮证据都保留 | `successor()` + `_next_attempt` |
| 报告 markdown 少于 80 字符 → 拒收；每条 pass 必须能对上 `executionId`，否则生成报告直接失败 | `validate_report` + `buildReport` |
| 执行结束写 `execution_cases` 并回写 `test_cases.status` | `executors/service.py` |
| 每次模型调用落 `agent_calls`（prompt/output hash、tokens、采纳与否） | `record_agent_call` |

Checkpoint policies (all three wanted, chosen per run): `analyze`（默认，分析后停）、
`analyze_author`（分析后 + 脚本生成后各停一次）、`auto`（不暂停，适合夜间批跑）。

Model: `pi.session.getLlmContext().modelKey`（当前会话正在用的模型），拿不到时回退
`pi.models.list()` 的默认项；两者都没有 → 流水线报 "no model available"，绝不降级为假通过。

## 8.6 Scheduled (nightly) runs

`pipeline_schedules` 是"什么时候跑"的规则层，与流水线本身解耦：

| 字段 | 含义 |
| --- | --- |
| `kind` | `daily`（`at_time` HH:MM）或 `interval`（`interval_minutes ≥ 5`） |
| `enabled` | 停用后不进 due 列表，`fire` 直接 409 |
| `next_run_at` | 到点判定唯一依据；`fire` 后按规则推进 |
| `last_pipeline_id` | 这次计划产生的流水线，报告页/通知都用它 |

触发链：插件 main 每 30s `GET /api/pipelines/due` → `POST …/schedules/{id}/fire`
→ 后端**在一个事务里**建流水线（`checkpoint_policy` 恒为 `auto`、`model_key=scheduled`）
并推进 `next_run_at` → 编排器接手跑完整条链。

为什么 `fire` 放在后端：如果有人半夜点了"确认继续"之类的前提被打破，或者主机在
两步之间挂掉，`create pipeline` 与 `advance next_run` 必须同生共死，否则同一晚可能
重复跑或永远不跑。

跑完汇报（`notifyPipelineFinished`）：机械摘要（judge 计数 + 修复轮次 + 失败原文）
→ 能取到模型时再让模型压成两句话 → `pi.ui.notify` 原生通知 + `showToast`。
`agent.complete` 不可用（无模型/未授权）时退回机械摘要，不静默失败。

## 9. Policy compliance

- One branch + one dedicated worktree per request; this plan lives on
  `feat/autotest-plugin` in its own worktree, never on local `main`.
- No change to `apps/desktop/electron/main/index.ts`, `app-store.ts`,
  `ChatTranscript.tsx`, `Composer.tsx`, or any Host/Rust file: the plugin path
  needs no host API today.
- If P2 proves the panel needs a host capability that does not exist
  (for example a CDP endpoint for `connect`), stop and write an ADR before
  touching core.
- Panel copy ships `en` + `zh-CN` (manifest validation rejects single-locale
  titles).
- `verify:ui:*` runs only when the user asks; plugin work uses `pi-plugin check`,
  `pnpm --filter <plugin> typecheck`, and plugin-local tests.
- e2e dependency (if A1): pin the version, force
  `E2E_TELEMETRY_DISABLED=1` in the launcher, keep the Apache-2.0 `NOTICE`, and
  never use the `e2e` / TesterArmy name in product copy.

## 10. Open risks

| Risk | Trigger | Mitigation |
|---|---|---|
| A2 cannot run the browser guest headless or concurrently | P2 observation | fall back to A1 if P0 passed; otherwise single-flight UI runs |
| Host denies `pi.browser` on a background guest | P2 | run the case in the visible work-panel Browser view |
| 118 MiB browser payload per install | P4 | pre-place in runtime, or `connect` to a shared browser |
| `e2e` pre-1.0 API churn | any upgrade | pin the commit, confine imports to one engine module |
| Plugin 50 MiB bound with a large Vue build | P4 | split views into lazy chunks; assets stay under 10 MiB |
