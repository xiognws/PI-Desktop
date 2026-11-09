/**
 * `capabilities.*` IPC bridge (D691).
 *
 * The renderer may not read the filesystem or start package code, so both back
 * ends sit behind one channel set: host-core owns "may this package run"
 * (discovery, digest trust, the enabled set), the agent sidecar owns "run it".
 * These tests pin the boundary — which back end answers, what crosses it, and
 * that a package's code is only ever invoked through the sidecar.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { IPC } from "@pi-workspace/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/capabilities-electron-hook.mjs", import.meta.url));
const { registerCapabilitiesIpc } = await import(
  "../electron/main/ipc/capabilities-ipc.ts"
);

const PACKAGE = {
  id: "local.tide",
  name: "Tide probe",
  version: "0.1.0",
  description: "test package",
  dirName: "tide",
  path: "D:/data/capabilities/tide",
  requestedPermissions: ["read"],
  grantedPermissions: ["read"],
  actions: [{ name: "ping", description: "say hello" }],
  enabled: true,
  trust: "trusted",
  digest: "a".repeat(64),
};

function harness({ host = true, sidecar = true } = {}) {
  const handlers = new Map();
  const hostCalls = [];
  const sidecarCalls = [];
  registerCapabilitiesIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () =>
      host
        ? {
            async call(method, params) {
              hostCalls.push([method, params]);
              if (method === "capabilities.dir") return { path: PACKAGE.path };
              return { packages: [PACKAGE] };
            },
          }
        : null,
    getSidecar: () =>
      sidecar
        ? {
            async call(method, params) {
              sidecarCalls.push([method, params]);
              if (method === "capability.invoke") {
                return { id: params.id, action: params.action, value: "pong", durationMs: 3 };
              }
              if (method === "capability.list") {
                return { packages: [PACKAGE], states: [{ id: PACKAGE.id, state: "loaded", actionNames: ["ping"] }] };
              }
              return { states: [] };
            },
          }
        : null,
  });
  return { handlers, hostCalls, sidecarCalls };
}

test("every capability channel is registered", () => {
  const { handlers } = harness();
  assert.deepEqual(new Set(handlers.keys()), new Set([
    IPC.invoke.capabilitiesList,
    IPC.invoke.capabilitiesRuntime,
    IPC.invoke.capabilitiesSetEnabled,
    IPC.invoke.capabilitiesTrust,
    IPC.invoke.capabilitiesReveal,
    // The scan root opens even when no package exists yet — that folder is how
    // a user adds one in the first place.
    IPC.invoke.capabilitiesRoot,
    IPC.invoke.capabilitiesInvoke,
  ]));
});

test("listing reads the host and pushes the same list into the sidecar", async () => {
  const { handlers, hostCalls, sidecarCalls } = harness();

  const result = await handlers.get(IPC.invoke.capabilitiesList)();

  assert.deepEqual(result, { packages: [PACKAGE] });
  assert.deepEqual(hostCalls, [["capabilities.list", {}]]);
  // One sync, carrying the host's verdict — the sidecar never re-derives trust.
  assert.deepEqual(sidecarCalls, [["capability.sync", { packages: [PACKAGE] }]]);
});

test("a sidecar that is not up yet does not break the page", async () => {
  const { handlers, hostCalls } = harness({ sidecar: false });

  const result = await handlers.get(IPC.invoke.capabilitiesList)();

  assert.equal(result.packages.length, 1);
  assert.deepEqual(hostCalls, [["capabilities.list", {}]]);
});

test("runtime state comes from the sidecar, and is empty before it starts", async () => {
  const running = harness();
  const states = await running.handlers.get(IPC.invoke.capabilitiesRuntime)();
  assert.deepEqual(states.states, [{ id: PACKAGE.id, state: "loaded", actionNames: ["ping"] }]);
  assert.deepEqual(running.hostCalls, []);

  const stopped = harness({ sidecar: false });
  assert.deepEqual(await stopped.handlers.get(IPC.invoke.capabilitiesRuntime)(), { states: [] });
});

test("enabling and trusting land on the host, then resync the sidecar", async () => {
  const { handlers, hostCalls, sidecarCalls } = harness();

  await handlers.get(IPC.invoke.capabilitiesSetEnabled)({ id: "local.tide", enabled: false });
  await handlers.get(IPC.invoke.capabilitiesTrust)({
    id: "local.tide",
    digest: PACKAGE.digest,
    trusted: true,
  });

  assert.deepEqual(hostCalls, [
    ["capabilities.setEnabled", { id: "local.tide", enabled: false }],
    ["capabilities.setTrusted", { id: "local.tide", digest: PACKAGE.digest, trusted: true }],
  ]);
  assert.equal(sidecarCalls.filter(([method]) => method === "capability.sync").length, 2);
});

test("a malformed request never reaches either back end", async () => {
  const { handlers, hostCalls, sidecarCalls } = harness();

  await assert.rejects(handlers.get(IPC.invoke.capabilitiesSetEnabled)({ id: "" }), /non-empty id/);
  await assert.rejects(
    handlers.get(IPC.invoke.capabilitiesSetEnabled)({ id: "local.tide", enabled: "yes" }),
    /boolean enabled/,
  );
  await assert.rejects(
    handlers.get(IPC.invoke.capabilitiesTrust)({ id: "local.tide", digest: "", trusted: true }),
    /non-empty digest/,
  );
  await assert.rejects(
    handlers.get(IPC.invoke.capabilitiesInvoke)({ id: "local.tide", action: "" }),
    /non-empty action/,
  );

  assert.deepEqual(hostCalls, []);
  assert.deepEqual(sidecarCalls, []);
});

test("invoking runs the action in the sidecar, never in the host", async () => {
  const { handlers, hostCalls, sidecarCalls } = harness();

  const result = await handlers.get(IPC.invoke.capabilitiesInvoke)({
    id: "local.tide",
    action: "ping",
    args: { n: 1 },
  });

  assert.deepEqual(result, { id: "local.tide", action: "ping", value: "pong", durationMs: 3 });
  assert.deepEqual(hostCalls, []);
  assert.deepEqual(sidecarCalls, [
    ["capability.invoke", { id: "local.tide", action: "ping", args: { n: 1 } }],
  ]);
});

test("invoking without an agent runtime fails loudly instead of silently", async () => {
  const { handlers } = harness({ sidecar: false });

  await assert.rejects(
    handlers.get(IPC.invoke.capabilitiesInvoke)({ id: "local.tide", action: "ping" }),
    /agent runtime unavailable/,
  );
});
