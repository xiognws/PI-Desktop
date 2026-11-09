/**
 * Minimal `electron` stub for importing main-process TypeScript under
 * `node --test`: the capability IPC bridge only needs the modules it touches,
 * and opening a file manager window is a recording no-op.
 */
export const shell = {
  showItemInFolder: (path) => {
    globalThis.__revealedCapabilityPaths?.push(path);
  },
  openPath: async () => "",
  openExternal: async () => undefined,
};

export const app = {
  getAppPath: () => process.cwd(),
  getPath: () => process.cwd(),
  getVersion: () => "0.0.0",
  isPackaged: false,
};
