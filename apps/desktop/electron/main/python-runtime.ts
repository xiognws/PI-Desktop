import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { getModuleDirectory } from "./module-path.ts";

/**
 * The Python runtime this installation ships.
 *
 * Office and file work needs libraries no customer machine is expected to have
 * (openpyxl, python-docx, python-pptx, pandas, Pillow, pypdf), and a released
 * client must not depend on an interpreter the user happens to have installed.
 * `scripts/bundle-python-runtime.mjs` therefore puts a complete CPython tree
 * and the pinned wheels into `<resources>/python`, and this module is the only
 * thing that decides where that tree is and whether it is still intact.
 *
 * The interpreter is chosen from four places, in this order, and this module is
 * the only thing that decides:
 *
 *   1. `PI_DESKTOP_PYTHON` / `PI_AUTOTEST_PYTHON`  an explicit path
 *   2. `<data>/python/venv`                        a venv the user owns — outside
 *                                                  the install, so an update and
 *                                                  a `pip install` never collide
 *   3. a CPython on `PATH`                          the user's own interpreter
 *   4. `<resources>/python/runtime`                 the bundled tree, last resort
 *
 * A customer's Python comes first because their libraries are the ones that know
 * their files; the bundled tree exists so a machine without Python still works.
 * What passes between the two is the library path, not the interpreter:
 *
 *   <resources>/python/site-packages/  the bundled libraries, read-only
 *   <data>/python-site/                the user's installs, writable, first
 *
 * The user layer comes first on `PYTHONPATH` so a customer who upgrades a
 * library keeps that upgrade across app updates, and so a reinstall never has
 * to reason about their changes. The bundled layers are verified against the
 * manifest the build wrote, which is what makes "the image is what we built"
 * checkable after an antivirus quarantine or a half-finished update.
 */

/** Directory names inside `<resources>/python`, fixed by the bundle script. */
const RUNTIME_DIR = "runtime";
const SITE_PACKAGES_DIR = "site-packages";
const MANIFEST_FILE = "MANIFEST.json";

/** Where a customer's own `pip install --target` writes. */
export const USER_SITE_DIR = "python-site";

/**
 * Where the user drops `.whl` files they brought from elsewhere.
 *
 * The point of a folder rather than a dialog is that an offline user already
 * has the files on a stick: dragging them into a directory they can open from
 * the app is the whole interaction. `install_libs.py` drains it at startup and
 * on demand, moving successes to `done/` and refusals to `failed/` beside a
 * note naming the libraries still needed.
 */
export const LIBRARY_DROP_DIR = "python-site-drop";

/**
 * Newer than this and the drop folder is drained on the next start anyway; the
 * check exists so a scan that finds nothing costs no Python process.
 */
export const LIBRARY_WORKER = "install_libs.py";

/** Where the interpreter we run came from; the UI names this. */
export type PythonSource = "explicit" | "settings" | "user-venv" | "system" | "bundled";

export type PythonRuntime = {
  /** Root of the tree this interpreter came from (its prefix's parent). */
  root: string;
  /** `python.exe` (or `bin/python3`). */
  executable: string;
  /** `PYTHONHOME` for the bundled tree; empty for an interpreter that owns its prefix. */
  home: string;
  /**
   * Library directory to prepend, or empty when this interpreter cannot use it.
   *
   * The bundled libraries are CPython 3.12 wheels with compiled extensions, so a
   * 3.13 or a PyPy interpreter must not see them: importing a `_pydantic` built
   * for another ABI is a crash, not a fallback.
   */
  sitePackages: string;
  /** Which step of the chain answered. */
  source: PythonSource;
  /** `major.minor` of the interpreter, when it could be probed. */
  version?: string;
  /** Root that holds `tools/` and `MANIFEST.json` (the bundled tree, when present). */
  assetsRoot: string;
};

export type PythonRuntimeStatus =
  | { state: "missing"; reason: string }
  | { state: "present"; runtime: PythonRuntime };

