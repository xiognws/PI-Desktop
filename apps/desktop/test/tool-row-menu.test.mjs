/**
 * Contract tests for the tool row's context menu.
 *
 * Every other transcript surface already had one — message rows, file
 * references, the conversation background — and the spec claimed tool rows did
 * too while the row only answered a right-click on its summary. These tests pin
 * the menu to the row, keep it on the shared vocabulary, and check that an item
 * a call cannot satisfy is left out instead of shown disabled.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const itemsSource = await read("../src/features/chat/transcript/menu-items.tsx");
const rowSource = await read("../src/features/chat/transcript/ToolRow.tsx");
const en = await read("../../../packages/i18n/src/locales/en/index.ts");
const zh = await read("../../../packages/i18n/src/locales/zh-CN/index.ts");

test("the tool row menu is built from the shared vocabulary", () => {
  assert.match(itemsSource, /export function toolRowMenuItems\(\{/);
  // Items the row already answers one chip at a time.
  assert.match(itemsSource, /id: "copy-output"[\s\S]{0,120}chat\.copyToolOutput/);
  assert.match(itemsSource, /id: "copy-command"[\s\S]{0,120}chat\.copyToolCommand/);
  assert.match(itemsSource, /id: "copy-path"[\s\S]{0,120}chat\.copyFullPath/);
  assert.match(itemsSource, /id: "open-file"[\s\S]{0,120}chat\.openToolFile/);
  assert.match(itemsSource, /id: "select-tool-text"[\s\S]{0,120}chat\.selectMessageText/);
  // Copy stays the transcript's copy: a live selection wins over the whole row.
  assert.match(itemsSource, /onSelect: \(selection\) => actions\.copyText\(output, selection\)/);
});

test("an item the call cannot satisfy is left out, not disabled", () => {
  assert.match(itemsSource, /if \(output\.trim\(\)\) \{/);
  assert.match(itemsSource, /if \(command\.trim\(\)\) \{/);
  assert.match(itemsSource, /if \(filePath\) \{[\s\S]{0,200}if \(onOpenFile\) \{/);
  assert.doesNotMatch(itemsSource, /id: "copy-output"[\s\S]{0,200}disabled:/);
});

test("the row owns the menu, and the summary keeps the file menu", () => {
  // Attached to the row root, not just the summary text.
  assert.match(rowSource, /onContextMenu=\{variant === "topology" \? undefined : openRowMenu\}/);
  assert.match(rowSource, /const rowMenu = useContextMenu\(\)/);
  assert.match(rowSource, /<ContextMenu state=\{rowMenu\.contextMenu\} onClose=\{rowMenu\.closeContextMenu\} \/>/);
  // The existing file menu on the summary survives: it stops propagation first.
  assert.match(rowSource, /<ContextMenu state=\{fileMenu\} onClose=\{closeFileMenu\} \/>/);
  assert.match(rowSource, /openFileMenu\(event, \{ path: previewTarget\.path \}\)/);
  // The row menu is a second hook instance, so the two surfaces never share state.
  assert.match(rowSource, /const \{ fileMenu, openFileMenu, closeFileMenu \} = useChatFileMenu\(\);/);
});

test("the menu names itself and speaks nine locales", () => {
  assert.match(rowSource, /label: t\("chat\.toolActions"\)/);
  for (const locale of [en, zh]) {
    assert.match(locale, /toolActions:/);
    assert.match(locale, /copyToolOutput:/);
    assert.match(locale, /copyToolCommand:/);
    assert.match(locale, /openToolFile:/);
  }
});

test("a non-string payload is still copyable", () => {
  assert.match(rowSource, /function stringifyPayload\(payload: unknown\): string \{/);
  assert.match(rowSource, /typeof raw === "string"[\s\S]{0,120}: stringifyPayload\(raw\)/);
  assert.match(rowSource, /JSON\.stringify\(payload, null, 2\) \?\? ""/);
});
