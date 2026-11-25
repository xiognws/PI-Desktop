/**
 * Finding the Pythons already on this machine.
 *
 * Settings → System → Python shows a list instead of asking for a path from
 * memory: the candidates come from the places an interpreter actually lands — the
 * launcher's registry view, `PATH`, the usual install roots, and the venv the user
 * keeps beside this app's data. Every candidate is probed, because a file called
 * `python.exe` is not yet an interpreter that runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { probePythonVersion } from "./python-runtime.ts";

export type PythonCandidateSource = "bundled" | "configured" | "data-venv" | "launcher" | "path" | "common";

export type PythonCandidate = {
  path: string;
  /** `major.minor`, or absent when the file did not answer. */
  version?: string;
  /**
   * Installed distributions (`*.dist-info`) this interpreter's own
   * site-packages holds. Counting on disk keeps the answer cheap: probing each
   * candidate by running it would cost a subprocess per row, and the number is
   * there to tell "an interpreter" from "an environment".
   */
  libraryCount: number;
  source: PythonCandidateSource;
};

/** The runtime this build ships, described by the caller that knows its layout. */
export type BundledCandidate = {
  path: string;
  version?: string;
  /** Where its pinned wheels live; empty when the build has no such folder. */
  sitePackages?: string;
};

export type ScanOptions = {
  dataDir?: string;
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Extra directories to look in, for a caller that knows more than we do. */
  extraRoots?: readonly string[];
  /**
   * Drive roots read for `Python*` directories (Windows only). Injected so a
   * test can point at a fixture instead of the real `C:\`.
   */
  driveRoots?: readonly string[];
  probeVersion?: (executable: string) => string | undefined;
  /** `py -0p` output for the launcher; injected so tests do not spawn anything. */
  launcherPaths?: readonly string[];
  /**
   * The interpreter this build ships. Offered even when it is also on `PATH`
   * (`C:\` installs are), and ranked first: it is the one interpreter whose
   * document libraries are guaranteed, so a user who picks it never has to read
   * a "missing libraries" warning.
   */
  bundled?: BundledCandidate;
};

/**
 * Interpreter paths the Windows `py` launcher has registered.
 *
 * `py -0p` prints one line per install, `-V:3.12 * C:\...\python.exe`; the `*` marks
 * the default. Installs registered with the launcher are invisible to `PATH` unless
 * the user ticked that box, and they are the ones a Windows user means by "my
 * Python". A machine without the launcher answers nothing, which is not an error.
 */
export function launcherPythonPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [];
  try {
    const output = execFileSync("py", ["-0p"], {
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return String(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[-\s]*\*?\s*(?:-V:\S+\s+)?/, ""))
      .map((line) => line.replace(/\s*\*$/, "").trim())
      .filter((line) => /\.exe$/i.test(line));
  } catch {
    return [];
  }
}

/** Install roots worth looking in, per platform. */
function commonRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") {
    return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  }
  const local = env.LOCALAPPDATA ?? "";
  const roaming = env.APPDATA ?? "";
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const home = env.USERPROFILE ?? "";
  const programData = env.ProgramData ?? "C:\ProgramData";
  return [
    local ? join(local, "Programs", "Python") : "",
    programFiles ? join(programFiles, "Python") : "",
    programFilesX86 ? join(programFilesX86, "Python") : "",
    "C:\\Python312",
    "C:\\Python311",
    "C:\\Python310",
    home ? join(home, "miniconda3") : "",
    home ? join(home, "anaconda3") : "",
    home ? join(home, "micromamba") : "",
    programData ? join(programData, "miniconda3") : "",
    roaming ? join(roaming, "Python") : "",
  ].filter((root) => root.length > 0);
}

/**
 * `Python*` directories sitting directly on a drive root.
 *
 * The fixed names above only cover the layout python.org suggests. A user who
 * unzips or installs a second minor version usually gets a name of their own
 * (`C:\Python3119`, `C:\Python3147`), and that interpreter is invisible to the
 * launcher, to `PATH`, and to every hard-coded root — the Settings list showed
 * only the shipped runtime and one old install until this read the drive.
 */
function driveRootPythonDirs(driveRoots: readonly string[]): string[] {
  const found: string[] = [];
  for (const drive of driveRoots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(drive, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^Python[\d.]+$/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) found.push(join(drive, entry));
  }
  return found;
}

/** Drive roots to read: `SystemDrive`, then `C:`. */
function defaultDriveRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  const systemDrive = (env.SystemDrive ?? "").trim();
  if (systemDrive) roots.add(`${systemDrive}\\`);
  roots.add("C:\\");
  return [...roots];
}

