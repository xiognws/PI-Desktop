#!/usr/bin/env node
/**
 * Build the platform UI into the plugin's renderer directory.
 *
 *   node build-panel.mjs
 *
 * Vite writes to platform/ui/dist; this copies the artifacts next to
 * manifest.json (the panel page must live inside the plugin directory) and
 * injects the backend base URL so `/api` calls reach the supervised backend
 * instead of the panel's own origin.
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(here, "platform", "ui");
const distDir = join(uiDir, "dist");
const rendererDir = resolve(here, "renderer");

function run(cmd, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}

if (!existsSync(join(uiDir, "node_modules", "vite"))) {
  console.error("ui/node_modules is missing; link or install the ui dependencies first");
  process.exit(1);
}

console.log("[build-panel] vite build");
await run(process.execPath, [join(uiDir, "node_modules", "vite", "bin", "vite.js"), "build"], uiDir);

const indexHtml = await readFile(join(distDir, "index.html"), "utf8");
const baseScript = `<script>
    (function () {
      var http = location.protocol.indexOf("http") === 0;
      // Served by the backend: root-absolute base so client-side routes keep
      // loading /assets/*. Opened from the plugin directory: relative base.
      var base = document.createElement("base");
      base.href = http ? "/" : new URL(".", location.href).href;
      document.head.appendChild(base);
      var q = new URLSearchParams(location.search).get("api");
      window.__AUTOTEST_API__ = q || (http ? "" : "http://127.0.0.1:4000");
    })();
  </script>`;
const patched = indexHtml.replace(/<head>/i, `<head>\n    ${baseScript}`);
if (patched === indexHtml) {
  console.error("[build-panel] could not inject the API base into index.html");
  process.exit(1);
}

// Keep the diagnostics page; the SPA becomes the panel entry point.
await rm(join(rendererDir, "assets"), { recursive: true, force: true });
const diagnosticsPath = join(rendererDir, "diagnostics.html");
if (existsSync(join(rendererDir, "index.html")) && !existsSync(diagnosticsPath)) {
  await cp(join(rendererDir, "index.html"), diagnosticsPath);
}
await cp(distDir, rendererDir, { recursive: true });
await writeFile(join(rendererDir, "index.html"), patched, "utf8");
// The build output is copied, not shipped twice: the package must stay small.
await rm(distDir, { recursive: true, force: true });

console.log("[build-panel] renderer/ updated");
