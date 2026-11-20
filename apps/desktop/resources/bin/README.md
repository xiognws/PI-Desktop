# Bundled binaries

Files here are copied into the application image as `<resources>/bin`, next to
`pi-desktop-host-core`. They are executables the host itself spawns, not tool
packages — a tool package belongs in `resources/tools` and needs a `tool.json`.

## `rg` (ripgrep)

The Grep tool searches with this binary and only with this binary. It used to
exec whatever `rg` sat on the user's `PATH` and fall back to a slower
in-process searcher when there was none, which meant the same query returned
different results (and different ordering) per machine. The binary now travels
with the image, and when it is missing Grep fails with `RG_NOT_FOUND` instead
of silently switching backends.

It is **not** committed. Assemble it before packaging:

```bash
node scripts/bundle-ripgrep.mjs --from <path-to-a-ripgrep-install>   # offline
node scripts/bundle-ripgrep.mjs                                     # download + verify
```

* Version and sha256 pin: `scripts/ripgrep.lock.json`.
* `predev`, `pack`, and `dist` run the script, so a normal build needs no
  manual step once the cache (or `RIPGREP_SOURCE`) is populated.
* Only `windows-x86_64` is pinned today, because that is the platform this
  client ships. On other platforms the script reports the gap and host-core
  keeps resolving `rg` from `PATH` for development builds.
* License files (`LICENSE-MIT`, `UNLICENSE`) are copied next to the binary by
  the same script; ripgrep is MIT OR Unlicense.