/**
 * How hard to prefer the customer's own interpreter.
 *
 *  - `auto`     the chain below (default)
 *  - `bundled`  never leave the shipped tree; for a machine whose own Python has
 *               half its libraries and none of the reproducibility
 *  - `system`   never fall back to the shipped tree; for a user who insists on
 *               their own environment and wants a loud failure when it is missing
 */
export type PythonStrategy = "auto" | "bundled" | "system";

export function pythonStrategyFromEnv(env: NodeJS.ProcessEnv = process.env): PythonStrategy {
  const value = (env.PI_PYTHON_STRATEGY ?? "").trim().toLowerCase();
  return value === "bundled" || value === "system" ? value : "auto";
}

export type ResolvePythonOptions = {
  /** `<data>`; the user-owned venv and library folders hang off it. */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Overrides `<resources>`, for a caller that knows its own layout. */
  resourcesPath?: string;
  /** Overrides the module-relative candidates, for tests and other hosts. */
  moduleDir?: string;
  /** Probe an interpreter's `major.minor`; injectable so tests can fake it. */
  probe?: (executable: string) => string | undefined;
  /** Whether an interpreter already imports the document libraries; injectable. */
  canRunTools?: (executable: string) => boolean;
  /** Overrides `PI_PYTHON_STRATEGY`. */
  strategy?: PythonStrategy;
  /** The interpreter chosen in Settings, when the caller has it at hand. */
  preferred?: string;
};

/** Same probe order as `resolveBuiltinSkillPath`: packaged, then a checkout. */
function resourceCandidates(options: ResolvePythonOptions): string[] {
  const moduleDir = options.moduleDir ?? getModuleDirectory(import.meta.url);
  const resources = options.resourcesPath ?? process.resourcesPath ?? "";
  return [
    resources ? join(resources, "python") : "",
    join(moduleDir, "../../resources/python"),
    join(moduleDir, "../../../resources/python"),
  ];
}

