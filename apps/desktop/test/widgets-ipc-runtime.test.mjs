/**
 * Which host runs a widget package, per runtime.
 *
 * The Node sidecar and the Rust kernel answer the same protocol but not the same
 * surface: the sidecar is a JavaScript host and runs packages itself, the kernel
 * is not and never will be, so main runs them (`widget-commands.ts`). These
 * cases pin that split at the IPC boundary — the same five channels, no second
 * shape, and a package's code running in exactly one host per runtime.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { IPC } from "@pi-workspace/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/widgets-electron-hook.mjs", import.meta.url));
const { registerWidgetsIpc } = await import(
  "../electron/main/ipc/widgets-ipc.ts"
);

/** One real package on disk, so main's host has something to load. */
function writePackage(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-widget-ipc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "widget.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      apiVersion: 1,
      id: "local.tide",
      name: "Tide probe",
      version: "0.1.0",
      actions: [{ name: "ping", description: "say hello" }],
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "index.js"),
    'export default function (api) {\n  api.action("ping", () => "pong");\n}\n',
  );
  return dir;
}

function packageSummary(dir) {
  return {
    id: "local.tide",
    name: "Tide probe",
    version: "0.1.0",
    description: "",
    dirName: "tide",
    path: dir,
    requestedPermissions: ["read"],
    grantedPermissions: ["read"],
    actions: [{ name: "ping", description: "say hello" }],
    enabled: true,
    trust: "trusted",
    digest: "a".repeat(64),
  };
}

/**
 * `runtime` decides which host is supposed to answer. A sidecar stub with a
 * runtime refuses `widget.*` outright, so a test that reaches it fails loudly
 * instead of quietly passing on the wrong host.
 */
function harness({ runtime, dir }) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  registerWidgetsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      async call(method, params) {
        hostCalls.push([method, params]);
        return { packages: [packageSummary(dir)] };
      },
    }),
    getSidecar: () => ({
      runtime,
      async call(method, params) {
        sidecarCalls.push([method, params]);
        if (method === "widget.invoke") {
          return { id: params.id, action: params.action, value: "sidecar-pong", durationMs: 3 };
        }
        if (method === "widget.list") {
          return { packages: [packageSummary(dir)], states: [{ id: "local.tide", state: "loaded", actionNames: ["ping"] }] };
        }
        return { states: [{ id: "local.tide", state: "loaded", actionNames: ["ping"] }] };
      },
    }),
  });
  return { handlers, hostCalls, sidecarCalls };
}

test("under the Rust kernel main lists and invokes, and the sidecar is not asked", async (t) => {
  const dir = writePackage(t);
  const { handlers, hostCalls, sidecarCalls } = harness({ runtime: "rust", dir });

  const listed = await handlers.get(IPC.invoke.widgetsList)();
  assert.deepEqual(listed.packages.map((entry) => entry.id), ["local.tide"]);

  const runtimeView = await handlers.get(IPC.invoke.widgetsRuntime)();
  assert.deepEqual(runtimeView.packages.map((entry) => entry.id), ["local.tide"]);
  assert.deepEqual(
    runtimeView.states.map((entry) => [entry.id, entry.state]),
    [["local.tide", "loaded"]],
  );

  const invoked = await handlers.get(IPC.invoke.widgetsInvoke)({
    id: "local.tide",
    action: "ping",
    args: { n: 1 },
  });
  assert.equal(invoked.value, "pong");
  assert.equal(invoked.action, "ping");

  assert.deepEqual(
    sidecarCalls,
    [],
    "a Rust-kernel sidecar answers no widget method, so none may be sent to it",
  );
  // Only the host-owned surfaces reach host-core: the package list, and the one
  // `host` method a package could ask for (this one asks for none).
  assert.deepEqual(hostCalls.map(([method]) => method), ["widgets.list"]);
});

test("a package that stops being trusted stops running without a restart", async (t) => {
  const dir = writePackage(t);
  const trusted = harness({ runtime: "rust", dir });
  await trusted.handlers.get(IPC.invoke.widgetsList)();
  const loaded = await trusted.handlers.get(IPC.invoke.widgetsInvoke)({
    id: "local.tide",
    action: "ping",
  });
  assert.equal(loaded.value, "pong");

  // The same window, after the user revokes trust: `widgets.trust` answers with
  // the host's new list, which is what main re-syncs from.
  const handlers = new Map();
  const entries = [{ ...packageSummary(dir), trust: "untrusted", grantedPermissions: [] }];
  registerWidgetsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      async call(method) {
        return method === "widgets.setTrusted" ? { packages: entries } : { packages: entries };
      },
    }),
    getSidecar: () => ({ runtime: "rust", async call() { throw new Error("sidecar must not be asked"); } }),
  });
  await handlers.get(IPC.invoke.widgetsTrust)({
    id: "local.tide",
    digest: "a".repeat(64),
    trusted: false,
  });
  await assert.rejects(
    () => handlers.get(IPC.invoke.widgetsInvoke)({ id: "local.tide", action: "ping" }),
    /is not loaded/,
  );
});

test("under the Node sidecar the package still runs there", async (t) => {
  const dir = writePackage(t);
  const { handlers, hostCalls, sidecarCalls } = harness({ runtime: "node", dir });

  await handlers.get(IPC.invoke.widgetsList)();
  assert.deepEqual(
    sidecarCalls.map(([method]) => method),
    ["widget.sync"],
    "the list pushes the host's view into the sidecar, exactly as before",
  );

  const runtimeView = await handlers.get(IPC.invoke.widgetsRuntime)();
  assert.deepEqual(runtimeView.states.map((entry) => entry.state), ["loaded"]);

  const invoked = await handlers.get(IPC.invoke.widgetsInvoke)({
    id: "local.tide",
    action: "ping",
    args: { n: 1 },
  });
  assert.equal(invoked.value, "sidecar-pong");
  assert.deepEqual(sidecarCalls.slice(1).map(([method]) => method), [
    "widget.list",
    "widget.invoke",
  ]);
  assert.deepEqual(hostCalls.map(([method]) => method), ["widgets.list"]);
});
