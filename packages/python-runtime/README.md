# @pi-workspace/python-runtime

The CPython install and the pinned Office/file wheels this product ships, kept
as one artifact with **its own version number**.

## Why a package and not a build step

The interpreter changes about once a year; the product changes daily. Building
the tree inside every desktop build meant rebuilding 182 MiB / 8 549 files that
were byte-identical to the previous build, and — because the manifest carried a
`builtAt` timestamp — the output was never actually identical either.

This package owns the tree. Its version moves only when the lock does, so a
product build can say "I need python-runtime 3.12.13" the way it says "I need
react 19", and the build reuses the tree already on disk when the version
matches.

## Layout of the produced artifact (`dist/`)

```
dist/runtime/          a full CPython install
dist/site-packages/    the pinned Office/data wheels
dist/tools/            the worker scripts shipped with the interpreter
dist/MANIFEST.json     version, inputHash, and sha256 + size of every file
dist/requirements.txt  the same pins in pip's own syntax
```

## The two identifiers

`version` (in `package.json`) names the product-facing release of this
artifact: `3.12.13` means "CPython 3.12.13 with the wheel set pinned in
`scripts/python-runtime.lock.json`".

`inputHash` (inside `MANIFEST.json`) is the content address: a digest of the
lock file, the package version, the platform, and every overlay source. Two
builds with the same `inputHash` are the same artifact; a build that finds a
`dist/` with a matching `inputHash` does not rebuild.

`builtAt` is deliberately **absent**. A timestamp in the artifact would make
the bytes differ on every build and defeat both the cache and any downstream
content comparison. Use the manifest's `inputHash` to tell artifacts apart.

## Commands

```
pnpm --filter @pi-workspace/python-runtime bundle           # build, or reuse a matching dist/
pnpm --filter @pi-workspace/python-runtime bundle --force   # always rebuild
pnpm --filter @pi-workspace/python-runtime verify           # re-check a dist/ against its manifest
```

`bundle` prints which of the two happened (`reused` / `built`) so a build log
shows whether a release paid the cost.
