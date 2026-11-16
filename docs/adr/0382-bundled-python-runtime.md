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

**The bundled wheel set stays small; the engineering stack ships beside the image.**
The Office and file libraries (`pandas`, `openpyxl`, `python-docx`, `python-pptx`,
`pypdf`, `xlsxwriter`) are the reason the runtime exists, so they live inside
`<resources>/python` where the built-in tools need them.

A desktop agent that runs Python at all is also asked for the ordinary
engineering stack — HTTP, SSH and serial, `python-can`/`isotp`/`udsoncan`/`pyxcp`,
`scipy`/`scikit-learn`/`matplotlib`, PDF and Markdown parsing, `boto3`,
`pywin32` — but that is roughly 400 MB unpacked, and putting it in every
installer taxes the users who never touch Python. It is therefore assembled by
`scripts/bundle-python-extras.mjs` into `<app dir>/python-extras/site-packages`,
**after** electron-builder has produced the installers, and is put on
`PYTHONPATH` only when the folder exists. The installer and the portable build
stay small; the unpacked/portable **folder** carries everything, and a customer
who only needs Office can delete `python-extras` without breaking anything.

The extras are added only for the bundled interpreter: they are 3.12 wheels, and
offering them to a customer's own 3.11 would turn a working import into a crash.

The extras set is a mirror of the customer's own working environment (406
distributions on `C:\Python3119`), so it is installed with `--no-deps`: pip's
resolver refuses the set as a whole because several packages want an older numpy
than the Office stack ships, while every one of them works with the pinned one.
What replaces the resolver is stronger than it: every wheel's metadata is scanned
for requirements that this set does not satisfy, packages whose dependency is
deliberately excluded (torch, onnxruntime, pyarrow and their dependents) are
dropped rather than shipped broken, and the assembled tree is verified by
importing all ~390 top-level modules with the packaged interpreter.

**Locally maintained code ships through an overlay.** Some libraries are not on
any index: the ZLG (周立功) USBCAN backend is a patched `python-can` interface
that the customer maintains. `python-runtime.lock.json` therefore carries
`overlays` — `copy` for a directory or file from
`apps/desktop/python-patches/`, `patch` for exact-text registration inside an
installed file — each tagged with the `scope` (`bundle` or `extras`) that should
receive it. Both are applied after `pip install` and both fail the build rather
than shipping a library that imports without its backend. The overlay source is
tracked; the generated trees stay disposable.

The two trees are installed independently, so a package both of them need
(`typing-extensions`, `numpy`, `pillow`, `python-dateutil`, `tzdata`) is listed
in both wheel sets, and where their dependency constraints differ each tree keeps
the version that satisfies its own set.

**Four layers, resolved in one place** (`apps/desktop/electron/main/python-runtime.ts`):

```text
<data>/python-site/                      the customer's own installs, writable, first
<app dir>/python-extras/site-packages/   the optional engineering stack, if present
<resources>/python/site-packages/        the pinned Office libraries, read-only
<resources>/python/runtime/              the interpreter, read-only
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
