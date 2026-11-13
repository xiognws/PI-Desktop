/**
 * One place for the scratch files this process writes while it runs.
 *
 * Everything the app needs on disk for a moment — an npm or ssh handoff, a
 * downloaded payload, a wrapper script handed to another program — belongs
 * under `<dataDir>/tmp` (AGENTS.md §8). The system temp directory is outside
 * the folder this application backs up, relocates and asks a user to inspect,
 * and on Windows it keeps collecting files whose owner exited long ago.
 *
 * The directory is created on demand and never removed: it is small, it lives
 * inside the data folder the user already owns, and a crash mid-write leaves at
 * most one file that the next start can recognise by its purpose prefix.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { desktopDataDir } from "./data-paths";

/** `<dataDir>/tmp`, created if missing. */
export function runtimeTmpDir(): string {
  const dir = join(desktopDataDir(), "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Unique directory inside {@link runtimeTmpDir}; `prefix` names its purpose. */
export function mkRuntimeTempDir(prefix: string): string {
  return mkdtempSync(join(runtimeTmpDir(), prefix));
}

/** A file path inside {@link runtimeTmpDir}; the caller writes and removes it. */
export function runtimeTempPath(name: string): string {
  return join(runtimeTmpDir(), name);
}
