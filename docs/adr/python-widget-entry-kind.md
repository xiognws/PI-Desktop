# ADR: Python packages as a widget entry kind

- Status: Proposed
- Related: D699 (widget packages), `packages/shared/src/widgets.ts`,
  `packages/agent-runtime/src/widgets/`, `crates/host-core/src/widgets.rs`,
  `packages/python-runtime`

## Context

Widget packages (D699) are this product's only "drop a folder in, the host
discovers it, the sidecar runs it" mechanism. The host owns discovery, trust and
the enabled set; the sidecar owns execution, so a package crash cannot take the
window down. Every property we want for an independently versioned Python
capability — its own version, its own release cadence, installable without
rebuilding the app — already exists in that mechanism.

It is, however, JavaScript-only. `ENTRY_CANDIDATES` is
`["index.js", "index.mjs", "index.cjs"]` and `loadWidgetEntry` evaluates the
entry through jiti in the sidecar process. A Python capability therefore cannot
use the mechanism at all today.

We need to land two things on top of it:

1. **ComTestTool's framework** (`core`, `libs`, `hal`, `utils` — about 3.7 MiB
   of Python source) as an independently versioned package, so it can be
   updated on its own schedule and shared by the autotest work that will build
   on it.
2. **A CPython runtime** that a Python package can execute against.

The second is not a package. It is a platform dependency: the whole client
depends on it, not just one capability, and it must not be a thing the user
trusts or enables. It is therefore handled separately (`packages/python-runtime`,
shipped under `<resources>/python`) and this ADR does not change its lifecycle.

Two facts about the real payload constrain the decision:

- `libs` contains **153 MiB / 543 files** of firmware images
  (`sdb_convert/VIUFR/*.hex`, 31 MiB each) and a vendor CAN driver suite
  (`zcan/kerneldlls/*.dll`). Those are test data and third-party binaries, not
Two facts about the real payload constrain the decision:

- `libs` carries the vendor CAN driver distribution (`zcan/kerneldlls`, 31.5 MiB)
  and the firmware images the converter operates on (`sdb_convert`, 118 MiB).
  These are **part of what the framework does** — `libs.zcan` and
  `libs.sdb_convert` are importable modules with `__init__.py` — so they ship
  with it. Together the framework is ~640 files / 154 MiB, which exceeds the
  original caps (512 files / 8 MiB); the caps are raised in this ADR rather than
  the payload being split out.
- The framework's own dependency set is heavy and **version-incompatible** with
  the bundled Office stack: `paddlepaddle` requires `numpy<2` while the bundled
  tree pins `numpy 2.5.4`. The two cannot share one `site-packages`.

## Decision

Add a second entry kind to the widget manifest, raise the package caps so a
framework package can carry its own driver distribution and firmware images,
and give the framework's libraries their own directory beside the extras.

### Manifest

`widget.json` gains an optional `runtime` field. Its absence means the existing
JavaScript entry, so every package written against API v1 keeps loading
unchanged.

```json
{
  "schemaVersion": 1,
  "apiVersion": 2,
  "id": "comtest-framework",
  "runtime": { "kind": "python", "entry": "main.py", "pythonPath": ["src"] }
}
```

- `apiVersion` becomes a **range check** rather than an equality check: a build
  accepts any version from 1 up to `WIDGET_API_VERSION`, and rejects only what
  it does not know. Raising the constant therefore cannot brick installed
  packages.
- `runtime.kind` is `"javascript"` (the default when the field is absent) or
  `"python"`. An unknown kind is a manifest error reported on the package's row,
  not a silent skip.
- `runtime.entry` for Python must end in `.py` and must resolve inside the
  package directory. `runtime.pythonPath` lists package-relative directories
  appended to `PYTHONPATH`.

### Execution

A Python package runs in its **own child process**, never in the sidecar and
never in the agent runtime's process:

