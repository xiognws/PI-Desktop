import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const transcriptRewrite = {
  beginTranscriptRewrite: () => ({ commit() {}, rollback: () => [] }),
  deferTranscriptEvent: () => false,
  isStaleTranscriptEvent: () => false,
};

/*
 * Windows can still hold a handle on a file the outbox just wrote, so a recursive
 * remove of the temp directory fails with ENOTEMPTY/EBUSY/EPERM even though the
 * test itself passed. Retrying only on those codes keeps the teardown honest: a
 * genuine failure surfaces on the last attempt.
 */
async function removeTree(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

test("a settled Task snapshot survives outbox recovery with its original turn and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-settlement-"));
  const silent = () => undefined;
  try {
    const persistenceOutbox = new PersistenceOutbox(dir, silent);
    const queued = [];
    const enqueue = persistenceOutbox.enqueue.bind(persistenceOutbox);
    persistenceOutbox.enqueue = (...args) => {
      const pending = enqueue(...args);
      queued.push(pending);
      return pending;
    };
    const { persistAgentEvent } = createEventPersistence({
      runtimeState: { host: null },
      activeTurns: new Map([["session", "newer-turn"]]),
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      persistenceOutbox,
      transcriptRewrite,
      logger: { app: silent },
    });
    const message = {
      id: "task-call", role: "tool", toolName: "Task", toolCallId: "task-call",
      toolArgs: { agent: "explorer", task: "Inspect the code" },
      toolStatus: "success", status: "complete", content: "completed",
      createdAt: "2026-09-13T00:00:00.000Z", toolDurationMs: 5,
      toolUsage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      toolResult: { details: { delegationId: "delegate", status: "completed", completedAt: 1000 } },
    };
    persistAgentEvent({ sessionId: "session", turnId: "original-turn", ts: 1000,
      event: { type: "message_end", message } });
    await Promise.all(queued);
    await persistenceOutbox.flush(() => null);
    assert.equal(persistenceOutbox.size(), 1);
    const recovered = new PersistenceOutbox(dir, silent);
    const writes = [];
    await recovered.flush(() => ({ isAvailable: () => true, call: async (method, params) => {
      writes.push({ method, params });
      return {};
    } }));
    assert.equal(recovered.size(), 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "session.appendMessage");
    assert.equal(writes[0].params.turnId, "original-turn");
    assert.deepEqual(writes[0].params.message, message);
  } finally {
    await removeTree(dir);
  }
});


for (const delegate of [false, true]) {
  test(`nested ${delegate ? "delegate" : "root"} tool lineage survives outbox recovery`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-nested-tool-outbox-"));
    const silent = () => undefined;
    try {
      const persistenceOutbox = new PersistenceOutbox(dir, silent);
      const queued = [];
      const enqueue = persistenceOutbox.enqueue.bind(persistenceOutbox);
      persistenceOutbox.enqueue = (...args) => {
        const pending = enqueue(...args);
        queued.push(pending);
        return pending;
      };
      const { persistAgentEvent } = createEventPersistence({
        runtimeState: { host: null },
        activeTurns: new Map([["session", "turn-1"]]),
        activeToolCalls: new Map(),
        activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
        approvedExecutionIdsBySession: new Map(),
        approvedExecutionTurns: new Map(),
        pendingExecutionFinishes: new Map(),
        planSubmissionTurnIds: new Set(),
        persistenceOutbox,
        transcriptRewrite,
        logger: { app: silent },
      });
      const lineage = {
        nestedParentToolCallId: "code-1",
        ...(delegate ? { parentToolCallId: "task-1", agentName: "reader" } : {}),
      };
      persistAgentEvent({ sessionId: "session", turnId: "turn-1", ts: 1_000, ...lineage,
        event: { type: "tool_start", toolCallId: "read-1", toolName: "Read", args: { path: "a.ts" } } });
      persistAgentEvent({ sessionId: "session", turnId: "turn-1", ts: 1_100, ...lineage,
        event: { type: "tool_end", toolCallId: "read-1", result: "contents" } });
      await Promise.all(queued);
      const recovered = new PersistenceOutbox(dir, silent);
      const writes = [];
      await recovered.flush(() => ({ isAvailable: () => true, call: async (_method, params) => {
        writes.push(params);
        return {};
      } }));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].turnId, "turn-1");
      assert.equal(writes[0].message.nestedParentToolCallId, "code-1");
      assert.equal(writes[0].message.parentToolCallId, delegate ? "task-1" : undefined);
    } finally {
      await removeTree(dir);
    }
  });
}