function executableIn(root: string, platform: NodeJS.Platform): string | null {
  const candidates =
    platform === "win32"
      ? [join(root, RUNTIME_DIR, "python.exe")]
      : [join(root, RUNTIME_DIR, "bin", "python3"), join(root, RUNTIME_DIR, "bin", "python")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Interpreter inside a venv or a prefix the user owns. */
function userInterpreter(root: string, platform: NodeJS.Platform): string | null {
  const candidates =
    platform === "win32"
      ? [join(root, "Scripts", "python.exe"), join(root, "python.exe")]
      : [join(root, "bin", "python3"), join(root, "bin", "python")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Interpreter candidates on `PATH`, in the order the shell would pick them.
 *
 * Only names that are unambiguously CPython: the Microsoft Store aliases
 * (`WindowsApps`) are skipped because they open the store instead of running.
 */
function pathInterpreterCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const names =
    platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  const found: string[] = [];
  for (const directory of pathValue.split(separator)) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    if (platform === "win32" && /\\WindowsApps$/i.test(trimmed)) continue;
    for (const name of names) {
      const candidate = join(trimmed, name);
      if (!existsSync(candidate) || found.includes(candidate)) continue;
      found.push(candidate);
    }
  }
  return found;
}

const versionCache = new Map<string, string | undefined>();

/**
 * Interpreter chosen in Settings, published for callers that build their
 * environment before settings can be read (the host process environment is one).
 */
let preferredPythonPath = "";

export function setPreferredPythonPath(path: string | null | undefined): void {
  const next = (path ?? "").trim();
  if (next === preferredPythonPath) return;
  preferredPythonPath = next;
  versionCache.clear();
  capabilityCache.clear();
}

export function getPreferredPythonPath(): string {
  return preferredPythonPath;
}

/** `major.minor` of an interpreter, or undefined when it cannot be asked. */
export function probePythonVersion(executable: string): string | undefined {
  if (versionCache.has(executable)) return versionCache.get(executable);
  let version: string | undefined;
  try {
    const output = execFileSync(
      executable,
      ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
      { timeout: 8_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = String(output).trim().match(/^(\d+)\.(\d+)$/);
    if (match) version = `${match[1]}.${match[2]}`;
  } catch {
    version = undefined;
  }
  versionCache.set(executable, version);
  return version;
}

/**
 * The libraries the agent's document tools import, in one probe.
 *
 * A system interpreter is only worth preferring when it can already do the work:
 * a bare `python` on `PATH` without openpyxl and pandas would make every
 * spreadsheet read fail, which is worse than the bundled tree it replaced. One
 * subprocess answers the whole question and the answer is cached per executable.
 */
const REQUIRED_LIBRARIES = ["openpyxl", "docx", "pptx", "pandas", "PIL", "pypdf"];
const capabilityCache = new Map<string, boolean>();

export function probePythonCapabilities(executable: string): boolean {
  const cached = capabilityCache.get(executable);
  if (cached !== undefined) return cached;
  let usable = false;
  try {
    execFileSync(
      executable,
      ["-c", REQUIRED_LIBRARIES.map((name) => `import ${name}`).join(";")],
      { timeout: 30_000, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    usable = true;
  } catch {
    usable = false;
  }
  capabilityCache.set(executable, usable);
  return usable;
}

/** The version the bundled libraries were built for, from the bundle manifest. */
function bundledLibraryVersion(root: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")) as {
      python?: unknown;
    };
    const text = typeof manifest.python === "string" ? manifest.python : "";
    const match = text.match(/^(\d+)\.(\d+)/);
    return match ? `${match[1]}.${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

function bundledRuntime(root: string, platform: NodeJS.Platform): PythonRuntime | null {
  const executable = executableIn(root, platform);
  if (!executable) return null;
  return {
    root,
    executable,
    home: join(root, RUNTIME_DIR),
    sitePackages: join(root, SITE_PACKAGES_DIR),
    source: "bundled",
    version: bundledLibraryVersion(root),
    assetsRoot: root,
  };
}

/**
 * The interpreter this installation should run.
 *
 * Ordered by who knows the customer's files best: their explicit choice, the venv
 * they provisioned beside the app's data, their `PATH`, and only then the tree we
 * ship. Each step is probed rather than assumed — a stale `python.exe` that cannot
 * start must not shadow a working interpreter further down.
 */
export function resolvePythonRuntime(
  options: ResolvePythonOptions = {},
): PythonRuntimeStatus {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? probePythonVersion;
  const canRunTools = options.canRunTools ?? probePythonCapabilities;
  const strategy = options.strategy ?? pythonStrategyFromEnv(env);
  const bundledRoots = resourceCandidates(options).filter((root) => root && existsSync(root));
  const bundledAssets = bundledRoots
    .map((root) => bundledRuntime(root, platform))
    .find((runtime) => runtime !== null);
  const bundledVersion = bundledAssets?.version;

  /** Libraries handed to an interpreter that is not the bundled one. */
  const libraryDirFor = (version?: string): string =>
    bundledAssets && bundledVersion && version === bundledVersion
      ? bundledAssets.sitePackages
      : "";

  // An explicit path is a decision, not a hint: honoured under every strategy.
  const explicit = (env.PI_DESKTOP_PYTHON ?? env.PI_AUTOTEST_PYTHON ?? "").trim();
  if (explicit && existsSync(explicit)) {
    const version = probe(explicit);
    return {
      state: "present",
      runtime: {
        root: dirname(explicit),
        executable: explicit,
        home: "",
        sitePackages: libraryDirFor(version),
        source: "explicit",
        version,
        assetsRoot: bundledAssets?.root ?? "",
      },
    };
  }

  // The interpreter picked in Settings. Honoured as given, even without the
  // document libraries: it is a decision, and the card that set it says what the
  // interpreter is missing so the choice stays informed.
  const preferred = (options.preferred ?? preferredPythonPath).trim();
  if (strategy !== "bundled" && preferred && existsSync(preferred)) {
    const version = probe(preferred);
    return {
      state: "present",
      runtime: {
        root: dirname(dirname(preferred)),
        executable: preferred,
        home: "",
        sitePackages: libraryDirFor(version),
        source: "settings",
        version,
        assetsRoot: bundledAssets?.root ?? "",
      },
    };
  }

  if (strategy !== "bundled" && options.dataDir) {
    const venv = join(options.dataDir, "python", "venv");
    const executable = userInterpreter(venv, platform);
    if (executable) {
      const version = probe(executable);
      return {
        state: "present",
        runtime: {
          root: venv,
          executable,
          home: "",
          sitePackages: libraryDirFor(version),
          source: "user-venv",
          version,
          assetsRoot: bundledAssets?.root ?? "",
        },
      };
    }
  }

  for (const executable of strategy === "bundled" ? [] : pathInterpreterCandidates(env, platform)) {
    const version = probe(executable);
    if (!version) continue;
    const [majorText, minorText] = version.split(".");
    const major = Number(majorText);
    const minor = Number(minorText);
    // 3.10 is the floor the agent's own scripts rely on; anything newer is fine.
    if (major !== 3 || !Number.isFinite(minor) || minor < 10) continue;
    // And it must already do the job. A `python` that cannot import openpyxl is
    // not an upgrade over the tree we ship, it is a regression.
    if (!canRunTools(executable)) continue;
    return {
      state: "present",
      runtime: {
        root: dirname(dirname(executable)),
        executable,
        home: "",
        sitePackages: libraryDirFor(version),
        source: "system",
        version,
        assetsRoot: bundledAssets?.root ?? "",
      },
    };
  }

  if (bundledAssets && strategy !== "system") {
    return { state: "present", runtime: bundledAssets };
  }

  for (const root of bundledRoots) {
    if (!executableIn(root, platform)) {
      return {
        state: "missing",
        reason: `${root} exists but has no interpreter at ${RUNTIME_DIR}/`,
      };
    }
  }
  return { state: "missing", reason: "no python interpreter found (bundled tree absent too)" };
}

/**
 * Environment for a child that should see the right libraries.
 *
 * A bundled interpreter needs `PYTHONHOME` pointing at its own prefix and
 * `PYTHONNOUSERSITE` so the customer's per-user installs cannot shadow the pinned
 * ones. A customer's own interpreter needs neither: setting `PYTHONHOME` on it
 * breaks it outright, and suppressing the user site would throw away exactly the
 * libraries that made it worth choosing. Only the library path is shared, and only
 * when the two versions agree (see `PythonRuntime.sitePackages`).
 */
export function pythonEnv(
  runtime: PythonRuntime,
  userSiteDirs: readonly string[] = [],
): NodeJS.ProcessEnv {
  const entries = [
    ...userSiteDirs.filter((dir) => dir.length > 0),
    ...(runtime.sitePackages ? [runtime.sitePackages] : []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Unbuffered so a long-running script's progress reaches the tool output
    // instead of arriving in one block when the process exits.
    PYTHONUNBUFFERED: "1",
  };
  if (entries.length) env.PYTHONPATH = entries.join(delimiter);
  else delete env.PYTHONPATH;
  if (runtime.home) env.PYTHONHOME = runtime.home;
  else delete env.PYTHONHOME;
  if (runtime.source === "bundled") env.PYTHONNOUSERSITE = "1";
  else delete env.PYTHONNOUSERSITE;
  return env;
}

export type ManifestEntry = { path: string; sha256: string; size: number };

export type PythonManifest = {
  schemaVersion: number;
  python: string;
  platform: string;
  wheels: string[];
  files: ManifestEntry[];
};

export async function readManifest(root: string): Promise<PythonManifest | null> {
  const file = join(root, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as PythonManifest).files)
  ) {
    return null;
  }
  return parsed as PythonManifest;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type VerifyResult = {
  checked: number;
  missing: string[];
  corrupted: string[];
};

/**
 * Verify the bundled tree against its manifest.
 *
 * Reading every file costs a few hundred milliseconds on a spinning disk, so
 * the caller runs this off the startup path and only surfaces a result. A
 * missing or altered file means the image is not what the build produced —
 * antivirus quarantine and an interrupted installer both look like this — and
 * the honest answer is to report it rather than to import a library whose
 * binary changed.
 */
export async function verifyPythonRuntime(
  runtime: PythonRuntime,
  options: { limit?: number } = {},
): Promise<VerifyResult> {
  const manifest = await readManifest(runtime.assetsRoot || runtime.root);
  if (!manifest) return { checked: 0, missing: [], corrupted: [] };
  const entries = options.limit ? manifest.files.slice(0, options.limit) : manifest.files;
  const missing: string[] = [];
  const corrupted: string[] = [];
  let checked = 0;
  for (const entry of entries) {
    const file = join(runtime.root, entry.path);
    const info = await statOf(file);
    if (!info) {
      missing.push(entry.path);
      continue;
    }
    if (info !== entry.size) {
      corrupted.push(`${entry.path} (size ${info}, expected ${entry.size})`);
      continue;
    }
    checked += 1;
    if ((await sha256File(file)) !== entry.sha256) corrupted.push(`${entry.path} (hash)`);
  }
  return { checked, missing, corrupted };
}

async function statOf(file: string): Promise<number | null> {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

export type LibraryDropResult =
  | { state: "no-runtime"; reason: string }
  | { state: "idle"; drop: string; site: string }
  | {
      state: "installed";
      drop: string;
      site: string;
      installed: string[];
      blocked: { file: string; reason: string; missing?: string[] }[];
      /** Libraries still needed, with the requirement text that asked for them. */
      missing: { name: string; reasons: string[] }[];
    }
  | { state: "refused"; drop: string; site: string; code: string; error: string; missing: { name: string; reasons: string[] }[] };

/**
 * Drain the user's wheel folder.
 *
 * Deliberately tolerant: this runs at startup, and a failure here must never
 * stop the app from opening. The result is reported so the settings page can
 * show what happened, not thrown.
 */
export async function installDroppedLibraries(
  runtime: PythonRuntime,
  drop: string,
  site: string,
  options: { execFile?: typeof execFile } = {},
): Promise<LibraryDropResult> {
  const run = options.execFile ?? execFile;
  const script = join(runtime.assetsRoot || runtime.root, "tools", LIBRARY_WORKER);
  if (!existsSync(script)) {
    return { state: "no-runtime", reason: `${script} is missing from this build` };
  }
  await mkdir(drop, { recursive: true });
  await mkdir(site, { recursive: true });
  // Nothing to do and no process to pay for: the common case on every launch
  // after the first.
  const pending = (await readdir(drop)).filter((name) => name.toLowerCase().endsWith(".whl"));
  if (!pending.length) return { state: "idle", drop, site };

  const request = JSON.stringify({ action: "install", drop, site });
  const output = await new Promise<string>((resolve, reject) => {
    const child = run(
      runtime.executable,
      [script],
      { env: pythonEnv(runtime, [site]), timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        // A non-zero exit is the worker reporting "refused", which still prints
        // a JSON answer; only a spawn failure has nothing to read.
        if (error && !stdout) reject(error);
        else resolve(String(stdout));
      },
    );
    child.stdin?.end(request);
  });

  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== "object" || parsed === null) {
    return { state: "refused", drop, site, code: "INSTALL_FAILED", error: "unreadable answer", missing: [] };
  }
  const body = parsed as Record<string, unknown>;
  const missing = Array.isArray(body.missing) ? (body.missing as { name: string; reasons: string[] }[]) : [];
  if (body.ok === true) {
    return {
      state: "installed",
      drop,
      site,
      installed: Array.isArray(body.installed) ? (body.installed as string[]) : [],
      blocked: Array.isArray(body.blocked)
        ? (body.blocked as { file: string; reason: string; missing?: string[] }[])
        : [],
      missing,
    };
  }
  return {
    state: "refused",
    drop,
    site,
    code: typeof body.code === "string" ? body.code : "INSTALL_FAILED",
    error: typeof body.error === "string" ? body.error : "the libraries were not installed",
    missing,
  };
}

