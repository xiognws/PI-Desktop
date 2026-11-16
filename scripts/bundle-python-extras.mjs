#!/usr/bin/env node
/**
 * Assemble the optional Python library folder that sits **next to** the app
 * image, not inside it.
 *
 * `bundle-python-runtime.mjs` ships the small Office/file stack inside
 * `resources/python`: those libraries back built-in tools, so they must be part
 * of the installed product. The everyday engineering stack (HTTP, SSH, CAN,
 * numpy/scipy/matplotlib, PDF and Markdown parsing, pywin32 …) is a different
 * bargain: many users never touch it, and every megabyte lands in every
 * installer. It therefore lives in `<app dir>/python-extras/site-packages`,
 * which `python-runtime.ts` appends to `PYTHONPATH` when present.
 *
 * The wheels are pinned in the same `scripts/python-runtime.lock.json`
 * (`extraWheels`), installed with `--require-hashes`, and the local overlays
 * (`can.interfaces.zlg`) are applied the same way as in the bundled tree.
 *
 * Usage:
 *   node scripts/bundle-python-extras.mjs --out <dir> [--python <exe>]
 *   node scripts/bundle-python-extras.mjs --out <dir> --from <wheels dir>
 *   node scripts/bundle-python-extras.mjs --dry-run
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = join(REPO, "scripts", "python-runtime.lock.json");
const STAGING = join(REPO, ".python-extras-staging");
const PATCHES = join(REPO, "apps", "desktop", "python-patches");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const OUT = flag("out", join(REPO, "apps", "desktop", "release", "win-unpacked", "python-extras"));
const PYTHON = flag("python", "");
const FROM = flag("from", "");
const DRY_RUN = has("dry-run");

const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
const wheels = lock.extraWheels ?? [];
if (!wheels.length) {
  console.log("no extraWheels in the lock; nothing to assemble");
  process.exit(0);
}
// The extra wheels are built for one platform; a mac/linux release simply has no
// extras folder and the app runs without them.
if (!lock.python.platform.startsWith(process.platform === "win32" ? "windows" : process.platform)) {
  console.log(`extras are pinned for ${lock.python.platform}; nothing to assemble on ${process.platform}`);
  process.exit(0);
}

console.log(`extras: ${wheels.length} wheels → ${resolve(OUT)}`);

if (DRY_RUN) {
  for (const wheel of wheels) console.log(`  ${wheel.name}==${wheel.version}  ${wheel.why ?? ""}`);
  process.exit(0);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requirementsTxt() {
  return wheels.map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`).join("\n") + "\n";
}

function resolvePython() {
  if (PYTHON) return PYTHON;
  for (const candidate of process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"]) {
    try {
      const version = execFileSync(candidate, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).trim();
      if (version === lock.python.version.split(".").slice(0, 2).join(".")) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no Python matching the lock is on PATH; pass --python <exe>");
}

const python = resolvePython();
const siteDir = join(OUT, "site-packages");
const wheelsDir = join(STAGING, "wheels");
await mkdir(STAGING, { recursive: true });
await mkdir(wheelsDir, { recursive: true });
await writeFile(join(STAGING, "requirements.txt"), requirementsTxt());

// Reuse an already-downloaded wheel directory when the caller has one.
let wheelSource = "";
if (FROM) {
  const names = await readdir(FROM);
  const missing = wheels.filter((wheel) => !names.includes(wheel.file));
  if (!missing.length) wheelSource = resolve(FROM);
  else console.log(`  ${FROM} is missing ${missing.length} wheels; falling back to pip download`);
}
if (wheelSource) {
  for (const wheel of wheels) {
    const bytes = await readFile(join(wheelSource, wheel.file));
    if (sha256(bytes) !== wheel.sha256) throw new Error(`${wheel.file}: sha256 does not match the lock`);
    await writeFile(join(wheelsDir, wheel.file), bytes);
  }
  console.log(`  reused ${wheels.length} verified wheels from ${wheelSource}`);
} else {
  console.log("  downloading the pinned wheels…");
  execFileSync(
    python,
    ["-m", "pip", "download", "--no-deps", "--dest", wheelsDir, "--only-binary=:all:", "--require-hashes", "--no-input", "-r", join(STAGING, "requirements.txt")],
    { stdio: "inherit" },
  );
}

await rm(siteDir, { recursive: true, force: true });
await mkdir(siteDir, { recursive: true });
console.log("  installing…");
execFileSync(
  python,
  ["-m", "pip", "install", "--no-index", "--find-links", wheelsDir, "--target", siteDir, "--no-compile", "--require-hashes", "-r", join(STAGING, "requirements.txt")],
  { stdio: "inherit" },
);

// Overlays: `copy` from the tracked patches folder, `patch` for exact text.
for (const overlay of (lock.overlays ?? []).filter((entry) => entry.scope === "extras")) {
  if (overlay.type === "patch") {
    const file = join(siteDir, overlay.file ?? overlay.to);
    if (!existsSync(file)) throw new Error(`overlay target missing: ${file}`);
    let text = await readFile(file, "utf8");
    for (const edit of overlay.replace ?? []) {
      if (text.includes(edit.with)) continue;
      if (!text.includes(edit.find)) throw new Error(`${overlay.file}: anchor not found (${overlay.why ?? "overlay"})`);
      text = text.replace(edit.find, edit.with);
    }
    await writeFile(file, text);
    console.log(`  patched ${overlay.file}`);
    continue;
  }
  const source = join(PATCHES, overlay.from);
  if (!existsSync(source)) throw new Error(`overlay source missing: ${source}`);
  const target = join(siteDir, overlay.to);
  await mkdir(dirname(target), { recursive: true });
  if ((await stat(source)).isDirectory()) {
    await cpTree(source, target);
  } else {
    await writeFile(target, await readFile(source));
  }
  console.log(`  copied ${overlay.from} → ${overlay.to}`);
}

console.log("  smoke-testing…");
const smoke = lock.extrasSmokeImports ?? [];
if (smoke.length) {
  execFileSync(python, ["-c", `import ${smoke.join(", ")}; print("extras imports ok")`], {
    stdio: "inherit",
    env: { ...process.env, PYTHONPATH: siteDir, PYTHONNOUSERSITE: "1" },
  });
}

const installed = await readdir(siteDir);
await writeFile(
  join(OUT, "EXTRAS.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      python: lock.python.version,
      platform: lock.python.platform,
      builtAt: new Date().toISOString(),
      wheels: wheels.map((wheel) => `${wheel.name}==${wheel.version}`),
      entries: installed.length,
    },
    null,
    2,
  ) + "\n",
);
console.log(`assembled: ${installed.length} entries, ${wheels.length} wheels → ${siteDir}`);

/** Copy a directory tree, skipping caches. */
async function cpTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await cpTree(source, target);
    else if (entry.isFile()) await writeFile(target, await readFile(source));
  }
}
