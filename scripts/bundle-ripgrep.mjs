#!/usr/bin/env node
/**
 * Assemble the ripgrep binary this build ships (`apps/desktop/resources/bin`).
 *
 * The Grep tool must answer the same query the same way on every machine, so it
 * no longer depends on whatever `rg` the user happens to have installed and no
 * longer falls back to a slower in-process searcher when it is missing. The
 * binary travels with the image instead (electron-builder copies
 * `resources/bin` to `<resources>/bin`, next to host-core).
 *
 * `scripts/ripgrep.lock.json` is the source of truth for the version and the
 * binary hash. Nothing is trusted from the network: an archive or binary whose
 * sha256 does not match the lock fails the build rather than shipping.
 *
 * The assembled tree is gitignored, exactly like the Python runtime tree, so
 * the repository carries the pin, not the megabytes.
 *
 * Usage:
 *   node scripts/bundle-ripgrep.mjs                    # download (cached) + verify
 *   node scripts/bundle-ripgrep.mjs --from <path>      # reuse a local zip, dir, or rg.exe
 *   node scripts/bundle-ripgrep.mjs --dry-run          # report the plan only
 *   node scripts/bundle-ripgrep.mjs --force            # rewrite an already-correct binary
 *
 * In this environment (no egress to github.com) pass `--from` at a local
 * ripgrep install, or set RIPGREP_SOURCE once.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIR = join(REPO, "apps", "desktop", "resources", "bin");
const LOCK_PATH = join(REPO, "scripts", "ripgrep.lock.json");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const DRY_RUN = has("dry-run");
const FORCE = has("force");
const FROM = flag("from", process.env.RIPGREP_SOURCE || "");

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")).ripgrep;
const platformKey =
  process.platform === "win32"
    ? "windows-x86_64"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "macos-aarch64"
        : "macos-x86_64"
      : "linux-x86_64";
const entry = lock.platforms[platformKey];

if (!entry) {
  // Only the pinned platform ships the binary. A developer on another platform
  // keeps host-core's PATH resolution for local work, and a release for that
  // platform needs its own lock entry (name + sha256) added first.
  console.log(
    `[ripgrep] no pinned artifact for ${platformKey}; leaving PATH resolution in place ` +
      `(add it to scripts/ripgrep.lock.json before shipping this platform)`,
  );
  process.exit(0);
}

const targetBinary = join(TARGET_DIR, entry.binary);

const sha256 = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

if (existsSync(targetBinary) && !FORCE && !DRY_RUN) {
  const current = await sha256(targetBinary);
  if (current === entry.binarySha256) {
    console.log(`[ripgrep] ${entry.binary} ${lock.version} already in place`);
    process.exit(0);
  }
  console.log(`[ripgrep] refreshing ${entry.binary}: on-disk sha256 does not match the lock`);
}

/** Resolve a `--from` value to the directory that holds the binary. */
async function stagedFromLocal(from) {
  const stats = statSync(from);
  if (stats.isDirectory()) return { dir: from, cleanup: null };
  if (from.toLowerCase().endsWith(".zip")) {
    const dir = join(cacheDir(), "extracted-local");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await mkdir(dir, { recursive: true });
    extractZip(from, dir);
    return { dir, cleanup: dir };
  }
  // A bare binary: stage it under a synthetic directory so the copy + license
  // handling below has one shape to deal with. Licenses stay behind, so they
  // are read from the lock's own platform entry instead.
  const dir = join(cacheDir(), "extracted-local");
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await mkdir(dir, { recursive: true });
  await copyFile(from, join(dir, entry.binary));
  return { dir, cleanup: dir };
}

function cacheDir() {
  const base =
    process.env.PI_BUILD_CACHE ||
    join(process.env.LOCALAPPDATA || process.env.HOME || REPO, "pi-build-cache");
  return join(base, "ripgrep", lock.version);
}

function extractZip(archive, destination) {
  try {
    execFileSync("unzip", ["-q", "-o", archive, "-d", destination], { stdio: "pipe" });
    return;
  } catch {
    // Git Bash may not ship unzip; Windows has Expand-Archive.
  }
  const script = join(destination, "expand.ps1");
  writeFileSync(
    script,
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force\n`,
  );
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    stdio: "pipe",
  });
}

async function fetchArchive() {
  const dir = cacheDir();
  const archive = join(dir, entry.archive);
  await mkdir(dir, { recursive: true });
  if (existsSync(archive)) return archive;
  const base = process.env.RIPGREP_ARTIFACT_BASE_URL || entry.url;
  console.log(`[ripgrep] downloading ${base}`);
  const response = await fetch(base);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${base}`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  return archive;
}

/** Find the binary inside an extracted ripgrep release tree. */
async function findBinary(dir) {
  const direct = join(dir, entry.binary);
  if (existsSync(direct)) return direct;
  for (const child of await readdir(dir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const nested = join(dir, child.name, entry.binary);
    if (existsSync(nested)) return nested;
  }
  return null;
}

async function findLicenses(dir) {
  const found = new Map();
  for (const name of entry.licenses) {
    const direct = join(dir, name);
    if (existsSync(direct)) found.set(name, direct);
  }
  if (found.size === entry.licenses.length) return found;
  for (const child of await readdir(dir, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    for (const name of entry.licenses) {
      const nested = join(dir, child.name, name);
      if (!found.has(name) && existsSync(nested)) found.set(name, nested);
    }
  }
  return found;
}

async function main() {
  let source = null;
  if (FROM) {
    source = await stagedFromLocal(FROM);
  } else {
    const archive = await fetchArchive();
    const dir = join(cacheDir(), "extracted");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await mkdir(dir, { recursive: true });
    extractZip(archive, dir);
    source = { dir, cleanup: dir };
  }

  const binary = await findBinary(source.dir);
  if (!binary) throw new Error(`no ${entry.binary} inside ${source.dir}`);
  const actual = await sha256(binary);
  if (actual !== entry.binarySha256) {
    throw new Error(
      `${entry.binary} sha256 mismatch: expected ${entry.binarySha256}, got ${actual}. ` +
        `Refusing to ship a binary the lock file does not describe.`,
    );
  }

  const licenses = await findLicenses(source.dir);
  // A bare-binary source has no licenses beside it; keep the ones already in
  // the target tree rather than dropping them.
  if (DRY_RUN) {
    console.log(`[ripgrep] would install ${binary} -> ${targetBinary} (${entry.binarySha256})`);
    return;
  }
  mkdirSync(TARGET_DIR, { recursive: true });
  await copyFile(binary, targetBinary);
  for (const name of entry.licenses) {
    const from = licenses.get(name);
    if (from) {
      await copyFile(from, join(TARGET_DIR, name));
    } else if (!existsSync(join(TARGET_DIR, name))) {
      console.log(`[ripgrep] WARNING: ${name} not found next to the source binary`);
    }
  }
  console.log(`[ripgrep] ${entry.binary} ${lock.version} -> ${targetBinary}`);
  if (source.cleanup) await rm(source.cleanup, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error(`[ripgrep] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
