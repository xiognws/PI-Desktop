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
import { join } from "node:path";

import { probePythonCapabilities, probePythonVersion } from "./python-runtime.ts";

export type PythonCandidateSource = "configured" | "data-venv" | "launcher" | "path" | "common";

export type PythonCandidate = {
  path: string;
  /** `major.minor`, or absent when the file did not answer. */
  version?: string;
  /** Whether it already imports the libraries the document tools need. */
  hasLibraries: boolean;
  source: PythonCandidateSource;
};

export type ScanOptions = {
  dataDir?: string;
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Extra directories to look in, for a caller that knows more than we do. */
  extraRoots?: readonly string[];
  probeVersion?: (executable: string) => string | undefined;
  probeLibraries?: (executable: string) => boolean;
  /** `py -0p` output for the launcher; injected so tests do not spawn anything. */
  launcherPaths?: readonly string[];
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
  const programData = env.ProgramData ?? "C:\\ProgramData";
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
  const probeLibraries = options.probeLibraries ?? probePythonCapabilities;
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
  for (const root of [...commonRoots(env, platform), ...(options.extraRoots ?? [])]) {
    for (const path of interpretersUnder(root, platform)) push(path, "common");
  }

  const seen = new Set<string>();
  const candidates: PythonCandidate[] = [];
  for (const { path, source } of ordered) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = probeVersion(path);
    // A file that cannot report a version is not an interpreter we can run.
    if (!version) continue;
    candidates.push({ path, version, hasLibraries: probeLibraries(path), source });
  }
  return candidates;
}
