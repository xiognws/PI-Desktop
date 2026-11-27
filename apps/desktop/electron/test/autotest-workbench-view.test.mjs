/**
 * `electron/autotest/workbench-view.ts` — the view the AutoTest surface embeds.
 *
 * The rules worth pinning are the ones that are invisible until they fail: a
 * hide must not reload the page (the workbench is a stateful app), a re-show
 * must reuse it, a port change must reload it, and a rect the renderer has not
 * measured yet must not attach a zero-sized view over the surface.
 *
 * Electron is injected, so this runs without an Electron process.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const { AutotestWorkbenchView, scaleWorkbenchBounds, boundsAreUsable } = await import(
  "../autotest/workbench-view.ts"
);

function harness({ zoom = 1 } = {}) {
  const state = { added: 0, removed: 0, attached: 0, closed: 0 };
  const loads = [];
  const bounds = [];
  const css = [];
  const scripts = [];
  const makeView = () => ({
    webContents: {
      loadURL(url) {
        loads.push(url);
        return Promise.resolve();
      },
      isDestroyed: () => state.closed > 0,
      close: () => {
        state.closed += 1;
      },
      insertCSS(text) {
        css.push(text);
        return Promise.resolve("key");
      },
      executeJavaScript(code) {
        scripts.push(code);
        return Promise.resolve(true);
      },
    },
    setBounds(rect) {
      bounds.push(rect);
    },
  });
  const created = [];
  const view = new AutotestWorkbenchView({
    addView: () => {
      state.added += 1;
      state.attached += 1;
    },
    removeView: () => {
      state.removed += 1;
      state.attached -= 1;
    },
    zoomFactor: () => zoom,
    createView: () => {
      const next = makeView();
      created.push(next);
      return next;
    },
  });
  return { view, state, loads, bounds, created, css, scripts };
}

const RECT = { x: 48, y: 0, width: 900, height: 700 };

test("scales a CSS rect by the window zoom factor", () => {
  assert.deepEqual(scaleWorkbenchBounds(RECT, 1), RECT);
  assert.deepEqual(scaleWorkbenchBounds(RECT, 1.5), {
    x: 72,
    y: 0,
    width: 1350,
    height: 1050,
  });
  // A malformed factor must not produce NaN bounds.
  assert.deepEqual(scaleWorkbenchBounds(RECT, 0), RECT);
});

test("treats an unmeasured or collapsed pane as unusable", () => {
  assert.equal(boundsAreUsable(null), false);
  assert.equal(boundsAreUsable({ x: 0, y: 0, width: 20, height: 700 }), false);
  assert.equal(boundsAreUsable({ x: 0, y: 0, width: 900, height: 10 }), false);
  assert.equal(boundsAreUsable(RECT), true);
});

test("a show without usable bounds attaches nothing", () => {
  const { view, state, loads } = harness();
  view.show("http://127.0.0.1:4000/", { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(state.added, 0);
  assert.equal(loads.length, 0);
  assert.equal(view.isAttached(), false);
});

test("show loads the loopback page, attaches once, and places it", () => {
  const { view, state, loads, bounds } = harness({ zoom: 2 });
  view.show("http://127.0.0.1:4000/", RECT);
  assert.deepEqual(loads, ["http://127.0.0.1:4000/"]);
  assert.equal(state.added, 1);
  assert.equal(view.isAttached(), true);
  assert.deepEqual(bounds, [{ x: 96, y: 0, width: 1800, height: 1400 }]);
});

test("hiding detaches without reloading, and showing again reuses the page", () => {
  const { view, state, loads } = harness();
  const url = "http://127.0.0.1:4000/";
  view.show(url, RECT);
  view.hide();
  assert.equal(state.removed, 1);
  assert.equal(view.isAttached(), false);
  view.show(url, RECT);
  assert.equal(state.added, 2);
  // Same URL, same page: the workbench keeps its in-page state.
  assert.deepEqual(loads, [url]);
});

test("a new port is a new page", () => {
  const { view, loads } = harness();
  view.show("http://127.0.0.1:4000/", RECT);
  view.show("http://127.0.0.1:4100/", RECT);
  assert.deepEqual(loads, ["http://127.0.0.1:4000/", "http://127.0.0.1:4100/"]);
});

test("setBounds moves an attached view and is ignored while detached", () => {
  const { view, bounds } = harness();
  view.setBounds(RECT);
  assert.deepEqual(bounds, []);
  view.show("http://127.0.0.1:4000/", RECT);
  view.setBounds({ ...RECT, width: 800 });
  assert.deepEqual(bounds.at(-1), { ...RECT, width: 800 });
  view.hide();
  view.setBounds({ ...RECT, width: 700 });
  assert.deepEqual(bounds.at(-1), { ...RECT, width: 800 });
});

test("reload discards the page and forgets where it was loaded from", () => {
  const { view, state, loads } = harness();
  const url = "http://127.0.0.1:4000/";
  view.show(url, RECT);
  view.reload();
  assert.equal(state.removed, 1);
  assert.equal(state.closed, 1);
  assert.equal(view.hasView(), false);
  view.show(url, RECT);
  assert.deepEqual(loads, [url, url]);
});

test("a load failure is reported and does not attach a broken page twice", () => {
  const messages = [];
  const view = new AutotestWorkbenchView({
    addView: () => undefined,
    removeView: () => undefined,
    zoomFactor: () => 1,
    createView: () => ({
      webContents: { loadURL: () => Promise.reject(new Error("net::ERR_CONNECTION_REFUSED")) },
      setBounds: () => undefined,
    }),
    log: (message) => messages.push(message),
  });
  view.show("http://127.0.0.1:4000/", RECT);
  // The load settles through one `.then` (palette) before the rejection is
  // reported, so let the whole microtask queue drain.
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(messages.length, 1);
    assert.match(messages[0], /ERR_CONNECTION_REFUSED/);
    assert.equal(view.hasView(), true);
  });
});

test("the host palette reaches the page once, and the theme flips on every show", () => {
  const { view, css, scripts } = harness();
  const url = "http://127.0.0.1:4000/";
  view.applyTheme("dark");
  // Nothing to apply to before the page exists: no crash, no phantom view.
  assert.equal(css.length, 0);

  view.show(url, RECT);
  return Promise.resolve().then(() => {
    assert.equal(css.length, 1, "the palette is injected once per page");
    assert.match(css[0], /--surface: #212121/);
    assert.ok(
      scripts.some((code) => code.includes('classList.toggle("dark", true)')),
      "the page is switched into dark mode",
    );

    view.applyTheme("light");
    assert.ok(
      scripts.some((code) => code.includes('classList.toggle("dark", false)')),
      "a light window hands the page a light palette",
    );
    assert.equal(css.length, 1, "re-theming must not stack stylesheets");

    // Hiding and showing again re-applies the class, because the page may have
    // reloaded itself in between.
    const before = scripts.length;
    view.hide();
    view.show(url, RECT);
    assert.ok(scripts.length > before);
    assert.equal(css.length, 1);
  });
});

test("a discarded page gets the palette again", () => {
  const { view, css } = harness();
  const url = "http://127.0.0.1:4000/";
  view.applyTheme("dark");
  view.show(url, RECT);
  return Promise.resolve()
    .then(() => {
      assert.equal(css.length, 1);
      view.reload();
      view.applyTheme("dark");
      view.show(url, RECT);
      return Promise.resolve();
    })
    .then(() => {
      assert.equal(css.length, 2, "a new page needs its own stylesheet");
    });
});
