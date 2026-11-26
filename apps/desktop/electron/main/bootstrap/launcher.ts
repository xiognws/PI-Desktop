import { app, BrowserWindow, globalShortcut, screen } from "electron";
import { join } from "node:path";
import { getModuleDirectory } from "../module-path";
import {
  APP_NAME,
  IPC,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  type KeybindingOverrides,
  type ShortcutPlatform,
} from "@pi-workspace/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import { loadLauncherSurface } from "../launcher-surface-load";
import { attachRendererConsoleLogging } from "../renderer-console";
import type { WindowLifecycleState } from "./window";
import { suppressLinuxFramelessSystemMenu } from "../frameless-system-menu";
import {
  PLUGIN_LAUNCHER_MAX_HEIGHT,
  PLUGIN_LAUNCHER_MAX_WIDTH,
  PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
  PLUGIN_LAUNCHER_MIN_WIDTH,
  readLauncherWindowState,
  resolveLauncherBounds,
  writeLauncherWindowState,
} from "../plugin-launcher-state";

export type LauncherState = {
  creationPromise: Promise<BrowserWindow> | null;
  pluginLauncherAccelerator: string | null;
  toggleWindowAccelerator: string | null;
};

export type LauncherDependencies = {
  state: WindowLifecycleState;
  launcherState: LauncherState;
  appState: { applicationBooted: boolean };
  getHost: () => HostProcess | null;
  logger: Pick<Logger, "app">;
  safeOpenExternal: (rawUrl: unknown) => Promise<void>;
  toggleMainWindow: () => void;
  /** Where `plugin-launcher-state.json` lives (ADR 0090 shell-state rule). */
  dataDir: string;
};

/**
 * Bindings the app currently spends on a process-wide accelerator, keyed by the
 * shortcut id that owns them. The plugin shortcut registry reads this, so a
 * plugin is refused an accelerator the app already holds and gets it back once
 * the user rebinds the app shortcut away.
 */
const hostGlobalBindings = new Map<string, string>();

/**
 * How long the launcher's first navigation waits before it is tried again.
 *
 * The warm-up races boot; a retry a fraction of a second later lands on a settled
 * process. Three attempts at this spacing cover a slow start without holding the
 * window for a second when the failure is real.
 */
const LAUNCHER_LOAD_RETRY_MS = 700;

/** Live view of the app's own global accelerators, for the plugin runtime. */
export function hostGlobalShortcutBindings(): string[] {
  return [...hostGlobalBindings.values()];
}

function recordHostGlobalBinding(id: string, binding: string | null): void {
  if (binding) hostGlobalBindings.set(id, binding);
  else hostGlobalBindings.delete(id);
}

