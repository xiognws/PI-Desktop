#!/usr/bin/env node
/**
 * Assemble the Python runtime this build ships (`apps/desktop/resources/python`).
 *
 * Office and file work is done by Python libraries, and a released client must
 * not depend on whatever interpreter the customer happens to have. This script
 * therefore builds one self-contained tree at build time:
 *
 *   resources/python/runtime/        a full CPython install
 *   resources/python/site-packages/  the pinned Office/data stack
 *   resources/python/MANIFEST.json   sha256 + size of every shipped file
 *   resources/python/requirements.txt  the same pins in pip's own syntax
 *
 * `scripts/python-runtime.lock.json` is the source of truth for versions and
 * hashes. Installation uses `--require-hashes`, so a mirror serving a
 * substituted or truncated wheel fails the build rather than shipping a broken
 * library to every customer.
 *
 * Nothing here runs at application start: the manifest installed in the image
 * is what the client verifies against. See apps/desktop/electron/main/python-runtime.ts.
 *
 * Usage:
 *   node scripts/bundle-python-runtime.mjs                # build + verify
 *   node scripts/bundle-python-runtime.mjs --dry-run      # report the plan
 *   node scripts/bundle-python-runtime.mjs --from <dir>   # reuse downloaded wheels
 *   node scripts/bundle-python-runtime.mjs --python <exe> # interpreter used to install
 *   node scripts/bundle-python-runtime.mjs --keep-staging # leave .python-staging behind
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(REPO, "apps", "desktop", "resources", "python");
const STAGING = join(REPO, ".python-staging");
const LOCK_PATH = join(REPO, "scripts", "python-runtime.lock.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const DRY_RUN = has("dry-run");
const KEEP_STAGING = has("keep-staging");
const FROM = flag("from", "");
const PYTHON = flag("python", "");

const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
if (!lock.python.platform.startsWith(platform)) {
  // Only the platform whose wheels are pinned ships the runtime today. The
  // release workflow keeps this step on the Windows lane alone, but `pack` and
  // `dist` are also run by hand on a developer's own machine, where a hard
  // failure would block an unrelated build. Say what is missing and carry on:
  // the app already answers PYTHON_RUNTIME_UNAVAILABLE when the tree is absent.
  console.warn(
    `skipping: this bundle pins Python for ${lock.python.platform}, and this host is ${platform}. ` +
      "The installer will ship without a Python runtime, so the Office tools will report " +
      "PYTHON_RUNTIME_UNAVAILABLE. Add this platform's wheels to " +
      "scripts/python-runtime.lock.json to bundle it here.",
  );
  process.exit(0);
}

/** A stable relative path inside the bundle, with forward slashes. */
const rel = (base, file) => file.slice(base.length + 1).split("\\").join("/");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
      // A packaged runtime never contains symlinks; if one appears the bundle
      // would not survive zipping, so fail loudly instead of silently skipping.
      else throw new Error(`unexpected non-file in the runtime tree: ${full}`);
    }
  }
  await visit(root);
  return out;
}

