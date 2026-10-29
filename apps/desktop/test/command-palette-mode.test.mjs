/**
 * Contract tests for the command palette mode.
 *
 * The palette and the search box are the same surface driven by two keystrokes
 * (Mod+Shift+P and Mod+K). The palette must not search conversations or settings,
 * or the reader who asked for an action gets a document instead.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const dialog = await read("../src/components/SearchDialog.tsx");
const runtime = await read("../src/features/app/useAppShellRuntime.tsx");
const shell = await read("../src/features/app/AppShell.tsx");
const shortcuts = await read("../../../packages/shared/src/keyboard-shortcuts.ts");
const locales = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "pt-BR", "tr"];

test("the dialog takes a mode and keeps the two surfaces apart", () => {
  assert.match(dialog, /mode\?: "search" \| "commands";/);
  assert.match(dialog, /mode = "search",/);
  assert.match(dialog, /const commandsOnly = mode === "commands";/);
  // No full-text search, no session / page / settings rows in palette mode.
  assert.match(dialog, /useSessionSearch\(open && !commandsOnly, query\)/);
  assert.match(dialog, /if \(commandsOnly\) return \[\];/);
  assert.match(dialog, /commandsOnly\s*\?\s*\[\]\s*:\s*searchSettings\(/);
  // The input says what it is asking for.
  assert.match(dialog, /t\("search\.palettePlaceholder"\)/);
  assert.match(dialog, /t\("search\.paletteEmpty"\)/);
});

test("both keystrokes still open one dialog, each in its own mode", () => {
  assert.match(runtime, /const \[searchMode, setSearchMode\] = useState<"search" \| "commands">\("search"\);/);
  assert.match(runtime, /const openSearchSurface = useCallback\(\(mode: "search" \| "commands"\) => \{/);
  const palette = runtime.match(/case "openCommandPalette":\s*\n\s*openSearchSurface\("commands"\);/g) ?? [];
  const search = runtime.match(/case "openSearch":\s*\n\s*openSearchSurface\("search"\);/g) ?? [];
  // Both the menu path and the keybinding path go through the same routing.
  assert.equal(palette.length, 2);
  assert.equal(search.length, 2);
  assert.doesNotMatch(runtime, /case "openCommandPalette":\s*\n\s*setSearchOpen\(true\);/);
  assert.match(shell, /mode=\{searchMode\}/);
});

test("Mod+Shift+P stays the palette and Mod+K stays the search", () => {
  assert.match(shortcuts, /id: "openSearch", group: "navigation", defaultBinding: "Mod\+K"/);
  assert.match(shortcuts, /id: "openCommandPalette",\s*\n\s*group: "navigation",\s*\n\s*defaultBinding: "Mod\+Shift\+P",/);
});

test("every locale can label the palette", async () => {
  for (const locale of locales) {
    const source = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    assert.match(source, /palettePlaceholder: "/, `${locale} is missing palettePlaceholder`);
    assert.match(source, /paletteEmpty: "/, `${locale} is missing paletteEmpty`);
  }
});