/**
 * The site-packages directory an interpreter of this shape uses.
 *
 * Windows keeps it at `Lib/site-packages` beside the executable; a POSIX build
 * nests it under `lib/python<major.minor>`. A path that is not there counts as
 * zero libraries rather than an error: an embedded or stripped interpreter is a
 * legitimate answer to "what do I have".
 */
function sitePackagesFor(interpreterPath: string, platform: NodeJS.Platform, version?: string): string {
  const root = dirname(interpreterPath);
  if (platform === "win32") return join(root, "Lib", "site-packages");
  return version ? join(root, "lib", `python${version}`, "site-packages") : join(root, "lib");
}

/**
 * How many distributions live in one site-packages directory.
 *
 * `*.dist-info` is what pip leaves for every installed distribution, so the
 * count matches what `pip list` reports instead of counting helper modules,
 * `__pycache__` or a stray `.pth` file as a library.
 */
function countInstalledDistributions(sitePackages: string): number {
  let entries: string[] = [];
  try {
    entries = readdirSync(sitePackages);
  } catch {
    return 0;
  }
  return entries.filter((entry) => /\.(dist|egg)-info$/i.test(entry)).length;
}

/** Interpreter file names inside one directory, per platform. */
function interpreterNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["python.exe"] : ["python3", "python"];
}

/** Every `python.exe` one level below an install root (`Python/Python312/…`). */
function interpretersUnder(root: string, platform: NodeJS.Platform): string[] {
  const names = interpreterNames(platform);
  const direct = names.map((name) => join(root, name)).filter((path) => existsSync(path));
  if (direct.length) return direct;
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    for (const name of names) {
      const path = join(root, entry, name);
      if (existsSync(path)) found.push(path);
    }
  }
  return found;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  return raw
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Candidates, best first: what the user configured, the app's own venv, the
 * launcher's registered installs, `PATH`, then the usual roots.
 */
export function scanPythonInstallations(options: ScanOptions = {}): PythonCandidate[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probeVersion = options.probeVersion ?? probePythonVersion;
  const names = interpreterNames(platform);
  const ordered: Array<{ path: string; source: PythonCandidateSource }> = [];
  const push = (path: string, source: PythonCandidateSource) => {
    if (!path) return;
    ordered.push({ path, source });
  };

  if (options.configured) push(options.configured, "configured");
  if (options.dataDir) {
    const venvRoot = join(options.dataDir, "python", "venv");
    for (const name of platform === "win32" ? ["Scripts/python.exe"] : ["bin/python3", "bin/python"]) {
      const path = join(venvRoot, name);
      if (existsSync(path)) push(path, "data-venv");
    }
  }
  const launcherPaths = options.launcherPaths ?? launcherPythonPaths(platform);
  for (const path of launcherPaths) push(path, "launcher");
  for (const directory of pathEntries(env, platform)) {
    for (const name of names) {
      const path = join(directory, name);
      // The Store aliases are stubs that open the Store; they are not interpreters.
      if (platform === "win32" && /\\WindowsApps$/i.test(directory)) continue;
      if (existsSync(path)) push(path, "path");
    }
  }
  const driveRoots =
    platform === "win32" ? (options.driveRoots ?? defaultDriveRoots(env)) : [];
  const discovered = platform === "win32" ? driveRootPythonDirs(driveRoots) : [];
  for (const root of [...commonRoots(env, platform), ...discovered, ...(options.extraRoots ?? [])]) {
    for (const path of interpretersUnder(root, platform)) push(path, "common");
  }

  const seen = new Set<string>();
  const candidates: PythonCandidate[] = [];
  // The shipped runtime goes first: it is the one interpreter whose document
  // libraries this build verified, so it is the safe answer to "which should I
  // pick". Its libraries are found through `PYTHONPATH`, not through the
  // interpreter's own site-packages, so presence of the folder is the check.
  if (options.bundled) {
    const bundledPath = options.bundled.path;
    const key = bundledPath.toLowerCase();
    if (existsSync(bundledPath)) {
      seen.add(key);
      const bundledSitePackages = options.bundled.sitePackages ?? "";
      candidates.push({
        path: bundledPath,
        version: options.bundled.version ?? probeVersion(bundledPath),
        libraryCount: bundledSitePackages ? countInstalledDistributions(bundledSitePackages) : 0,
        source: "bundled",
      });
    }
  }
  for (const { path, source } of ordered) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = probeVersion(path);
    // A file that cannot report a version is not an interpreter we can run.
    if (!version) continue;
    candidates.push({
      path,
      version,
      libraryCount: countInstalledDistributions(sitePackagesFor(path, platform, version)),
      source,
    });
  }
  return candidates;
}
