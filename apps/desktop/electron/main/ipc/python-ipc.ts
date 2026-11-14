import { BrowserWindow, dialog } from "electron";
import { existsSync } from "node:fs";

import { IPC } from "@pi-workspace/shared";

import { readPythonInterpreterPreference, writePythonInterpreterPreference } from "../python-preferences.ts";
import {
  getPreferredPythonPath,
  probePythonCapabilities,
  probePythonVersion,
  resolvePythonRuntime,
  setPreferredPythonPath,
  type PythonRuntimeStatus,
} from "../python-runtime.ts";
import { scanPythonInstallations, type PythonCandidate } from "../python-scan.ts";
import type { IpcRegistrar } from "./types";

export type PythonIpcDependencies = {
  registrar: IpcRegistrar;
  dataDir: string;
  /** Host RPC, so the choice lands in settings as well as in the mirror file. */
  callHost?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

export type PythonStatusPayload = {
  /** What the next launch would run. */
  active: {
    path: string;
    version?: string;
    source: string;
    sitePackages: string;
  } | null;
  /** The user's choice, or empty when the app picks for them. */
  configured: string;
  /** Whether the configured file still exists; false makes the card offer a rescan. */
  configuredUsable: boolean;
};

function describe(status: PythonRuntimeStatus, configured: string): PythonStatusPayload {
  return {
    active:
      status.state === "present"
        ? {
            path: status.runtime.executable,
            version: status.runtime.version,
            source: status.runtime.source,
            sitePackages: status.runtime.sitePackages,
          }
        : null,
    configured,
    configuredUsable: configured.length > 0 && existsSync(configured),
  };
}

/**
 * Settings → System → Python.
 *
 * Four calls, no switch: the app always runs *some* interpreter, so the only
 * decision is which. `status` answers what that is now, `scan` lists what this
 * machine has, `choose` opens a file dialog for one that was not found, and
 * `setPath` stores the answer (`""` returns to automatic).
 */
export function registerPythonIpc({ registrar, dataDir, callHost }: PythonIpcDependencies): void {
  registrar.handle(IPC.invoke.pythonStatus, async () => {
    const configured = readPythonInterpreterPreference(dataDir) || getPreferredPythonPath();
    return describe(resolvePythonRuntime({ dataDir, preferred: configured }), configured);
  });

  registrar.handle(IPC.invoke.pythonScan, async () => {
    const configured = readPythonInterpreterPreference(dataDir) || getPreferredPythonPath();
    const candidates = scanPythonInstallations({ dataDir, configured });
    return { candidates, configured };
  });

  registrar.handle(IPC.invoke.pythonChoose, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const filters =
      process.platform === "win32"
        ? [{ name: "Python", extensions: ["exe"] }]
        : [{ name: "All files", extensions: ["*"] }];
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openFile"], filters })
      : await dialog.showOpenDialog({ properties: ["openFile"], filters });
    const path = result.canceled ? "" : (result.filePaths[0] ?? "");
    return { path, version: path ? probePythonVersion(path) : undefined };
  });

  registrar.handle(IPC.invoke.pythonSetPath, async (input?: unknown) => {
    const raw = input && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
    const path = typeof raw === "string" ? raw.trim() : "";
    // Mirrored first: the next launch resolves the interpreter before host-core
    // can answer, and this file is what that read sees.
    writePythonInterpreterPreference(dataDir, path);
    setPreferredPythonPath(path);
    if (callHost) {
      // The setting is the durable copy; the mirror only survives it.
      await callHost("settings.set", { pythonInterpreterPath: path }).catch(() => undefined);
    }
    return describe(resolvePythonRuntime({ dataDir, preferred: path }), path);
  });

  registrar.handle(IPC.invoke.pythonCapabilities, async (input?: unknown) => {
    const path = input && typeof input === "object" ? (input as { path?: unknown }).path : undefined;
    if (typeof path !== "string" || !path.trim()) {
      return { path: "", version: undefined, hasLibraries: false };
    }
    return {
      path,
      version: probePythonVersion(path),
      hasLibraries: probePythonCapabilities(path),
    };
  });
}

export type { PythonCandidate };
