import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Data components the install image ships, and the user's own copies of them.
 *
 * `resources/gen-ui`, `resources/models.dev` and `resources/manual` are data, not
 * code: a visualization kit, a model catalog, a handbook. They ship with the
 * application so a first launch has them, but none of them is load-bearing, and
 * "the copy that shipped" is not automatically the copy the user wants — a
 * catalog for a private gateway, a kit with their own components, a handbook
 * they annotated.
 *
 * So the same rule as preinstalled plugins (ADR 0396) applies one level down:
 * the image provides a default, and a file the user puts under
 * `<data>/components/<name>/` wins over it. Nothing is copied, nothing is
 * written, and every file the user did not provide falls back to the image.
 *
 * ```text
 * <data>/components/gen-ui/        ← the user's kit, whole directory
 * <data>/components/models.dev/api.json
 * <data>/components/manual/…
 * ```
 *
 * The directory is whole-cloth: a half-overridden kit would be a kit whose CSS
 * and markup disagree, so a user who overrides `gen-ui` provides all of it.
 */

/** Folder inside the data directory that holds user-provided components. */
export const USER_COMPONENTS_DIR = "components";

/** The component names this mechanism serves today. */
export type UserComponent = "gen-ui" | "models.dev" | "manual";

/** Root of the user's components, whether or not it exists. */
export function userComponentsRoot(dataDir: string): string {
  return join(dataDir, USER_COMPONENTS_DIR);
}

/** Directory for one component, whether or not it exists. */
export function userComponentDir(dataDir: string, name: UserComponent): string {
  return join(userComponentsRoot(dataDir), name);
}

/**
 * A path inside the user's copy of one component, or null when absent.
 *
 * `required` decides what "present" means: a directory needs only to exist, a
 * file needs to be there. Handing back a path that does not resolve would make
 * the caller load nothing and lose the shipped default with it.
 */
export function userComponentPath(
  dataDir: string | null | undefined,
  name: UserComponent,
  ...segments: string[]
): string | null {
  if (!dataDir || !dataDir.trim()) return null;
  const target = join(userComponentDir(dataDir, name), ...segments);
  return existsSync(target) ? target : null;
}

/**
 * Where the data directory is, without importing Electron.
 *
 * `index.ts` publishes `PI_DESKTOP_DATA_DIR` before anything resolves a path
 * (the plugin runtime reads the same variable), so a module that only needs the
 * root can stay Electron-free and unit-testable.
 */
export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PI_DESKTOP_DATA_DIR ?? "").trim();
}

/** What a component needs on disk before it counts as provided. */
const REQUIRED_FILE: Record<UserComponent, string | null> = {
  "gen-ui": "visualize.css",
  "models.dev": "api.json",
  manual: null,
};

/** One component as the settings page shows it. */
export type ComponentStatus = {
  name: UserComponent;
  /** Where the user's copy goes (created on demand by the settings page). */
  userDir: string;
  /** True when a user copy is complete enough to be used. */
  overridden: boolean;
  /** True when the user's directory exists at all (complete or not). */
  present: boolean;
};

/**
 * The three components, with the state each one is in.
 *
 * `overridden` is not "the directory exists": a `gen-ui` folder without its
 * stylesheet or a `manual` folder without a handbook changes nothing, and the
 * page must not claim it does.
 */
export function listComponents(dataDir: string): ComponentStatus[] {
  const names: UserComponent[] = ["gen-ui", "models.dev", "manual"];
  return names.map((name) => {
    const dir = userComponentDir(dataDir, name);
    const present = existsSync(dir);
    const required = REQUIRED_FILE[name];
    const overridden = required
      ? existsSync(join(dir, required))
      : present && existsSync(dir) && directoryHasHandbook(dir);
    return { name, userDir: dir, overridden, present };
  });
}

function directoryHasHandbook(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => /^Pi-Workspace-.*\.md$/i.test(entry));
  } catch {
    return false;
  }
}

/** Create the component's directory if needed and hand back its path. */
export function ensureComponentDir(dataDir: string, name: UserComponent): string {
  const dir = userComponentDir(dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Turn off a user override without destroying it.
 *
 * Renaming beats deleting: the files are the user's work, and "restore the
 * shipped one" has to be as reversible as the override was. The directory stays
 * beside the component with a timestamp, so it is findable and can be renamed
 * back.
 */
export function parkComponentDir(
  dataDir: string,
  name: UserComponent,
): { parked: string | null; dir: string } {
  const dir = userComponentDir(dataDir, name);
  if (!existsSync(dir)) return { parked: null, dir };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let parked = `${dir}.disabled-${stamp}`;
  let attempt = 1;
  // A second reset within the same millisecond must not overwrite the first.
  while (existsSync(parked)) {
    parked = `${dir}.disabled-${stamp}-${attempt++}`;
  }
  renameSync(dir, parked);
  return { parked, dir };
}

