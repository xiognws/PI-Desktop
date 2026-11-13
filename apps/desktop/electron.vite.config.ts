import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import type { OutputChunk } from "rollup";

// Dev needs 'unsafe-eval' for vite HMR tooling; production must not ship it.
function tightenCsp(): Plugin {
  return {
    name: "pi-tighten-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(" 'unsafe-eval'", "")
        .replace(
          /connect-src [^;]*;/,
          "connect-src 'self';",
        );
    },
  };
}

// A sandboxed preload can only require `electron` and a small builtin subset -
// it does no file resolution at all. Rollup, given more than one preload entry,
// hoists whatever they share (the IPC map) into `chunks/*.cjs`, and the window
// then loads with `Unable to load preload script: module not found`, which
// leaves `window.piDesktop` undefined and every caller failing. Fold those
// shared chunks back into each entry that requires them: the chunk is
// self-contained CommonJS (`exports.X = ...`), so an IIFE over a local
// `exports` object is enough, and no entry keeps a file it cannot load.
function inlinePreloadChunks(): Plugin {
  return {
    name: "pi-inline-preload-chunks",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const shared = Object.values(bundle).filter(
        (item): item is OutputChunk =>
          item.type === "chunk" && !item.isEntry && item.code.includes("exports."),
      );
      if (shared.length === 0) return;
      for (const chunk of shared) {
        const fileName = chunk.fileName.split("/").pop() ?? chunk.fileName;
        const pattern = new RegExp(`require\\(\\s*[\"'][^\"']*${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']\\s*\\)`, "g");
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

// Electron 43 ships a Chromium that always supports woff2, but KaTeX's
// stylesheet lists woff and truetype fallbacks for every face. Dropping those
// src entries lets Rollup tree-shake ~0.8 MB of .woff/.ttf assets it would
// otherwise emit but never serve.
function dropLegacyFontFallbacks(): Plugin {
  return {
    name: "pi-drop-legacy-font-fallbacks",
    apply: "build",
    // Must run before Vite rewrites url() into asset references, otherwise the
    // .woff/.ttf files are already registered for emission.
    enforce: "pre",
    transform(code, id) {
      if (!/\.css(?:\?.*)?$/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  main: {
    // `ws` loads its optional native accelerators (bufferutil, utf-8-validate)
    // inside `require` + try/catch and falls back to its own JavaScript
    // implementation when they are absent. A bundle cannot fail a require, and
    // Vite turns the unresolved optional peer into a module-level throw that
    // kills the whole Main bundle before the app starts, so state the documented
    // "no native accelerator" input to that branch at build time instead.
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "\"1\"",
      "process.env.WS_NO_UTF_8_VALIDATE": "\"1\"",
      // The main bundle is ESM (`type: module`), where Node does not provide
      // the CommonJS `__dirname` global used by Electron's relative asset paths.
      "__dirname": "import.meta.dirname",
    },
    build: {
      rollupOptions: {
        // Bundle JS workspace packages into Main.
        // jiti is loaded lazily by the sidecar's trusted-extension loader
        // (D387); Electron main never calls it, and its transpiled dist
        // breaks the main bundle's esbuild transform.
        external: [
          "original-fs",
          "electron-updater",
          // A native addon: its loader resolves `*.node` bindings with a runtime
          // `require`, which does not exist in this ESM bundle — bundling it
          // throws "require is not defined" before the app reaches `ready`.
          "@ast-grep/napi",
          "jiti",
          "jiti/static",
        ],
        input: {
          index: resolve(__dirname, "electron/main/entry.ts"),
          // Forked per plugin by PluginRuntime (ADR 0008); must stay a
          // standalone entry so utilityProcess can point at a real file.
          "plugin-host-process": resolve(__dirname, "electron/main/plugin-host-process.mjs"),
        },
      },
    },
  },
  preload: {
    // The preload must be a fully bundled CJS file so it can run in a
    // sandboxed renderer without Node module resolution.
    build: {
      rollupOptions: {
        plugins: [inlinePreloadChunks()],
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
          "plugin-panel": resolve(__dirname, "electron/preload/plugin-panel.ts"),
          // 测试工作台窗口是外部页面（本机 FastAPI 托管），单独一份最小 preload。
          autotest: resolve(__dirname, "electron/preload/autotest.ts"),
        },
        output: {
          format: "cjs",
          // Main window preload stays .cjs; plugin panels use .js as referenced by panel host.
          entryFileNames: (chunk) =>
            chunk.name === "plugin-panel" ? "[name].js" : "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      // electron-vite's renderer preset hard-defaults minify to false, unlike
      // plain Vite. Enabling esbuild minification roughly halves the emitted
      // renderer chunks with no behavior change.
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss(), tightenCsp(), dropLegacyFontFallbacks()],
    resolve: {
      alias: [
        { find: "@renderer", replacement: resolve("src") },
        {
          find: /^@pi-workspace\/i18n\/locales\/([^/]+)$/,
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locales/$1/index.ts",
          ),
        },
        {
          find: "@pi-workspace/i18n/locale-info",
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locale-info.ts",
          ),
        },
        // Always read locale source so new keys work without a stale packages/*/dist.
        {
          find: "@pi-workspace/i18n",
          replacement: resolve(__dirname, "../../packages/i18n/src/index.ts"),
        },
      ],
    },
  },
});
