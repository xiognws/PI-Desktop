---
name: Autotest
description: Use when the user asks about test projects, cases, scripts, runs or reports of the Autotest platform.
---

# Autotest

The Autotest plugin hosts an automotive test platform (FastAPI backend on
127.0.0.1) inside Desktop. It has no model of its own: **you are the AI part**.
Use the tools for data and runs; author cases yourself and show the result in
the panel.

## Tools

| Tool | Input | Use |
|---|---|---|
| `platform_status` | – | backend reachable? port, python, data root |
| `list_projects` | `limit?` | find a `projectId` |
| `list_cases` | `projectId` | cases of a project |
| `list_scripts` | `projectId` | scripts/cases with `language` |
| `create_script` | `projectId, name, language, content` | write a case (`python` or `e2e`) |
| `run_case` | `projectId, scriptId` | starts a background run, returns immediately |
| `get_execution` | `projectId, executionId` | run row + RunEvent stream (steps, durations, artifacts, failure) |
| `cancel_run` | `projectId, executionId` | stop a run; it ends `cancelled` in a few seconds |
| `list_executions` | `projectId` | recent runs of a project |
| `run_pipeline` | `projectId, requirementFilename, checkpointPolicy?, targetUrl?` | full chain: requirement → cases → scripts → gate → execute → judge → repair → report |
| `pipeline_status` | `projectId, pipelineId?` | stages, outputs, and the model-call ledger |
| `pipeline_action` | `projectId, pipelineId, approve|retry|cancel` | continue a paused run, rerun its stage, or stop it |
| `pipeline_report` | `projectId, pipelineId` | the markdown report (evidence, artifacts, repair log) |
| `list_schedules` | `projectId` | scheduled runs with rules and next fire time |
| `fire_schedule` | `projectId, scheduleId` | start a scheduled run now |

## Case formats

- `python`: a plain script run with the platform interpreter, 30 s default
  timeout. Failure = non-zero exit. Good for API checks, data checks and
  simulated-CAN diagnostics.
- `e2e`: a TypeScript file for the UI channel. The first line must name the app
  under test:

  ```ts
  // @target http://127.0.0.1:4000
  import { test } from "@e2e-dev/web";
  import { expect } from "e2e";

  test("home shows the shell", async ({ app, browser }) => {
    await app.open("/");
    await expect(browser.locator("body")).toContainText("AI 测试平台");
  });
  ```

  A failing assertion keeps a screenshot and `screen-at-failure.txt` next to the
  case under `artifacts/<runId>/…`.

## Pipeline vs. one-off case

Use `run_pipeline` when the user hands you a requirement document and expects the
whole chain (分析 → 用例 → 脚本) to be produced. Pick the checkpoint policy by
intent, not by habit:

| Policy | Use when |
| --- | --- |
| `analyze` (default) | the user wants to check the function points before cases are written |
| `analyze_author` | cases and scripts both need a human look (review-heavy projects) |
| `auto` | unattended/nightly runs, or the user said "just do the whole thing" |

The run advances every ~2.5 s in the plugin, using the model of the session the
user is looking at. Poll `pipeline_status`; when it turns `waiting`, show the
stage output and ask the user to approve (`pipeline_action approve`).

## What the pipeline does on its own

| Stage | Owner | Notes |
| --- | --- | --- |
| analyze / design / author | the model (the user's session model) | strict JSON, re-asked up to 2–3 times |
| gate | platform | python syntax / e2e `// @target`; failure ends the run |
| execute | platform | real processes, one background run per script, polled to completion |
| judge | platform | mechanical verdict from exit/assert；写回 `test_cases.status` |
| repair | the model | only failing scripts, **max 2 rounds**, each round re-runs |
| report | platform | `reports/<pipeline>.md` + a `reports` row; the markdown carries every round's evidence, artifact paths (failure screenshot) and the repair log |

Rules you must respect when talking about a run:

- A `pass` is only real when the report row carries an `executionId`. Quote it.
- `repair` never gets to lower an assertion to force green — if the model patches
  away an assertion, say so and treat the case as unresolved.
- Two repair rounds is the ceiling: after that the report keeps the failures.
- The report file is the deliverable; read it (`/pipelines/{id}/report` or the
  project's 报告 page) instead of reconstructing results from memory.
- A UI case keeps its failure screenshot under
  `scripts/artifacts/<runId>/<case>/attempt-1/screenshots/001-failure.png`; the
  report's 产物 section lists it. Link that path when reporting a fixed failure.

A pipeline ends `failed` when a rule rejects the model output or the static gate
finds a broken script. Report the exact stage and error text; never re-run it
silently and never describe a failed gate as done.

## Scheduled runs

A schedule (`daily HH:MM` or `interval ≥ 5 min`) always fires with the `auto`
policy — no checkpoint, nobody is awake to approve. The plugin checks
`/api/pipelines/due` every 30 s and fires; on the terminal state it sends a
native notification + toast summarised from the report (model-compressed when a
model is available).

When the user asks "跑一次夜间的 / 加个每天两点的回归", use `list_schedules` first,
then either point them at 流水线页 → 定时计划 or `fire_schedule` for an immediate
run. Never promise a schedule was created without reading it back.

## Workflow

1. `list_projects` (or create one in the panel) → get `projectId`.
2. Read the requirement files the user uploaded, then `create_script` one case
   per behaviour; keep names descriptive (`home_shell.e2e.ts`).
3. `run_case` → poll `get_execution` until the row leaves `执行中`.
4. Report **actual** evidence: step statuses and durations, artifacts, failure
   text. Never claim a pass you did not read back from `get_execution`.

## Rules

- Every write goes through `create_script`; do not hand-edit files under the
  plugin's data folder.
- A run is a real process: if the user changes their mind, `cancel_run` instead
  of starting another one.
- A missing runtime (no `node`, no e2e home, no `// @target`) surfaces as
  `e2e runtime not provisioned: …` — report that to the user, do not retry.
- Keep project ids, script ids and status values exactly as returned.
