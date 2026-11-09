/**
 * Redirect `import ... from "electron"` to a local stub so the capability IPC
 * bridge can be imported by `node --test` outside an Electron process.
 */
const STUB = new URL("./capabilities-electron-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}
