import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
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
 * Three layers, resolved here and nowhere else:
 *
 *   <resources>/python/runtime/        the interpreter, read-only
 *   <resources>/python/site-packages/  the bundled libraries, read-only
 *   <data>/python-site/                the user's own installs, writable, first
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

export type PythonRuntime = {
  /** Root of the bundled tree. */
  root: string;
  /** `python.exe` (or `bin/python3`) inside `root`. */
  executable: string;
  /** The interpreter's prefix, for `PYTHONHOME`. */
  home: string;
  /** Bundled libraries, read-only. */
  sitePackages: string;
};

export type PythonRuntimeStatus =
  | { state: "missing"; reason: string }
  | { state: "present"; runtime: PythonRuntime };

/** Same probe order as `resolveBuiltinSkillPath`: packaged, then a checkout. */
function resourceCandidates(): string[] {
  const moduleDir = getModuleDirectory(import.meta.url);
  return [
    join(process.resourcesPath || "", "python"),
    join(moduleDir, "../../resources/python"),
    join(moduleDir, "../../../resources/python"),
  ];
}

function executableIn(root: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(root, RUNTIME_DIR, "python.exe")]
      : [join(root, RUNTIME_DIR, "bin", "python3"), join(root, RUNTIME_DIR, "bin", "python")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The runtime this build ships, or a reason it is absent.
 *
 * Absence is not an error at this level: a development checkout that has never
 * run the bundle script, and a Linux or macOS build that has no pinned runtime
 * yet, both land here. The caller decides whether that is a degraded feature or
 * a hard failure.
 */
export function resolvePythonRuntime(): PythonRuntimeStatus {
  for (const root of resourceCandidates()) {
    if (!root || !existsSync(root)) continue;
    const executable = executableIn(root);
    if (!executable) {
      return {
        state: "missing",
        reason: `${root} exists but has no interpreter at ${RUNTIME_DIR}/`,
      };
    }
    return {
      state: "present",
      runtime: {
        root,
        executable,
        home: join(root, RUNTIME_DIR),
        sitePackages: join(root, SITE_PACKAGES_DIR),
      },
    };
  }
  return { state: "missing", reason: "no bundled python tree in this build" };
}

/**
 * Environment for a child that should see the bundled libraries.
 *
 * `PYTHONNOUSERSITE` keeps the customer's own `%APPDATA%\\Python` out of the
 * import path: a library they installed for their own projects must not
 * shadow the pinned one every time the agent reads a spreadsheet.
 */
export function pythonEnv(
  runtime: PythonRuntime,
  userSiteDirs: readonly string[] = [],
): NodeJS.ProcessEnv {
  // One ordered list, most specific first: the customer's own installs win over
  // the pinned bundle, and the bundle wins over nothing.
  const entries = [...userSiteDirs.filter((dir) => dir.length > 0), runtime.sitePackages];
  return {
    ...process.env,
    PYTHONHOME: runtime.home,
    PYTHONPATH: entries.join(delimiter),
    PYTHONNOUSERSITE: "1",
    // Unbuffered so a long-running script's progress reaches the tool output
    // instead of arriving in one block when the process exits.
    PYTHONUNBUFFERED: "1",
  };
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
  const manifest = await readManifest(runtime.root);
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
