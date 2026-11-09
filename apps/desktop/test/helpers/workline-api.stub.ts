/**
 * SSR stub for the renderer API surface (ADR 0385 test).
 *
 * `WorklineStrip` only reads the host inside an effect, and an effect does not
 * run during `renderToStaticMarkup`; the module still has to import, so the
 * whole IPC layer is replaced with one unreachable read.
 */
export const api = {
  getSessionCollaboration: async () => {
    throw new Error("the workline strip must not read the host during a static render");
  },
};
