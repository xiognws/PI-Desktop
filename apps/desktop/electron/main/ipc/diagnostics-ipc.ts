import { app, dialog, shell } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "@pi-workspace/shared";
import type { BrowserWindow, SaveDialogOptions } from "electron";
import {
  exportDiagnosticsBundle,
  readCounts,
  type HostCaller,
} from "../diagnostics/export.ts";
import type { IpcRegistrar } from "./types";

export type DiagnosticsIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  stripWinLongPrefix: (path: string) => string;
  isDeveloperMode: () => boolean;
  getMainWindow: () => BrowserWindow | null;
  /** The local service; null while it is down, which the bundle then reports. */
  getHost: () => HostCaller | null;
};

/** Register developer diagnostics and log navigation channels. */
export function registerDiagnosticsIpc({
  registrar,
  dataDir,
  stripWinLongPrefix,
  isDeveloperMode,
  getMainWindow,
  getHost,
}: DiagnosticsIpcDependencies): void {
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, fn);
  };
  handle(IPC.invoke.logOpenFolder, async () => {
    const logs = join(dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    await shell.openPath(stripWinLongPrefix(logs));
    return { ok: true, path: logs };
  });

  /**
   * Save a support bundle. The user picks the destination: the point of the file
   * is to be attached somewhere else, and the app should not decide where a copy
   * of its own diagnostics is allowed to live.
   */
  handle(IPC.invoke.diagnosticsExport, async () => {
    return exportDiagnosticsBundle({
      dataDir,
      appVersion: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      readCounts: () => readCounts(getHost()),
      chooseTarget: async (suggestedName) => {
        const options: SaveDialogOptions = {
          defaultPath: join(app.getPath("downloads"), suggestedName),
          filters: [{ name: "Zip archive", extensions: ["zip"] }],
        };
        const owner = getMainWindow();
        const picked =
          owner && !owner.isDestroyed()
            ? await dialog.showSaveDialog(owner, options)
            : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) return null;
        return stripWinLongPrefix(picked.filePath);
      },
    });
  });

  handle(IPC.invoke.devtoolsToggle, async (input: unknown) => {
    if (!isDeveloperMode()) throw new Error("developer mode is disabled");
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("window unavailable");
    }
    const contents = mainWindow.webContents;
    const desired = (input as { open?: unknown } | null)?.open;
    const open =
      typeof desired === "boolean" ? desired : !contents.isDevToolsOpened();
    if (open) contents.openDevTools({ mode: "detach" });
    else contents.closeDevTools();
    return { open };
  });
}
