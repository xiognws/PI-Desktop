# 0411 — The AutoTest platform service is a Rust binary, not a Python process

Status: accepted (2026-11-27)

## Context

The workbench under `services/autotest` was a Python FastAPI service that the
Electron host spawned lazily: 73 loopback routes over one SQLite file per
project, a Vue bundle served from the same process, and an executor that runs the
user's pytest scripts. Measured on the reference machine before the change:

| metric | value |
| --- | --- |
| cold start to `/api/health` 200 | **2.42 s / 2.92 s / 3.00 s** |
| `.deps` shipped with the installer | **98.6 MB** across 91 top-level entries |
| declared dependencies | 11 (`pyproject.toml`) — the lock was a full machine `pip freeze`, including `-e d:\code\autotestdemo`, boto3, cohere and allure |
| resident memory, idle | 51.1 MB working set |
| service source | 9,810 lines across 41 files |

Two costs followed from that shape. Every launch that reaches the surface pays an
interpreter import (uvicorn+fastapi alone 2.9 s), and the installer carries a
Python tree whose contents nobody chose. A third cost is structural: the platform
keeps a SQLite database of its own, so the process that owns user data was a
service the host did not build, sign, or version with the rest of the app.

## Decision

Implement the service in Rust as `crates/autotest-core`, binary `pi-autotest`, a
peer of `host-core` in the same workspace and release profile, and have the
Electron host spawn it instead of uvicorn.

The **wire contract does not change**: same routes, same JSON shapes, same
`runtime.json`, same database files and directory layout. The Vue bundle and the
plugin's agent tools keep talking HTTP to loopback and cannot tell which process
answers. Python remains only where the work is genuinely Python — executing the
user's pytest scripts, and extracting text from `.docx`/`.xlsx` containers.

## Consequences

Measured after the port (release build, same machine, same scratch paths):

| metric | value |
| --- | --- |
| listener bound | **134–190 ms** |
| first `/api/health` 200 | **610–650 ms** (the first inbound connection on this machine carries a fixed ~470 ms cost; subsequent requests answer in ~3 ms) |
| binary size | 8.4 MB |
| `.deps` still required | only for the executor (pytest closure) |

Parity is enforced mechanically, not by review: 69 route fixtures captured from
the Python service are replayed against the Rust service and compared on status,
recursive JSON shape and every deterministic value (41 core + 24 workflow + 6
knowledge; the workflow comparison includes generated pytest text by line count).

What this buys: no interpreter on the boot path, one binary signed and versioned
with the app, and a service whose process lifecycle, watchdog and error handling
are the same code style as host-core.

What it costs, stated plainly:

* The platform logic now exists twice — Rust is authoritative, the Python source
  stays in the tree as the reference for the fixtures and as the fallback engine.
* `.pdf` extraction is refused with a 400 rather than imported: no PDF parser is
  available in the offline crate set. The Python service imported it, so this is
  a real (narrow) regression, recorded rather than hidden.
* Non-UTF-8 text falls back to a lossy decode for the same reason.
* Two SQLite owners now exist in a stricter sense than before: `host-core` owns
  app data, `pi-autotest` owns the platform's project databases. The boundary is
  intentional — the platform's data model (one database per project, moved with
  the project directory) is its own.

## Alternatives considered

**Hosting the 73 routes inside `host-core` over its JSON-RPC channel.** Rejected:
it would move the UI off HTTP (fetch + WebSocket → host RPC), force the Vue bundle
to load from `app.asar` instead of the service, and grow `host-core` — already a
ratchet hotspot (AGENTS.md § 7) — into a second application. Same startup win,
much larger change.

**Keeping Python and only pruning `.deps`.** Cheap (one day) and worth doing on
its own, but it leaves the 2.4–3.0 s cold start, the interpreter on the boot path,
and an unsigned third-party-shaped subtree in the installer.

**Pre-warming the Python service at launch.** Rejected: it trades a startup pause
for a resident interpreter and a listening port started before any user action —
exactly the process shape the lazy-start rule in ADR 0408 was written to avoid.
