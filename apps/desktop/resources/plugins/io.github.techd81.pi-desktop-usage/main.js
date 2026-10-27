"use strict";

/**
 * PI-Desktop plugin entry point.
 *
 * The host injects the plugin API as `globalThis.pi` and expects CommonJS
 * exports named `onLoad`, `onUnload` and `onPanelInvoke`. Everything real lives
 * in `src/backend.js`; this file only bridges the lifecycle and never throws
 * into the host.
 */

const { createBackend } = require("./src/backend.js");

const COMMAND_ID = "usage.openPanel";
const SHORTCUT_ID = "usage.openPanel.shortcut";
const SHORTCUT_ACCELERATOR = "Mod+Shift+U";

/** @type {ReturnType<typeof createBackend> | null} */
let backend = null;

function resolveBackend() {
  if (backend) return backend;
  const pi = /** @type {any} */ (globalThis).pi;
  backend = createBackend({ pi });
  return backend;
}

/** @returns {any} the host API, or null outside PI-Desktop */
function host() {
  return /** @type {any} */ (globalThis).pi ?? null;
}

/**
 * A palette command that opens the panel window, plus the same command bound to
 * a global shortcut. The docked view in the work panel is unaffected: it comes
 * from `contributes.views` and the host opens it on its own.
 */
async function registerCommand() {
  const pi = host();
  if (!pi?.commands?.register || !pi?.ui?.openPanel) return;
  await pi.commands.register({
    id: COMMAND_ID,
    title: "用量统计: 打开面板",
    keywords: ["usage", "token", "cost", "用量", "统计"],
    run: async () => {
      await pi.ui.openPanel({ title: "用量统计" });
    },
  });
  try {
    await pi.keyboard?.registerGlobalShortcut?.({
      id: SHORTCUT_ID,
      accelerator: SHORTCUT_ACCELERATOR,
      command: COMMAND_ID,
    });
  } catch (error) {
    // A taken accelerator only costs the shortcut, never the panel.
    console.error(
      `[pi-desktop-usage] shortcut unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function onLoad() {
  try {
    resolveBackend();
    // Loading must stay cheap: the cache is opened lazily on the first panel call.
    await registerCommand();
  } catch (error) {
    console.error(`[pi-desktop-usage] load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function onUnload() {
  try {
    await host()?.keyboard?.unregisterGlobalShortcut?.(SHORTCUT_ID);
  } catch {
    // A shortcut that cannot be removed must not block teardown.
  }
  try {
    await host()?.commands?.unregister?.(COMMAND_ID);
  } catch {
    // A command that cannot be removed must not block teardown.
  }
  try {
    // Waits for a pass in flight, so two plugin generations never write the same
    // cache at once.
    await backend?.dispose();
  } catch {
    // Never throw during teardown.
  }
  backend = null;
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
async function onPanelInvoke(channel, payload) {
  try {
    return await resolveBackend().invoke(String(channel), payload);
  } catch (error) {
    return {
      ok: false,
      code: "FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
