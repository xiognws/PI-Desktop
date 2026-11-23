/**
 * A main-run extension command's turn half reaches the host session services
 * (spec 07-plugins/16 §5, §8; D426 / ADR 0258).
 *
 * Under the Rust kernel Electron main is the only JavaScript host, so a command
 * that names the session, queues a user message or switches to a plugin agent
 * must reach the same host flows the Node runtime's bridge calls. These tests
 * pin that, and pin the model registry as a redacted projection: ids and auth
 * availability, never a credential or an endpoint.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentExtensionBridge } = await import("../electron/main/agent-extensions.ts");

const EXTENSION_SOURCE = `
const reply = (model, text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
});
export default function (pi) {
  pi.registerAgent({
    id: "cc",
    name: "Command Code",
    models: [{ id: "cc-1", name: "Command Code 1" }],
    complete: async (model) => reply(model, "plugin-transport-ok"),
  });
  pi.registerCommand("switch", {
    async handler(args, ctx) {
      const models = await ctx.modelRegistry.getAvailable();
      const status = ctx.modelRegistry.getProviderAuthStatus(models[0].provider);
      const target = models.find((model) => model.id === "cc-1");
      const switched = await pi.setModel(target);
      pi.setSessionName("Hello " + args);
      globalThis.__commandReport = {
        models,
        status,
        switched,
        name: pi.getSessionName(),
      };
      await pi.sendUserMessage("queued by the command");
    },
  });
  pi.registerCommand("switch-own", {
    async handler(_args, ctx) {
      const models = await ctx.modelRegistry.getAvailable();
      const own = models.find((model) => model.id === "stub-1");
      globalThis.__commandReport = { switched: await pi.setModel(own) };
    },
  });
  pi.registerCommand("refuse", {
    async handler(_args, ctx) {
      const models = await ctx.modelRegistry.getAvailable();
      const target = models.find((model) => model.id === "cc-1");
      globalThis.__commandReport = { switched: await pi.setModel(target) };
    },
  });
}
`;

/** The host services main supplies, recorded so the test can assert the calls. */
function sessionHost(overrides = {}) {
  const calls = { configured: [], renamed: [], queued: [], prioritized: [] };
  const host = {
    calls,
    binding: { providerId: "provider-1", modelId: "stub-1", mode: "agent", projectPath: "/project" },
    idle: true,
    async sessionBinding() {
      return host.binding;
    },
    async configureModel(input) {
      calls.configured.push(input);
      return { ok: true, session: { providerId: input.providerId, modelId: input.modelId } };
    },
    async renameSession(input) {
      calls.renamed.push(input);
    },
    async queueUserMessage(input) {
      calls.queued.push(input);
      return { id: "turn-1" };
    },
    async prioritizeQueuedMessage(id) {
      calls.prioritized.push(id);
    },
    isSessionIdle() {
      return host.idle;
    },
    ...overrides,
  };
  return host;
}

function createBridge(host) {
  return new AgentExtensionBridge({
    hasRenderer: true,
    onChanged: () => {},
    onPrompt: () => {},
    onToast: () => {},
    onStatus: () => {},
    promptTimeoutMs: 50,
    sessionHost: host,
  });
}

function withExtension(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-extension-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "host.ts");
  writeFileSync(entry, EXTENSION_SOURCE, "utf8");
  return { id: entry, entry, label: "demo", source: "plugin", root: dir };
}

