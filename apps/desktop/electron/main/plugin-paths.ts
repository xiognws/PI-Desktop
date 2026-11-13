import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getModuleDirectory } from "./module-path.ts";

/**
 * Directories the user pointed the host at, and the two sets this build ships.
 *
 * Two different ideas share this file because they share one question: *which
 * directories may contribute plugins?*
 *
 * - **Preinstalled** directories ship with the install image. The host
 *   reconciles its registry against them on every launch, and the user may
 *   remove, disable, or update what they find there (see
 *   `crates/host-core/src/plugins/preinstalled.rs`).
 * - **Extra** directories are the user's own: a plugin checkout they are
 *   working on, a folder they copied plugins into. The host reads them in place
 *   and never writes to them, so pointing at one has to be an explicit act with
 *   a record the settings page can edit.
 *
 * Electron resolves paths because only it knows whether the app runs from
 * `resources/` or a source checkout; the host receives the answer as
 * environment variables.
 */

/** File the settings page writes; read once per launch, before the host starts. */
export const PLUGIN_PATHS_FILE = "plugin-paths.json";

/**
 * Upper bound on extra directories.
 *
 * Each one is scanned on every launch and every id in it is loaded, so a list
 * that grew without limit would turn a settings mistake into a slow boot. The
 * cap is generous for the intended use (one or two checkouts).
 */
export const MAX_EXTRA_DIRS = 20;

export type PluginPaths = { extraDirs: string[] };

/**
 * What the host splits these lists on, so a value means the same thing on both
 * sides of the process boundary: `;` on Windows, `:` elsewhere.
 */
export const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

/**
 * Preinstalled directories, packaged location first.
 *
 * Every candidate that exists is returned rather than just the first: a
 * distribution may layer its own set in front of a vendored one, and the host
 * scans them in the order it receives.
 */
export function resolvePreinstalledPluginsDirs(input: {
  resourcesPath?: string;
  moduleDirectory?: string;
} = {}): string[] {
  const resources =
    input.resourcesPath ?? process.resourcesPath ?? "";
  const moduleDir = input.moduleDirectory ?? getModuleDirectory(import.meta.url);
  const candidates = [
    join(resources, "plugins"),
    join(moduleDir, "../../resources/plugins"),
    join(moduleDir, "../../../resources/plugins"),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Parse `plugin-paths.json`.
 *
 * Anything unusable is dropped rather than reported: this is read on the launch
 * path, and a hand-edited file with one bad entry must not stop the app from
 * opening. Non-absolute paths are dropped too — the host runs with the data
 * directory as its working directory, so a relative entry would silently mean
 * something else there.
 */
export function parsePluginPaths(raw: string): PluginPaths {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { extraDirs: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { extraDirs: [] };
  const listed = (parsed as { extraDirs?: unknown }).extraDirs;
  if (!Array.isArray(listed)) return { extraDirs: [] };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_EXTRA_DIRS) break;
  }
  return { extraDirs: out };
}

/** The settings file for one installation's data directory. */
export function pluginPathsFile(dataDir: string): string {
  return join(dataDir, PLUGIN_PATHS_FILE);
}

/** One directory as the settings page shows it. */
export type PluginDirectoryEntry = {
  path: string;
  /** Whether the directory is on disk right now. */
  exists: boolean;
  /** Whether the host will actually scan it (it only scans what exists). */
  counted: boolean;
};

/**
 * Round-trip the file so the page and the host agree on one list.
 *
 * Written as data, not as the in-memory value: a hand-edited file with an entry
 * the parser drops must stop being listed, or the page would keep offering a
 * directory that does nothing.
 */
export function writePluginPaths(dataDir: string, dirs: readonly string[]): PluginPaths {
  const parsed = parsePluginPaths(JSON.stringify({ extraDirs: [...dirs] }));
  const file = pluginPathsFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

/** Appending a directory that is already listed keeps the first position. */
export function addExtraDir(dirs: readonly string[], dir: string): string[] {
  const trimmed = dir.trim();
  if (!trimmed || dirs.includes(trimmed)) return [...dirs];
  return [...dirs, trimmed].slice(0, MAX_EXTRA_DIRS);
}

export function removeExtraDir(dirs: readonly string[], dir: string): string[] {
  return dirs.filter((entry) => entry !== dir);
}

/** The configured list, with the state each entry is in on disk. */
export function listPluginDirectories(dataDir: string): PluginDirectoryEntry[] {
  const parsed = parsePluginPaths(
    existsSync(pluginPathsFile(dataDir))
      ? readFileSync(pluginPathsFile(dataDir), "utf8")
      : "{}",
  );
  return parsed.extraDirs.map((path) => {
    const exists = existsSync(path);
    return { path, exists, counted: exists };
  });
}

/**
 * True when `target` is `dir` itself or lives inside it.
 *
 * Separator-agnostic on purpose: a path the renderer shows is a string the user
 * copied, and Windows accepts both separators. Trailing separators are trimmed
 * so `D:\plugins\` covers `D:\plugins\x` but not `D:\plugins-old`.
 */
export function isInsideDirectory(dir: string, target: string): boolean {
  // Normalise both sides first: the two separators mean the same thing on
  // Windows, and a user copying a path out of Explorer gets backslashes while a
  // plugin's own manifest uses forward slashes.
  const normalize = (value: string) =>
    String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const root = normalize(dir);
  const path = normalize(target);
  if (!root || !path) return false;
  if (path === root) return true;
  return path.startsWith(`${root}/`);
}

/**
 * Directories the host should scan for the user's own plugins.
 *
 * `PI_DESKTOP_EXTRA_PLUGIN_DIRS` wins when set, because that is what the E2E
 * harness and a support session use to point one instance at a fixture without
 * writing into the user's data directory.
 */
export function resolveExtraPluginDirs(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env.PI_DESKTOP_EXTRA_PLUGIN_DIRS;
  if (override && override.trim()) {
    return parsePluginPaths(
      JSON.stringify({ extraDirs: override.split(delimiterFor(override)) }),
    ).extraDirs.filter((dir) => existsSync(dir));
  }
  const file = pluginPathsFile(dataDir);
  if (!existsSync(file)) return [];
  return parsePluginPaths(readFileSync(file, "utf8")).extraDirs.filter((dir) =>
    existsSync(dir),
  );
}

/**
 * Separator the host will split on, so the value means the same thing on both
 * sides: `;` on Windows, `:` elsewhere.
 */
function delimiterFor(value: string): string {
  return process.platform === "win32" || value.includes(";") ? ";" : ":";
}
