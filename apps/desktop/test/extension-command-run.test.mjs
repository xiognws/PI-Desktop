/**
 * A trusted extension command runs in main when the Rust kernel answers turns.
 *
 * The kernel has no JavaScript runner, so `extensions.command.run` is main's job
 * for those sessions (spec 07-plugins/16 §8). These tests pin the contract the
 * sidecar runner gives the renderer: `{ handled }` and nothing else, an unknown
 * command answers false (the IPC layer turns that into NOT_FOUND), and a
 * throwing handler is a diagnostic on the plugin row rather than a failed call.
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
export default function (pi) {
  pi.registerCommand("greet", {
    description: "Greets you",
    async handler(args, ctx) {
      ctx.ui.notify("hello " + args, "info");
    },
  });
  pi.registerCommand("boom", {
    handler() {
      throw new Error("kaboom");
    },
  });
}
`;

function writeExtension(dir) {
  const entry = join(dir, "greet.ts");
  writeFileSync(entry, EXTENSION_SOURCE, "utf8");
  return { id: entry, entry, label: "demo", source: "plugin", root: dir };
}

function createBridge(options = {}) {
  const events = { changed: 0, toasts: [], prompts: [] };
  const bridge = new AgentExtensionBridge({
    hasRenderer: true,
    onChanged: () => {
      events.changed += 1;
    },
    onPrompt: (prompt) => events.prompts.push(prompt),
    onToast: (message, level) => events.toasts.push({ message, level }),
    onStatus: () => {},
    promptTimeoutMs: 50,
    ...options,
  });
  return { bridge, events };
}

function withExtensionDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-extension-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return writeExtension(dir);
}

test("runs a trusted extension command in main and reports it handled", async (t) => {
  const spec = withExtensionDir(t);
  const { bridge, events } = createBridge();
  t.after(() => bridge.clearSession("session-1"));

  // The leading slash is what the composer sends; the runner's names have none.
  const result = await bridge.runCommand({
    sessionId: "session-1",
    name: "/greet",
    args: "world",
    specs: [spec],
  });

  assert.deepEqual(result, { handled: true });
  assert.equal(events.toasts.length, 1);
  assert.match(events.toasts[0].message, /hello world/);
  // Loading publishes the command list, which is how the composer learns it.
  assert.deepEqual(
    bridge.commandsForSession("session-1").map((command) => command.name).sort(),
    ["boom", "greet"],
  );
});

test("a command no trusted extension registered answers not handled", async (t) => {
  const spec = withExtensionDir(t);
  const { bridge } = createBridge();
  t.after(() => bridge.clearSession("session-1"));

  assert.deepEqual(
    await bridge.runCommand({ sessionId: "session-1", name: "missing", args: "", specs: [spec] }),
    { handled: false },
  );
});

test("an untrusted session never loads an extension", async (t) => {
  let loads = 0;
  const { bridge } = createBridge({
    runnerFactory: () => {
      loads += 1;
      throw new Error("no extension may be loaded for an untrusted session");
    },
  });

  assert.deepEqual(
    await bridge.runCommand({ sessionId: "session-1", name: "greet", args: "", specs: [] }),
    { handled: false },
  );
  assert.equal(loads, 0);
});

test("a throwing handler is reported as a diagnostic, not a failed call", async (t) => {
  const spec = withExtensionDir(t);
  const { bridge } = createBridge();
  t.after(() => bridge.clearSession("session-1"));

  assert.deepEqual(
    await bridge.runCommand({ sessionId: "session-1", name: "boom", args: "", specs: [spec] }),
    { handled: true },
  );
  const status = bridge.statusForPlugin([spec.id]);
  assert.equal(status.diagnostics.length, 1);
  assert.equal(status.diagnostics[0].kind, "handler_error");
  assert.match(status.diagnostics[0].message, /kaboom/);
});

test("one runner per session, rebuilt when the trusted set changes", async (t) => {
  const spec = withExtensionDir(t);
  const created = [];
  const { bridge } = createBridge({
    runnerFactory: ({ specs }) => {
      const runner = {
        specs,
        loads: 0,
        disposals: 0,
        async load() {
          runner.loads += 1;
        },
        async runCommand() {
          return true;
        },
        async dispose() {
          runner.disposals += 1;
        },
      };
      created.push(runner);
      return runner;
    },
  });
  t.after(() => bridge.clearSession("session-1"));

  await bridge.runCommand({ sessionId: "session-1", name: "greet", args: "", specs: [spec] });
  await bridge.runCommand({ sessionId: "session-1", name: "greet", args: "", specs: [spec] });
  assert.equal(created.length, 1);
  assert.equal(created[0].loads, 1);

  await bridge.runCommand({ sessionId: "session-1", name: "greet", args: "", specs: [] });
  assert.equal(created[0].disposals, 1);
  assert.equal(created.length, 1);
});

test("the IPC layer turns an unhandled command into NOT_FOUND", async () => {
  const { registerAgentExtensionIpc } = await import("../electron/main/agent-extensions-ipc.ts");
  const { IPC, ErrorCodes } = await import("@pi-workspace/shared");
  const handlers = new Map();
  const { bridge } = createBridge();
  registerAgentExtensionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    bridge,
    window: () => null,
    dialogs: {},
    getLocale: () => "en",
    getNpmPath: () => "",
    setNpmPath: () => {},
    importRoot: tmpdir(),
    loadDevPlugin: async () => ({}),
    // What register.ts does under the kernel with nothing trusted for the session.
    runCommand: (input) => bridge.runCommand({ ...input, specs: [] }),
  });

  const run = handlers.get(IPC.invoke.extensionsCommandRun);
  assert.equal(typeof run, "function");
  await assert.rejects(
    run({ sessionId: "session-1", name: "greet", args: "" }),
    (error) => error.errorCode === ErrorCodes.NOT_FOUND,
  );
});
