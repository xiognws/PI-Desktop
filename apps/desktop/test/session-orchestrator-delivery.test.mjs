import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Vendored Session Orchestrator delivery defaults (ADR 0398).
 *
 * A supervising session only continues on its own when the host is told to send
 * a completion message. Upstream 0.7.1 left that opt-in, so the bundled patch
 * flips the default for work deliveries while keeping plain peer messages
 * pull-first. These assertions run the real `actions.js` against a stub runtime:
 * the contract under test is the `notifyOnCompletion` value the plugin sends to
 * the host, not the host's handling of it (covered by host-core tests).
 */

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { createActions } = require(resolve(HERE, "../resources/plugins/pi.session-orchestrator/actions.js"));

const MODELS = [
  {
    key: "stub/model",
    providerId: "stub",
    modelId: "model",
    providerName: "Stub",
    label: "Stub Model",
    availableForSubagents: true,
    isDefault: true,
  },
];

function harness() {
  const calls = [];
  const runtime = {
    store: { list: () => [], accepted: () => undefined },
    assertActive: () => {},
    ensureOperation: async () => {},
    models: async () => MODELS,
    remember: async () => undefined,
    sleep: async () => {},
    call: async (action, input) => {
      calls.push({ action, input });
      return {
        sessionId: input.sessionId || "worker-1",
        messageId: "message-1",
        status: "queued",
      };
    },
  };
  return { execute: createActions(runtime).execute, calls };
}

const ctx = { sessionId: "supervisor-1" };

test("spawn asks the host for a completion message by default", async () => {
  const { execute, calls } = harness();
  await execute({ action: "spawn", task: "run the test suite" }, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "spawn");
  assert.equal(calls[0].input.notifyOnCompletion, true);
});

test("spawn keeps an explicit pull request", async () => {
  const { execute, calls } = harness();
  await execute({ action: "spawn", task: "run the test suite", notifyOnCompletion: false }, ctx);
  assert.equal(calls[0].input.notifyOnCompletion, false);
});

test("a send without kind is a work delivery and reports back", async () => {
  const { execute, calls } = harness();
  await execute({ action: "send", sessionId: "worker-1", message: "now fix the lint" }, ctx);
  assert.equal(calls[0].action, "send");
  assert.equal(calls[0].input.notifyOnCompletion, true);
});

test("an explicit task send reports back", async () => {
  const { execute, calls } = harness();
  await execute({ action: "send", sessionId: "worker-1", message: "rerun", kind: "task" }, ctx);
  assert.equal(calls[0].input.notifyOnCompletion, true);
});

test("a plain peer message stays pull-first", async () => {
  const { execute, calls } = harness();
  await execute({ action: "send", sessionId: "worker-1", message: "status?", kind: "message" }, ctx);
  assert.equal(calls[0].input.notifyOnCompletion, false);
});

test("a peer message can still opt into a completion message", async () => {
  const { execute, calls } = harness();
  await execute({
    action: "send",
    sessionId: "worker-1",
    message: "status?",
    kind: "message",
    notifyOnCompletion: true,
  }, ctx);
  assert.equal(calls[0].input.notifyOnCompletion, true);
});

test("supervise inherits the work-delivery default for every target", async () => {
  const { execute, calls } = harness();
  await execute({ action: "supervise", sessionIds: ["worker-1", "worker-2"], message: "continue" }, ctx);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.input.notifyOnCompletion, true);
});