function requirementsTxt() {
  return lock.wheels
    .map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`)
    .join("\n") + "\n";
}

/** Where the pinned wheels live: `--from`, or a local pip download cache. */
async function resolveWheelSource() {
  const dirs = [];
  if (FROM) dirs.push(resolve(FROM));
  dirs.push(join(STAGING, "wheels"));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir);
    const missing = lock.wheels.filter((wheel) => !names.includes(wheel.file));
    if (!missing.length) return dir;
  }
  return null;
}

/** Reuse an interpreter the developer already has; the bundle carries its own anyway. */
function resolvePython() {
  if (PYTHON) return PYTHON;
  const candidates = platform === "windows" ? ["python.exe", "python"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ["-c", "import sys;print(sys.version_info[:2])"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (version === `(${lock.python.version.split(".").slice(0, 2).join(", ")})`) return candidate;
    } catch {
      // Not installed, or not the pinned minor: try the next candidate.
    }
  }
  throw new Error(
    `no Python ${lock.python.version.split(".").slice(0, 2).join(".")} on PATH. Pass --python <exe>. ` +
      "The runtime shipped in the image is built separately; this interpreter only installs the wheels.",
  );
}

console.log(`target: ${TARGET}`);
console.log(`python: ${lock.python.version} (${lock.python.platform}) from ${lock.python.source}`);
console.log(`wheels: ${lock.wheels.length}`);

const wheelSource = await resolveWheelSource();
console.log(`wheel source: ${wheelSource ?? "pip download (network)"}`);

if (DRY_RUN) {
  for (const wheel of lock.wheels) {
    console.log(`  ${wheel.name}==${wheel.version}  ${wheel.sha256.slice(0, 12)}…  ${wheel.why}`);
  }
  process.exit(0);
}

let python = PYTHON;
if (!wheelSource) python = resolvePython();

await mkdir(STAGING, { recursive: true });
const wheelsDir = join(STAGING, "wheels");
const siteDir = join(STAGING, "site-packages");
const runtimeDir = join(STAGING, "runtime");

if (wheelSource !== wheelsDir) {
  await mkdir(wheelsDir, { recursive: true });
  for (const wheel of lock.wheels) {
    const source = join(wheelSource, wheel.file);
    const bytes = await readFile(source);
    const digest = sha256(bytes);
    if (digest !== wheel.sha256) {
      throw new Error(`${wheel.file}: sha256 ${digest} does not match the lock. Refusing to bundle it.`);
    }
    await writeFile(join(wheelsDir, wheel.file), bytes);
  }
  console.log(`verified ${lock.wheels.length} wheels against the lock`);
}

if (!wheelSource) {
  const args = [
    "-m",
    "pip",
    "download",
    "--no-deps",
    "--dest",
    wheelsDir,
    "--only-binary=:all:",
    "--require-hashes",
    "-r",
    join(STAGING, "requirements.txt"),
  ];
  await writeFile(join(STAGING, "requirements.txt"), requirementsTxt());
  console.log("downloading the pinned wheels…");
  execFileSync(python, args, { stdio: "inherit" });
}

// Install into an empty directory: `--target` does not uninstall, so a second
// run over the same directory would keep files of a removed dependency.
rmSync(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
await writeFile(join(STAGING, "requirements.txt"), requirementsTxt());
python = python || resolvePython();
console.log("installing the pinned wheels…");
execFileSync(
  python,
  [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--find-links",
    wheelsDir,
    "--target",
    siteDir,
    "--no-compile",
    "--require-hashes",
    "-r",
    join(STAGING, "requirements.txt"),
  ],
  { stdio: "inherit" },
);

// A runtime that cannot import its own libraries is worse than no runtime: the
// client would advertise Office support and fail on the first request.
console.log("smoke-testing the stack…");
execFileSync(
  python,
  ["-c", `import ${lock.smokeImports.join(", ")}; print("imports ok")`],
  { stdio: "inherit", env: { ...process.env, PYTHONPATH: siteDir, PYTHONNOUSERSITE: "1" } },
);

// The interpreter tree comes from the build machine's own CPython install.
// Ask Python for its prefix rather than trimming a path: a virtualenv reports
// `sys.prefix` inside `<base>` while `sys.executable` lives in `<venv>/Scripts`,
// and a packaged runtime's executable can sit anywhere in its own tree.
const runtimeSource = execFileSync(
  python,
  ["-c", "import sys;print(sys.prefix)"],
  { encoding: "utf8" },
).trim();
if (!existsSync(join(runtimeSource, "python.exe")) && !existsSync(join(runtimeSource, "bin", "python3"))) {
  throw new Error(`${runtimeSource} does not look like a CPython prefix; expected python.exe or bin/python3`);
}
if (!existsSync(join(runtimeSource, "Lib"))) {
  throw new Error(`${runtimeSource} has no Lib/ directory; a bundled runtime needs the standard library`);
}
rmSync(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const entry of await readdir(runtimeSource, { withFileTypes: true })) {
  if (entry.name === "Lib" || entry.name === "Scripts" || entry.name === "__pycache__") continue;
  await cp(join(runtimeSource, entry.name), join(runtimeDir, entry.name), entry.isDirectory());
}
await cp(join(runtimeSource, "Lib"), join(runtimeDir, "Lib"), true);
console.log(`runtime: ${runtimeSource}`);

async function cp(from, to, isDirectory) {
  // Callers pass a bare file name one level down, so the parent directory of a
  // fresh target subtree does not exist yet.
  await mkdir(dirname(to), { recursive: true });
  if (!isDirectory) {
    await writeFile(to, await readFile(from));
    return;
  }
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
    await cp(join(from, entry.name), join(to, entry.name), entry.isDirectory());
  }
}

// Assemble the shipped tree, then record what it contains.
rmSync(TARGET, { recursive: true, force: true });
await mkdir(join(TARGET, "site-packages"), { recursive: true });
for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
  await cp(join(runtimeDir, entry.name), join(TARGET, "runtime", entry.name), entry.isDirectory());
}
for (const entry of await readdir(siteDir, { withFileTypes: true })) {
  await cp(join(siteDir, entry.name), join(TARGET, "site-packages", entry.name), entry.isDirectory());
}
await writeFile(join(TARGET, "requirements.txt"), requirementsTxt());

// The worker scripts ship inside the tree they run in, so host-core runs one
// known file next to the interpreter rather than guessing a path in the app
// image. They live under `scripts/python-tools` because this tree is generated
// and never committed.
const toolSource = join(REPO, "scripts", "python-tools");
if (existsSync(toolSource)) {
  for (const entry of await readdir(toolSource, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
    await cp(join(toolSource, entry.name), join(TARGET, "tools", entry.name), false);
  }
} else {
  throw new Error(`${toolSource} is missing: the Office tools cannot ship without their scripts`);
}

const files = await walk(TARGET);
const manifest = {
  schemaVersion: 1,
  python: lock.python.version,
  platform: lock.python.platform,
  builtAt: new Date().toISOString(),
  root: "runtime",
  sitePackages: "site-packages",
  tools: "tools",
  wheels: lock.wheels.map((wheel) => `${wheel.name}==${wheel.version}`),
  files: [],
};
let bytesTotal = 0;
for (const file of files.sort()) {
  const bytes = await readFile(file);
  bytesTotal += bytes.length;
  manifest.files.push({ path: rel(TARGET, file), sha256: sha256(bytes), size: bytes.length });
}
await writeFile(join(TARGET, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

if (!KEEP_STAGING) rmSync(STAGING, { recursive: true, force: true });

console.log(
  `bundled: ${manifest.files.length} files, ${(bytesTotal / 1048576).toFixed(1)} MiB, ` +
    `${lock.wheels.length} wheels, python ${lock.python.version}`,
);
console.log(`manifest: ${join(TARGET, "MANIFEST.json")}`);
