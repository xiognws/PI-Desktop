/**
 * The surface model's contract, pinned from the source that implements it.
 *
 * The window has one rail and one host; every interface is a row in the
 * registry. What can silently rot is the drift: an id in `SURFACE_IDS` with no
 * descriptor (the interface simply missing from the rail), a shell that grows
 * its own `page ===` switch again, or a surface that stops hiding its native
 * view when an overlay opens. None of those throw — they just look wrong — so
 * they are asserted here.
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

const { SURFACE_IDS, resolveSurfaceId, DEFAULT_SURFACE_ID } = await import(
  pathToFileURL(join(root, "packages", "shared", "src", "surfaces.ts")).href
);

const read = (...parts) => readFileSync(join(...parts), "utf8");
const registry = read(root, "apps", "desktop", "src", "features", "surfaces", "registry.tsx");
const rail = read(root, "apps", "desktop", "src", "features", "surfaces", "SurfaceRail.tsx");
const host = read(root, "apps", "desktop", "src", "features", "surfaces", "SurfaceHost.tsx");
const appShell = read(root, "apps", "desktop", "src", "features", "app", "AppShell.tsx");
const autotestShell = read(
  root,
  "apps",
  "desktop",
  "src",
  "features",
  "surfaces",
  "autotest",
  "AutoTestSurfaceShell.tsx",
);

test("the registry declares exactly the surfaces the contract lists", () => {
  const declared = [...registry.matchAll(/^\s{4}id: "([a-z]+)",$/gm)].map((match) => match[1]);
  assert.deepEqual(declared, [...SURFACE_IDS]);
  for (const id of SURFACE_IDS) {
    assert.match(registry, new RegExp(`labelKey: "surface\\.${id}"`), `no label for ${id}`);
  }
});

test("the home surface is the one that stays mounted", () => {
  assert.equal(DEFAULT_SURFACE_ID, "chat");
  const chatEntry = registry.slice(registry.indexOf('id: "chat"'), registry.indexOf('id: "autotest"'));
  assert.match(chatEntry, /keepMounted: true/);
  // Only chat: a second always-mounted surface would pay its bundle on every launch.
  assert.equal(registry.match(/keepMounted: true/g).length, 1);
});

test("the window names no interface and delegates to the rail and the host", () => {
  assert.match(appShell, /<SurfaceRail \/>/);
  assert.match(appShell, /<SurfaceHost runtime=\{runtime\} overlaysOpen=\{searchOpen\} \/>/);
  // The chat destinations moved into the chat surface; the window must not grow
  // the switch chain back.
  for (const destination of ["plugins", "scheduled", "artifacts", "tools"]) {
    assert.doesNotMatch(
      appShell,
      new RegExp(`page === "${destination}"`),
      `AppShell still branches on page === "${destination}"`,
    );
  }
  // Settings remains a window takeover, not a surface.
  assert.match(appShell, /page === "settings"/);
});

test("the rail switches through the store and marks the active item", () => {
  assert.match(rail, /s\.setSurface/);
  assert.match(rail, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(rail, /t\("surface\.switcher"\)/);
  // It walks the registry rather than naming the interfaces it draws.
  assert.match(rail, /SURFACES\.map\(/);
  assert.doesNotMatch(rail, /"autotest"/);
});

test("the host mounts only the active surface, plus the home surface", () => {
  assert.match(host, /descriptor\.keepMounted \|\| descriptor\.id === active\.id/);
});

test("the AutoTest surface hides its native view behind every overlay", () => {
  // A WebContentsView paints above renderer content: leaving it attached over a
  // dialog makes the dialog unreachable.
  assert.match(autotestShell, /overlaysOpen/);
  assert.match(autotestShell, /const visible = active && !overlaysOpen;/);
  assert.match(autotestShell, /autotestWorkbenchDetach/);
  // Attaching is what starts the local service; both live in the same call, and
  // the call carries the window's resolved theme.
  assert.match(autotestShell, /api\.autotestWorkbenchAttach\(\{ theme: resolvedTheme\(\) \}\)/);
  assert.match(autotestShell, /new ResizeObserver/);
});

test("a stored surface id this build no longer knows lands on chat", () => {
  assert.equal(resolveSurfaceId("autotest"), "autotest");
  assert.equal(resolveSurfaceId("workflow"), "chat");
  assert.equal(resolveSurfaceId(""), "chat");
});
