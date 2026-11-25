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
 *   node scripts/package-windows.mjs --skip-verify  # iterate: skip the tree verifier
 *   node scripts/package-windows.mjs --rebuild-rust # force the release Rust compile
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
import { existsSync, readdirSync, statSync } from "node:fs";
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
const skipVerify = argv.has("--skip-verify");
const rebuildRust = argv.has("--rebuild-rust");
const withPython = argv.has("--with-python");
const allowRunning = argv.has("--allow-running");

/**
 * Per-step wall clock.
 *
 * The build is long enough that "which step is the slow one" is worth printing
 * instead of guessing, and the answer moves with what changed: a JS-only change
 * spends its time in electron-builder, a Rust change in the linker.
 */
const timings = [];
let openStep = null;

function step(title) {
  closeStep();
  openStep = { title, startedAt: Date.now() };
  process.stdout.write(`\n=== ${title} ===\n`);
}

function closeStep() {
  if (!openStep) return;
  timings.push({ title: openStep.title, ms: Date.now() - openStep.startedAt });
  openStep = null;
}

function printTimings() {
  closeStep();
  if (timings.length === 0) return;
  const width = Math.max(...timings.map((entry) => entry.title.length));
  const total = timings.reduce((sum, entry) => sum + entry.ms, 0);
  process.stdout.write("\n=== step timings ===\n");
  for (const entry of timings) {
    process.stdout.write(`  ${entry.title.padEnd(width)}  ${(entry.ms / 1000).toFixed(1)}s\n`);
  }
  process.stdout.write(`  ${"total".padEnd(width)}  ${(total / 1000).toFixed(1)}s\n`);
}

process.on("exit", printTimings);

/**
 * The newest Rust input the release binaries depend on.
 *
 * The workspace is two crates under `crates/` plus the manifests at the root, so
 * this is the whole input set: a `.rs`, `.toml` or lock file newer than the
 * binary means the binary is stale.
 */
function newestRustInputMs() {
  const extensions = /\.(rs|toml|lock)$/;
  let newest = 0;
  const roots = [join(REPO, "crates"), REPO];
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "target" || entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // Root-level directories are not Rust inputs; crates/ is walked whole.
          if (root === REPO) continue;
          stack.push(full);
          continue;
        }
        if (!extensions.test(entry.name)) continue;
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

/** The profile the binary in `target/release/` was actually built with. */
/** Whether a release binary already covers every Rust input. */
function rustBinaryIsCurrent(exe) {
  if (rebuildRust || !existsSync(exe)) return false;
  return statSync(exe).mtimeMs >= newestRustInputMs();
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

// Re-linking host-core for a JS-only change is minutes of a build that otherwise
// takes seconds, so the binary is reused while it is newer than every Rust input.
// `--rebuild-rust` forces a compile and `--verify-only` never reaches this point.
const hostExe = join(REPO, "target", "release", "pi-desktop-host-core.exe");
if (rustBinaryIsCurrent(hostExe)) {
  step("build host-core (release): binary is newer than the sources");
} else {
  step("build host-core (release)");
  const host = run("cargo", ["build", "--release", "-p", "host-core", "--locked"]);
  if (host !== 0) process.exit(host);
}

// The kernel ships from `target/release` too, and this script does not build it
// (`build:agent-release` in the desktop package does). Pack a missing one is a
// silent half-install, so it fails here instead.
const agentExe = join(REPO, "target", "release", "nubo-proto.exe");
if (!existsSync(agentExe)) {
  process.stderr.write(
    `missing ${agentExe}\nRun \`pnpm --filter @pi-workspace/desktop run build:agent-release\` first.\n`,
  );
  process.exit(3);
}

// The dependency-closure build above already ran the app's own `build`
// (electron-vite), so running it again here bought a second identical bundle for
// a minute and a half. Only the `--skip-deps` path still needs it.
if (skipDeps) {
  step("electron-vite build");
  const vite = run("pnpm", ["exec", "electron-vite", "build"], { cwd: APP, shell: true });
  if (vite !== 0) process.exit(vite);
}

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
//    `--skip-verify` exists for the iterate-then-verify-once loop; a tree that is
//    about to be installed still goes through the verifier.
if (skipVerify) {
  step("verify packaged tree: skipped (--skip-verify)");
  process.exit(0);
}
process.exit(verify());
