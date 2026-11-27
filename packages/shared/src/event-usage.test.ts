import { describe, expect, it } from "vitest";
import { usageForEvent, ownsUsageTurn } from "./event-usage.js";
import type { AgentEventEnvelope } from "./types/agent.js";

const operation = {
  operationId: "image-request", usageOrigin: "pi" as const,
  providerId: "account-a", modelId: "image-model",
  inputTokens: 12, outputTokens: 8, totalTokens: 20,
  costStatus: "unknown" as const,
};
function envelope(result: unknown): AgentEventEnvelope {
  return { sessionId: "session", turnId: "old-turn", ts: 1,
    event: { type: "tool_end", toolCallId: "image-tool", result } };
}
describe("tool operation accounting", () => {
  it("counts a physical image request once even when several artifacts expose it", () => {
    const usage = usageForEvent(envelope({ details: { operations: [
      { usage: operation }, { usage: operation },
      { usage: { ...operation, operationId: "second-request" } },
    ] } }));
    expect(usage?.totalTokens).toBe(40);
    expect(usage?.operations).toHaveLength(2);
    expect(usage?.costStatus).toBe("unknown");
    expect(usage?.operations?.[0].providerId).toBe("account-a");
  });
  it("ignores ordinary tool details and unidentifiable usage", () => {
    for (const result of [null, "text", { details: {} }, { details: { operations: [
      null, { usage: { totalTokens: 20 } },
      { usage: { ...operation, inputTokens: "12" } },
    ] } }]) expect(usageForEvent(envelope(result))).toBeUndefined();
  });
  it("does not debit a later active turn for a late image result", () => {
    expect(ownsUsageTurn(envelope({}), "new-turn")).toBe(false);
    expect(ownsUsageTurn(envelope({}), "old-turn")).toBe(true);
    expect(ownsUsageTurn(envelope({}), undefined)).toBe(false);
  });
});

it("ignores invalid counts in provider-supplied tool operations", () => {
  for (const value of [NaN, Infinity, -1, 0.5]) {
    for (const key of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
      expect(usageForEvent(envelope({ details: { operations: [{ usage: { ...operation, [key]: value } }] } }))).toBeUndefined();
    }
  }
});

it("folds a settled delegation's spend into the turn that asked for it", () => {
  // The shape `delegation_details` writes: the plain counts, plus one atomic
  // operation whose id marks it as delegated work.
  const settled = {
    delegationId: "del-7", agent: "test-runner", status: "completed",
    turns: 4, toolCalls: 9, modelId: "9554",
    usage: { inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 41_000,
      cacheWriteTokens: 0, reasoningTokens: 0 },
    operations: [{ usage: {
      operationId: "delegation:del-7", inputTokens: 12_000, outputTokens: 800,
      totalTokens: 12_800, cacheReadTokens: 41_000, cacheWriteTokens: 0,
      reasoningTokens: 0, agentName: "test-runner", modelId: "9554",
    } }],
  };
  const usage = usageForEvent(envelope({ details: settled }));
  // A single settled operation folds to itself, so the record carries the id the
  // ledger unions by; a replayed settle therefore counts once.
  expect(usage?.operationId).toBe("delegation:del-7");
  expect(usage?.inputTokens).toBe(12_000);
  // Vitest takes the explanation as the expectation's message, not a second
  // argument to `toBe` (which is Jest's shape).
  expect(usage?.cacheReadTokens, "cache reads are the biggest bucket in practice").toBe(41_000);
  expect(usage?.totalTokens).toBe(12_800);
  // The worker's name belongs to the delegation (`details.agent`), not to the
  // usage record: one turn can fold several workers' requests.
  expect(settled.agent).toBe("test-runner");
});

it("keeps one record per delegation when the settle event repeats", () => {
  const operation = {
    operationId: "delegation:del-7", inputTokens: 12_000, outputTokens: 800,
    totalTokens: 12_800, cacheReadTokens: 41_000,
  };
  const usage = usageForEvent(envelope({ details: { operations: [
    { usage: operation }, { usage: operation },
  ] } }));
  expect(usage?.operations).toHaveLength(1);
  expect(usage?.inputTokens, "a replayed settle must not double the bill").toBe(12_000);
});

it("does not bill a worker's own steps as well as its settled delegation", () => {
  // A delegate's spend is reported once, on settle, as `delegation:<id>`. Its per-step
  // usage events now carry the parent turn (so its rows are addressable), and counting
  // those too would charge the session twice for the same request.
  const usage = {
    type: "usage" as const,
    usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 },
  };
  const delegated = usageForEvent({
    sessionId: "session", turnId: "parent-turn", ts: 1,
    parentToolCallId: "call_1", agentName: "explorer", event: usage,
  } as never);
  const parent = usageForEvent({
    sessionId: "session", turnId: "parent-turn", ts: 1, event: usage,
  } as never);

  expect(delegated).toBeUndefined();
  expect(parent?.totalTokens).toBe(1_000, "the orchestrator's own step still counts");
});
