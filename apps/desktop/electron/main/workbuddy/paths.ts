/**
 * Local locations a WorkBuddy install uses.
 *
 * Every path is derived from an injected environment so detection stays pure and
 * testable; the runtime supplies the real one. Files here are read as *data*:
 * the desktop app's sealed token is never parsed, and this module does not name
 * it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type WorkBuddyEnvironment = {
  homeDir: string;
  /** `%LOCALAPPDATA%` on Windows; the XDG data dir elsewhere. */
  localAppData: string;
  /** `%PROGRAMFILES%` on Windows; `/Applications` elsewhere. */
  programFiles: string;
  platform: NodeJS.Platform;
  /** Injected clock so expiry checks are deterministic in tests. */
  now?: number;
};

export function currentEnvironment(now?: number): WorkBuddyEnvironment {
  const env = process.env;
  const homeDir = env.HOME || env.USERPROFILE || "";
  const localAppData =
    process.platform === "win32"
      ? env.LOCALAPPDATA || join(homeDir, "AppData", "Local")
      : env.XDG_DATA_HOME || join(homeDir, ".local", "share");
  const programFiles =
    process.platform === "win32"
      ? env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files"
      : "/Applications";
  return { homeDir, localAppData, programFiles, platform: process.platform, now };
}

/** Directories the desktop app writes its per-account data into. */
export function workBuddyDataDirs(environment: WorkBuddyEnvironment): string[] {
  return [
    join(environment.homeDir, ".workbuddy"),
    join(environment.homeDir, ".codebuddy"),
  ];
}

/**
 * Files the desktop app caches its signed-in account in.
 *
 * Only the non-secret fields (`account`, `auth.expiresAt`) are read. A store may
 * hold sealed token envelopes; they stay untouched.
 */
export function workBuddyAccountStores(environment: WorkBuddyEnvironment): string[] {
  return [
    join(
      environment.localAppData,
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
      "workbuddy-desktop.info",
    ),
    join(environment.homeDir, ".workbuddy", "auth.info"),
    join(environment.homeDir, ".codebuddy", "auth.json"),
  ];
}

/** Directories holding the desktop app's cached model catalog. */
export function workBuddyStorageDirs(environment: WorkBuddyEnvironment): string[] {
  return workBuddyDataDirs(environment).map((dir) => join(dir, "local_storage"));
}

/** Model catalog written by the optional local connector, when present. */
export function workBuddyConnectorCatalog(environment: WorkBuddyEnvironment): string {
  return join(environment.homeDir, ".pi-workbuddy-connect", ".workbuddy-catalog.json");
}

/** Executable candidates for an installed desktop app. */
export function workBuddyExecutables(environment: WorkBuddyEnvironment): string[] {
  if (environment.platform === "darwin") {
    return [join(environment.programFiles, "WorkBuddy.app")];
  }
  if (environment.platform === "win32") {
    return [
      join(environment.programFiles, "WorkBuddy", "WorkBuddy.exe"),
      join(environment.localAppData, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    ];
  }
  return [
    join(environment.localAppData, "WorkBuddy", "WorkBuddy"),
    join(environment.programFiles, "WorkBuddy", "WorkBuddy"),
  ];
}

/** Files inside a storage directory, newest first. Missing directories are empty. */
export function storageFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".info"));
  } catch {
    return [];
  }
  const stated = names.map((name) => {
    const path = join(directory, name);
    let modified = 0;
    try {
      modified = statSync(path).mtimeMs;
    } catch {
      modified = 0;
    }
    return { path, modified };
  });
  return stated.sort((left, right) => right.modified - left.modified).map((entry) => entry.path);
}
