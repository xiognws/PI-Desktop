#!/usr/bin/env node
/**
 * Build the CPython tree this product ships into `packages/python-runtime/dist`.
 *
 * The tree is a **package artifact**, not a build side effect: it has its own
 * version, and a desktop build asks for that version instead of re-creating the
 * same 182 MiB of bytes every time. Two identifiers make that possible:
 *
 *   version     the product-facing release (`package.json`), e.g. 3.12.13
 *   inputHash   the content address: lock + version + platform + overlay sources
 *
 * When `dist/MANIFEST.json` already carries the same `inputHash`, the build is
 * skipped and the existing tree is reused. That is the whole point: the
 * interpreter changes about once a year, the product changes daily.
 *
 * There is deliberately **no `builtAt`** in the manifest. A timestamp would make
 * two builds of identical inputs differ byte-for-byte, which defeats the reuse
 * here and any content comparison downstream.
 *
 * Usage:
 *   node scripts/bundle.mjs                # build, or reuse a matching dist/
 *   node scripts/bundle.mjs --force        # rebuild even if the hash matches
 *   node scripts/bundle.mjs --dry-run      # print the plan and the hash
 *   node scripts/bundle.mjs --from <dir>   # reuse downloaded wheels
 *   node scripts/bundle.mjs --python <exe> # interpreter used to install
 *   node scripts/bundle.mjs --keep-staging # leave .staging behind
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const DIST = join(PKG, "dist");
const STAGING = join(PKG, ".staging");
// The lock lives at the repo root: the same file also drives the extras and the
// autotest framework, and one lock per concern beats one lock per package.
const LOCK_PATH = join(REPO, "scripts", "python-runtime.lock.json");
const PATCHES_ROOT = join(REPO, "apps", "desktop", "python-patches");
const TOOLS_SOURCE = join(REPO, "scripts", "python-tools");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const FORCE = has("force");
const DRY_RUN = has("dry-run");
const KEEP_STAGING = has("keep-staging");
const FROM = flag("from", "");
const PYTHON = flag("python", "");
const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
const lockText = await readFile(LOCK_PATH, "utf8");
const lock = JSON.parse(lockText);

const platform =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

if (!lock.python.platform.startsWith(platform)) {
  // Only the platform whose wheels are pinned ships this artifact. A developer
  // on another host gets a clear line instead of a half-built tree; the app
  // already answers PYTHON_RUNTIME_UNAVAILABLE when the artifact is absent.
  console.warn(
    `skipping: this package pins Python for ${lock.python.platform}, and this host is ${platform}. ` +
      "Add this platform's wheels to scripts/python-runtime.lock.json to build it here.",
  );
  process.exit(0);
}

const rel = (base, file) => relative(base, file).split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Content address of everything that decides the bytes of this artifact.
 *
 * The lock digest is taken over the raw file text, not over a re-serialised
 * object: a whitespace-only edit that a human made on purpose must still count
 * as a different input, and a key-order change must not silently look the same.
 */
async function computeInputHash() {
  const sources = [lockText, pkg.version, platform];
  const overlays = (lock.overlays ?? []).filter((o) => (o.scope ?? "bundle") === "bundle");
  for (const overlay of overlays) {
    sources.push(JSON.stringify(overlay));
    if (overlay.type === "patch") continue;
    const source = join(PATCHES_ROOT, overlay.from);
    if (!existsSync(source)) {
      throw new Error(`overlay source missing: ${source}`);
    }
    const info = await stat(source);
    if (info.isDirectory()) {
      for (const file of await walk(source)) {
        // Path plus bytes: a renamed overlay member is a different input.
        sources.push(`${rel(PATCHES_ROOT, file)}:${sha256(await readFile(file))}`);
      }
    } else {
      sources.push(`${rel(PATCHES_ROOT, source)}:${sha256(await readFile(source))}`);
    }
  }
  // The worker scripts ship inside the tree, so an edit to one changes it.
  if (existsSync(TOOLS_SOURCE)) {
    for (const file of await walk(TOOLS_SOURCE)) {
      if (!file.endsWith(".py")) continue;
      sources.push(`tools/${rel(TOOLS_SOURCE, file)}:${sha256(await readFile(file))}`);
    }
  }
  return createHash("sha256").update(sources.join("\n")).digest("hex");
}

