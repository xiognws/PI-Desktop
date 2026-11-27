/**
 * The AutoTest surface has to look like the rest of the window.
 *
 * It cannot by construction: the workbench is a Vue application in another
 * process with its own design system. The unification is done in one place — the
 * host injects its palette into that page's semantic variables — so what these
 * tests pin is that seam: the variables are the ones the page actually declares,
 * the values are the shell's own tokens, and the surface keeps only one chrome
 * band once the workbench is up.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { WORKBENCH_THEME_CSS, workbenchThemeScript, isWorkbenchTheme } = await import(
  pathToFileURL(
    join(root, "apps", "desktop", "electron", "autotest", "workbench-theme.ts"),
  ).href
);

const read = (...parts) => readFileSync(join(...parts), "utf8");
const pageStyles = read(root, "services", "autotest", "ui", "src", "style.css");
const shellTokens = read(root, "apps", "desktop", "src", "styles", "tokens.css");
const surface = read(
  root,
  "apps",
  "desktop",
  "src",
  "features",
  "surfaces",
  "autotest",
  "AutoTestSurfaceShell.tsx",
);

const overridden = [...WORKBENCH_THEME_CSS.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(
  (match) => match[1],
);

test("every variable the shell overrides is one the page declares", () => {
  // If the workbench renames one of these, the injection silently stops matching
  // and the two interfaces drift apart again — so it fails here instead.
  assert.ok(overridden.length >= 18, `expected a full palette, got ${overridden.length}`);
  for (const variable of overridden) {
    assert.match(
      pageStyles,
      new RegExp(`${variable}:`),
      `${variable} is not declared by services/autotest/ui/src/style.css`,
    );
  }
});

test("the palette is the shell's own neutral ramp, not a second design", () => {
  assert.match(shellTokens, /--gray-900: #181818;/);
  assert.match(shellTokens, /--gray-800: #212121;/);
  assert.match(shellTokens, /--gray-750: #282828;/);
  assert.match(shellTokens, /--gray-700: #303030;/);
  // The page's own background is `bg-surface-2`, so that is the window's primary
  // background; cards and the header sit one step up.
  assert.match(WORKBENCH_THEME_CSS, /--surface: #212121;/);
  assert.match(WORKBENCH_THEME_CSS, /--surface-2: #181818;/);
  assert.match(WORKBENCH_THEME_CSS, /--surface-3: #282828;/);
  assert.match(WORKBENCH_THEME_CSS, /--surface-4: #303030;/);
  // Text and hairlines use the tokens' white-alpha steps.
  assert.match(WORKBENCH_THEME_CSS, /--fg: #ffffff;/);
  assert.match(WORKBENCH_THEME_CSS, /--line: rgba\(255, 255, 255, 0\.08\);/);
  assert.match(WORKBENCH_THEME_CSS, /--line-strong: rgba\(255, 255, 255, 0\.14\);/);
  // Accent is the shell's neutral one; a blue button would be the only blue left.
  assert.match(WORKBENCH_THEME_CSS, /--accent-solid: #303030;/);
  // Status colours are deliberately left alone: a failing test stays red.
  for (const status of ["--danger", "--success", "--warn"]) {
    assert.doesNotMatch(
      WORKBENCH_THEME_CSS,
      new RegExp(`${status}:`),
      `${status} must keep the workbench's own meaning`,
    );
  }
});

test("the theme reaches the page as a class toggle, in both directions", () => {
  assert.match(workbenchThemeScript("dark"), /classList\.toggle\("dark", true\)/);
  assert.match(workbenchThemeScript("light"), /classList\.toggle\("dark", false\)/);
  // The page can see which side set it, for debugging without a devtools session.
  assert.match(workbenchThemeScript("dark"), /piSurfaceTheme/);
  assert.equal(isWorkbenchTheme("dark"), true);
  assert.equal(isWorkbenchTheme("system"), false);
  assert.equal(isWorkbenchTheme(null), false);
});

test("the surface forwards the window's resolved theme and keeps one chrome", () => {
  assert.match(surface, /function resolvedTheme\(\): "light" \| "dark"/);
  assert.match(surface, /document\.documentElement\.dataset\.theme/);
  assert.match(surface, /api\.autotestWorkbenchAttach\(\{ theme: resolvedTheme\(\) \}\)/);
  // A theme switch in the shell re-attaches the same view with the other palette.
  assert.match(surface, /attributeFilter: \["data-theme"\]/);
  // Its own titlebar stands in only while the workbench is not up: the page's
  // header band is the one chrome then.
  assert.match(surface, /\{state === "ready" \? null : \(\s*<header className="autotest-titlebar no-drag">/);
});
