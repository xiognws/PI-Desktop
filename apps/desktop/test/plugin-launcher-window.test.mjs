import { readMainModuleSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [main, renderer, launcher, styles] = await Promise.all([
  Promise.resolve(
    `${readMainModuleSync("bootstrap/launcher.ts")}\n${readMainModuleSync("bootstrap/window.ts")}\n${readMainModuleSync("bootstrap/startup.ts")}`,
  ),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/PluginLauncher.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/plugin-launcher.css", import.meta.url), "utf8"),
]);

test("global plugin launcher is a centered frameless cross-platform utility window", () => {
  assert.match(main, /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/);
  assert.match(main, /frame: false/);
  assert.match(main, /minimizable: false/);
  assert.match(main, /maximizable: false/);
  assert.match(main, /fullscreenable: false/);
  assert.match(main, /process\.platform === "darwin" \? \{ type: "panel" as const \}/);
  assert.match(main, /input\.code === "Space"[\s\S]*input\.alt/);
  assert.match(main, /globalShortcut\.register\(accelerator/);
  assert.match(main, /keyboard\.setGlobalShortcut/);
  assert.match(main, /pluginLauncherBinding === "Alt\+Space"/);
  assert.match(main, /creationPromise: Promise<BrowserWindow> \| null/);
  assert.match(
    main,
    /if \(launcherState\.creationPromise\) return launcherState\.creationPromise/,
  );
  assert.match(main, /function prewarmPluginLauncher\(\): void/);
  assert.ok(
    main.indexOf("prewarmPluginLauncher();") < main.indexOf("await bootBackends();"),
    "launcher warm-up should start before backend boot",
  );
  assert.doesNotMatch(main, /await ensureWindow\(\);\s+prewarmPluginLauncher\(\)/);
  assert.match(main, /window\.show\(\);\s+\/\/ `show\(\)` already activates and focuses a macOS panel\./);
  assert.match(main, /process\.platform !== "darwin"\) \{[\s\S]*window\.focus\(\);[\s\S]*window\.moveTop\(\);/);
  assert.doesNotMatch(main, /process\.platform === "darwin"\) app\.focus\(\{ steal: true \}\)/);
  assert.match(main, /window\.on\("blur"[\s\S]*window\.hide\(\)/);
});

test("launcher never turns the app into a macOS accessory process", () => {
  assert.match(
    main,
    /setVisibleOnAllWorkspaces\(true, \{\s*visibleOnFullScreen: true,\s*skipTransformProcessType: true,\s*\}\)/,
  );
  assert.doesNotMatch(main, /app\.dock\.hide\(\)/);
  assert.doesNotMatch(main, /setActivationPolicy/);
});

test("launcher renderer supports keyboard selection and has no window controls", () => {
  assert.match(
    renderer,
    /const PluginLauncher = React\.lazy\(\(\) =>\s*import\("\.\/components\/PluginLauncher"\)\.then\(\(module\) => \(\{\s*default: module\.PluginLauncher,/,
  );
  assert.match(
    renderer,
    /rendererSurface === "plugin-launcher" \? \([\s\S]*?<ErrorBoundary>\s*<PluginLauncher \/>/,
  );
  // An IME composition never opens a tile: Enter confirms the candidate first.
  assert.match(launcher, /event\.nativeEvent\.isComposing/);
  assert.match(launcher, /event\.nativeEvent\.keyCode === 229/);
  // Two-dimensional movement: rows move by the column count, tiles by one.
  assert.match(launcher, /event\.key === "ArrowDown"[\s\S]*moveActive\(LAUNCHER_COLUMNS\)/);
  assert.match(launcher, /event\.key === "ArrowUp"[\s\S]*moveActive\(-LAUNCHER_COLUMNS\)/);
  assert.match(launcher, /event\.key === "ArrowRight"[\s\S]*moveActive\(1\)/);
  assert.match(launcher, /event\.key === "ArrowLeft"[\s\S]*moveActive\(-1\)/);
  assert.match(launcher, /event\.key === "Enter"/);
  assert.match(launcher, /event\.key === "Escape"/);
  // Opening goes through the launcher channels, which can carry a payload.
  assert.match(launcher, /api\.launcherOpenPlugin\(/);
  assert.match(launcher, /api\.launcherOpenApp\(/);
  assert.match(launcher, /loadPromiseRef/);
  assert.match(launcher, /inputRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(launcher, /requestAnimationFrame\(\(\) => inputRef/);
  assert.doesNotMatch(launcher, /WindowControls|window-controls/);
  assert.match(styles, /html\[data-surface="plugin-launcher"\][\s\S]*background: transparent/);
});

test("the launcher grid is eight fixed columns with one tile shape", () => {
  assert.match(
    styles,
    /\.plugin-launcher-grid \{[\s\S]*grid-template-columns: repeat\(8, minmax\(0, 1fr\)\)/,
  );
  // One shape for every source: no per-kind icon rule and no type badge.
  assert.match(styles, /\.plugin-launcher-icon \{[\s\S]*width: 48px/);
  assert.match(styles, /\.plugin-launcher-icon \{[\s\S]*border-radius: var\(--radius-lg\)/);
  assert.doesNotMatch(styles, /plugin-launcher-icon-(plugin|app)/);
  assert.doesNotMatch(styles, /plugin-launcher-tile-type/);
});

test("the launcher window is resizable and remembers its size", () => {
  assert.match(main, /resizable: true/);
  assert.match(main, /minWidth: PLUGIN_LAUNCHER_MIN_WIDTH/);
  assert.match(main, /resolveLauncherBounds\(/);
  assert.match(main, /writeLauncherWindowState\(dataDir/);
  assert.match(main, /window\.on\("resize", \(\) => schedulePluginLauncherBounds/);
  assert.match(main, /window\.on\("move", \(\) => schedulePluginLauncherBounds/);
});

test("the launcher asks for its surface by hash, which a packaged asar can serve", () => {
  // `loadFile(…, { query })` on a path inside `app.asar` failed to load at all in a
  // packaged build — `ERR_FAILED (-2)` on
  // `file://…/app.asar/out/renderer/index.html?surface=plugin-launcher`, logged as
  // `plugin.launcher.warm.up.failed` on every boot. A fragment is not part of path
  // resolution, so it loads from the asar and from the dev server alike.
  assert.match(main, /hash: "surface=plugin-launcher"/);
  assert.match(main, /url\.hash = "surface=plugin-launcher"/);
  assert.doesNotMatch(
    main,
    /query: \{ surface: "plugin-launcher" \}/,
    "a query on the asar file URL is what broke the packaged load",
  );
  // The renderer has to read the new place, or it renders the main window instead.
  assert.match(renderer, /window\.location\.hash\.replace\(/);
});