test("a command sees the plugin agents and its own binding, never a credential", async (t) => {
  const spec = withExtension(t);
  const host = sessionHost();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  await bridge.runCommand({ sessionId: "session-1", name: "switch", args: "Ann", specs: [spec] });
  const report = globalThis.__commandReport;

  const providers = report.models.map((model) => `${model.provider}/${model.id}`);
  assert.ok(providers.includes("provider-1/stub-1"), `own binding missing: ${providers.join(",")}`);
  assert.ok(
    providers.some((key) => key.startsWith("extension-agent:") && key.endsWith("/cc-1")),
    `plugin agent missing: ${providers.join(",")}`,
  );
  // Availability only: the projection names a provider, never a secret or an endpoint.
  assert.deepEqual(report.status, { configured: true, source: "plugin" });
  const raw = JSON.stringify(report.models).toLowerCase();
  for (const forbidden of [
    "apikey",
    "api_key",
    "authorization",
    "bearer ",
    "secret",
    "baseurl",
    "accesstoken",
    "refreshtoken",
  ]) {
    assert.ok(!raw.includes(forbidden), `registry leaked "${forbidden}": ${raw}`);
  }
  // `models[0]` is the session's own binding, which is a provider main can reach.
  assert.equal(
    report.models.find((model) => model.id === "cc-1").provider.startsWith("extension-agent:"),
    true,
  );
});

test("setModel persists the plugin agent's binding through the host session flow", async (t) => {
  const spec = withExtension(t);
  const host = sessionHost();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  await bridge.runCommand({ sessionId: "session-1", name: "switch", args: "Ann", specs: [spec] });

  assert.equal(globalThis.__commandReport.switched, true);
  assert.equal(host.calls.configured.length, 1);
  const [configured] = host.calls.configured;
  assert.match(configured.providerId, /^extension-agent:/);
  assert.equal(configured.modelId, "cc-1");
  assert.equal(configured.mode, "agent");
  assert.equal(configured.sessionId, "session-1");
});

test("setModel is idle-only, like the Node runtime's", async (t) => {
  const spec = withExtension(t);
  const host = sessionHost();
  host.idle = false;
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  await bridge.runCommand({ sessionId: "session-1", name: "refuse", args: "", specs: [spec] });

  assert.equal(globalThis.__commandReport.switched, false);
  assert.equal(host.calls.configured.length, 0);
});

test("setModel refuses a model no plugin agent registered", async (t) => {
  const spec = withExtension(t);
  const host = sessionHost();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  // The session's own binding is in the registry, but switching to a Host row's
  // model is not something an extension may do under either runtime.
  await bridge.runCommand({ sessionId: "session-1", name: "switch-own", args: "", specs: [spec] });

  assert.equal(globalThis.__commandReport.switched, false);
  assert.equal(host.calls.configured.length, 0);
});

test("setSessionName renames the session and sendUserMessage uses the Host queue", async (t) => {
  const spec = withExtension(t);
  const host = sessionHost();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  await bridge.runCommand({ sessionId: "session-1", name: "switch", args: "Ann", specs: [spec] });

  assert.deepEqual(host.calls.renamed, [{ sessionId: "session-1", title: "Hello Ann" }]);
  assert.equal(host.calls.queued.length, 1);
  assert.equal(host.calls.queued[0].sessionId, "session-1");
  assert.equal(host.calls.queued[0].content, "queued by the command");
  assert.equal(typeof host.calls.queued[0].idempotencyKey, "string");
  // A plain message is not a steer: nothing is moved to the head of the queue.
  assert.deepEqual(host.calls.prioritized, []);
});

test("without host services the turn half refuses instead of pretending", async (t) => {
  const spec = withExtension(t);
  const bridge = createBridge(undefined);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__commandReport;

  assert.deepEqual(
    await bridge.runCommand({ sessionId: "session-1", name: "switch", args: "Ann", specs: [spec] }),
    { handled: true },
  );
  const report = globalThis.__commandReport;
  assert.equal(report.switched, false);
  // The rename is fire-and-forget, so its refusal is its own diagnostic; the
  // queue member throws inside the handler, which the runner records as one.
  const kinds = bridge
    .statusForPlugin([spec.id])
    .diagnostics.map((diagnostic) => `${diagnostic.kind}:${diagnostic.member}`)
    .sort();
  assert.deepEqual(kinds, ["handler_error:command:switch", "handler_error:setSessionName"]);
});
