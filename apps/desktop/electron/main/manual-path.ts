import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirFromEnv, userComponentPath } from "./user-components.ts";

const HANDBOOK_PATTERN = /^Pi-Workspace-.*\.md$/i;

/**
 * The built Main output directory that owns `moduleUrl`.
 *
 * Rollup emits Main as `out/main/index.js` plus shared chunks under
 * `out/main/chunks/`; collapse the `chunks` segment so packaging-relative
 * lookups do not inherit the chunk nesting.
 */
function moduleDirectory(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (basename(directory) === "chunks") directory = dirname(directory);
  return directory;
}

/**
 * Resolve the handbook that shipped with this build.
 *
 * electron-builder copies `apps/desktop/resources/manual` to `<resources>/manual`
 * (see `scripts/stage-desktop-manual.mjs`); a source checkout reaches the same
 * staged tree relatively, so development and packaged builds resolve alike.
 *
 * Deliberately free of Electron imports so it is unit-testable outside the app.
 */
export function resolveManualPath(
  moduleUrl: string = import.meta.url,
  resourcesPath: string = process.resourcesPath || "",
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // A handbook the user provided wins over the shipped one: the shipped file is
  // a starting point, not the edition they want to read in-app.
  const moduleDir = moduleDirectory(moduleUrl);
  const userRoot = userComponentPath(dataDirFromEnv(env), "manual");
  const roots = [
    ...(userRoot ? [userRoot] : []),
    join(resourcesPath, "manual"),
    join(moduleDir, "../../resources/manual"),
    join(moduleDir, "../../../resources/manual"),
  ];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const handbook = readdirSync(root).find((name) => HANDBOOK_PATTERN.test(name));
    if (handbook) return join(root, handbook);
  }
  return null;
}
