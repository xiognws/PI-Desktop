/**
 * A main-run extension command's view of the turn the kernel is running
 * (spec 07-plugins/16 §8–§10, D426 / ADR 0258).
 *
 * Under the Node runtime these members read the runtime's own agent state in the
 * same process. Under the Rust kernel that state is the kernel's, so main reads it
 * once per Runner use (`agent.surface`) and answers the synchronous members from
 * what came back — and reports them as unavailable when there was no answer,
 * rather than as zero tokens or an empty prompt.
 *
 * The host half is pinned here as well: the RPC names and parameter shapes main
 * and the kernel have to agree on, and the bounded idle wait that must resolve
 * when a session never settles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentExtensionBridge } = await import("../electron/main/agent-extensions.ts");
const { createExtensionSessionHost, extensionSurfaceFrom } = await import(
  "../electron/main/extension-session-host.ts"
);

const USAGE = { tokens: 4_096, contextWindow: 15_360, percent: 27 };
const CATALOG = [
  { name: "Read", description: "Read a file.", active: true },
  { name: "Bash", description: "Run a command.", active: true },
  { name: "OfficeWrite", description: "Write a document.", active: false },
  { name: "ToolSearch", description: "Activate a tool.", active: true },
];
const ACTIVE = ["Read", "Bash", "ToolSearch"];
const SYSTEM_PROMPT = "You are Pi. Tool policy: on-demand tools need ToolSearch.";

const EXTENSION_SOURCE = `
export default function (pi) {
  pi.registerCommand("surface", {
    async handler(_args, ctx) {
      globalThis.__surfaceReads = {
        usage: ctx.getContextUsage(),
        systemPrompt: ctx.getSystemPrompt(),
        active: pi.getActiveTools(),
        all: pi.getAllTools(),
        pending: ctx.hasPendingMessages(),
        thinking: pi.getThinkingLevel(),
        idle: ctx.isIdle(),
      };
      try {
        pi.setActiveTools(["Read", "Bash", "OfficeWrite"]);
      } catch (error) {
        globalThis.__surfaceWriteError = String(error);
      }
      await ctx.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 30));
      globalThis.__surfaceReport = {
        after: pi.getActiveTools(),
        allAfter: pi.getAllTools().find((tool) => tool.name === "OfficeWrite"),
      };
      ctx.abort();
      ctx.compact();
    },
  });
  pi.registerCommand("think", {
    async handler(args, _ctx) {
      try {
        pi.setThinkingLevel(args);
        globalThis.__surfaceReport = { accepted: true, thinking: pi.getThinkingLevel() };
      } catch (error) {
        globalThis.__surfaceReport = { accepted: false, error: String(error), thinking: pi.getThinkingLevel() };
      }
    },
  });
}
`;

/** The kernel side: records calls, answers `agent.surface` and the writes. */
function agentRuntime(answers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (answers[method]) return answers[method](params);
      switch (method) {
        case "agent.surface":
          return { usage: USAGE, systemPrompt: SYSTEM_PROMPT, tools: { known: true, active: ACTIVE, catalog: CATALOG } };
        case "agent.setActiveTools":
          return {
            tools: {
              known: true,
              active: ["Read", "Bash", "ToolSearch", "OfficeWrite"],
              catalog: CATALOG.map((tool) => ({ ...tool, active: true })),
            },
          };
        case "agent.abort":
          return { ok: true, aborted: true };
        case "agent.compact":
          return { compacted: true, messageCount: 3, turnId: "t1" };
        default:
          throw Object.assign(new Error(`method \`${method}\` is not implemented`), { code: -32601 });
      }
    },
    methods() {
      return calls.map((call) => call.method);
    },
    paramsOf(method) {
      return calls.find((call) => call.method === method)?.params;
    },
  };
}

function hostCore() {
  return {
    async call(method, params) {
      if (method === "session.get") {
        return {
          session: {
            providerId: "provider-1",
            modelId: "stub-1",
            mode: "agent",
            thinkingLevel: "off",
            projectPath: "/project",
          },
        };
      }
      if (method === "providers.list") {
        return { providers: [{ id: "provider-1", vendorKey: "custom" }] };
      }
      if (method === "session.configure") {
        return { session: { providerId: params.providerId, modelId: params.modelId, thinkingLevel: params.thinkingLevel } };
      }
      throw new Error(`unexpected host method ${method}`);
    },
  };
}

function createHost(overrides = {}) {
  const configured = [];
  const runtime = overrides.runtime ?? agentRuntime();
  let turnActive = overrides.turnActive ?? false;
  const host = createExtensionSessionHost({
    getHost: () => hostCore(),
    getAgentHost: () => null,
    getAgentRuntime: () => runtime,
    isTurnActive: () => turnActive,
    broadcast: () => {},
    ...overrides.deps,
  });
  return {
    host,
    runtime,
    configured,
    setTurnActive: (value) => {
      turnActive = value;
    },
  };
}

function withExtension(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-extension-surface-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "surface.ts");
  writeFileSync(entry, EXTENSION_SOURCE, "utf8");
  return { id: entry, entry, label: "demo", source: "plugin", root: dir };
}

