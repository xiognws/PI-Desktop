/**
 * IPC channel names for in-app providers.
 *
 * Main owns the authoritative list (`electron/main/providers/ipc.ts`). The
 * renderer may not import Main implementation modules, so the strings live here
 * as well and `test/in-app-providers.test.mjs` asserts both lists are identical.
 */
export const IN_APP_PROVIDER_CHANNELS = {
  list: "pi-desktop/in-app-providers/list",
  credits: "pi-desktop/in-app-providers/credits",
  setEnabled: "pi-desktop/in-app-providers/set-enabled",
} as const;
