import type { OutputChunk } from "rollup";
import type { Plugin } from "vite";

/**
 * Fold shared chunks back into the preload entries that require them.
 *
 * A sandboxed preload resolves no files: it can require `electron` and a small
 * builtin subset, nothing else. Rollup, given more than one preload entry,
 * hoists whatever they share (the IPC table) into `chunks/*.cjs` — and the
 * window then loads with `Unable to load preload script: module not found`,
 * leaving `window.piDesktop` undefined and every caller reporting
 * "piDesktop preload bridge unavailable": no skill list, no memory list, no
 * learning map, nothing that talks to the host.
 *
 * The chunk is self-contained CommonJS (`exports.X = ...`), so an IIFE over a
 * local `exports` object reproduces it inline and the file can be dropped.
 */
export function inlinePreloadChunks(): Plugin {
  return {
    name: "pi-inline-preload-chunks",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const shared = Object.values(bundle).filter(
        (item): item is OutputChunk => item.type === "chunk" && !item.isEntry && item.code.includes("exports."),
      );
      for (const chunk of shared) {
        const fileName = chunk.fileName.split("/").pop() ?? chunk.fileName;
        const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`require\\(\\s*["'][^"']*${escaped}["']\\s*\\)`, "g");
        const inlined = `(() => { const exports = {}; ${chunk.code}\nreturn exports; })()`;
        for (const entry of Object.values(bundle)) {
          if (entry.type !== "chunk" || entry === chunk) continue;
          if (!pattern.test(entry.code)) continue;
          entry.code = entry.code.replace(pattern, () => inlined);
        }
        delete bundle[chunk.fileName];
      }
    },
  };
}
