# ADR 0382: Ship a pinned Python runtime for Office and file work

- Status: Accepted
- Date: 2026-11-06
- Supersedes: nothing
- Related: [0008](0008-plugin-runtime-isolation-target.md) plugin runtime isolation; `03-runtime/03-tools-and-permissions.md` § 2.3

## Context

The agent could already read and write text, but not open the documents people
actually send each other: `.xlsx`, `.docx`, `.pptx`, `.pdf`. The libraries that
understand those formats — openpyxl, python-docx, python-pptx, pypdf, pandas —
are Python-only, and the built-in skill catalog only carried *instructions* for
using them, fetched from a CDN. Nothing enforced that the customer's machine had
the libraries, the versions, or even an interpreter.

Three constraints came from the product owner and shaped the decision:

1. The interpreter and libraries ship with the installation. Behaviour must not
   depend on what the customer happens to have installed.
2. The plugin host stays separate from the main process. An Office library must
   never load into the host binary or the desktop process.
3. Whatever happens to a document, the app must keep working.

## Decision

**Ship one pinned CPython tree and one pinned wheel set** at
`<resources>/python`, assembled on the build machine by
`scripts/bundle-python-runtime.mjs` from `scripts/python-runtime.lock.json`.
Every wheel is pinned by version and sha256 and installed with
`--require-hashes`, so a mirror serving a substituted or truncated wheel fails
the build instead of shipping a broken library to every customer. A build-time
smoke test imports the stack, and a generated `MANIFEST.json` records the sha256
and size of every shipped file.

**Full CPython, not the embeddable distribution.** The embeddable build has no
`pip` and no `sysconfig`, and a customer installing their own library into the
user layer needs both. The extra size buys that path.

**Three layers, resolved in one place** (`apps/desktop/electron/main/python-runtime.ts`):

```text
<resources>/python/runtime/        the interpreter, read-only
<resources>/python/site-packages/  the pinned libraries, read-only
<data>/python-site/                the customer's own installs, writable, first
```

The user layer comes first on `PYTHONPATH`, so an upgrade survives app updates
and a reinstall never has to reason about the customer's changes.
`PYTHONNOUSERSITE` keeps their per-user `site-packages` out of the path: a
library installed for their own projects must not shadow the pinned one on every
spreadsheet read. Integrity is verified against the manifest off the startup
path, because a quarantined or half-restored file is exactly the failure a
manifest exists to catch.

**The Office work runs in a child process.** `crates/host-core/src/tools/office.rs`
starts `tools/office.py` from the bundle, writes one JSON request to stdin, and
reads one JSON response from stdout. Three properties follow, and each was a
requirement rather than a convenience:

* A malformed document crashes the worker, not the host. The host sees a broken
  response and the session continues.
* No argument becomes command-line syntax: a path with spaces, quotes, or a
  leading dash cannot change what runs.
* Path containment is decided by the existing workspace/scratch resolver *before*
  the child starts; the child receives an already-resolved absolute path and does
  no joining of its own.

## Consequences

* The installer grows by roughly 180 MB uncompressed (61.9 MB interpreter,
  ~117 MB libraries). Compression in the NSIS packaging reduces the download; the
  installed size is what it is.
* `bundle:python` runs on the Windows lane only, and the generated tree is
  gitignored — the lock file is the reviewed artifact. `pack` and `dist` still
  invoke it so a local build matches a release build on the machine that can do
  it.
* The Windows release lane installs a Python 3.12 with `actions/setup-python`
  (`.github/workflows/release.yml`), because the script needs an interpreter to
  run `pip install --target`. The *shipped* interpreter is that prefix, so the
  build is only as reproducible as the machine's CPython — which is why the
  version is pinned in the lock file and checked at bundle time.
* Only `windows-x86_64` is pinned today, so only the Windows installer carries
  the runtime. `dist:mac` and `dist:linux` do not run the step at all, and on any
  other host the script prints what is missing and exits zero rather than failing
  a build that has nothing to do with it. On those installers the Office tools
  answer `PYTHON_RUNTIME_UNAVAILABLE`. Adding a platform means adding its wheels
  to the lock, putting the step back in that dist script, and adding an
  interpreter to that lane.
* `OfficeRead` and `OfficeWrite` are built-in tools, not a plugin. They add no
  process at launch, which keeps this change out of the way of the memory work
  that is reducing plugin host count.
* `.docx` tracked changes, comments, and formula recalculation remain out of
  scope; the tool descriptions say so, so the model does not promise them.

## Alternatives rejected

* **Use the customer's Python.** The failure mode is a mystery
  `ModuleNotFoundError` at the moment a user asks for a document, on a machine
  whose Python state the support team cannot see.
* **Ship an Office plugin.** Correct isolation, but a plugin host costs about
  30 MB per launch for a capability every session may want; that is the cost the
  bundled-plugin work is actively reducing.
* **Implement parsers in Rust.** `.xlsx` and `.pptx` are ZIP containers of XML
  that four libraries already model well; reimplementing them is a permanent
  maintenance tax for no user-visible gain.
