/**
 * 「加入上下文」这条窄通道的契约测试。
 *
 * 三个可判定点：入参校验（纯函数）、工作台窗口的选项里带上了最小 preload、
 * 协议里的两个通道都在白名单内（少了任何一个，preload 的 invoke 会当场抛）。
 * 真正的跨窗口插入要跑 Electron，由用户重启应用时人工验证。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const { MAX_CONTEXT_CHARS, normalizeContextText } = await import("../../electron/autotest/context.ts");
const { autotestWindowOptions } = await import("../../electron/autotest/window.ts");
const { IPC, IPC_WHITELIST } = await import("@pi-workspace/shared/protocol");

test("context text is trimmed, bounded and type-checked", () => {
  assert.deepEqual(normalizeContextText("  诊断要点  "), { ok: true, text: "诊断要点" });
  assert.equal(normalizeContextText("   ").error, "EMPTY");
  assert.equal(normalizeContextText("").error, "EMPTY");
  assert.equal(normalizeContextText(42).error, "NOT_TEXT");
  assert.equal(normalizeContextText(null).error, "NOT_TEXT");
  assert.equal(normalizeContextText({ text: "x" }).error, "NOT_TEXT");

  const exact = "a".repeat(MAX_CONTEXT_CHARS);
  assert.equal(normalizeContextText(exact).ok, true);
  assert.equal(normalizeContextText(`${exact}a`).error, "TOO_LONG");
});

test("the workbench window carries the minimal preload", () => {
  const withPreload = autotestWindowOptions("测试工作台", "/res/autotest.cjs");
  assert.equal(withPreload.webPreferences.preload, "/res/autotest.cjs");
  // 安全开关不因为加了 preload 而放松
  assert.equal(withPreload.webPreferences.contextIsolation, true);
  assert.equal(withPreload.webPreferences.nodeIntegration, false);
  assert.equal(withPreload.webPreferences.sandbox, true);

  const without = autotestWindowOptions("测试工作台");
  assert.equal("preload" in without.webPreferences, false);
});

test("both channels are on the preload whitelist", () => {
  assert.ok(IPC_WHITELIST.has(IPC.invoke.autotestInsertContext));
  assert.ok(IPC_WHITELIST.has(IPC.event.autotestContextInsert));
});

test("the action preload exposes only insertContext", () => {
  const source = readFileSync(join(here, "..", "preload", "autotest.ts"), "utf8");
  assert.match(source, /contextBridge\.exposeInMainWorld\("autotestHost"/);
  assert.match(source, /insertContext/);
  // 通用 invoke 会把整条白名单交出去，这里不能有
  assert.doesNotMatch(source, /exposeInMainWorld\("piDesktop"/);
});
