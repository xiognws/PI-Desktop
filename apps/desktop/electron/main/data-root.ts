import { app } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DATA_IDENTIFIER, PI_HOME_SUBDIRECTORIES } from "@pi-workspace/shared";
import {
  adoptDirectory,
  LEGACY_DEVELOPMENT_INSTALLATION_NAME,
  LEGACY_DEVELOPMENT_MAIN_DIR_NAME,
  LEGACY_INSTALLATION_DATA_DIR_NAME,
  LEGACY_INSTALLATION_NAME,
  resolveReleaseDataRoot,
} from "./data-paths";

/** Folder this installation owns on the data drive. */
const ROOT_FOLDER = DATA_IDENTIFIER.replace(/[^a-zA-Z0-9.-]/g, "-");

/** Folder the release before the rename owned on the same drive. */
const LEGACY_ROOT_FOLDER = LEGACY_INSTALLATION_NAME.replace(/[^a-zA-Z0-9.-]/g, "-");

/**
 * Fixed drives other than the one Windows runs from, in letter order.
 *
 * Only the presence of the drive root is checked: a release may create its
 * folder there, and every candidate that exists is a legitimate place to keep
 * data. Network and removable drives are not considered — a mapped share can
 * disappear between launches, and the database must not.
 */
function candidateRoots(): string[] {
  if (process.platform !== "win32") return [];
  const system = (process.env.SystemDrive || "C:").slice(0, 2).toUpperCase();
  const roots: string[] = [];
  for (let code = "D".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code);
    if (`${letter}:` === system) continue;
    if (existsSync(`${letter}:\\`)) roots.push(`${letter}:\\${ROOT_FOLDER}`);
  }
  return roots;
}

/**
 * Point this process at a data root of its own before anything reads a path.
 *
 * A shipped build keeps the database, plugin data, Electron user data (lock
 * file, localStorage, caches) and the Playwright browsers in one folder on a
 * non-system drive. Existing installs are moved over on first launch, and when
 * no such drive exists the previous home-directory layout is kept — starting is
 * more important than where the files live.
 *
 * The folder is named by `DATA_IDENTIFIER`, never by the display name, so
 * rebranding moves nothing. When the identifier itself changes, the whole
 * previous root is adopted in one step: `rename` is atomic and free on the same
 * volume and carries every child — database, userData, plugin data, browsers —
 * at once, where a per-directory copy would leave whichever one it missed
 * behind.
 *
 * Development builds are left alone: they already have their own profile, and a
 * checkout should not seize the release folder.
 */
export function applyReleaseDataRoot(development: boolean): string | null {
  const explicitDataDir = process.env.PI_DESKTOP_DATA_DIR?.trim();
  const explicitRoot = process.env.PI_DESKTOP_DATA_ROOT?.trim();
  const root = resolveReleaseDataRoot({
    override: explicitRoot,
    candidates: candidateRoots(),
  });
  if (!root) return null;

  // Only a root this build named itself can have a predecessor beside it. An
  // explicit PI_DESKTOP_DATA_ROOT is the user's own directory and is used as
  // given: adopting a sibling folder there would be a guess, not a migration.
  if (!explicitRoot) {
    adoptDirectory(root, [join(dirname(root), LEGACY_ROOT_FOLDER)], "data root");
  }

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    console.warn(`[data-root] cannot create ${root}:`, error);
    return null;
  }

  // Publish the root before anything resolves a path. Skills, agent prompts and
  // plugin data all hang off it, and a child process can only honour one answer,
  // so the value is an environment variable rather than a per-caller guess.
  // `data` and `userdata` are deliberately left to the adoption logic below:
  // creating them here would make a legacy profile look like a live one.
  process.env.PI_HOME = root;
  for (const name of PI_HOME_SUBDIRECTORIES) {
    if (name === "data" || name === "userdata") continue;
    try {
      mkdirSync(join(root, name), { recursive: true });
    } catch (error) {
      console.warn(`[data-root] cannot create ${join(root, name)}:`, error);
    }
  }

  const dataDir = join(root, "data");
  // Development keeps its own Electron profile beside the release one: the
  // single-instance lock and renderer storage must not be shared, but neither
  // belongs on the system drive.
  const userData = join(root, development ? "userdata-dev" : "userdata");
  const browsers = join(root, "ms-playwright");

  // An explicit PI_DESKTOP_DATA_DIR is the user's own answer: honour it and
  // only relocate what nothing else pins down. An explicit PI_DESKTOP_DATA_ROOT
  // is the same answer one level up — a root the caller named must not silently
  // inherit a legacy profile, or a test/probe installation starts life with
  // someone else's database in it.
  if (!explicitDataDir && !explicitRoot) {
    adoptDirectory(
      dataDir,
      [
        join(
          homedir(),
          development
            ? LEGACY_DEVELOPMENT_MAIN_DIR_NAME
            : LEGACY_INSTALLATION_DATA_DIR_NAME,
        ),
      ],
      "database",
    );
    process.env.PI_DESKTOP_DATA_DIR = dataDir;
  }
  // `appData` is read defensively: it throws before Electron has resolved the
  // profile paths, and a start-up that cannot name a legacy profile must still
  // launch with the new one instead of failing outright.
  let legacyUserData: string | null = null;
  try {
    legacyUserData = join(
      app.getPath("appData"),
      development
        ? LEGACY_DEVELOPMENT_INSTALLATION_NAME
        : LEGACY_INSTALLATION_NAME,
    );
  } catch (error) {
    console.warn("[data-root] cannot resolve appData; no legacy profile is adopted:", error);
  }
  adoptDirectory(userData, legacyUserData ? [legacyUserData] : [], "user data");
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    adoptDirectory(browsers, [join(localAppData, "ms-playwright")], "browsers");
  }

  if (!app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", userData);
  }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(browsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  }
  console.log(`[data-root] ${root}`);
  return root;
}
