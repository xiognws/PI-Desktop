/*
 * The window's status bar belongs to the shell, not to one interface.
 *
 * What can silently regress: a second bar reappearing inside the chat sidebar,
 * the bar learning an interface's name (so a third surface needs a branch in
 * it), a surface losing its row, or a customize-menu label that names a key no
 * locale has.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const [shellSource, barSource, surfaceStatusSource, sidebarSource, surfaces, en] =
  await Promise.all([
    read("../src/features/app/AppShell.tsx"),
    read("../src/features/shell/StatusBar.tsx"),
    read("../src/features/shell/surface-status.ts"),
    read("../src/components/Sidebar.tsx"),
    read("../../../packages/shared/src/surfaces.ts"),
    read("../../../packages/i18n/src/locales/en/index.ts"),
  ]);

const surfaceIds =
  surfaces.match(/SURFACE_IDS = \[([^\]]+)\] as const/)?.[1]
    .split(",")
    .map((id) => id.trim().replace(/^"|"$/g, "")) ?? [];

test("the shell draws the bar once, and Settings takes it with the window", () => {
  assert.equal(shellSource.match(/<StatusBar \/>/g)?.length, 1);
  assert.match(shellSource, /\{page === "settings" \? null : <StatusBar \/>\}/);
  // The chat sidebar is conversation navigation now; a second bar inside it
  // would draw two bands over the same 30px strip.
  assert.doesNotMatch(sidebarSource, /sidebar-footer/);
});

test("the bar knows no interface by name", () => {
  // It draws the row `surface` resolves to. Naming a surface here is how the
  // next one ends up with a branch in the middle of the bar. `page` ids are a
  // different vocabulary — chat is also a destination — so only surfaces that
  // are not page ids are checked as literals.
  const pageIds = ["chat", "scheduled", "plugins", "artifacts", "tools", "settings"];
  for (const id of surfaceIds.filter((id) => !pageIds.includes(id))) {
    assert.doesNotMatch(barSource, new RegExp(`["'\`]${id}["'\`]`), id);
  }
  assert.doesNotMatch(barSource, /surface (===|!==) "/);
  assert.match(barSource, /SURFACE_STATUS_SEGMENTS\[surface\]/);
  assert.match(barSource, /SURFACE_STATUS_MENU\[surface\]/);
});

test("every surface feeds the bar a row and a customize menu", () => {
  assert.ok(surfaceIds.length >= 2, "the surface contract lists its ids");
  for (const id of surfaceIds) {
    assert.match(
      surfaceStatusSource,
      new RegExp(`^  ${id}: \\[$`, "m"),
      `${id} has no status segments`,
    );
  }
  // The bar keeps the outer element, its class and its own actions.
  assert.match(barSource, /className=\{cx\("sidebar-footer no-drag"/);
  assert.match(barSource, /className="footer-actions"/);
  assert.match(barSource, /className=\{`footer-build /);
  assert.match(barSource, /className="statusbar-info"/);
});

test("the customize menu only offers items that exist, with real labels", () => {
  const labelKeys = [...surfaceStatusSource.matchAll(/labelKey: "([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(labelKeys.length > 0);
  for (const key of labelKeys) {
    const [section, entry] = key.split(".");
    assert.ok(
      en.includes(entry) && new RegExp(`${section}: \\{`).test(en),
      `no catalog entry for ${key}`,
    );
  }
  // The chat menu kept the ids users already have stored as hidden.
  for (const id of [
    "project",
    "context",
    "tokens",
    "speed",
    "cache",
    "sessionAge",
    "scheduled",
    "timer",
    "pending",
    "credits",
  ]) {
    assert.match(surfaceStatusSource, new RegExp(`\\{ id: "${id}", labelKey:`), id);
  }
});
