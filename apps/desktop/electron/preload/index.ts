import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC, IPC_WHITELIST } from "@pi-workspace/shared/protocol";
// Narrow subpath, not the package barrel: the preload is a single bundled file
// for a sandboxed renderer, so it must not pull the whole shared surface in.
import { decodeStartupAnimationArgument } from "@pi-workspace/shared/startup-animation";

const LOCALE_ARGUMENT_PREFIX = "--pi-desktop-locale=";

function readOsLocale(): string | undefined {
  return process.argv
    .find((argument) => argument.startsWith(LOCALE_ARGUMENT_PREFIX))
    ?.slice(LOCALE_ARGUMENT_PREFIX.length);
}

function assertChannel(channel: string) {
  if (!IPC_WHITELIST.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

const api = {
  invoke: async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    assertChannel(channel);
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  channels: IPC,
  // Synchronous platform info so the renderer can style window chrome
  // (traffic lights on macOS vs. controls overlay on Windows/Linux)
  // before first paint, without an IPC round-trip.
  platform: process.platform,
  // `app.getLocale()` is resolved in the main process and passed as a renderer
  // creation argument. This keeps the locale available before first paint
  // without importing Electron's main-only `app` module in the sandbox.
  locale: readOsLocale(),
  // The boot animation must be on screen in the renderer's first frame, so it
  // arrives the same way the locale does: resolved in main, passed as a
  // creation argument, read synchronously here (D679). Null — no file, the
  // setting off, a later window of the same process — means the brand splash.
  startupAnimation: decodeStartupAnimationArgument(process.argv),
  /** Resolve a real dropped File without exposing Node or Electron to the page. */
  getDroppedFilePath: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopPreloadApi = typeof api;