- The sidecar spawns the interpreter resolved by `resolvePythonRuntime()`, the
  same one that serves the Office tools, so a Python package does not introduce
  a second interpreter.
- Actions are dispatched over a line-delimited JSON request/response protocol on
  stdio, one request at a time per package, bounded by the existing
  `WIDGET_INVOKE_TIMEOUT_MS`.
- The child inherits the sandbox floor of the Python side: a pinned
  `PYTHONPATH` (the package's own `pythonPath` first, then the shared bundle),
  `PYTHONNOUSERSITE=1`, and no `PYTHONHOME` when the interpreter is not the
  bundled one — the same rules `pythonEnv` already applies.
- A package that fails to start, crashes, or hangs leaves its own row broken and
  the client working. The runner never reuses a dead child silently; the next
  invoke restarts it once and reports the failure if it fails again.

### What does not change

- Discovery, trust hashing, the enabled set and the widget page stay exactly as
  they are. A Python package is trusted and enabled like any other.
- The per-package caps rise to 4096 files / 256 MiB, which is what lets a package
  carry a driver distribution and firmware images. The cost is trust hashing:
  154 MiB is read on the first scan after a change. `digest_dir` streams each
  file instead of reading it whole, so the hash no longer loads a 31 MiB image
  into memory; the hashed layout is unchanged, so digests already recorded in
  `state.json` still match.
- **Dependencies do not travel inside a widget package.** The framework's stack
  is installed into its own locked directory beside the extras
  (`<app dir>/python-extras/framework-deps/site-packages`) and appended to
  `PYTHONPATH` for the bundled interpreter by default, ahead of the Office stack
  so a framework import resolves against its own locked `numpy`. The bundled
  interpreter is therefore a complete execution environment for the framework,
  without the package locating libraries itself.
- The interpreter remains a platform dependency under `<resources>/python`.
  It is not a widget, is not discoverable, and has no trust state.

## Alternatives

**A JS shell package that spawns Python.** Rejected: it adds a permanent wrapper
layer whose only job is to forward calls, and the manifest would describe a
package in terms of a language it is not written in. The runner already owns
spawning; a wrapper only moves that logic into user-replaceable code.

**A separate Python discovery mechanism alongside widgets.** Rejected: two
discovery paths mean two trust states, two enabled sets and two UI surfaces for
one concept, and the second one would drift.

**Splitting the driver distribution and firmware images out of the package.**
Considered and rejected: `libs.zcan` and `libs.sdb_convert` are importable
modules, so the framework is not complete without them. A package that loads but
cannot import its own subpackage is worse than a large package, and a second
delivery channel for "the rest of the framework" would be a discovery path
needing its own trust state. The caps are raised instead.


**Sharing one `site-packages` between the Office stack and the framework.**
Rejected by the `numpy` constraint above. Separate directories are not a
preference here; they are the only arrangement that can resolve at all.

## Consequences

- Manifest gains an optional field and a widened version check. `WIDGET_API_VERSION`
  moves to 2; v1 packages keep loading because the check is now a range.
- `crates/host-core/src/widgets.rs` must relax `api_version != API_VERSION` into
  a `1..=API_VERSION` range and report the accepted range in its error text.
  Discovery, trust and state are untouched.
- The sidecar gains a Python dispatch path. It must resolve the interpreter
  through the existing resolver rather than assuming one is on `PATH`, and it
  must report `PYTHON_RUNTIME_UNAVAILABLE` through the package's row when none is.
- The framework package ships **source only**. Its dependency set is built into
  its own locked directory; a package that needs binaries the caps cannot hold
  is out of scope for this contract and needs its own design.
- Firmware images and vendor drivers stay outside the package. How the autotest
  work reaches them is a separate decision and is not implied by this ADR.
- A Python action cannot call back into the sidecar's `host` permission during
  the same call: the protocol is request/response. Packages needing that must
  declare it and be handled by a follow-up contract rather than assumed here.
