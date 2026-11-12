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
  /**
   * Explicit executable candidates. Absent means "derive them from the standard
   * locations"; present (even as an empty list) means "only these" — the seam a
   * test uses to describe a machine that has the app nowhere.
   */
  executables?: string[];
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

/**
 * Program-directory roots to search on Windows.
 *
 * The desktop app is commonly installed on a drive that is not the system one,
 * so the environment's own `ProgramFiles` is only the first candidate; every
 * mounted drive contributes its `Program Files` roots as well. The list is
 * generation only — existence is checked by the caller, which keeps this module
 * free of filesystem reads.
 */
export function windowsProgramRoots(environment: WorkBuddyEnvironment): string[] {
  const roots = new Set<string>();
  roots.add(environment.programFiles);
  if (environment.localAppData.endsWith("Local")) {
    roots.add(join(environment.localAppData, "..", "..", "Program Files"));
  }
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const drive = `${String.fromCharCode(code)}:`;
    roots.add(`${drive}\\Program Files`);
    roots.add(`${drive}\\Program Files (x86)`);
    roots.add(`${drive}\\`);
  }
  return [...roots];
}

/** Executable candidates for an installed desktop app, most likely first. */
export function workBuddyExecutables(environment: WorkBuddyEnvironment): string[] {
  if (environment.platform === "darwin") {
    return [
      join(environment.programFiles, "WorkBuddy.app"),
      join(environment.homeDir, "Applications", "WorkBuddy.app"),
    ];
  }
  if (environment.platform === "win32") {
    const candidates: string[] = [];
    for (const root of windowsProgramRoots(environment)) {
      for (const app of ["WorkBuddy", "CodeBuddy"]) {
        candidates.push(join(root, app, `${app}.exe`));
      }
    }
    for (const app of ["WorkBuddy", "CodeBuddy"]) {
      candidates.push(join(environment.localAppData, "Programs", app, `${app}.exe`));
      candidates.push(join(environment.localAppData, app, `${app}.exe`));
    }
    return candidates;
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