/** A host double for the bridge: answers the surface and records the writes. */
function sessionHostDouble(overrides = {}) {
  const calls = { configured: [], activeTools: [], aborted: [], compacted: [], waited: [] };
  const host = {
    calls,
    async sessionBinding() {
      return { providerId: "provider-1", modelId: "stub-1", mode: "agent", thinkingLevel: "off", projectPath: "/project" };
    },
    async configureModel(input) {
      calls.configured.push(input);
      return { ok: true, session: { providerId: input.providerId, modelId: input.modelId } };
    },
    async sessionSurface() {
      return { usage: USAGE, systemPrompt: SYSTEM_PROMPT, tools: { active: ACTIVE, catalog: CATALOG } };
    },
    async setActiveTools(sessionId, names) {
      calls.activeTools.push({ sessionId, names });
      return {
        active: [...ACTIVE, ...names.filter((name) => name === "OfficeWrite")],
        catalog: CATALOG.map((tool) => ({
          ...tool,
          active: tool.active || names.includes(tool.name),
        })),
      };
    },
    async abortSession(sessionId) {
      calls.aborted.push(sessionId);
    },
    async compactSession(sessionId) {
      calls.compacted.push(sessionId);
      return true;
    },
    async waitForIdle(sessionId) {
      calls.waited.push(sessionId);
    },
    isSessionIdle() {
      return true;
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

test("the host reads the kernel's surface with one RPC and writes the active set", async () => {
  const { host, runtime } = createHost();

  const surface = await host.sessionSurface("session-1");
  assert.deepEqual(surface.usage, USAGE);
  assert.equal(surface.systemPrompt, SYSTEM_PROMPT);
  assert.deepEqual(surface.tools.active, ACTIVE);
  assert.deepEqual(runtime.paramsOf("agent.surface"), { sessionId: "session-1" });

  const tools = await host.setActiveTools("session-1", ["Read", "Bash", "OfficeWrite"]);
  assert.deepEqual(runtime.paramsOf("agent.setActiveTools"), {
    sessionId: "session-1",
    names: ["Read", "Bash", "OfficeWrite"],
  });
  assert.ok(tools.active.includes("OfficeWrite"), JSON.stringify(tools));

  await host.abortSession("session-1");
  assert.deepEqual(runtime.paramsOf("agent.abort"), { sessionId: "session-1" });

  assert.equal(await host.compactSession("session-1"), true);
  assert.deepEqual(runtime.paramsOf("agent.compact"), { sessionId: "session-1" });
  assert.deepEqual(runtime.methods(), [
    "agent.surface",
    "agent.setActiveTools",
    "agent.abort",
    "agent.compact",
  ]);
});

test("an unknown session is reported as unavailable, not as zero tokens", async () => {
  const { host } = createHost({
    runtime: agentRuntime({
      "agent.surface": () => ({ usage: null, systemPrompt: null, tools: { known: false, active: [], catalog: [] } }),
    }),
  });
  const surface = await host.sessionSurface("never-ran");
  assert.equal(surface, undefined, "nothing to report means no answer, not an empty one");

  // A runtime error is the same answer: this host does not know, and says so.
  const failing = createHost({
    runtime: agentRuntime({
      "agent.surface": () => {
        throw new Error("sidecar unavailable");
      },
    }),
  });
  assert.equal(await failing.host.sessionSurface("session-1"), undefined);
});

test("the idle wait is bounded and resolves when the session never settles", async () => {
  const { host } = createHost({ turnActive: true });
  const started = Date.now();
  const idle = await host.waitForIdle("session-1", 120);
  const elapsed = Date.now() - started;

  assert.equal(idle, false, "a session that never settles reports the timeout");
  assert.ok(elapsed >= 100, `the wait must actually wait: ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `the wait must not hang: ${elapsed}ms`);

  const idleHost = createHost({ turnActive: false });
  assert.equal(await idleHost.host.waitForIdle("session-1", 120), true);
});

test("a command sees the kernel's context usage, prompt and tool set", async (t) => {
  const spec = withExtension(t);
  const host = sessionHostDouble();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__surfaceReads;
  delete globalThis.__surfaceReads;
  delete globalThis.__surfaceReport;
  delete globalThis.__surfaceWriteError;
  delete globalThis.__surfaceWriteError;

  await bridge.runCommand({ sessionId: "session-1", name: "surface", args: "", specs: [spec] });
  const reads = globalThis.__surfaceReads;
  const report = globalThis.__surfaceReport;
  assert.ok(
    reads && report,
    `the command reported nothing: ${JSON.stringify(bridge.statusForPlugin([spec.id]).diagnostics)}`,
  );

  assert.deepEqual(reads.usage, USAGE, "getContextUsage reports what the kernel measured");
  assert.equal(reads.systemPrompt, SYSTEM_PROMPT);
  assert.deepEqual(reads.active, ACTIVE);
  assert.equal(reads.all.length, CATALOG.length, "getAllTools lists the whole catalog");
  assert.deepEqual(
    reads.all.map((tool) => `${tool.name}:${tool.active}`).sort(),
    ["Bash:true", "OfficeWrite:false", "Read:true", "ToolSearch:true"],
  );
  assert.equal(reads.pending, false, "hasPendingMessages matches the Node runtime's constant");
  assert.equal(reads.thinking, "off");
  assert.equal(reads.idle, true);
  assert.equal(globalThis.__surfaceWriteError, undefined, "the write reached the host");
  // The write reached the host and the very next read in the same command sees it.
  assert.deepEqual(host.calls.activeTools, [
    { sessionId: "session-1", names: ["Read", "Bash", "OfficeWrite"] },
  ]);
  assert.ok(report.after.includes("OfficeWrite"), `after: ${JSON.stringify(report.after)}`);
  assert.equal(report.allAfter.active, true);
  // `waitForIdle`, `abort` and `compact` all reached the host.
  assert.deepEqual(host.calls.waited, ["session-1"]);
  assert.deepEqual(host.calls.aborted, ["session-1"]);
  assert.deepEqual(host.calls.compacted, ["session-1"]);
});

test("setThinkingLevel persists the level through the session binding", async (t) => {
  const spec = withExtension(t);
  const host = sessionHostDouble();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__surfaceReads;
  delete globalThis.__surfaceReport;
  delete globalThis.__surfaceWriteError;

  await bridge.runCommand({ sessionId: "session-1", name: "think", args: "high", specs: [spec] });
  const report = globalThis.__surfaceReport;

  assert.equal(report.accepted, true, JSON.stringify(report));
  assert.equal(report.thinking, "high", "the same command reads back what it wrote");
  assert.equal(host.calls.configured.length, 1);
  const [configured] = host.calls.configured;
  assert.equal(configured.sessionId, "session-1");
  assert.equal(configured.providerId, "provider-1");
  assert.equal(configured.modelId, "stub-1");
  assert.equal(configured.thinkingLevel, "high");
});

test("setThinkingLevel refuses a level host-core would not persist", async (t) => {
  const spec = withExtension(t);
  const host = sessionHostDouble();
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__surfaceReads;
  delete globalThis.__surfaceReport;
  delete globalThis.__surfaceWriteError;

  await bridge.runCommand({ sessionId: "session-1", name: "think", args: "ludicrous", specs: [spec] });
  const report = globalThis.__surfaceReport;

  assert.equal(report.accepted, false);
  assert.match(report.error, /ludicrous/);
  assert.equal(report.thinking, "off", "a refused level leaves the binding as it was");
  assert.deepEqual(host.calls.configured, [], "nothing is stored for a level host-core would reject");
});

test("with no runtime view the read members report unavailable instead of a default", async (t) => {
  const spec = withExtension(t);
  // A host double from before the kernel answered these: no `sessionSurface`
  // and no writer for the active set.
  const host = sessionHostDouble({ sessionSurface: undefined, setActiveTools: undefined });
  const bridge = createBridge(host);
  t.after(() => bridge.clearSession("session-1"));
  delete globalThis.__surfaceReads;
  delete globalThis.__surfaceReport;
  delete globalThis.__surfaceWriteError;

  await bridge.runCommand({ sessionId: "session-1", name: "surface", args: "", specs: [spec] });
  const reads = globalThis.__surfaceReads;
  const report = globalThis.__surfaceReport;
  assert.ok(
    reads && report,
    `the command reported nothing: ${JSON.stringify(bridge.statusForPlugin([spec.id]).diagnostics)}`,
  );

  assert.equal(reads.usage, undefined, "no measurement is not a measurement of zero");
  assert.equal(reads.systemPrompt, "", "an uncomposed prompt is the empty string");
  assert.deepEqual(reads.active, []);
  assert.deepEqual(reads.all, []);
  assert.equal(reads.pending, false);
  // The write still refuses loudly rather than pretending.
  assert.match(String(globalThis.__surfaceWriteError), /setActiveTools needs the host session services/);
});

test("a malformed surface answer is narrowed, never trusted field by field", () => {
  assert.equal(extensionSurfaceFrom(null), undefined);
  assert.equal(extensionSurfaceFrom({}), undefined);
  assert.equal(extensionSurfaceFrom({ usage: { tokens: "4096" } }), undefined);
  assert.deepEqual(extensionSurfaceFrom({ usage: { tokens: 10, contextWindow: 100, percent: null } }), {
    usage: { tokens: 10, contextWindow: 100, percent: null },
  });
  assert.equal(
    extensionSurfaceFrom({ tools: { known: false, active: ["Read"], catalog: [] } }),
    undefined,
    "a session the kernel has not run a turn for has no tool set to report",
  );
  assert.deepEqual(
    extensionSurfaceFrom({
      tools: { known: true, active: ["Read", 7], catalog: [{ name: "Read" }, { nope: true }, null] },
    }),
    { tools: { active: ["Read"], catalog: [{ name: "Read", description: "", active: false }] } },
  );
});
