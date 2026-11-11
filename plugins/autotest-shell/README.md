# Autotest Workflow (agent-native shell plugin)

Minimal first cut of the agent-native test workbench. Tools are registered
inside the Agent sidecar through `contributes.agentExtensions`; there is no
MCP server, no tool gateway, and no separate protocol layer. Each `execute`
is one loopback HTTP call to the local FastAPI service in
`services/autotest`.

## What is wired today

| Tool | Backend route | Notes |
| --- | --- | --- |
| `autotest_prd_parse` | `POST /api/projects/{id}/workflow/prd-parse` | deterministic section split, opens a run |
| `autotest_case_design` | `POST .../workflow/case-design` | function point × type matrix |
| `autotest_case_review` | `POST .../workflow/case-review` | untestable / duplicate detection |
| `autotest_script_author` | `POST .../workflow/script-author` | pytest skeleton files under the project `scripts/` dir |
| `autotest_run` | `POST .../runs/{id}/execute` | dispatches to a background thread, returns immediately |
| `autotest_run_status` | `GET .../runs/{id}/status` | summary view: steps, pending, execution stats, failures |
| `autotest_log_analyze` | `POST .../workflow/log-analyze` | error type, suspect frames, suggestions |
| `autotest_report` | `POST .../runs/{id}/report` | Markdown report into `reports/` + reports table; also maps failures to bug rows |
| `autotest_request_confirmation` | `POST .../runs/{id}/pending` | human checkpoint; ends the turn with `WAITING_HUMAN` |
| `autotest_decide` | `POST .../runs/{id}/pending/{decision}/decide` | records the human answer |
| `autotest_knowledge_search` | `GET .../workflow/knowledge/search` | read-only: BM25 over imported docs + archived run reports |

Two tools (`request_confirmation`, `decide`) exist on top of the eight in the
design table because a human checkpoint has to be a real row, not a sentence
in the transcript. `knowledge_search` is an extra read-only tool: it lets the
agent look up project history before designing cases (returns title + excerpt +
`source_ref`, never the full document). Everything else follows the
"summary + handle" rule: full function points, cases and scripts stay in
SQLite, so the model context does not grow with the document.

Knowledge base ingestion is UI/service side, not an agent tool:
`POST .../knowledge/documents` (single), `.../documents/batch` (many files,
mixed formats), `.../documents/text`, `.../documents/from-specs`, and
`GET .../documents/{doc_id}/chunks` for a split preview. Imported
files are split by Markdown headings and length, stored per project, and
indexed in FTS5 (`trigram`) so BM25 ranking works without embeddings.
`autotest_report` archives each finished report into the same table
(`record_type='run-report'`, idempotent by `source_ref=run:<id>`).

State lives in six tables created per project database
(`workflow_runs`, `workflow_steps`, `workflow_decisions`,
`knowledge_records`, `bugs`, `bug_occurrences`). `bugs` is filled by the
backend when a report is built: one `bug-xxxxxxxx` row per failing case,
merged across runs by a `script_name + case_id` signature (`occurrences`
counts repeats, `last_run_id` points at the newest sighting). Re-emitting a
report for the same run never duplicates defects or bumps the counter.
`PATCH .../workflow/runs/{id}/bugs/{bug_id}` moves a defect through
`open → fixed → verified` (or `wontfix`), scoped to the run where it occurred.
A later run where the same signature passes flips it to `verified`
automatically (`verified_bug_ids` in the report response).

Generated scripts run twice-compatible on purpose: `pytest <file>` collects
them as test cases and skips the skeleton, `python <file>` prints a note and
exits 0 — the executor judges by exit code, so a skeleton must not be counted
as a failure.

## The standalone window

The workbench is its own `BrowserWindow` (not a plugin panel: panels are
`sandbox: true` with a fixed 46px drag strip, and their page network goes
through `net.domains`). `electron/autotest/window.ts` builds it, the
application menu opens it under **View → Autotest Workbench**, and the page
comes from the local FastAPI service (`loadURL("http://127.0.0.1:<port>/")`),
so it is same-origin with the API and needs no CORS layer. The window has no
preload, `contextIsolation: true`, `sandbox: true`, denies `window.open`, and
only loads loopback URLs.

Until the Vue app in `services/autotest/ui` is built (`ui/dist`), the backend
serves `services/autotest/ui-shell/index.html`: a zero-build page with
projects, runs, step timeline, approval buttons, execution stats and the
knowledge search box. When `ui/dist` appears that branch takes over and the
window code does not change.

## Not wired yet

- Building the Vue app in `services/autotest/ui` (`ui/dist`, `ui/node_modules`
  are both absent; the shell page stands in meanwhile)
- `bug_organizer` / `knowledge_save` as separate tools (backend-side
  deterministic steps, not model calls)
- Packaging needs one build-machine step: `pip install --target
  services/autotest/.deps -r services/autotest/requirements.lock` before
  `electron-builder`, otherwise the packaged `.deps` is empty and the backend
  cannot import fastapi

## Running locally

The service runs on the Python that ships with Pi Desktop
(`apps/desktop/resources/python`, CPython 3.12). No venv and no second
interpreter: autotest's own wheels live in `services/autotest/.deps`
(gitignored), and the bundled `site-packages` is appended to `PYTHONPATH`
so packages the bundle already carries (pandas, openpyxl, ...) are reused.
Never install into the bundled `site-packages` — its `MANIFEST.json` is
verified by sha256 on every build.

1. Install the service dependencies once (from the repo root):

   ```powershell
   $py = "apps\desktop\resources\python\runtime\python.exe"
   & $py -m pip install --target services\autotest\.deps `
       fastapi "uvicorn[standard]" pydantic pytest httpx `
       sse-starlette websockets python-multipart `
       pdfplumber beautifulsoup4 python-docx
   ```

   The list mirrors `services/autotest/pyproject.toml`; installing the
   project itself (`pip install -e .`) is not needed because `PYTHONPATH`
   already points at `services/autotest/src`. The last three are only needed
   by knowledge-base ingestion (PDF / HTML / DOCX); md/txt/csv/json parse with
   the standard library alone.

2. Run the backend by hand:

   ```powershell
   $env:PYTHONHOME = (Resolve-Path "apps\desktop\resources\python\runtime").Path
   $env:PYTHONPATH = ((Resolve-Path "services\autotest\src").Path, (Resolve-Path "services\autotest\.deps").Path, (Resolve-Path "apps\desktop\resources\python\site-packages").Path) -join ";"
   & $env:PYTHONHOME\python.exe -m uvicorn autotest.api.server:app --host 127.0.0.1 --port 4000
   ```

   Give it `AUTOTEST_WORKSPACE` too, otherwise it writes under
   `services/autotest/workspace/projects`.

3. In the Desktop app the backend is started by
   `apps/desktop/electron/autotest/service.ts`: it picks a free port, spawns
   uvicorn, polls `/api/health`, then writes
   `<dataDir>/autotest/runtime.json` (`{port, pid, workspace, startedAt}`).
   Failures are fail-soft — the app keeps working, only the tools report a
   connection error.

4. Runtime address override: the tools read `PI_AUTOTEST_RUNTIME` first, then
   `<PI_DESKTOP_DATA_DIR>/autotest/runtime.json`, then fall back to port 4000.
   `token` in that file is forwarded as `x-autotest-token` when present.

## Tests

```powershell
$env:PYTHONPATH = "services\autotest\src;services\autotest\.deps;apps\desktop\resources\python\site-packages"
& "apps\desktop\resources\python\runtime\python.exe" -m pytest services\autotest\tests -q
```
