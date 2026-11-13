import { existsSync } from "node:fs";
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
