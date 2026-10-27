# Autotest plugin

Hosts the Autotest platform (automotive ECU / cockpit HMI test platform) inside
PI-Desktop.

## Contributions

- Panel `renderer/index.html` — projects, live backend status
- Work-panel view `runs` (`renderer/runs.html`) — executions per project
- Resident service `backend` — supervises the FastAPI backend process
- Agent tools `platform_status`, `list_projects`, `list_cases`,
  `list_executions` (read-only)
- Skill `skills/autotest.md`
- Settings `pythonPath`, `dataRoot`, `backendPort`, `autoStart`

## Layout

```text
plugins/autotest/
  manifest.json  main.js  renderer/  skills/   plugin surface
  platform/                                      the platform source (copied)
    src/autotest/   FastAPI, storage, executors, agents
    tests/          pytest suite
    config/         settings.yaml, agents.yaml
    scripts/        legacy launchers
    ui/             Vue 3 source
```

## Backend resolution

1. `pythonPath` setting: the venv interpreter to run (development reuses an
   existing venv; P4 provisions one).
2. Otherwise `<plugin>/platform/.venv/Scripts/python.exe` (POSIX:
   `.venv/bin/python`).

The backend always starts with `cwd=<plugin>/platform`,
`PYTHONPATH=<plugin>/platform/src` and `AUTOTEST_WORKSPACE=<dataRoot>`, where
`dataRoot` is the setting or `<plugin data>/workspace`. Project data therefore
never lands inside the package.

## Develop

1. `pythonPath` → an existing venv (this repository does not create one).
2. Plugins page → **Load development plugin** → pick this directory.
3. Validate, test, package:

```bash
pnpm pi-plugin check plugins/autotest
platform/.venv/Scripts/python.exe -m pytest platform/tests -q    # or your venv
pnpm pi-plugin pack plugins/autotest
```

## Verify without Desktop

```bash
cd plugins/autotest/platform
PYTHONPATH=src AUTOTEST_WORKSPACE=<scratch dir> <venv>/python -m uvicorn \
  autotest.api.server:app --host 127.0.0.1 --port 4002
curl -s --noproxy '*' http://127.0.0.1:4002/api/health
```

`--noproxy '*'` matters: this host's proxy variables make a loopback curl return
`000`, which looks like a dead server.

## Known limits (P1)

- The panel hardcodes port `4000`; a non-default `backendPort` shows as offline
  until the port is passed through the panel bridge.
- Execution status values are still free text from the legacy schema; RunEvent
  v1 (P2) replaces them with `pass|fail|error|cancelled`.
