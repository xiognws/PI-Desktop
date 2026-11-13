import { shell } from "electron";
import { IPC } from "@pi-workspace/shared";
import type { Logger } from "../logger";
import {
  ensureComponentDir,
  listComponents,
  parkComponentDir,
  type UserComponent,
} from "../user-components.ts";
import type { IpcRegistrar } from "./types";

export type ComponentsIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  logger: Pick<Logger, "app">;
};

/** The component names this page may touch; anything else is a renderer bug. */
const COMPONENTS: readonly UserComponent[] = ["gen-ui", "models.dev", "manual"];

function asComponent(value: unknown): UserComponent {
  const name = typeof value === "string" ? value.trim() : "";
  const match = COMPONENTS.find((component) => component === name);
  if (!match) throw new Error("INVALID_PARAMS: unknown component");
  return match;
}

/**
 * Data components the user may override (ADR 0396 § component overlays).
 *
 * The page never reads or writes the filesystem itself: it asks for the state,
 * asks for a folder to be created and opened, and asks for an override to be
 * turned off. Resetting renames rather than deletes, so "restore the shipped
 * one" is as reversible as the override was.
 */
export function registerComponentsIpc({
  registrar,
  dataDir,
  logger,
}: ComponentsIpcDependencies): void {
  registrar.handle(IPC.invoke.componentList, async () => ({
    components: listComponents(dataDir),
  }));

  registrar.handle(IPC.invoke.componentOpen, async (name: unknown) => {
    const component = asComponent(name);
    const dir = ensureComponentDir(dataDir, component);
    const openError = await shell.openPath(dir);
    if (openError) {
      // A machine with no file manager still gets the path, which the page
      // shows so the user can open it themselves.
      logger.app("lifecycle", "warn", "component folder did not open", {
        data: { component, error: openError },
      });
    }
    return { ok: openError === "", path: dir };
  });

  registrar.handle(IPC.invoke.componentReset, async (name: unknown) => {
    const component = asComponent(name);
    const { parked } = parkComponentDir(dataDir, component);
    logger.app("lifecycle", "info", "component override turned off", {
      data: { component, parked },
    });
    return { parked, components: listComponents(dataDir) };
  });
}
