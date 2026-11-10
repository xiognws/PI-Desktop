import { shell } from "electron";
import { IPC } from "@pi-workspace/shared";
import { resolveManualPath } from "../manual-path";
import type { IpcRegistrar } from "./types";

export type ManualIpcDependencies = {
  registrar: IpcRegistrar;
  stripWinLongPrefix: (path: string) => string;
};

/** Register the About panel's handbook entry point. */
export function registerManualIpc({ registrar, stripWinLongPrefix }: ManualIpcDependencies): void {
  registrar.handle(IPC.invoke.manualOpen, async () => {
    const manual = resolveManualPath();
    if (!manual) {
      throw new Error("manual not found in this build");
    }
    const openError = await shell.openPath(stripWinLongPrefix(manual));
    if (openError) {
      // A fresh Windows install often has no Markdown handler. Selecting the
      // file in Explorer still lands the user on the handbook, so the entry
      // point degrades instead of failing.
      shell.showItemInFolder(stripWinLongPrefix(manual));
    }
    return { ok: true, path: manual };
  });
}
