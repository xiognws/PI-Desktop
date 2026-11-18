import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_TOKEN_CEILING,
  TurnTokenLedger,
  turnTokenBudget,
  turnTokenDiagnostic,
} from "./turn-token-ledger.js";

const budget = (tokens: number, hardLimit = 200_000) => ({ tokens, hardLimit });

function usage(inputTokens: number, outputTokens: number, aggregation?: "operation" | "aggregate") {
  return { inputTokens, outputTokens, ...(aggregation ? { aggregation } : {}) };
}

describe("TurnTokenLedger per-result ceiling", () => {
  it("counts a legitimately large result at its real size when the caller offers a budget", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-big");
    // One 128KB Read as the host allows it: ~37k tokens, far past the old floor.
    ledger.recordToolResult(37_449, 50_000);
    expect(ledger.snapshot().toolResultTokens).toBe(37_449);
  });

  it("keeps the floor when the caller has no budget to offer", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-floor");
    ledger.recordToolResult(37_449);
    expect(ledger.snapshot().toolResultTokens).toBe(TOOL_RESULT_TOKEN_CEILING);
  });

  it("still caps an absurd result at the caller's ceiling", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-absurd");
    ledger.recordToolResult(5_000_000, 50_000);
    expect(ledger.snapshot().toolResultTokens).toBe(50_000);
  });

  it("reaches the tool-result share trigger two results in, not seven", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-share");
    // 200k safe budget ⇒ 100k threshold, 80k early floor, 50% share trigger.
    // Three real 128KB Reads (37.4k each) clear the share trigger; the old fixed
    // 8k ceiling would have recorded 24k for the same three results.
    ledger.recordToolResult(37_449, 180_000);
    ledger.recordToolResult(37_449, 180_000);
    ledger.recordToolResult(37_449, 180_000);
    const view = turnTokenBudget(ledger, budget(90_000, 200_000));
    expect(view.trigger).toBe("tool_result_share");
  });
});

describe("TurnTokenLedger", () => {
  it("keeps input, output and tool-result tokens apart", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(1_200, 300));
    ledger.recordUsage(usage(2_000, 500));
    ledger.recordToolResult(4_000);
    ledger.recordToolResult(1_500);

    expect(ledger.snapshot()).toEqual({
      turnId: "turn-1",
      inputTokens: 3_200,
      outputTokens: 800,
      toolResultTokens: 5_500,
      toolResultCount: 2,
      requests: 2,
    });
  });

  it("does not count an aggregate rollup on top of its operations", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(1_000, 100, "operation"));
    ledger.recordUsage(usage(1_000, 100, "aggregate"));

    expect(ledger.snapshot()).toMatchObject({ inputTokens: 1_000, outputTokens: 100, requests: 1 });
  });

  it("caps one tool result so a single payload cannot claim the budget", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordToolResult(5_000_000);

    expect(ledger.snapshot().toolResultTokens).toBe(TOOL_RESULT_TOKEN_CEILING);
  });

  it("starts every turn from zero", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(9_000, 9_000));
    ledger.beginTurn("turn-2");

    expect(ledger.snapshot()).toEqual({
      turnId: "turn-2",
      inputTokens: 0,
      outputTokens: 0,
      toolResultTokens: 0,
      toolResultCount: 0,
      requests: 0,
    });
  });

  it("ignores unusable token counts", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(Number.NaN, -5));
    ledger.recordToolResult(Number.POSITIVE_INFINITY);

    expect(ledger.snapshot()).toMatchObject({ inputTokens: 0, outputTokens: 0, toolResultTokens: 0 });
  });
});

describe("turnTokenBudget", () => {
  it("reports the budget left before compaction and before the hard boundary", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(3_000, 400));

    const view = turnTokenBudget(ledger, budget(10_000));
    expect(view).toMatchObject({
      contextTokens: 10_000,
      thresholdTokens: 100_000,
      hardLimitTokens: 200_000,
      remainingTokens: 90_000,
      remainingToHardLimitTokens: 190_000,
      usedRatio: 0.05,
      trigger: null,
    });
  });

  it("triggers on the context threshold, matching the live trigger", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    expect(turnTokenBudget(ledger, budget(100_000)).trigger).toBe("context_threshold");
    expect(turnTokenBudget(ledger, budget(99_999)).trigger).toBeNull();
    // The ledger never reports a negative budget.
    expect(turnTokenBudget(ledger, budget(300_000)).remainingTokens).toBe(0);
    expect(turnTokenBudget(ledger, budget(300_000)).usedRatio).toBe(1);
  });

  it("triggers on tool-result pressure only once the turn is genuinely large", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    for (let index = 0; index < 13; index += 1) ledger.recordToolResult(TOOL_RESULT_TOKEN_CEILING);

    // Half the safe budget in tool output, but the context is still small: no compaction.
    const small = turnTokenBudget(ledger, budget(50_000));
    expect(small.toolResultShare).toBeGreaterThan(0.5);
    expect(small.trigger).toBeNull();

    // The same output with the context already near the trigger does compact.
    const large = turnTokenBudget(ledger, budget(85_000));
    expect(large.trigger).toBe("tool_result_share");
  });

  it("stays quiet for a tool-heavy but small turn", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordToolResult(2_000);

    expect(turnTokenBudget(ledger, budget(5_000)).trigger).toBeNull();
  });
});

describe("turnTokenDiagnostic", () => {
  it("publishes counters and the remaining budget only", () => {
    const ledger = new TurnTokenLedger();
    ledger.beginTurn("turn-1");
    ledger.recordUsage(usage(12_000, 800));
    ledger.recordToolResult(3_000);

    expect(turnTokenDiagnostic(turnTokenBudget(ledger, budget(96_000)))).toEqual({
      remainingBudgetTokens: 4_000,
      remainingHardLimitTokens: 104_000,
      budgetUsedRatio: 0.48,
      inputTokens: 12_000,
      outputTokens: 800,
      toolResultTokens: 3_000,
      toolResultCount: 1,
      requests: 1,
      compactionTrigger: null,
    });
  });
});
