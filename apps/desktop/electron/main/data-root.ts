import { app } from "electron";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { APP_NAME } from "@pi-desktop/shared";
import { resolveReleaseDataRoot } from "./data-paths";
import { applyHomeLinks, dropDanglingHomeLinks, HOME_LINK_DIRS, planHomeLinks } from "./data-root-home";

/** Folder this installation owns on the data drive. */
const ROOT_FOLDER = APP_NAME.replace(/[^a-zA-Z0-9.-]/g, "-");

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

/** Copy a legacy location into the new root once, so the move loses nothing. */
function migrate(from: string, to: string, label: string): void {
  if (existsSync(to)) return;
  if (!existsSync(from)) return;
  try {
    cpSync(from, to, { recursive: true });
    console.log(`[data-root] migrated ${label}: ${from} -> ${to}`);
  } catch (error) {
    console.warn(`[data-root] could not migrate ${label} (${from}):`, error);
  }
}

/**
 * Point this process at a data root of its own before anything reads a path.
 *
 * A shipped build keeps the database, plugin data, Electron user data (lock
 * file, localStorage, caches) and the Playwright browsers in one folder on a
 * non-system drive. Global skills and subagents move there as well, and the home
 * directories that plugins write to on their own are linked onto the same root,
 * so a single folder holds everything this installation produces. Existing
 * installs are copied over on first launch, and when no such drive exists the
 * previous home-directory layout is kept — starting is more important than where
 * the files live.
 *
 * A development build claims the same root but its own Electron profile
 * (`userdata-dev`), so it never seizes the release folder's lock or storage.
 */
export function applyReleaseDataRoot(development: boolean): string | null {
  const explicitDataDir = process.env.PI_DESKTOP_DATA_DIR?.trim();
  const root = resolveReleaseDataRoot({
    override: process.env.PI_DESKTOP_DATA_ROOT,
    candidates: candidateRoots(),
  });
  if (!root) {
    // No data drive right now. A link from a previous launch would point at a
    // directory that is gone, and writing through it fails instead of falling
    // back, so the link goes and the home layout below takes over again.
    dropDanglingHomeLinks(homedir());
    return null;
  }

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    console.warn(`[data-root] cannot create ${root}:`, error);
    return null;
  }

  const dataDir = join(root, "data");
  // Development keeps its own Electron profile beside the release one: the
  // single-instance lock and renderer storage must not be shared, but neither
  // belongs on the system drive.
  const userData = join(root, development ? "userdata-dev" : "userdata");
  const browsers = join(root, "ms-playwright");

  // An explicit PI_DESKTOP_DATA_DIR is the user's own answer: honour it and
  // only relocate what nothing else pins down.
  if (!explicitDataDir) {
    migrate(
      join(homedir(), development ? ".pi-desktop-dev-main" : ".pi-desktop"),
      dataDir,
      "database",
    );
    process.env.PI_DESKTOP_DATA_DIR = dataDir;
  }
  migrate(
    join(app.getPath("appData"), development ? `${APP_NAME} Dev` : APP_NAME),
    userData,
    "user data",
  );
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) migrate(join(localAppData, "ms-playwright"), browsers, "browsers");

  // Everything else this installation owns is reachable from the home directory:
  // global skills and subagents through `PI_DESKTOP_AGENTS_DIR`, and the state
  // some bundled plugins resolve with `os.homedir()` through a link. Both belong
  // on the data drive, and an explicit `PI_DESKTOP_AGENTS_DIR` stays the caller's
  // own answer, exactly like `PI_DESKTOP_DATA_DIR`.
  const home = homedir();
  const agentsPinned = Boolean(process.env.PI_DESKTOP_AGENTS_DIR?.trim());
  if (!agentsPinned) process.env.PI_DESKTOP_AGENTS_DIR = join(root, "agents");
  applyHomeLinks(
    planHomeLinks({
      home,
      root,
      dataDir: process.env.PI_DESKTOP_DATA_DIR?.trim() || dataDir,
    }).filter((link) => !(agentsPinned && link.home === join(home, HOME_LINK_DIRS.agents))),
  );

  if (!app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", userData);
  }
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(browsers)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  }
  console.log(`[data-root] ${root}`);
  return root;
}