test("a settled delegate republishes its Task row with the call it started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-tool-refresh-"));
  const silent = () => undefined;
  try {
    const persistenceOutbox = new PersistenceOutbox(dir, silent);
    const { persistAgentEvent } = createEventPersistence({
      runtimeState: { host: null },
      activeTurns: new Map([["session", "turn-1"]]),
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      persistenceOutbox,
      transcriptRewrite,
      logger: { app: silent },
    });
    const args = { agent: "explorer", task: "Inspect the code", description: "look" };
    persistAgentEvent({ sessionId: "session", turnId: "turn-1", ts: 1_000,
      event: { type: "tool_start", toolCallId: "task-call", toolName: "Task", args } });
    // `Task` settles when the delegate starts: the provisional row says running.
    persistAgentEvent({ sessionId: "session", turnId: "turn-1", ts: 1_010,
      event: { type: "tool_end", toolCallId: "task-call", result: {
        content: "Delegation d1 started: the explorer subagent is working in the background",
        truncated: false,
        details: { delegationId: "d1", agent: "explorer", status: "running", startedAt: 1_000 },
      } } });
    // The runtime republishes the row when the delegate finishes. The frame
    // carries the settled result and nothing else, so the name and arguments
    // have to come from the call it replaces.
    persistAgentEvent({ sessionId: "session", turnId: "turn-1", ts: 9_000,
      event: { type: "tool_end", toolCallId: "task-call", result: {
        content: "Delegation d1 settled: the explorer subagent completed after 3 turn(s)",
        truncated: false,
        details: {
          delegationId: "d1", agent: "explorer", status: "completed",
          startedAt: 1_000, completedAt: 9_000, turns: 3, toolCalls: 5,
        },
      } } });
    const written = [];
    await persistenceOutbox.flush(() => ({ isAvailable: () => true, call: async (_method, params) => {
      written.push(params.message);
      return {};
    } }));
    const settled = written.at(-1);
    assert.equal(settled.toolName, "Task");
    assert.deepEqual(settled.toolArgs, args);
    assert.equal(settled.toolResult.details.status, "completed");
    assert.equal(settled.toolResult.details.delegationId, "d1");
    // The row's runtime still measures from the call's own start, not the
    // republish: an elapsed clock that resets would hide a slow delegate.
    assert.equal(settled.toolDurationMs, 8_000);
  } finally {
    await removeTree(dir);
  }
});

test("settlement replacing an in-flight Task append is written after the initial snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-outbox-race-"));
  const outbox = new PersistenceOutbox(dir, () => undefined);
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const pending = new Promise((resolve) => { releaseFirst = resolve; });
  const written = [];
  const host = { isAvailable: () => true, call: async (_method, params) => {
    written.push(params.message);
    if (written.length === 1) {
      firstStarted();
      await pending;
    }
    return {};
  } };
  try {
    const entry = { key: "message:session:task", sessionId: "session", turnId: "turn" };
    await outbox.enqueue({ ...entry, message: { status: "running" } }, () => host);
    await started;
    await outbox.enqueue({ ...entry, message: { status: "completed" } }, () => host);
    releaseFirst();
    await outbox.flush(() => host);
    assert.deepEqual(written, [{ status: "running" }, { status: "completed" }]);
    assert.equal(outbox.size(), 0);
  } finally {
    releaseFirst();
    await outbox.flush(() => host);
    await removeTree(dir);
  }
});

test("independent usage aggregates survive an unavailable Host and outbox restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-outbox-"));
  try {
    const outbox = new PersistenceOutbox(dir, () => undefined);
    const queued = [];
    const enqueue = outbox.enqueue.bind(outbox);
    outbox.enqueue = (...args) => { const promise = enqueue(...args); queued.push(promise); return promise; };
    const { persistAgentEvent } = createEventPersistence({
      runtimeState: { host: null }, activeTurns: new Map([["session", "turn"]]),
      activeToolCalls: new Map(), activeToolCallKey: (s, t) => `${s}:${t}`,
      approvedExecutionIdsBySession: new Map(), approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(), planSubmissionTurnIds: new Set(),
      persistenceOutbox: outbox, transcriptRewrite,
      logger: { app: () => undefined }, addActiveTurnUsage: () => undefined,
    });
    for (const id of ["image-a", "image-b", "image-a"]) {
      const operation = { operationId: id, inputTokens: 10, outputTokens: 2, totalTokens: 12 };
      persistAgentEvent({ sessionId: "session", turnId: "turn", ts: 1, event: {
        type: "usage", usage: { ...operation, operationId: undefined, aggregation: "aggregate", operations: [operation] },
      } });
    }
    await Promise.all(queued);
    const recovered = new PersistenceOutbox(dir, () => undefined);
    const written = [];
    await recovered.flush(() => ({ isAvailable: () => true, call: async (method, params) => { if (method === "session.recordUsage") written.push(params); return {}; } }));
    assert.deepEqual(written.flatMap(row => row.usage.operations.map(op => op.operationId)).sort(), ["image-a", "image-b"]);
    assert.ok(written.every(row => row.turnId === "turn"));
  } finally { await removeTree(dir); }
});
