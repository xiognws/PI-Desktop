#!/usr/bin/env node
/**
 * `pnpm dev` with a data directory this checkout owns.
 *
 * The development profile (`.pi-desktop-dev`) is shared by every worktree on the
 * machine. A newer branch that migrates the database forward makes older builds
 * refuse to start ("local data schema is newer than this build"), which has
 * nothing to do with the change under test. Giving each checkout its own
 * directory keeps that failure out of the way while leaving the shared profile
 * intact for the builds that migrated it.
 *
 * `PI_DESKTOP_DATA_DIR` still wins when it is already set, so CI and the
 * capture harnesses keep their own roots.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Everything this installation writes lives under one root, off the system
 * drive when that root exists: the SQLite database, plugin data, logs, the
 * Electron user-data (localStorage, caches) and the Playwright browsers the e2e
 * runner needs. `PI_DESKTOP_DATA_DIR` and `PLAYWRIGHT_BROWSERS_PATH` still win,
 * and the home-directory defaults remain for machines without the data root.
 */
const DATA_ROOT = process.env.PI_DESKTOP_DATA_ROOT?.trim() || "D:/PI-Desktop";
const onDataRoot = existsSync(DATA_ROOT);
const dataDir = process.env.PI_DESKTOP_DATA_DIR?.trim()
  || (onDataRoot ? join(DATA_ROOT, "data") : join(homedir(), ".pi-desktop-dev-main"));
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  || (onDataRoot ? join(DATA_ROOT, "ms-playwright") : undefined);
const child = spawn("pnpm", ["--filter", "@pi-desktop/desktop", "dev"], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    PI_DESKTOP_DATA_DIR: dataDir,
    ...(browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {}),
  },
});
console.log(`[dev] PI_DESKTOP_DATA_DIR=${dataDir}${browsers ? ` PLAYWRIGHT_BROWSERS_PATH=${browsers}` : ""}`);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
