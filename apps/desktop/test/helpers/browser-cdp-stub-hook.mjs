/**
 * Module hooks for importing browser-host.ts under `node --test` with the
 * CDP layer replaced: specifiers ending in `browser-cdp` resolve to the
 * controllable stub, everything else defers to the repo's ts-import-hooks.
 *
 * Register with:
 *   register(new URL("./browser-cdp-stub-hook.mjs", import.meta.url).href);
 */
import { resolve as resolveTypeScriptSibling } from "./ts-import-hooks.mjs";

const stub = new URL("./browser-cdp-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  // `browser-host.ts` spells the import with its extension (`./browser-cdp.ts`);
  // matching the bare form only sent the real module through and left
  // `BrowserCdp.current` null.
  if (/^\.\/browser-cdp(\.ts|\.js)?$/.test(specifier)) {
    return next(stub, { ...context, parentURL: undefined });
  }
  return resolveTypeScriptSibling(specifier, context, next);
}
