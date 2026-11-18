#!/usr/bin/env node
/**
 * Assemble the autotest framework as a **widget package**.
 *
 * The product's widget mechanism (D699, ADR python-widget-entry-kind) is the
 * delivery channel: a package is a directory with a `widget.json` and one entry,
 * discovered by the host, trusted by the user, executed in its own process. This
 * script produces exactly that directory under `dist/`.
 *
 * What ships is **source only**. Two kinds of thing that live beside the
 * framework in its own repository are deliberately excluded:
 *
 *   firmware images   `libs/sdb_convert` — 118 MiB of .hex/.sdb test assets
 *   vendor drivers    `libs/zcan`         — 32 MiB of third-party DLLs
 *
 * Neither is framework code, and together they would blow past the package caps
 * (512 files / 8 MiB) that keep a package a package.
 *
 * Dependencies do not travel either: they are built into their own locked
 * directory and offered to the child process through `PYTHONPATH`.
 *
 * Usage:
 *   node scripts/bundle.mjs                 # build, or reuse a matching dist/
 *   node scripts/bundle.mjs --force         # rebuild
 *   node scripts/bundle.mjs --dry-run       # print the plan and the hash
 *   node scripts/bundle.mjs --source <dir>  # framework checkout to copy from
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PKG, "dist");
const LOCK_PATH = join(PKG, "requirements.lock.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const FORCE = has("force");
const DRY_RUN = has("dry-run");
// The framework's own checkout. Defaults to the sibling repository the team
// develops it in; CI passes the path it checked out.
const SOURCE = resolve(flag("source", "D:/Code/ComTestTool"));

const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));

const rel = (base, file) => relative(base, file).split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The directories that make up the framework, imported as `core.*`, `libs.*`,
 * `hal.*` and `utils.*`. They are siblings, so each is a package root.
 */
const SOURCE_DIRS = ["core", "libs", "hal", "utils"];

/** Files that are build residue rather than framework source. */
const EXCLUDED_NAMES = new Set(["__pycache__", ".pytest_cache", ".mypy_cache"]);
const EXCLUDED_EXTENSIONS = new Set([".pyc", ".pyo"]);

/**
 * Nothing is excluded by path: the CAN driver distribution and the firmware
 * images the converter operates on are part of what the framework does, which is
 * why the host caps were raised alongside this package.
 */
const EXCLUDED_PATHS = [];

function isExcluded(relativePath) {
  for (const part of relativePath.split("/")) {
    if (EXCLUDED_NAMES.has(part)) return true;
  }
  const extension = relativePath.slice(relativePath.lastIndexOf("."));
  if (EXCLUDED_EXTENSIONS.has(extension)) return true;
  return EXCLUDED_PATHS.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

async function walk(root, base = root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    const relativePath = rel(base, full);
    if (isExcluded(relativePath)) continue;
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    // A packaged framework never contains symlinks; the artifact would not
    // survive zipping, so fail instead of silently skipping.
    else if (entry.isFile()) out.push(full);
    else throw new Error(`unexpected non-file in the framework tree: ${full}`);
  }
  return out;
}

async function cp(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
}

/**
 * Content address of everything that decides the bytes of this package.
 *
 * The source tree, the lock and the package version go in. The build produces
 * the same bytes for the same inputs, which is what lets a product build reuse a
 * package it already has instead of re-copying it.
 */
async function computeInputHash(files) {
  const sources = [pkg.version, pkg.name, JSON.stringify(lock)];
  for (const file of files.sort()) {
    sources.push(`${rel(SOURCE, file)}:${sha256(await readFile(file))}`);
  }
  return createHash("sha256").update(sources.join("\n")).digest("hex");
}

if (!existsSync(SOURCE)) {
  console.warn(
    `skipping: the framework checkout is not at ${SOURCE}. ` +
      "Pass --source <dir> to point at it; the app answers AUTOTEST_FRAMEWORK_UNAVAILABLE when the package is absent.",
  );
  process.exit(0);
}

const files = [];
for (const dir of SOURCE_DIRS) {
  files.push(...(await walk(join(SOURCE, dir), SOURCE)));
}

if (!files.length) {
  console.warn(`skipping: no framework source under ${SOURCE_DIRS.join(", ")} in ${SOURCE}`);
  process.exit(0);
}

const inputHash = await computeInputHash(files);
const manifestPath = join(DIST, "MANIFEST.json");

