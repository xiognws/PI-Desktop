#!/usr/bin/env node
/**
 * Put the built python-runtime package where the installer expects it.
 *
 * `packages/python-runtime` owns the tree; `apps/desktop/resources/python` is
 * where electron-builder picks it up (`extraResources`). This script is the one
 * hop between them.
 *
 * The hop is skipped when the resource tree already holds the same artifact,
 * judged by the manifest's `inputHash`. That is what stops a release from
 * re-copying 182 MiB of unchanged bytes on every build: the package reuses its
 * own `dist`, and this script reuses the copy.
 *
 * Usage:
 *   node scripts/sync-python-runtime.mjs
 *   node scripts/sync-python-runtime.mjs --force
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(REPO, "packages", "python-runtime", "dist");
const TARGET = join(REPO, "apps", "desktop", "resources", "python");
const MANIFEST = "MANIFEST.json";

const FORCE = process.argv.includes("--force");

if (!existsSync(SOURCE)) {
  // The package skips itself on a host whose platform has no pinned wheels. The
  // app already answers PYTHON_RUNTIME_UNAVAILABLE when the tree is absent, so a
  // missing package is a reason to carry on, not to fail an unrelated build.
  console.warn(
    `no built artifact at ${SOURCE}: the installer will ship without a Python runtime. ` +
      "Run `pnpm --filter @pi-workspace/python-runtime bundle` first.",
  );
  process.exit(0);
}

const sourceManifest = JSON.parse(await readFile(join(SOURCE, MANIFEST), "utf8"));

/*
  A manifest alone is not an artifact. Copying a half-populated `dist` over the
  installed tree is how a build silently ships a runtime with no interpreter in
  it, so the source is checked before anything is touched: the interpreter the
  manifest names has to be present.
*/
const sourceRoot = join(SOURCE, sourceManifest.root ?? "runtime");
const sourceInterpreter =
  process.platform === "win32"
    ? join(sourceRoot, "python.exe")
    : join(sourceRoot, "bin", "python3");
if (!existsSync(sourceInterpreter)) {
  console.error(
    `refusing to stage: ${SOURCE} has a manifest but no interpreter at ` +
      `${relative(SOURCE, sourceInterpreter)}. The installed tree was left untouched.`,
  );
  process.exit(1);
}

if (!FORCE && existsSync(join(TARGET, MANIFEST))) {
  try {
    const targetManifest = JSON.parse(await readFile(join(TARGET, MANIFEST), "utf8"));
    if (targetManifest.inputHash === sourceManifest.inputHash) {
      console.log(
        `python runtime already at ${relative(REPO, TARGET)} ` +
          `(${sourceManifest.name}@${sourceManifest.version}, inputs unchanged)`,
      );
      process.exit(0);
    }
  } catch {
    // An unreadable manifest means the copy is not trustworthy; fall through.
  }
}
/*
  Copy next door, then swap. The swap never deletes the live tree before the new
  one exists: on Windows a running client holds the interpreter open, and the
  earlier "remove then rename" order destroyed the very tree it was replacing
  when the copy failed halfway. The old tree is moved aside instead, and only
  removed once the new one is in place.
*/
const NEXT = `${TARGET}.next`;
const PREVIOUS = `${TARGET}.previous`;
await rm(NEXT, { recursive: true, force: true });
await mkdir(dirname(NEXT), { recursive: true });

async function copy(from, to) {
  const info = await stat(from);
  if (!info.isDirectory()) {
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, await readFile(from));
    return;
  }
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    await copy(join(from, entry.name), join(to, entry.name));
  }
}

await copy(SOURCE, NEXT);

// A partial copy must not cost the installed tree: if the copy above failed,
// this line is never reached and the live directory is untouched.
await rm(PREVIOUS, { recursive: true, force: true });
if (existsSync(TARGET)) await rename(TARGET, PREVIOUS);

try {
  await rename(NEXT, TARGET);
} catch (cause) {
  // Put the previous tree back before reporting: a client that was running
  // against it must not be left with a missing runtime.
  if (existsSync(PREVIOUS)) await rename(PREVIOUS, TARGET);
  throw cause;
}

// Best effort: a client still holding files keeps this directory around, which
// is harmless until the next successful run removes it.
await rm(PREVIOUS, { recursive: true, force: true }).catch(() => {});

console.log(
  `staged ${sourceManifest.name}@${sourceManifest.version} → ${relative(REPO, TARGET)} ` +
    `(${sourceManifest.files.length} files, inputHash ${String(sourceManifest.inputHash).slice(0, 12)}…)`,
);