export function createLauncher({
  state,
  launcherState,
  appState,
  getHost,
  logger,
  safeOpenExternal,
  toggleMainWindow,
  dataDir,
}: LauncherDependencies) {
  /** Debounced write of the panel's own size and position. */
  let persistBoundsTimer: ReturnType<typeof setTimeout> | null = null;

  function launcherWorkArea() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  }

  /**
   * Bounds to open with: the size the user dragged to, kept only when the saved
   * position still lands inside the display the panel is opening on. A display
   * that was unplugged must not leave the panel off-screen (ADR 0090).
   */
  function pluginLauncherBounds() {
    return resolveLauncherBounds(
      readLauncherWindowState(dataDir),
      launcherWorkArea(),
    );
  }

  function persistPluginLauncherBounds(window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) {
      return;
    }
    writeLauncherWindowState(dataDir, window.getBounds());
  }

  function flushPluginLauncherBounds(window: BrowserWindow): void {
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer);
      persistBoundsTimer = null;
    }
    persistPluginLauncherBounds(window);
  }

  function schedulePluginLauncherBounds(window: BrowserWindow): void {
    if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
    persistBoundsTimer = setTimeout(() => {
      persistBoundsTimer = null;
      persistPluginLauncherBounds(window);
    }, 400);
    persistBoundsTimer.unref?.();
  }

  function createPluginLauncherWindow(): Promise<BrowserWindow> {
    if (launcherState.creationPromise) return launcherState.creationPromise;
    if (state.pluginLauncherWindow && !state.pluginLauncherWindow.isDestroyed()) {
      return Promise.resolve(state.pluginLauncherWindow);
    }

    const creation = (async () => {
      const window = new BrowserWindow({
        ...pluginLauncherBounds(),
        title: `${APP_NAME} Plugin Launcher`,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        // The user drags this panel wider to fit their own grid; the eight
        // columns stay aligned from the minimum width up.
        resizable: true,
        minWidth: PLUGIN_LAUNCHER_MIN_WIDTH,
        // Height follows the measured content, so only the floor is set here;
        // the renderer reports the real height on show.
        minHeight: PLUGIN_LAUNCHER_MIN_CONTENT_HEIGHT,
        maxWidth: PLUGIN_LAUNCHER_MAX_WIDTH,
        maxHeight: PLUGIN_LAUNCHER_MAX_HEIGHT,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        autoHideMenuBar: true,
        ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: join(getModuleDirectory(import.meta.url), "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`],
        },
      });
      state.pluginLauncherWindow = window;
      suppressLinuxFramelessSystemMenu(window);
      // The launcher is its own web contents; without this subscription its
      // console failures never reach the diagnostics log.
      attachRendererConsoleLogging(window.webContents, logger, "plugin-launcher");

      if (process.platform === "darwin") {
        // Join every Space and float above this app's own fullscreen window, but
        // never let Electron transform the process type. Without
        // `skipTransformProcessType`, `visibleOnFullScreen` runs
        // TransformProcessType(kProcessTransformToUIElementApplication) on the
        // whole process, which removes Pi-Workspace from the Dock and Cmd+Tab for
        // as long as this window exists — and the launcher is prewarmed during
        // boot, so that would apply to every session (ADR 0086).
        window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      window.webContents.setWindowOpenHandler(({ url }) => {
        void safeOpenExternal(url).catch(() => undefined);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        const devOrigin = process.env.ELECTRON_RENDERER_URL;
        if (devOrigin && url.startsWith(devOrigin)) return;
        event.preventDefault();
      });
      window.on("resize", () => schedulePluginLauncherBounds(window));
      window.on("move", () => schedulePluginLauncherBounds(window));
      window.on("blur", () => {
        if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) {
          // Persist before hiding: the panel is only ever hidden, never closed,
          // so a size the user dragged stays until shutdown flushes again.
          flushPluginLauncherBounds(window);
          window.hide();
        }
      });
      window.on("close", () => flushPluginLauncherBounds(window));
      window.on("closed", () => {
        if (state.pluginLauncherWindow === window) state.pluginLauncherWindow = null;
      });

      // A surface that fails to load must say why: this window is the only route
      // into a plugin's own panel, so "warm-up failed" without a code, a URL and
      // whether the renderer went away is not enough to act on.
      const failure: { current: { code: number; description: string; url: string } | null } = {
        current: null,
      };
      window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        if (isMainFrame === false) return;
        failure.current = { code, description, url };
        logger.app("diagnostics", "warn", "plugin.launcher.load.failed", {
          data: { code, description, url },
        });
      });
      window.webContents.on("render-process-gone", (_event, details) => {
        logger.app("diagnostics", "warn", "plugin.launcher.renderer.gone", { data: details });
      });

      try {
        // The surface travels in the HASH, not the query string.
        //
        // A packaged renderer is loaded from inside `app.asar`, and Electron's file
        // handler resolves that path itself — a `?query` on it made Chromium fail the
        // load outright in a packaged build (`ERR_FAILED (-2)` on
        // `file://…/app.asar/out/renderer/index.html?surface=plugin-launcher`), so the
        // warm-up logged a failure on every boot and the launcher opened late or not
        // at all. A fragment never takes part in path resolution, so it works in both
        // the dev server and the asar.
        //
        // The fragment fixed the every-boot failure, not every failure: the warm-up
        // runs while boot is still allocating the first window and the plugin host, and
        // on a small fraction of starts the navigation is aborted within milliseconds
        // (`ERR_FAILED (-2)`) and the same load succeeds on the next attempt. Without
        // that retry the launcher stays unbuilt for the session, which the user reads as
        // "the plugin panels do nothing". See `launcher-surface-load.ts`.
        await loadLauncherSurface(
          () => {
            if (process.env.ELECTRON_RENDERER_URL) {
              const url = new URL(process.env.ELECTRON_RENDERER_URL);
              url.hash = "surface=plugin-launcher";
              return window.loadURL(url.toString());
            }
            return window.loadFile(
              join(getModuleDirectory(import.meta.url), "../renderer/index.html"),
              { hash: "surface=plugin-launcher" },
            );
          },
          {
            delayMs: LAUNCHER_LOAD_RETRY_MS,
            onRetry: ({ attempt, error }) =>
              logger.app("diagnostics", "warn", "plugin launcher load retry", {
                data: { attempt, error: String(error), lastFailure: failure.current },
              }),
          },
        );
        return window;
      } catch (error) {
        logger.app("diagnostics", "error", "plugin launcher warm-up failed", {
          data: { error: String(error), lastFailure: failure.current },
        });
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    })();

    launcherState.creationPromise = creation;
    void creation.then(
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
      () => {
        if (launcherState.creationPromise === creation) {
          launcherState.creationPromise = null;
        }
      },
    );
    return creation;
  }

  function prewarmPluginLauncher(): void {
    void createPluginLauncherWindow().catch((error) => {
      logger.app("diagnostics", "warn", "plugin launcher warm-up failed", {
        data: String(error),
      });
    });
  }

  async function showPluginLauncher(): Promise<void> {
    if (!appState.applicationBooted) return;
    const window = await createPluginLauncherWindow();
    if (window.isDestroyed()) return;
    window.setBounds(pluginLauncherBounds(), false);
    window.show();
    // `show()` already activates and focuses a macOS panel. Avoid a second
    // native focus/activation and window-stack move there; each adds visible
    // compositor work when another app owns the foreground window. Windows and
    // Linux retain the explicit focus and move for their frameless utility
    // window.
    if (process.platform !== "darwin") {
      window.focus();
      window.moveTop();
    }
    window.webContents.send(IPC.event.pluginLauncherShown);
  }

  async function togglePluginLauncher(): Promise<void> {
    const window = state.pluginLauncherWindow;
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.hide();
      return;
    }
    await showPluginLauncher();
  }

  function applyPluginLauncherShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "openPluginLauncher",
    );
    if (!shortcut || !app.isReady()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);
    state.pluginLauncherBinding = binding;
    recordHostGlobalBinding("openPluginLauncher", binding);

    if (process.platform === "win32" && getHost()?.isAvailable()) {
      void getHost()!
        .call("keyboard.setGlobalShortcut", { binding })
        .catch((error) =>
          logger.app("diagnostics", "warn", "Windows global shortcut mode update failed", {
            data: String(error),
          }),
        );
    }

    if (launcherState.pluginLauncherAccelerator && launcherState.pluginLauncherAccelerator !== accelerator) {
      globalShortcut.unregister(launcherState.pluginLauncherAccelerator);
      launcherState.pluginLauncherAccelerator = null;
    }

    // Windows reserves Alt+Space for the active window system menu. The
    // host-core low-level hook owns this exact binding so it still works while
    // another application is focused; do not ask Electron to register it too.
    if (process.platform === "win32" && binding === "Alt+Space") return;
    if (!accelerator || accelerator === launcherState.pluginLauncherAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      void togglePluginLauncher().catch((error) =>
        logger.app("diagnostics", "error", "plugin launcher shortcut failed", {
          data: String(error),
        }),
      );
    });
    if (registered) {
      launcherState.pluginLauncherAccelerator = accelerator;
    } else {
      logger.app("diagnostics", "error", "plugin launcher shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }

  /**
   * Register the merged window toggle (D438, rebound by D439). The default
   * `Alt+Shift+W` runs the same toggle the menu item and the renderer run: it
   * hides the window the user is looking at, or brings a hidden/minimized-to-tray
   * window back into focus. The key is process-wide, so it deliberately avoids
   * `Mod+W` — macOS spends that chord on its own close-window command. The
   * retired `Mod+Shift+W` summon binding is not registered either.
   */
  function applyToggleWindowShortcut(keybindings?: KeybindingOverrides) {
    const shortcut = KEYBOARD_SHORTCUTS.find(
      (candidate) => candidate.id === "toggleWindow",
    );
    if (!shortcut || !app.isReady()) return;
    const platform: ShortcutPlatform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : "linux";
    const binding = resolveKeybinding(shortcut, keybindings, platform);
    const accelerator = keybindingToElectronAccelerator(binding, platform);
    recordHostGlobalBinding("toggleWindow", binding);

    if (launcherState.toggleWindowAccelerator && launcherState.toggleWindowAccelerator !== accelerator) {
      globalShortcut.unregister(launcherState.toggleWindowAccelerator);
      launcherState.toggleWindowAccelerator = null;
    }

    if (!accelerator || accelerator === launcherState.toggleWindowAccelerator) return;
    const registered = globalShortcut.register(accelerator, () => {
      toggleMainWindow();
    });
    if (registered) {
      launcherState.toggleWindowAccelerator = accelerator;
    } else {
      logger.app("diagnostics", "warn", "window toggle shortcut unavailable", {
        data: { accelerator, platform: process.platform },
      });
    }
  }


  return {
    pluginLauncherBounds,
    createPluginLauncherWindow,
    prewarmPluginLauncher,
    showPluginLauncher,
    togglePluginLauncher,
    applyPluginLauncherShortcut,
    applyToggleWindowShortcut,
  };
}
