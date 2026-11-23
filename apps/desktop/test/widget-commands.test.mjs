/**
 * Main's widget host (`widget-commands.ts`).
 *
 * These tests pin the two things that matter about moving a widget package's
 * load/run into main for the Rust runtime: the trust boundary did not move (an
 * untrusted, disabled, missing or manifest-broken package never runs), and the
 * five `widget.*` surfaces answer with the same shapes and messages the Node
 * sidecar answers with.
 *
 * The registry is the real one — the same object the sidecar holds — so these
 * cases exercise the actual manifest read, the actual entry load and the actual
 * permission checks, not a stand-in for them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WidgetCommandHost } = await import("../electron/main/widget-commands.ts");

/** Write one widget package to disk and return its directory. */
function writePackage(root, {
  id = "local.tide",
  entry = 'export default function (api) {\n  api.action("ping", () => "pong");\n}\n',
  actions = [{ name: "ping", description: "say hello" }],
} = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "widget.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      apiVersion: 1,
      id,
      name: "Tide probe",
      version: "0.1.0",
      description: "test package",
      actions,
    }, null, 2)}\n`,
  );
  writeFileSync(join(dir, "index.js"), entry);
  return dir;
}

/** One host summary, in the shape host-core produces. */
function summary(dir, overrides = {}) {
  return {
    id: "local.tide",
    name: "Tide probe",
    version: "0.1.0",
    description: "test package",
    dirName: "tide",
    path: dir,
    requestedPermissions: ["read"],
    grantedPermissions: ["read"],
    actions: [{ name: "ping", description: "say hello" }],
    enabled: true,
    trust: "trusted",
    digest: "a".repeat(64),
    ...overrides,
  };
}

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-widget-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a trusted package lists and its action runs", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root);
  const callHost = async () => ({});
  const host = new WidgetCommandHost({ callHost });

  const synced = await host.sync({ packages: [summary(dir)] });
  assert.deepEqual(synced.states, [
    { id: "local.tide", state: "loaded", actionNames: ["ping"], error: undefined },
  ]);

  const listed = await host.list();
  assert.equal(listed.packages.length, 1);
  assert.equal(listed.packages[0].id, "local.tide");
  assert.equal(listed.packages[0].name, "Tide probe");
  assert.deepEqual(
    listed.packages[0].actions.map((action) => action.name),
    ["ping"],
  );
  assert.equal(listed.states[0].state, "loaded");

  const result = await host.invoke({ id: "local.tide", action: "ping", args: { n: 1 } });
  assert.equal(result.id, "local.tide");
  assert.equal(result.action, "ping");
  assert.equal(result.value, "pong");
  assert.equal(typeof result.durationMs, "number");
});

test("an untrusted package is never loaded, and invoking it is refused", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root);
  const host = new WidgetCommandHost({ callHost: async () => ({}) });

  const synced = await host.sync({
    packages: [summary(dir, { trust: "untrusted", grantedPermissions: [] })],
  });
  assert.deepEqual(synced.states, [
    {
      id: "local.tide",
      state: "skipped",
      actionNames: [],
      error: "package is not trusted yet",
    },
  ]);
  const listed = await host.list();
  assert.deepEqual(listed.packages, []);

  await assert.rejects(
    () => host.invoke({ id: "local.tide", action: "ping" }),
    /widget local\.tide is not loaded/,
  );
});

test("a disabled package is not loaded", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root);
  const host = new WidgetCommandHost({ callHost: async () => ({}) });

  const synced = await host.sync({ packages: [summary(dir, { enabled: false })] });
  assert.deepEqual(synced.states, []);
  await assert.rejects(
    () => host.invoke({ id: "local.tide", action: "ping" }),
    /widget local\.tide is not loaded/,
  );
});

test("a package that is not on disk reports why, and cannot be invoked", async (t) => {
  const root = scratch(t);
  const missing = join(root, "absent", "local.tide");
  const host = new WidgetCommandHost({ callHost: async () => ({}) });

  const synced = await host.sync({ packages: [summary(missing)] });
  assert.equal(synced.states.length, 1);
  assert.equal(synced.states[0].id, "local.tide");
  assert.equal(synced.states[0].state, "error");
  assert.match(synced.states[0].error, /widget\.json/);

  // The row stays in the registry so the status panel can explain it, so the
  // rejection names the action rather than pretending the package is unknown —
  // the same answer the sidecar gives for the same package.
  await assert.rejects(
    () => host.invoke({ id: "local.tide", action: "ping" }),
    /widget local\.tide has no action ping/,
  );
});

test("a package may only reach the host methods the sidecar allows", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root, {
    entry: [
      "export default function (api) {",
      '  api.action("reach", (input) => input.call("app.health", {}));',
      '  api.action("overreach", (input) => input.call("widgets.setTrusted", {}));',
      "}",
      "",
    ].join("\n"),
    actions: [
      { name: "reach", description: "allowed host read" },
      { name: "overreach", description: "a host method a widget must not reach" },
    ],
  });
  const hostCalls = [];
  const host = new WidgetCommandHost({
    callHost: async (method, params) => {
      hostCalls.push([method, params]);
      return { ok: true };
    },
  });

  await host.sync({
    packages: [summary(dir, { grantedPermissions: ["read", "host"] })],
  });

  const reached = await host.invoke({ id: "local.tide", action: "reach" });
  assert.equal(reached.id, "local.tide");
  assert.equal(reached.action, "reach");
  assert.deepEqual(reached.value, { ok: true });
  assert.equal(typeof reached.durationMs, "number");
  assert.deepEqual(hostCalls, [["app.health", {}]]);

  await assert.rejects(
    () => host.invoke({ id: "local.tide", action: "overreach" }),
    /host method not allowed from a widget: widgets\.setTrusted/,
  );
  assert.deepEqual(hostCalls, [["app.health", {}]], "the refused call never reached host-core");
});

test("the widget surfaces keep the sidecar's argument and reply shapes", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root, {
    entry: [
      "export default function (api) {",
      '  api.action("log", (input) => { input.log("ticking"); return "tock"; });',
      "}",
      "",
    ].join("\n"),
    actions: [{ name: "log", description: "writes one log line" }],
  });
  const host = new WidgetCommandHost({ callHost: async () => ({}) });
  await host.sync({ packages: [summary(dir)] });

  // Absent id/action is the sidecar's `-32602`, which the app classifies as
  // INVALID_ARGUMENT — not a different shape because main answered it.
  await assert.rejects(
    () => host.invoke({ action: "log" }),
    (error) => error.message === "widget.invoke needs an id"
      && error.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => host.invoke({ id: "local.tide" }),
    (error) => error.message === "widget.invoke needs an action"
      && error.errorCode === "INVALID_ARGUMENT",
  );

  await host.invoke({ id: "local.tide", action: "log" });
  assert.deepEqual(await host.logs({ id: "local.tide" }), { logs: ["ticking"] });
  assert.deepEqual(await host.logs({ id: "local.unknown" }), { logs: [] });

  assert.deepEqual(await host.clear(), { ok: true });
  assert.deepEqual(await host.list(), { packages: [], states: [] });
});

test("sync with no package list clears what was loaded", async (t) => {
  const root = scratch(t);
  const dir = writePackage(root);
  const host = new WidgetCommandHost({ callHost: async () => ({}) });
  await host.sync({ packages: [summary(dir)] });

  assert.deepEqual(await host.sync({}), { states: [] });
  assert.deepEqual((await host.list()).packages, []);
});

test("the runtime module loads once, and a failed load is retried", async () => {
  let loads = 0;
  const registry = {
    sync: async () => [],
    list: () => [],
    states: () => [],
    invoke: async (id, action) => ({ id, action, value: null, durationMs: 0 }),
    logsFor: () => [],
    clear: () => {},
  };
  const module = {
    WidgetRegistry: class {
      constructor() {
        return registry;
      }
    },
    WIDGET_HOST_METHODS: new Set(["app.health"]),
  };
  const host = new WidgetCommandHost({
    callHost: async () => ({}),
    moduleFactory: async () => {
      loads += 1;
      if (loads === 1) throw new Error("loader unavailable");
      return module;
    },
  });

  await assert.rejects(() => host.list(), /loader unavailable/);
  await host.list();
  await host.list();
  assert.equal(loads, 2, "the failure is not cached, the success is");
});
