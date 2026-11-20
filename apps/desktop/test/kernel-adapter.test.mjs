import assert from "node:assert/strict";
import test from "node:test";

const { adaptKernelEvent, adaptKernelMessage, adaptKernelUsage } = await import(
  "../electron/main/kernel/kernel-adapter.ts"
);

/*
 * The kernel speaks its own vocabulary; the renderer, the persistence outbox and
 * the transcript consume `AgentEventEnvelope`. These cases pin the translation
 * against frames recorded from the real binary
 * (`target/debug/nubo-proto.exe serve`, scripted provider), so a change on
 * either side shows up as a failing mapping instead of a blank transcript.
 */

/** Recorded from the real kernel: one scripted text turn. */
const RECORDED = {
  messageEnd: {
    type: "message_end",
    message: {
      created_at_ms: 1795140248789,
      id: "0fac54d9-06ea-4533-8c1c-40ab2ae79d20",
      parts: [{ text: "hello-from-kernel", type: "text" }],
      role: "assistant",
      stop_reason: "end_turn",
      usage: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    },
  },
  messageUpdate: {
    type: "message_update",
    deltaText: "hello-from-kernel",
    message: {
      created_at_ms: 1795140248789,
      id: "0fac54d9-06ea-4533-8c1c-40ab2ae79d20",
      parts: [{ text: "hello-from-kernel", type: "text" }],
      role: "assistant",
    },
    stream: "delta",
  },
  usage: {
    type: "usage",
    usage: {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 12,
      outputTokens: 8,
      reasoningTokens: 3,
    },
  },
  status: {
    type: "status",
    status: {
      currentTurnId: "turn-1",
      isRunning: true,
      pendingToolConfirmations: 0,
      sessionId: "probe-session",
    },
  },
  skillReview: { type: "skill_review", outcome: "skipped", reason: "too-few-tools" },
  agentEnd: { type: "agent_end", messageIds: ["0fac54d9-06ea-4533-8c1c-40ab2ae79d20"] },
};

const envelope = (event) => ({
  sessionId: "probe-session",
  turnId: "turn-1",
  ts: 1795140248789,
  event,
});

test("a recorded assistant message becomes a renderable UiMessage", () => {
  const adapted = adaptKernelEvent(envelope(RECORDED.messageEnd));
  assert.ok(adapted);
  assert.equal(adapted.sessionId, "probe-session");
  assert.equal(adapted.turnId, "turn-1");
  assert.equal(adapted.event.type, "message_end");
  const message = adapted.event.message;
  assert.equal(message.id, "0fac54d9-06ea-4533-8c1c-40ab2ae79d20");
  assert.equal(message.role, "assistant");
  assert.equal(message.content, "hello-from-kernel");
  assert.equal(message.status, "complete");
  assert.equal(message.createdAt, new Date(1795140248789).toISOString());
  assert.equal(message.usage.totalTokens, 0);
  assert.equal(message.outputTruncated, undefined);
});

test("a streaming frame keeps the append-only contract", () => {
  const adapted = adaptKernelEvent(envelope(RECORDED.messageUpdate));
  assert.ok(adapted);
  assert.equal(adapted.event.type, "message_update");
  assert.equal(adapted.event.stream, "delta");
  assert.equal(adapted.event.deltaText, "hello-from-kernel");
  assert.equal(adapted.event.message.content, "hello-from-kernel");
});

test("usage totals are computed because the kernel reports the parts only", () => {
  const adapted = adaptKernelEvent(envelope(RECORDED.usage));
  assert.ok(adapted);
  assert.equal(adapted.event.type, "usage");
  assert.deepEqual(adapted.event.usage, {
    inputTokens: 12,
    outputTokens: 8,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 3,
    totalTokens: 20,
  });
});

test("status carries the running flag the composer lock reads", () => {
  const adapted = adaptKernelEvent(envelope(RECORDED.status));
  assert.ok(adapted);
  assert.equal(adapted.event.type, "status");
  assert.equal(adapted.event.status.isRunning, true);
  assert.equal(adapted.event.status.currentTurnId, "turn-1");
  assert.equal(adapted.event.status.sessionId, "probe-session");
});

test("skill_review and agent_end pass through unchanged", () => {
  const review = adaptKernelEvent(envelope(RECORDED.skillReview));
  assert.deepEqual(review.event, { type: "skill_review", outcome: "skipped", reason: "too-few-tools" });
  const end = adaptKernelEvent(envelope(RECORDED.agentEnd));
  assert.deepEqual(end.event, { type: "agent_end", messageIds: [RECORDED.agentEnd.messageIds[0]] });
});

test("thinking parts stay separate from the answer text", () => {
  const message = adaptKernelMessage({
    id: "m1",
    role: "assistant",
    created_at_ms: 1795140248789,
    parts: [
      { type: "thinking", text: "weigh options" },
      { type: "text", text: "answer" },
    ],
  });
  assert.equal(message.content, "answer");
  assert.equal(message.thinking, "weigh options");
});

test("a truncated provider answer is marked, not silently shortened", () => {
  const message = adaptKernelMessage({
    id: "m1",
    role: "assistant",
    created_at_ms: 1795140248789,
    parts: [{ type: "text", text: "half a sen" }],
    stop_reason: "max_tokens",
  });
  assert.equal(message.outputTruncated, true);
  assert.equal(message.status, "complete");
});

test("an aborted turn is stored as aborted", () => {
  const message = adaptKernelMessage({
    id: "m1",
    role: "assistant",
    created_at_ms: 0,
    parts: [{ type: "text", text: "" }],
    stop_reason: "aborted",
  });
  assert.equal(message.status, "aborted");
});

test("frames the contract cannot address are refused instead of guessed", () => {
  assert.equal(adaptKernelEvent(null), null);
  assert.equal(adaptKernelEvent({ event: { type: "agent_start" } }), null, "no session id");
  assert.equal(adaptKernelEvent(envelope({ type: "not_a_kernel_event" })), null);
  assert.equal(adaptKernelEvent(envelope({ type: "message_end", message: { role: "assistant" } })), null);
  assert.equal(adaptKernelMessage({ role: "assistant" }), null, "no id");
  assert.equal(adaptKernelMessage({ id: "m1", role: "narrator" }), null, "unknown role");
  assert.equal(adaptKernelUsage(undefined), null);
});