async function walk(root) {
  const out = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
      // A packaged runtime never contains symlinks; if one appears the artifact
      // would not survive zipping, so fail loudly instead of skipping it.
      else throw new Error(`unexpected non-file in the runtime tree: ${full}`);
    }
  }
  if (existsSync(root)) await visit(root);
  return out;
}

async function cp(from, to, isDirectory) {
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

function requirementsTxt() {
  return (
    lock.wheels
      .map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`)
      .join("\n") + "\n"
  );
}

async function resolveWheelSource(wheelsDir) {
  const dirs = [];
  if (FROM) dirs.push(resolve(FROM));
  dirs.push(wheelsDir);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = await readdir(dir);
    const missing = lock.wheels.filter((wheel) => !names.includes(wheel.file));
    if (!missing.length) return dir;
  }
  return null;
}

/**
 * The interpreter used to install the wheels.
 *
 * It has to be the minor version the lock pins: the wheels include binary ones
 * (`lxml`, `pillow`) whose ABI belongs to that minor, so another interpreter
 * cannot install them. `--python` wins; then the PATH; then the copies this
 * repository already has on disk — a previous release artifact ships one, and
 * the packaging step should not depend on the build host having 3.12 installed.
 *
 * Returns `null` when none is found: the caller skips the Python bundle and the
 * rest of the release still builds. A shipped package without the interpreter is
 * a degraded package, but a release that cannot be produced at all is worse.
 */
function resolvePython() {
  if (PYTHON) return PYTHON;
  const wanted = lock.python.version.split(".").slice(0, 2).join(".");
  const probe = (exe) => {
    try {
      const version = execFileSync(
        exe,
        ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return version === wanted ? exe : null;
    } catch {
      return null;
    }
  };

  const onPath = platform === "windows" ? ["python.exe", "python"] : ["python3", "python"];
  for (const candidate of onPath) {
    const found = probe(candidate);
    if (found) return found;
  }

  // Copies already on disk. A previous release artifact is the interesting one:
  // it is the same interpreter this product ships, so the wheels match it by
  // construction.
  const onDisk = [];
  for (const relative of [
    "apps/desktop/release/win-unpacked/resources/python/runtime/python.exe",
    "apps/desktop/resources/python/runtime/python.exe",
    "packages/python-runtime/dist/runtime/python.exe",
    "apps/desktop/release/win-unpacked/resources/python/runtime/bin/python3",
  ]) {
    onDisk.push(join(REPO, relative));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (let minor = 10; minor <= 14; minor += 1) {
      onDisk.push(join(localAppData, "Programs", "Python", `Python3${minor}`, "python.exe"));
    }
  }
  for (let minor = 10; minor <= 14; minor += 1) {
    onDisk.push(`C:/Python3${minor}/python.exe`, `/usr/bin/python3.${minor}`);
  }
  for (const candidate of onDisk) {
    if (!existsSync(candidate)) continue;
    const found = probe(candidate);
    if (found) return found;
  }

  return null;
}

/** Said once, when the Python bundle cannot be produced on this host. */
function pythonSkipNotice() {
  const wanted = lock.python.version.split(".").slice(0, 2).join(".");
  return (
    `skipping the Python runtime: no Python ${wanted} found (PATH, a previous release ` +
    "artifact, or a local install). Pass --python <exe> to name one. The desktop release " +
    "still builds; the tools that need the bundled interpreter will report it as unavailable."
  );
}


async function applyOverlays(sitePackages) {
  const overlays = (lock.overlays ?? []).filter((o) => (o.scope ?? "bundle") === "bundle");
  for (const overlay of overlays) {
    if (!overlay.to) throw new Error(`overlay without a destination: ${JSON.stringify(overlay)}`);
    if (overlay.type === "patch") {
      const file = join(sitePackages, overlay.file ?? overlay.to);
      if (!existsSync(file)) throw new Error(`overlay target missing: ${file}`);
      let text = await readFile(file, "utf8");
      for (const edit of overlay.replace ?? []) {
        if (text.includes(edit.with)) continue; // already applied
        if (!text.includes(edit.find)) {
          throw new Error(`${overlay.file}: anchor not found, so ${overlay.why ?? "the overlay"} cannot be applied`);
        }
        text = text.replace(edit.find, edit.with);
      }
      await writeFile(file, text);
      console.log(`  patched ${overlay.file} (${overlay.why ?? "local overlay"})`);
      continue;
    }
    const source = join(PATCHES_ROOT, overlay.from);
    if (!existsSync(source)) throw new Error(`overlay source missing: ${source}`);
    const destination = join(sitePackages, overlay.to);
    await cp(source, destination, (await stat(source)).isDirectory());
    console.log(`  copied ${overlay.from} -> ${overlay.to} (${overlay.why ?? "local overlay"})`);
  }
}

const inputHash = await computeInputHash();
const manifestPath = join(DIST, "MANIFEST.json");

if (DRY_RUN) {
  console.log(`package:  ${pkg.name}@${pkg.version}`);
  console.log(`python:   ${lock.python.version} (${lock.python.platform})`);
  console.log(`wheels:   ${lock.wheels.length}`);
  console.log(`platform: ${platform}`);
  console.log(`inputHash:${inputHash}`);
  process.exit(0);
}

// Reuse: the artifact on disk already describes exactly these inputs.
if (!FORCE && existsSync(manifestPath)) {
  try {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (existing.inputHash === inputHash && existing.version === pkg.version) {
      console.log(
        `reused ${pkg.name}@${pkg.version} from dist (${existing.files.length} files) — inputs unchanged`,
      );
      process.exit(0);
    }
    console.log(
      `rebuilding: dist holds ${existing.version ?? "?"}/${String(existing.inputHash).slice(0, 12)}…, ` +
        `inputs are ${pkg.version}/${inputHash.slice(0, 12)}…`,
    );
  } catch {
    console.log("rebuilding: the existing manifest is unreadable");
  }
} else if (FORCE) {
  console.log("rebuilding: --force");
}

await mkdir(STAGING, { recursive: true });
const wheelsDir = join(STAGING, "wheels");
const siteDir = join(STAGING, "site-packages");
const runtimeDir = join(STAGING, "runtime");
await writeFile(join(STAGING, "requirements.txt"), requirementsTxt());

let python = PYTHON;
const wheelSource = await resolveWheelSource(wheelsDir);
console.log(`wheel source: ${wheelSource ?? "pip download (network)"}`);

if (wheelSource && wheelSource !== wheelsDir) {
  await mkdir(wheelsDir, { recursive: true });
  for (const wheel of lock.wheels) {
    const bytes = await readFile(join(wheelSource, wheel.file));
    const digest = sha256(bytes);
    if (digest !== wheel.sha256) {
      throw new Error(`${wheel.file}: sha256 ${digest} does not match the lock. Refusing to ship it.`);
    }
    await writeFile(join(wheelsDir, wheel.file), bytes);
  }
  console.log(`verified ${lock.wheels.length} wheels against the lock`);
}

if (!wheelSource) {
  if (!python) python = resolvePython();
  if (!python) {
    console.log(pythonSkipNotice());
    process.exit(0);
  }
  console.log("downloading the pinned wheels…");
  execFileSync(
    python,
    [
      "-m", "pip", "download", "--no-deps", "--dest", wheelsDir,
      "--only-binary=:all:", "--require-hashes",
      "-r", join(STAGING, "requirements.txt"),
    ],
    { stdio: "inherit" },
  );
}

// Install into an empty directory: `--target` does not uninstall, so a second
// run over the same directory would keep files of a removed dependency.
await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
if (!python) python = resolvePython();
if (!python) {
  console.log(pythonSkipNotice());
  process.exit(0);
}
console.log("installing the pinned wheels…");
execFileSync(
  python,
  [
    "-m", "pip", "install", "--no-index", "--find-links", wheelsDir,
    "--target", siteDir, "--no-compile", "--require-hashes",
    "-r", join(STAGING, "requirements.txt"),
  ],
  { stdio: "inherit" },
);

// A runtime that cannot import its own libraries is worse than no runtime: the
// client would advertise Office support and fail on the first request.
console.log("applying local overlays…");
await applyOverlays(siteDir);

console.log("smoke-testing the stack…");
execFileSync(
  python,
  ["-c", `import ${lock.smokeImports.join(", ")}; print("imports ok")`],
  { stdio: "inherit", env: { ...process.env, PYTHONPATH: siteDir, PYTHONNOUSERSITE: "1" } },
);

// The interpreter tree comes from the build machine's own CPython install. Ask
// Python for its prefix rather than trimming a path: a virtualenv reports
// `sys.prefix` inside `<base>` while `sys.executable` lives in `<venv>/Scripts`.
const runtimeSource = execFileSync(python, ["-c", "import sys;print(sys.prefix)"], {
  encoding: "utf8",
}).trim();
if (
  !existsSync(join(runtimeSource, "python.exe")) &&
  !existsSync(join(runtimeSource, "bin", "python3"))
) {
  throw new Error(`${runtimeSource} does not look like a CPython prefix; expected python.exe or bin/python3`);
}
if (!existsSync(join(runtimeSource, "Lib"))) {
  throw new Error(`${runtimeSource} has no Lib/ directory; a shipped runtime needs the standard library`);
}

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(runtimeDir, { recursive: true });
for (const entry of await readdir(runtimeSource, { withFileTypes: true })) {
  if (entry.name === "Lib" || entry.name === "Scripts" || entry.name === "__pycache__") continue;
  await cp(join(runtimeSource, entry.name), join(runtimeDir, entry.name), entry.isDirectory());
}
await cp(join(runtimeSource, "Lib"), join(runtimeDir, "Lib"), true);
console.log(`runtime: ${runtimeSource}`);

// Assemble the artifact: build into a sibling directory first, so an interrupted
// build never leaves a half-replaced `dist` that the next one would call valid.
const NEXT = `${DIST}.next`;
await rm(NEXT, { recursive: true, force: true });
await mkdir(join(NEXT, "site-packages"), { recursive: true });
for (const entry of await readdir(runtimeDir, { withFileTypes: true })) {
  await cp(join(runtimeDir, entry.name), join(NEXT, "runtime", entry.name), entry.isDirectory());
}
for (const entry of await readdir(siteDir, { withFileTypes: true })) {
  await cp(join(siteDir, entry.name), join(NEXT, "site-packages", entry.name), entry.isDirectory());
}
await writeFile(join(NEXT, "requirements.txt"), requirementsTxt());

// The worker scripts ship inside the tree they run in, so host-core runs one
// known file next to the interpreter instead of guessing a path in the image.
if (!existsSync(TOOLS_SOURCE)) {
  throw new Error(`${TOOLS_SOURCE} is missing: the Office tools cannot ship without their scripts`);
}
for (const entry of await readdir(TOOLS_SOURCE, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
  await cp(join(TOOLS_SOURCE, entry.name), join(NEXT, "tools", entry.name), false);
}

const files = await walk(NEXT);
const manifest = {
  schemaVersion: 2,
  name: pkg.name,
  version: pkg.version,
  inputHash,
  python: lock.python.version,
  platform: lock.python.platform,
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
  manifest.files.push({ path: rel(NEXT, file), sha256: sha256(bytes), size: bytes.length });
}
await writeFile(join(NEXT, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

// Replace the old artifact only once the new one is complete.
await rm(DIST, { recursive: true, force: true });
await rename(NEXT, DIST);

if (!KEEP_STAGING) await rm(STAGING, { recursive: true, force: true });

console.log(
  `built ${pkg.name}@${pkg.version}: ${manifest.files.length} files, ` +
    `${(bytesTotal / 1048576).toFixed(1)} MiB, ${lock.wheels.length} wheels, python ${lock.python.version}`,
);
console.log(`manifest: ${join(DIST, "MANIFEST.json")}`);
console.log(`inputHash: ${inputHash}`);