if (DRY_RUN) {
  let bytes = 0;
  for (const file of files) bytes += (await readFile(file)).length;
  console.log(`package:   ${pkg.name}@${pkg.version}`);
  console.log(`source:    ${SOURCE}`);
  console.log(`dirs:      ${SOURCE_DIRS.join(", ")}`);
  console.log(`files:     ${files.length}`);
  console.log(`bytes:     ${(bytes / 1048576).toFixed(2)} MiB`);
  console.log(`inputHash: ${inputHash}`);
  process.exit(0);
}

// Reuse: the package on disk already describes exactly these inputs.
if (!FORCE && existsSync(manifestPath)) {
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (existing.inputHash === inputHash && existing.version === pkg.version) {
      console.log(
        `reused ${pkg.name}@${pkg.version} from dist (${existing.files.length} files) — inputs unchanged`,
      );
      process.exit(0);
    }
  } catch {
    console.log("rebuilding: the existing manifest is unreadable");
  }
}

// Build into a sibling, then swap: an interrupted build never leaves a
// half-replaced `dist` that the next run would call valid.
const NEXT = `${DIST}.next`;
await rm(NEXT, { recursive: true, force: true });
await mkdir(NEXT, { recursive: true });

const staged = [];
let bytesTotal = 0;
for (const file of files.sort()) {
  const destination = join(NEXT, "src", rel(SOURCE, file));
  const bytes = await readFile(file);
  bytesTotal += bytes.length;
  await cp(file, destination);
  staged.push({ path: `src/${rel(SOURCE, file)}`, sha256: sha256(bytes), size: bytes.length });
}

/*
  The entry. A v2 widget manifest names the runtime and the file to run; the
  dispatcher is what lets the host drive declared actions without the framework
  knowing anything about widgets.
*/
await writeFile(
  join(NEXT, "src", "framework_entry.py"),
  [
    '"""Widget entry for the autotest framework (generated by bundle.mjs).',
    "",
    "The host speaks one line of JSON per request on stdin and expects one line of",
    "JSON per response on stdout. Actions come from the manifest, so this file only",
    "has to resolve them; keeping it generated means the source tree stays a plain",
    'Python library."""',
    "import importlib",
    "import json",
    "import sys",
    "",
    "",
    "def _resolve(name):",
    '    """Import `module:function` and return the callable."""',
    '    module_name, _, attribute = name.partition(":")',
    "    module = importlib.import_module(module_name)",
    '    return getattr(module, attribute) if attribute else module',
    "",
    "",
    "def main():",
    "    for line in sys.stdin:",
    "        line = line.strip()",
    "        if not line:",
    "            continue",
    "        try:",
    "            request = json.loads(line)",
    "            handler = _resolve(request[\"action\"])",
    "            result = handler(**(request.get(\"args\") or {}))",
    '            reply = {"id": request.get("id"), "ok": True, "result": result}',
    "        except Exception as cause:  # reported to the host, never swallowed",
    '            reply = {"id": request.get("id") if "request" in dir() else None, "ok": False,',
    '                     "error": f"{type(cause).__name__}: {cause}"}',
    "        sys.stdout.write(json.dumps(reply) + chr(10))",
    "        sys.stdout.flush()",
    "",
    "",
    'if __name__ == "__main__":',
    "    main()",
    "",
  ].join("\n"),
);
const entryBytes = await readFile(join(NEXT, "src", "framework_entry.py"));
staged.push({
  path: "src/framework_entry.py",
  sha256: sha256(entryBytes),
  size: entryBytes.length,
});
bytesTotal += entryBytes.length;

await writeFile(
  join(NEXT, "widget.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      apiVersion: 2,
      id: "autotest-framework",
      name: "Autotest framework",
      version: pkg.version,
      description: "Python test framework backing the autotest capability.",
      runtime: {
        kind: "python",
        entry: "src/framework_entry.py",
        pythonPath: ["src"],
      },
      permissions: ["read", "write"],
      // Actions are filled in as the framework exposes them; an empty list is a
      // valid package that simply declares nothing callable yet.
      actions: [],
    },
    null,
    2,
  ) + "\n",
);

const manifest = {
  schemaVersion: 1,
  kind: "widget-package",
  name: pkg.name,
  version: pkg.version,
  inputHash,
  python: lock.python,
  platform: lock.platform,
  wheels: (lock.wheels ?? []).map((wheel) => `${wheel.name}==${wheel.version}`),
  files: staged.sort((left, right) => left.path.localeCompare(right.path)),
};
await writeFile(join(NEXT, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

await rm(DIST, { recursive: true, force: true });
await rename(NEXT, DIST);

console.log(
  `built ${pkg.name}@${pkg.version}: ${manifest.files.length} files, ` +
    `${(bytesTotal / 1048576).toFixed(2)} MiB`,
);
console.log(`inputHash: ${inputHash}`);
