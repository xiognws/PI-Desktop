import { shell } from "electron";
import { IPC } from "@pi-workspace/shared";
import { resolveManualPath } from "../manual-path";
import type { IpcRegistrar } from "./types";

export type ManualIpcDependencies = {
  registrar: IpcRegistrar;
  stripWinLongPrefix: (path: string) => string;
};

/**
 * Register the Info panel's handbook entry point.
 *
 * The document is handed to whatever the operating system uses to display
 * Markdown, so the reader is the user's own viewer rather than something this
 * app renders. A fresh Windows install often has no Markdown handler, so a
 * failed hand-off degrades to selecting the file in Explorer instead of
 * erroring.
 */
export function registerManualIpc({ registrar, stripWinLongPrefix }: ManualIpcDependencies): void {
  registrar.handle(IPC.invoke.manualOpen, async () => {
    const manual = resolveManualPath();
    if (!manual) {
      throw new Error("manual not found in this build");
    }
    const openError = await shell.openPath(stripWinLongPrefix(manual));
    if (openError) {
      shell.showItemInFolder(stripWinLongPrefix(manual));
    }
    return { ok: true, path: manual };
  });
}
