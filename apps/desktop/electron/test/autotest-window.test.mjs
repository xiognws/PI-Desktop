/**
 * `electron/autotest/window.ts` 的单元测试。
 *
 * 窗口本身要 Electron 运行时，这里注入一个假的 `createWindow`，只验证可判定的
 * 部分：地址必须落在 loopback、页面安全开关、外链导航被拦、菜单触发器的注册
 * 与复用。真正的窗口由集成路径（Electron E2E）覆盖。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const {
  AUTOTEST_WINDOW_HEIGHT,
  AUTOTEST_WINDOW_WIDTH,
  autotestWindowOptions,
  autotestWorkbenchUrl,
  createAutotestWindow,
  isLoopbackUrl,
  openAutotestWorkbench,
  registerAutotestWorkbenchOpener,
  resetAutotestWorkbenchOpener,
} = await import("../autotest/window.ts");

function fakeWindow() {
  const listeners = new Map();
  const calls = { loadURL: [], openHandler: 0, menuSet: 0, focus: 0 };
  const window = {
    calls,
    loadURL(url) {
      calls.loadURL.push(url);
      return Promise.resolve();
    },
    on(event, listener) {
      listeners.set(event, listener);
      return window;
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    },
    setMenu(menu) {
      calls.menuSet += 1;
      return menu;
    },
    isDestroyed() {
      return false;
    },
    focus() {
      calls.focus += 1;
    },
    webContents: {
      setWindowOpenHandler() {
        calls.openHandler += 1;
      },
    },
  };
  return window;
}

test("autotestWorkbenchUrl only accepts valid loopback ports", () => {
  assert.equal(autotestWorkbenchUrl(4012), "http://127.0.0.1:4012/");
  assert.equal(autotestWorkbenchUrl(0), null);
  assert.equal(autotestWorkbenchUrl(70000), null);
  assert.equal(autotestWorkbenchUrl(4012.5), null);
  assert.equal(autotestWorkbenchUrl(undefined), null);
  assert.equal(autotestWorkbenchUrl(null), null);
});

test("isLoopbackUrl rejects external hosts and non-http schemes", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:4012/"), true);
  assert.equal(isLoopbackUrl("http://localhost:8080/"), true);
  assert.equal(isLoopbackUrl("http://10.0.0.5:4012/"), false);
  assert.equal(isLoopbackUrl("https://example.com/"), false);
  assert.equal(isLoopbackUrl("file:///tmp/x.html"), false);
  assert.equal(isLoopbackUrl("not a url"), false);
});

test("window options keep the page sandboxed", () => {
  const options = autotestWindowOptions("Autotest Workbench");
  assert.equal(options.width, AUTOTEST_WINDOW_WIDTH);
  assert.equal(options.height, AUTOTEST_WINDOW_HEIGHT);
  assert.equal(options.title, "Autotest Workbench");
  assert.equal(options.show, false);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webviewTag, false);
});

test("createAutotestWindow loads the url and denies popups", () => {
  const window = fakeWindow();
  const logs = [];
  const created = createAutotestWindow({
    url: "http://127.0.0.1:4012/",
    title: "Autotest Workbench",
    createWindow: () => window,
    log: (message) => logs.push(message),
  });

  assert.equal(created, window);
  assert.deepEqual(window.calls.loadURL, ["http://127.0.0.1:4012/"]);
  assert.equal(window.calls.menuSet, 1);
  assert.equal(window.calls.openHandler, 1);
});

test("external navigation is logged and never loaded", () => {
  const window = fakeWindow();
  const logs = [];
  createAutotestWindow({
    url: "http://127.0.0.1:4012/",
    title: "Autotest Workbench",
    createWindow: () => window,
    log: (message) => logs.push(message),
  });

  window.emit("will-navigate", {}, "https://example.com/page");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /example\.com/);

  window.emit("will-navigate", {}, "http://127.0.0.1:4012/runs/wf-1");
  assert.equal(logs.length, 1);
});

test("menu trigger is a no-op until an opener is registered", () => {
  resetAutotestWorkbenchOpener();
  assert.equal(openAutotestWorkbench(), false);

  let opened = 0;
  registerAutotestWorkbenchOpener(() => {
    opened += 1;
  });
  assert.equal(openAutotestWorkbench(), true);
  assert.equal(opened, 1);

  resetAutotestWorkbenchOpener();
  assert.equal(openAutotestWorkbench(), false);
});
