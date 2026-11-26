/**
 * Contract tests for repeated-read sharing.
 *
 * A polling panel re-asks for the same snapshot far faster than the snapshot can
 * change: the install this came from requested `session/get` every 37 ms for 80
 * minutes, 20 039 calls in total. Each is cheap on its own and expensive in
 * aggregate, and every other plugin waits behind it. Identical reads from one
 * plugin inside the window share a single host call.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginReadCoalescer, stableArgsKey, DEFAULT_COALESCED_READ_WINDOW_MS } = await import(
  "../electron/main/plugin-read-coalescing.ts"
);

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

function coalescer(options = {}) {
  let clock = 0;
  const instance = new PluginReadCoalescer({
    windowMs: DEFAULT_COALESCED_READ_WINDOW_MS,
    now: () => clock,
    ...options,
  });
  return { instance, advance: (ms) => (clock += ms) };
}

test("the window is a quarter second", () => {
  assert.equal(DEFAULT_COALESCED_READ_WINDOW_MS, 250);
});

test("an identical read inside the window is answered once", async () => {
  const { instance, advance } = coalescer();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { session: "s1", tick: loads };
  };
  const first = await instance.run("local.diff-view", "session/get:[]", load);
  advance(120);
  const second = await instance.run("local.diff-view", "session/get:[]", load);
  assert.equal(loads, 1, "the second read must not reach the host");
  assert.deepEqual(second, first);
  assert.equal(instance.stats().hits, 1);
});

test("a read past the window runs again", async () => {
  const { instance, advance } = coalescer();
  let loads = 0;
  const load = async () => ({ tick: ++loads });
  await instance.run("p", "k", load);
  advance(251);
  const later = await instance.run("p", "k", load);
  assert.equal(loads, 2);
  assert.equal(later.tick, 2);
});

test("concurrent identical reads share one in-flight call", async () => {
  const { instance } = coalescer();
  let loads = 0;
  let resolveLoad;
  const load = () => {
    loads += 1;
    return new Promise((resolve) => {
      resolveLoad = resolve;
    });
  };
  const a = instance.run("p", "k", load);
  const b = instance.run("p", "k", load);
  resolveLoad({ ok: true });
  assert.deepEqual(await a, { ok: true });
  assert.deepEqual(await b, { ok: true });
  assert.equal(loads, 1);
});

test("different arguments and different plugins are different reads", async () => {
  const { instance } = coalescer();
  let loads = 0;
  const load = async () => ++loads;
  await instance.run("p", "session/get:[1]", load);
  await instance.run("p", "session/get:[2]", load);
  await instance.run("other", "session/get:[1]", load);
  assert.equal(loads, 3, "a shared answer must never cross a plugin or argument boundary");
});

test("a failure is never remembered", async () => {
  const { instance } = coalescer();
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("host read failed");
    return "ok";
  };
  await assert.rejects(() => instance.run("p", "k", failing), /host read failed/);
  assert.equal(await instance.run("p", "k", failing), "ok");
  assert.equal(attempts, 2);
});

test("a plugin's write drops its own answers, and only its own", async () => {
  const { instance } = coalescer();
  let loads = 0;
  const load = async () => ++loads;
  await instance.run("writer", "session/get:[]", load);
  await instance.run("bystander", "session/get:[]", load);
  instance.clear("writer");
  await instance.run("writer", "session/get:[]", load);
  await instance.run("bystander", "session/get:[]", load);
  assert.equal(loads, 3, "the writer re-read; the bystander stayed cached");
});

test("equal arguments with different key order are the same read", () => {
  assert.equal(
    stableArgsKey({ path: "a", workspacePath: "b" }),
    stableArgsKey({ workspacePath: "b", path: "a" }),
  );
  assert.notEqual(stableArgsKey(["a"]), stableArgsKey(["b"]));
});

test("the broker shares repeated reads on both host entries", async () => {
  const runtime = await read("../electron/main/plugin-runtime.ts");
  assert.match(runtime, /COALESCED_READ_APIS/);
  for (const api of ["session/get", "agent/getStatus", "desktop.listOperations", "fs.readText"]) {
    assert.ok(runtime.includes(`"${api}"`), `${api} must be coalesced`);
  }
  // The plugin process path goes through the sharing dispatcher...
  assert.match(runtime, /return this\.dispatchCoalesced\(loaded/);
  // ...and so does the panel bridge.
  const panel = runtime.indexOf("async invokePanelBridge(");
  const panelRun = runtime.indexOf("this.readCoalescer.run(", panel);
  assert.ok(panelRun > panel, "the panel bridge must share repeated reads too");
  // Anything that is not a shared read may be a write: it clears that plugin.
  assert.match(runtime, /this\.readCoalescer\.clear\(pluginId\)/);
  assert.match(runtime, /if \(!key\) \{\n      this\.readCoalescer\.clear\(pluginId\);/);
  // A gone plugin keeps nothing.
  assert.match(runtime, /this\.apiRateWarnings\.delete\(pluginId\);\n    this\.readCoalescer\.clear\(pluginId\);/);
});
