#!/usr/bin/env node
/**
 * One command that turns this checkout into a branded, verified Windows build.
 *
 * Why this exists: the canonical `pack` chain downloads Electron and winCodeSign,
 * so on an intranet machine it fails halfway. Working around that by hand ends in
 * `-c.win.signAndEditExecutable=false`, which silently also skips the icon and the
 * version resource: every subsequent build carries Electron's icon and Electron's
 * ProductName, and nothing in the pipeline notices. Two ways out are both closed
 * here - the arguments are fixed in one place, and the result is verified before
 * the command reports success.
 *
 * Usage:
 *   node scripts/package-windows.mjs                # full build into apps/desktop/release
 *   node scripts/package-windows.mjs --verify-only  # check the tree that is there now
 *   node scripts/package-windows.mjs --skip-deps    # keep the package dist/ that exist
 *   node scripts/package-windows.mjs --with-python  # also re-sync resources/python
 *   node scripts/package-windows.mjs --allow-running # build while the app is open (unsafe)
 *
 * Deliberate defaults:
 * - Electron is taken from `node_modules/electron/dist` when it is there, so no
 *   download is attempted on a machine that already has the matching version.
 * - Signing stays off unless a certificate is configured, but resource editing
 *   (icon + version strings) always stays ON: `signExecutable`, never
 *   `signAndEditExecutable`.
 * - `resources/python` is left alone: re-syncing it replaces the signed CPython
 *   binaries with the unsigned bundled ones unless the wheel cache is complete.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(REPO, "apps", "desktop");
const RELEASE = join(APP, "release");
const UNPACKED = join(RELEASE, "win-unpacked");
const VERIFY = join(REPO, "scripts", "verify-windows-package.ps1");

const argv = new Set(process.argv.slice(2));
const verifyOnly = argv.has("--verify-only");
const skipDeps = argv.has("--skip-deps");
const withPython = argv.has("--with-python");
const allowRunning = argv.has("--allow-running");

function step(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    // pnpm refuses to run with a pipe where a terminal is expected ("stdin is
    // not a tty") when a parent process hands it an inherited non-tty stdin.
    stdio: ["ignore", "inherit", "inherit"],
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...(options.env ?? {}) },
    // On Windows `pnpm` only exists as pnpm.cmd, and Node does not apply PATHEXT
    // without a shell: spawn would fail with ENOENT before the first step runs.
    shell: process.platform === "win32" || Boolean(options.shell),
  });
  if (result.error) {
    process.stderr.write(`cannot run ${command}: ${result.error.message}
`);
    throw result.error;
  }
  return result.status ?? 1;
}

/** Running Pi-Workspace.exe holds the tree open, and a delete then half-succeeds. */
function runningAppCount() {
  if (process.platform !== "win32") return 0;
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq Pi-Workspace.exe", "/NH"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) return 0;
  return result.stdout.split(/\r?\n/).filter((line) => /Pi-Workspace\.exe/i.test(line)).length;
}

function localElectronDist() {
  const dist = join(APP, "node_modules", "electron", "dist");
  return existsSync(join(dist, "electron.exe")) ? dist : "";
}

function signingConfigured() {
  const env = process.env;
  return Boolean(
    env.CSC_LINK || env.CSC_NAME || env.WINDOWS_SIGN_CERT ||
    env.AZURE_TENANT_ID || env.AZURE_KEY_VAULT_URI,
  );
}

function verify() {
  step("verify packaged tree");
  if (process.platform === "win32") {
    return run("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", VERIFY, "-Root", UNPACKED,
    ]);
  }
  process.stdout.write("verification is Windows-only; skipped\n");
  return 0;
}

if (verifyOnly) {
  process.exit(verify());
}

// 1. Refuse to destroy a tree that is in use.
const running = runningAppCount();
if (running > 0 && !allowRunning) {
  process.stdout.write(
    `Pi-Workspace.exe is running (${running} processes) and holds ${UNPACKED} open.\n` +
    "Close it, then run this again. Deleting the tree underneath a running app is\n" +
    "how the previous build left a directory with one file in it.\n",
  );
  process.exit(2);
}

// 2. Package dist/ of the workspace packages. A packaging run that reuses a stale
//    dist ships yesterday's strings: the renderer bundles from source, the main
//    process bundles from the package's built output.
if (!skipDeps) {
  step("build workspace package dists");
  // `pnpm -r --if-present build` is the repository's own `build:js`, and it avoids
  // the `^` selector: through cmd.exe that character is an escape, so the filter
  // form would have to be quoted differently for every shell.
  // `@pi-workspace/desktop...` is the app and its dependency closure. A bare
  // `-r build` also builds `docs` (vitepress), which is not shipped here and
  // aborts with "stdin is not a tty" when the log is redirected.
  const deps = run("pnpm", ["--filter", "@pi-workspace/desktop...", "build"]);
  if (deps !== 0) process.exit(deps);
}

if (withPython) {
  step("re-sync resources/python");
  const python = run("pnpm", ["--filter", "@pi-workspace/desktop", "run", "bundle:python"], { shell: true });
  if (python !== 0) process.exit(python);
}

step("bundle agent runtime");
const runtime = run("pnpm", ["-C", "packages/agent-runtime", "bundle"], { shell: true });
if (runtime !== 0) process.exit(runtime);

step("build host-core (release)");
const host = run("cargo", ["build", "--release", "-p", "host-core", "--locked"]);
if (host !== 0) process.exit(host);

step("electron-vite build");
const vite = run("pnpm", ["exec", "electron-vite", "build"], { cwd: APP, shell: true });
if (vite !== 0) process.exit(vite);

step("electron-builder");
const builderArgs = [
  "exec", "electron-builder", "--dir", "--win", "--publish", "never",
  `-c.directories.output=${RELEASE}`,
];
const dist = localElectronDist();
if (dist) builderArgs.push(`-c.electronDist=${dist}`);
if (!signingConfigured()) {
  // Editing the executable's resources (icon, version) is what makes the build
  // look like Pi-Workspace instead of Electron; only signing is skipped.
  builderArgs.push("-c.win.signExecutable=false");
}
const pack = run("pnpm", builderArgs, { cwd: APP, shell: true });
if (pack !== 0) process.exit(pack);

// 3. Never report success for a tree that ships the wrong icon or stale content.
process.exit(verify());
