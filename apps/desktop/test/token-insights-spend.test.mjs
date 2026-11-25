/**
 * The spend channel of `pi.token-insights`.
 *
 * The panel bridge is read-only and has no ledger channel, so the card asks the
 * plugin process for one window and the plugin process asks the host. These
 * tests pin the contract the panel depends on: a window goes through untouched,
 * a malformed window never reaches the host, and an older host degrades to a
 * plain "no" instead of an exception crossing the bridge.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const pluginPath = require.resolve(
  "../resources/plugins/pi.token-insights/main.js",
);

/** Load the plugin module against a host double, uncached so each test is clean. */
function loadPlugin(host) {
  globalThis.pi = host;
  delete require.cache[pluginPath];
  return require(pluginPath);
}

const HOUR_MS = 60 * 60 * 1000;

test("the spend channel forwards the window and returns the host rollup", async () => {
  const calls = [];
  const rollup = { requests: 12, costTotal: 0.42, byProvider: [], byModel: [] };
  const plugin = loadPlugin({
    usage: {
      async summary(input) {
        calls.push(input);
        return rollup;
      },
    },
  });

  const toMs = Date.UTC(2026, 10, 24, 12);
  const fromMs = toMs - 30 * 24 * HOUR_MS;
  assert.deepEqual(await plugin.onPanelInvoke("spend", { fromMs, toMs }), {
    ok: true,
    spend: rollup,
  });
  assert.deepEqual(calls, [{ fromMs, toMs }]);
});

test("a malformed window never reaches the host", async () => {
  let asked = 0;
  const plugin = loadPlugin({
    usage: {
      async summary() {
        asked += 1;
        return {};
      },
    },
  });

  const toMs = Date.UTC(2026, 10, 24, 12);
  const cases = [
    { fromMs: toMs, toMs }, // equal bounds are a single instant, not a window
    { fromMs: toMs, toMs: toMs - HOUR_MS }, // inverted
    { fromMs: "2026-11-01", toMs }, // not a number
    { toMs }, // no start
    { fromMs: toMs - 400 * 24 * HOUR_MS, toMs }, // beyond the 365-day ceiling
  ];
  for (const input of cases) {
    const reply = await plugin.onPanelInvoke("spend", input);
    assert.equal(reply.ok, false, `must refuse ${JSON.stringify(input)}`);
    assert.equal(reply.code, "INVALID_PARAMS");
  }
  assert.equal(asked, 0, "the host is never asked for an unusable window");
});

test("a host without the rollup answers no instead of failing the bridge", async () => {
  const plugin = loadPlugin({ usage: {} });
  const toMs = Date.UTC(2026, 10, 24, 12);
  assert.deepEqual(await plugin.onPanelInvoke("spend", { fromMs: toMs - HOUR_MS, toMs }), {
    ok: false,
    code: "UNAVAILABLE",
    message: "this host has no spend rollup",
  });
});

test("a host error stays inside the reply the panel reads", async () => {
  const plugin = loadPlugin({
    usage: {
      async summary() {
        throw new Error("PERMISSION_DENIED: usage.read");
      },
    },
  });
  const toMs = Date.UTC(2026, 10, 24, 12);
  const reply = await plugin.onPanelInvoke("spend", { fromMs: toMs - HOUR_MS, toMs });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "UNAVAILABLE");
  assert.match(reply.message, /PERMISSION_DENIED/);
});

test("another channel is not served by this plugin", async () => {
  const plugin = loadPlugin({ usage: { summary: async () => ({}) } });
  const reply = await plugin.onPanelInvoke("settings", {});
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "UNSUPPORTED");
});
