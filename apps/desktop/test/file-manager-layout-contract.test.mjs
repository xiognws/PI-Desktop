/**
 * Contract test for the bundled File Manager view's collapse gate.
 *
 * 0.9.1-pi.3 moved the file list to the right of the editor but left the
 * `treeCollapsed ? null : …` gate on the editor while the file tree rendered
 * unconditionally. Collapsing the tree — which opening a file does on purpose —
 * therefore removed the code view and left only the tree, so a user who opened a
 * file saw the editor disappear.
 *
 * The shipped view is a built bundle with no source tree in this checkout, so the
 * gate is asserted on the artifact itself: exactly one conditional surface, and it
 * sits in front of the tree fragment instead of the editor.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const viewBundle =
  process.env.PI_FILE_MANAGER_VIEW_BUNDLE ??
  join(root, "apps/desktop/resources/plugins/pi.file-manager/views/assets/index.js");

const GATE = "p.treeCollapsed?null:";
const EDITOR = "D.jsx(knA,{";
const TREE = 'D.jsxs("aside",{';

function occurrences(haystack, needle) {
  const positions = [];
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    positions.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return positions;
}

test("collapsing the file tree never removes the code editor", async () => {
  const source = await readFile(viewBundle, "utf8");

  const editors = occurrences(source, EDITOR);
  const trees = occurrences(source, TREE);
  const gates = occurrences(source, GATE);
  assert.equal(editors.length, 1, "the view must render exactly one editor surface");
  assert.ok(trees.length >= 1, "the view must still render the file tree");
  assert.equal(
    gates.length,
    1,
    "exactly one surface may be conditionally rendered, so a stray gate cannot hide the editor",
  );

  const gate = gates[0];
  const editor = editors[0];
  const treeAfterEditor = trees.filter((position) => position > editor);
  assert.ok(
    treeAfterEditor.length > 0,
    "the file tree must render after the editor in the layout container",
  );
  const tree = treeAfterEditor[0];
  assert.ok(
    gate > editor,
    "the collapse gate must come after the editor element, so the editor is not the conditional surface",
  );
  assert.ok(
    gate < tree,
    "the collapse gate must guard the tree fragment that follows it",
  );
  assert.ok(
    !source.slice(Math.max(0, editor - 40), editor).includes("null:"),
    "the editor element must render unconditionally",
  );
});
