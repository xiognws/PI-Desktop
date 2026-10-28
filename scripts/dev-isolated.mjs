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
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.PI_DESKTOP_DATA_DIR?.trim() || join(homedir(), ".pi-desktop-dev-main");
const child = spawn("pnpm", ["--filter", "@pi-desktop/desktop", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PI_DESKTOP_DATA_DIR: dataDir },
});
console.log(`[dev] PI_DESKTOP_DATA_DIR=${dataDir}`);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
