import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { isSessionTaskTool, spawnedSessionFrom, spawnedSessionState } = await import(
  "../src/lib/session-task-card.ts"
);

function message(overrides = {}) {
  return {
    id: "row-1",
    role: "assistant",
    content: "",
    createdAt: "2026-11-09T00:00:00.000Z",
    status: "complete",
    toolName: "SessionTask",
    toolArgs: { action: "spawn", task: "run the test suite", title: "Tests" },
    toolResult: { action: "spawn", sessionId: "child-1", messageId: "delivery-1", status: "queued" },
    ...overrides,
  };
}

test("the plugin tool name is recognised with its provider namespace", () => {
  assert.equal(isSessionTaskTool("SessionTask"), true);
  assert.equal(isSessionTaskTool("pi.session-orchestrator__SessionTask"), true);
  assert.equal(isSessionTaskTool("Task"), false);
  assert.equal(isSessionTaskTool(undefined), false);
});

test("a spawn becomes a card with the child session and its delivery", () => {
  const card = spawnedSessionFrom(message());
  assert.deepEqual(card, {
    sessionId: "child-1",
    messageId: "delivery-1",
    title: "Tests",
    task: "run the test suite",
    state: "running",
  });
});

test("a queued delivery reads as running, because the child already exists", () => {
  assert.equal(spawnedSessionState("queued"), "running");
  assert.equal(spawnedSessionState("running"), "running");
  assert.equal(spawnedSessionState("completed"), "completed");
  assert.equal(spawnedSessionState("failed"), "failed");
  assert.equal(spawnedSessionState("cancelled"), "stopped");
  assert.equal(spawnedSessionState("interrupted"), "aborted");
  assert.equal(spawnedSessionState("something-new"), undefined);
});

test("a spawn that reported no status is still being admitted", () => {
  const card = spawnedSessionFrom(message({ toolResult: { sessionId: "child-1" } }));
  assert.equal(card.state, "running");
  assert.equal(card.messageId, "row-1");
});

test("the task's first line titles the card when no title was requested", () => {
  const card = spawnedSessionFrom(
    message({ toolArgs: { action: "spawn", task: "fix the\n\nflaky test" } }),
  );
  assert.equal(card.title, "fix the flaky test");
  assert.equal(card.task, "fix the flaky test");
});

test("a long task is bounded to one line", () => {
  const card = spawnedSessionFrom(
    message({ toolArgs: { action: "spawn", task: "word ".repeat(80) } }),
  );
  assert.ok(card.task.length <= 161, `task length ${card.task.length}`);
  assert.ok(card.task.endsWith("…"));
});

test("other actions of the same tool are not new subagent rows", () => {
  for (const action of ["send", "status", "result", "wait", "accept", "cancel", "list", "models"]) {
    assert.equal(
      spawnedSessionFrom(message({ toolArgs: { action, sessionId: "child-1" } })),
      null,
      `${action} must not render as a spawn card`,
    );
  }
});

test("a spawn that never returned a child session is left to the generic row", () => {
  assert.equal(spawnedSessionFrom(message({ toolResult: { action: "spawn", accepted: true } })), null);
  assert.equal(spawnedSessionFrom(message({ toolResult: undefined })), null);
});

test("another tool's spawn-shaped payload is ignored", () => {
  assert.equal(spawnedSessionFrom(message({ toolName: "Bash" })), null);
});
