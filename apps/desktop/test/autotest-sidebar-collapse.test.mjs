/**
 * The AutoTest surface's sidebar collapses like the chat one does — same key,
 * same affordance, its own state.
 *
 * What can silently break: the shortcut still collapsing chat while the test
 * platform is on screen, the collapsed column not being reachable again, or the
 * preference landing in the chat sidebar's storage and folding the wrong column
 * on the next launch.
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

const preferences = await import(
  pathToFileURL(
    join(root, "apps", "desktop", "src", "lib", "surface-preferences.ts"),
  ).href
);

const read = (...parts) => readFileSync(join(...parts), "utf8");
const surfaceSource = read(
  root,
  "apps",
  "desktop",
  "src",
  "features",
  "surfaces",
  "autotest",
  "AutoTestSurfaceShell.tsx",
);
const runtimeSource = read(
  root,
  "apps",
  "desktop",
  "src",
  "features",
  "app",
  "useAppShellRuntime.tsx",
);
const sliceSource = read(
  root,
  "apps",
  "desktop",
  "src",
  "stores",
  "slices",
  "interaction-slice.ts",
);
const styles = read(root, "apps", "desktop", "src", "styles", "surfaces.css");

function fakeStorage(initial = {}) {
  const values = { ...initial };
  return {
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => {
      values[key] = String(value);
    },
    values,
  };
}

test("the surface offers collapse and expand, and keeps the service visible", () => {
  assert.match(surfaceSource, /const collapsed = useAppStore\(\(s\) => s\.autotestSidebarCollapsed\)/);
  assert.match(surfaceSource, /const setCollapsed = useAppStore\(\(s\) => s\.setAutotestSidebarCollapsed\)/);
  // Both directions are pointer-reachable: the shortcut is not the only way back.
  assert.match(surfaceSource, /data-nav="autotest-collapse-sidebar"[\s\S]{0,200}onClick=\{\(\) => setCollapsed\(true\)\}/);
  assert.match(surfaceSource, /data-nav="autotest-expand-sidebar"[\s\S]{0,200}onClick=\{\(\) => setCollapsed\(false\)\}/);
  // A collapsed column that says nothing would hide a failed service.
  assert.match(surfaceSource, /className="autotest-sidebar-rail"/);
  assert.match(surfaceSource, /className="autotest-sidebar-rail"[\s\S]{0,1200}className="autotest-service-dot"/);
  // Accessible state, not just a visual fold.
  assert.match(surfaceSource, /ariaLabel=\{t\("nav\.expandSidebar"\)\}[\s\S]{0,80}aria-expanded=\{false\}/);
  assert.match(surfaceSource, /ariaLabel=\{t\("nav\.collapseSidebar"\)\}[\s\S]{0,80}aria-expanded\b/);
});

test("the shortcut collapses the column of whichever surface is on screen", () => {
  assert.match(
    runtimeSource,
    /const store = useAppStore\.getState\(\);\s*if \(store\.surface === "autotest"\) \{\s*store\.setAutotestSidebarCollapsed\(!store\.autotestSidebarCollapsed\);\s*return;\s*\}/,
  );
  // Chat keeps its own path below that guard, untouched.
  assert.match(runtimeSource, /autoCollapsedSidebarRef\.current = false;\s*if \(sidebarCollapsedRef\.current\) reopenSidebar\(\);\s*else setSidebarCollapsed\(true\);/);
});

test("the choice is stored apart from the chat sidebar's state", () => {
  assert.match(sliceSource, /setAutotestSidebarCollapsed: \(collapsed\) => \{/);
  assert.match(sliceSource, /saveAutotestSidebarCollapsed\(collapsed\)/);
  const storage = fakeStorage();
  preferences.saveAutotestSidebarCollapsed(true, storage);
  assert.equal(storage.values["pi.desktop.surface.autotestSidebar"], "true");
  assert.equal(preferences.loadAutotestSidebarCollapsed(storage), true);
  preferences.saveAutotestSidebarCollapsed(false, storage);
  assert.equal(preferences.loadAutotestSidebarCollapsed(storage), false);
  // A missing or unreadable entry expands rather than hiding navigation.
  assert.equal(preferences.loadAutotestSidebarCollapsed(fakeStorage()), false);
  assert.equal(
    preferences.loadAutotestSidebarCollapsed({ getItem: () => { throw new Error("blocked"); } }),
    false,
  );
});

test("the collapsed column is narrower and stays in flow", () => {
  assert.match(styles, /\.autotest-sidebar\.is-collapsed \{[\s\S]*?width: 44px;/);
  // In flow, not an overlay: the embedded workbench is positioned from a
  // measured rect, so the column may not float above it.
  assert.doesNotMatch(styles, /\.autotest-sidebar\.is-collapsed \{[^}]*position: (absolute|fixed)/);
});
