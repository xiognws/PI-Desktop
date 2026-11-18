#!/usr/bin/env node
/**
 * Install the framework's Python libraries into the directory the app reads.
 *
 * The framework package itself carries source, its vendor CAN driver distribution
 * and its firmware images — never wheels. Its libraries go here:
 *
 *   <app dir>/python-extras/framework-deps/site-packages
 *
 * which `python-runtime.ts` appends to `PYTHONPATH` for the bundled interpreter
 * by default. One directory of its own, because this stack needs `numpy<2` while
 * the bundled Office stack pins `numpy 2.5.4`.
 *
 * Usage:
 *   node scripts/install-deps.mjs                      # into the default target
 *   node scripts/install-deps.mjs --out <dir>
 *   node scripts/install-deps.mjs --python <exe>
 *   node scripts/install-deps.mjs --dry-run
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PKG, "..", "..");
const LOCK_PATH = join(PKG, "requirements.lock.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

// The one directory the bundled interpreter reads. The framework adds only the
// packages the engineering stack does not already provide; it never replaces a
// working install.
const SITE = resolve(
  flag("out", join(REPO, "apps", "desktop", "release", "win-unpacked", "python-extras", "site-packages")),
);
const OUT = SITE;
const PYTHON = flag("python", "");
const DRY_RUN = has("dry-run");

const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
const wheels = lock.wheels ?? [];

if (!wheels.length) {
  // Not a failure: the framework source is still deliverable. Say exactly what is
  // missing so a build log does not look like success it cannot back up.
  console.warn(
    "no wheels pinned in packages/autotest-framework/requirements.lock.json: " +
      "the framework package ships, but its imports will fail until `wheels` is populated.",
  );
  process.exit(0);
}

const platform =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
if (!String(lock.platform ?? "").startsWith(platform)) {
  console.log(`framework deps are pinned for ${lock.platform}; nothing to install on ${platform}`);
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`target: ${OUT}`);
  console.log(`python: ${lock.python}`);
  console.log(`wheels: ${wheels.length}`);
  for (const wheel of wheels) console.log(`  ${wheel.name}==${wheel.version}`);
  process.exit(0);
}

function resolvePython() {
  if (PYTHON) return PYTHON;
  const wanted = String(lock.python);
  for (const candidate of platform === "windows" ? ["python.exe", "python"] : ["python3", "python"]) {
    try {
      const version = execFileSync(
        candidate,
        ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (version === wanted) return candidate;
    } catch {
      // Not installed, or not the pinned minor: try the next candidate.
    }
  }
  throw new Error(`no Python ${wanted} on PATH. Pass --python <exe>.`);
}

// Never remove SITE: it holds the engineering stack. Wheels are staged
// elsewhere and thrown away; the install targets the existing directory.
const siteDir = SITE;
const wheelsDir = join(REPO, ".autotest-framework-wheels");
await rm(wheelsDir, { recursive: true, force: true });
await mkdir(wheelsDir, { recursive: true });

/*
  Extras first, framework only for what is missing.

  `python-extras/site-packages` is the one directory the bundled interpreter
  reads, and the engineering stack already fills it. Where a package is already
  there, that copy wins — including the 15 that differ from this lock, such as
  `numpy 2.5.4` there against `2.4.6` in the lock. Installing the lock wholesale
  would silently downgrade the stack other tools rely on, so only names extras
  does not provide are installed.
*/
function normalise(name) {
  return name.toLowerCase().replace(/[-.]/g, "_");
}

const PRESENT = new Set(
  readdirSync(SITE)
    .filter((name) => name.endsWith(".dist-info"))
    .map((name) => normalise(name.slice(0, name.indexOf(".dist-info")).replace(/-[^-]*$/, ""))),
);

const missing = wheels.filter((wheel) => !PRESENT.has(normalise(wheel.name)));
const kept = wheels.length - missing.length;

if (!missing.length) {
  console.log(`framework deps: all ${wheels.length} packages already provided by python-extras`);
  process.exit(0);
}

console.log(
  `framework deps: ${missing.length} package(s) to add, ${kept} already provided by python-extras`,
);

const requirements =
  missing
    .map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`)
    .join("\n") + "\n";
await writeFile(join(OUT, "requirements.txt"), requirements);

/*
  `--only-binary=:all:` cannot express "this one package is an sdist". When the
  lock marks any entry that way the download step drops the flag and relies on
  `--require-hashes` instead, which still refuses anything whose bytes differ
  from the pin. Building the sdist needs setuptools, so the bundled interpreter
  contributes its own via `--find-links` on a staged copy.
*/
const needsSdist = wheels.some((wheel) => wheel.sdist);

const python = resolvePython();
console.log("downloading the pinned framework wheels…");
execFileSync(
  python,
  [
    "-m", "pip", "download", "--no-deps", "--dest", wheelsDir,
    ...(needsSdist ? [] : ["--only-binary=:all:"]),
    "--require-hashes",
    "-r", join(OUT, "requirements.txt"),
  ],
  { stdio: "inherit" },
);

for (const wheel of wheels) {
  if (!wheel.file) continue;
  const file = join(wheelsDir, wheel.file);
  if (!existsSync(file)) continue;
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  if (digest !== wheel.sha256) {
    throw new Error(`${wheel.file}: sha256 ${digest} does not match the lock`);
  }
}

console.log("installing the missing packages into python-extras…");
execFileSync(
  python,
  [
    "-m", "pip", "install", "--no-index", "--find-links", wheelsDir,
    // Dependencies are already satisfied by the engineering stack in this same
    // directory, and `--no-index` cannot resolve anything outside the staged
    // wheels. Installing only the named packages keeps the existing install
    // untouched and avoids a resolver failure over a dependency that is present.
    "--no-deps",
    "--target", siteDir, "--no-compile", "--require-hashes",
    "-r", join(OUT, "requirements.txt"),
  ],
  { stdio: "inherit" },
);

// The wheels are an install detail, not part of what the app reads.
await rm(wheelsDir, { recursive: true, force: true });

const files = await readdir(siteDir);
let bytes = 0;
async function size(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await size(full);
    else if (entry.isFile()) bytes += (await stat(full)).size;
  }
}
await size(siteDir);

console.log(
  `installed ${wheels.length} wheels into ${siteDir} (${files.length} top-level entries, ` +
    `${(bytes / 1048576).toFixed(1)} MiB)`,
);
