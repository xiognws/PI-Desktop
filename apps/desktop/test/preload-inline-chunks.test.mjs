import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { inlinePreloadChunks } from "../electron/vite/inline-preload-chunks.ts";

/**
 * A sandboxed preload cannot require a sibling file. Rollup nevertheless hoists
 * any module two preload entries share into `chunks/`, and the window then dies
 * with "Unable to load preload script: module not found" - silently, because the
 * only symptom is `window.piDesktop` being undefined. These tests pin the two
 * halves of the fix: the build folds the shared chunk back in, and a built
 * preload on disk contains nothing it cannot load.
 */

const SHARED = `"use strict"; const IPC = { invoke: { a: "x" } }; exports.IPC = IPC;`;

const bundleWith = (entryCode) => ({
  "chunks/protocol-abc123.cjs": {
    type: "chunk",
    fileName: "chunks/protocol-abc123.cjs",
    isEntry: false,
    code: SHARED,
  },
  "index.cjs": { type: "chunk", fileName: "index.cjs", isEntry: true, code: entryCode },
});

const run = (bundle) => {
  inlinePreloadChunks().generateBundle({}, bundle);
  return bundle;
};

test("a shared chunk is folded into the entry that requires it", () => {
  const code = `"use strict"; const protocol = require("./chunks/protocol-abc123.cjs"); protocol.IPC; const electron = require("electron");`;
  const bundle = run(bundleWith(code));

  const entry = bundle["index.cjs"];
  assert.doesNotMatch(entry.code, /require\(["']\.\/chunks\//, "nothing may point at a file the sandbox cannot load");
  assert.match(entry.code, /const protocol = \(\(\) => \{ const exports = \{\};/, "the chunk body is inlined in place");
  assert.match(entry.code, /exports\.IPC = IPC/, "the inlined body is the chunk itself");
  assert.match(entry.code, /require\("electron"\)/, "a builtin require is left alone");
  assert.equal(bundle["chunks/protocol-abc123.cjs"], undefined, "the orphan file is dropped from the output");
});

test("an entry that does not use the chunk is untouched", () => {
  const bundle = bundleWith(`"use strict"; require("./chunks/protocol-abc123.cjs");`);
  bundle["autotest.cjs"] = { type: "chunk", fileName: "autotest.cjs", isEntry: true, code: `"use strict"; const e = require("electron");` };
  const autotestBefore = bundle["autotest.cjs"].code;

  run(bundle);

  assert.equal(bundle["autotest.cjs"].code, autotestBefore);
  assert.equal(bundle["autotest.cjs"].type, "chunk");
});

test("a build with no shared chunk changes nothing", () => {
  const bundle = {
    "index.cjs": { type: "chunk", fileName: "index.cjs", isEntry: true, code: `require("electron");` },
  };
  const before = bundle["index.cjs"].code;

  run(bundle);

  assert.equal(bundle["index.cjs"].code, before);
  assert.deepEqual(Object.keys(bundle), ["index.cjs"]);
});

test("an asset in the bundle is not treated as a chunk", () => {
  const bundle = bundleWith(`require("./chunks/protocol-abc123.cjs");`);
  bundle["logo.svg"] = { type: "asset", fileName: "logo.svg", source: "<svg/>" };

  run(bundle);

  assert.equal(bundle["logo.svg"].type, "asset");
  assert.equal(bundle["logo.svg"].source, "<svg/>");
});

test("the chunk is inlined into every entry that requires it", () => {
  const requiring = `const p = require("./chunks/protocol-abc123.cjs");`;
  const bundle = bundleWith(requiring);
  bundle["plugin-panel.js"] = { type: "chunk", fileName: "plugin-panel.js", isEntry: true, code: requiring };

  run(bundle);

  assert.doesNotMatch(bundle["index.cjs"].code, /require\(["']\.\/chunks\//);
  assert.doesNotMatch(bundle["plugin-panel.js"].code, /require\(["']\.\/chunks\//);
});

test("a built preload on disk is self-contained", { skip: !existsSync(resolve("out/preload")) }, () => {
  const dir = resolve("out/preload");
  const entries = readdirSync(dir).filter((name) => name.endsWith(".cjs") || name.endsWith(".js"));

  assert.ok(entries.length > 0, "the build emitted at least one preload");
  for (const name of entries) {
    const code = readFileSync(resolve(dir, name), "utf8");
    // Only the sandbox's own builtins may be required - no relative paths at all.
    const relative = [...code.matchAll(/require\(\s*["'](\.[^"']*)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(relative, [], `${name} requires ${relative.join(", ")}; a sandboxed preload cannot resolve that`);
  }
  assert.equal(
    readdirSync(dir).includes("chunks"),
    false,
    "out/preload/chunks means the shared chunk survived and some window will load without a bridge",
  );
});
