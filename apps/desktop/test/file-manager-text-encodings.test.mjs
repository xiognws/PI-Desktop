import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/*
 * A Windows tool that writes UTF-16 (PowerShell's `>` and `Out-File` default to
 * UTF-16LE) produces bytes full of NUL. Judging "contains NUL = binary" alone
 * turned every such .txt / .log into 「二进制文件，无法预览」 — a readable file the
 * viewer refused to show. These cases pin the encoding decision at the panel's
 * read handler, which is where the text/binary verdict is made.
 */

async function withPlugin(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-file-encoding-"));
  const previous = globalThis.pi;
  globalThis.pi = {
    workspace: { get: async () => ({ path: root }) },
    plugin: { getDataPath: async () => null, getSettings: async () => ({}) },
  };
  const require = createRequire(import.meta.url);
  const entry = require.resolve("../resources/plugins/pi.file-manager/main.js");
  delete require.cache[entry];
  const plugin = require(entry);
  try {
    await plugin.onLoad();
    await run(plugin, root);
  } finally {
    await plugin.onUnload();
    globalThis.pi = previous;
    delete require.cache[entry];
    await rm(root, { recursive: true, force: true });
  }
}

const utf16 = (text, { bigEndian = false } = {}) => {
  const body = Buffer.from(text, "utf16le");
  if (!bigEndian) return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  const swapped = Buffer.from(body);
  swapped.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
};

test("a UTF-16LE text file previews as text, read-only", async () => {
  await withPlugin(async (plugin, root) => {
    await writeFile(join(root, "diff.txt"), utf16("diff --git a/x b/x\r\n+新增一行\r\n"));
    const read = await plugin.onPanelInvoke("fm.read", { path: "diff.txt" });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.kind, "text", "a BOM'd UTF-16 file is text, not binary");
    assert.equal(read.encoding, "utf-16le");
    assert.equal(read.eol, "crlf");
    assert.equal(read.text, "diff --git a/x b/x\n+新增一行\n");
    // The editor's save path only writes UTF-8: a save must not transcode.
    assert.equal(read.readOnly, true);
  });
});

test("a UTF-16BE text file previews as text", async () => {
  await withPlugin(async (plugin, root) => {
    await writeFile(join(root, "be.log"), utf16("中文日志\nsecond line\n", { bigEndian: true }));
    const read = await plugin.onPanelInvoke("fm.read", { path: "be.log" });
    assert.equal(read.kind, "text", JSON.stringify(read));
    assert.equal(read.encoding, "utf-16be");
    assert.equal(read.text, "中文日志\nsecond line\n");
    assert.equal(read.readOnly, true);
  });
});

test("UTF-8 with BOM stays editable, and a NUL-bearing file stays binary", async () => {
  await withPlugin(async (plugin, root) => {
    await writeFile(join(root, "utf8.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("普通文本\n", "utf8")]));
    const utf8 = await plugin.onPanelInvoke("fm.read", { path: "utf8.txt" });
    assert.equal(utf8.kind, "text");
    assert.equal(utf8.bom, true);
    assert.equal(utf8.readOnly, undefined, "a UTF-8 file must stay editable");

    // No BOM and a NUL inside the first 4 KiB: a real binary, still refused.
    await writeFile(join(root, "blob.dat"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]));
    const blob = await plugin.onPanelInvoke("fm.read", { path: "blob.dat" });
    assert.equal(blob.kind, "binary");
  });
});
