import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AUTO_COMPACTION_TRIGGER_RATIO,
  automaticCompactionThresholdFor,
  COMPACTION_MAX_KEEP_RECENT_TOKENS,
  COMPACTION_MIN_KEEP_RECENT_TOKENS,
  COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
  contextBudgetFor,
  contextBudgetLimitsFor,
  retainedUserMessageBudget,
} from "./context-budget.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from "./provider-binding.js";

describe("contextBudgetFor", () => {
  it("derives the hard limit from provider-request headroom", () => {
    // The numbers the session runtime's own compaction tests assert against.
    expect(contextBudgetFor({ contextWindow: 256_000, maxTokens: 32_000 }, []))
      .toEqual({
        tokens: 0,
        hardLimit: 224_000,
        requestHeadroom: 32_000,
        keepRecentTokens: 44_800,
      });
  });
  it("derives an early automatic trigger while preserving the hard guard", () => {
    const limits = contextBudgetLimitsFor({
      contextWindow: 128_000,
      maxTokens: 32_000,
    });
    const trigger = automaticCompactionThresholdFor(limits);

    expect(AUTO_COMPACTION_TRIGGER_RATIO).toBe(0.5);
    expect(trigger).toBe(48_000);
    expect(trigger).toBeLessThan(limits.hardLimit);
    expect(automaticCompactionThresholdFor({ hardLimit: 1 })).toBe(1);
  });

  it("compacts at half the safe budget, so a long turn cannot re-send the window", () => {
    // A 262,144-token window plans a 229,376 hard limit and compacts at half of it.
    const limits = contextBudgetLimitsFor({ contextWindow: 262_144, maxTokens: 32_768 });

    expect(limits.hardLimit).toBe(229_376);
    expect(automaticCompactionThresholdFor(limits)).toBe(114_688);
    // The retained tail still fits under the trigger, so a checkpoint keeps its window.
    expect(limits.keepRecentTokens).toBeLessThan(automaticCompactionThresholdFor(limits));
  });

  it("plans a million-token model against the window it declares", () => {
    // Settings → Models says a million, so the turn plans against a million. This
    // used to be capped at 262,144, which is what made the settings page and the
    // session budget disagree.
    const limited = contextBudgetLimitsFor({ contextWindow: 1_000_000, maxTokens: 32_768 });
    const quarter = contextBudgetLimitsFor({
      contextWindow: 262_144,
      maxTokens: 32_768,
    });

    expect(limited.hardLimit).toBe(950_000);
    expect(automaticCompactionThresholdFor(limited)).toBe(475_000);
    expect(limited).not.toEqual(quarter);
  });

  it("clamps the retained tail for a small model context window", () => {
    // A 32K window cannot spare 20% for the tail: the half-budget clamp wins,
    // which lands exactly on the minimum rather than below it.
    expect(contextBudgetLimitsFor({ contextWindow: 32_000, maxTokens: 8_000 }))
      .toEqual({
        hardLimit: 16_000,
        requestHeadroom: 16_000,
        keepRecentTokens: 8_000,
      });
  });

  it("holds the reserve floor on a 64K window", () => {
    // The 25% cap keeps a 64K window's output budget at 16_000, just under the
    // reserve floor, so the floor is what the headroom settles on.
    expect(contextBudgetLimitsFor({ contextWindow: 64_000, maxTokens: 16_000 }))
      .toEqual({
        hardLimit: 47_616,
        requestHeadroom: 16_384,
        keepRecentTokens: 9_523,
      });
  });

  it("falls back to the package defaults when the model reports no window", () => {
    const budget = contextBudgetLimitsFor({});
    const fallback = contextBudgetLimitsFor({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    expect(budget).toEqual(fallback);
    // Written as the derivation rather than as literals: this assertion silently went
    // stale the last time the default output cap moved, and the failure said nothing
    // about which number had changed.
    const headroom = Math.floor(DEFAULT_CONTEXT_WINDOW * 0.25);
    expect(budget.requestHeadroom).toBe(headroom);
    expect(budget.hardLimit).toBe(DEFAULT_CONTEXT_WINDOW - headroom);
    expect(budget.keepRecentTokens).toBe(Math.floor(DEFAULT_CONTEXT_WINDOW * 0.15));
  });

  it("derives the tail from the configured window", () => {
    const advertised = contextBudgetLimitsFor({
      contextWindow: 1_048_576,
      maxTokens: 64_000,
    });

    // A million-token model is planned as a million-token model: the headroom is
    // its 64K output budget, not a share of a smaller, invented window.
    expect(advertised.hardLimit).toBe(984_576);
    expect(advertised.keepRecentTokens).toBe(64_000);
  });

  it("never lets the retained tail exceed half of the hard limit", () => {
    for (const contextWindow of [
      1, 100, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 200_000, 256_000,
      1_048_576, 2_000_000,
    ]) {
      const budget = contextBudgetLimitsFor({ contextWindow });

      expect(budget.hardLimit).toBeGreaterThan(0);
      // A one-token window is degenerate: it can reserve nothing and still has
      // to leave a positive limit behind, so headroom may legitimately be zero.
      expect(budget.requestHeadroom).toBeGreaterThanOrEqual(0);
      expect(budget.requestHeadroom).toBeLessThan(contextWindow);
      expect(budget.keepRecentTokens).toBeGreaterThan(0);
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(
        Math.max(1, Math.floor(budget.hardLimit * 0.5)),
      );
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
      );
      // The minimum only applies while half the budget can still cover it.
      if (budget.hardLimit * 0.5 >= COMPACTION_MIN_KEEP_RECENT_TOKENS) {
        expect(budget.keepRecentTokens).toBeGreaterThanOrEqual(
          COMPACTION_MIN_KEEP_RECENT_TOKENS,
        );
      }
    }
  });

  it("counts the estimated tokens of the supplied context", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "count these tokens", timestamp: 1 },
    ];

    const empty = contextBudgetFor({ contextWindow: 256_000 }, []);
    const filled = contextBudgetFor({ contextWindow: 256_000 }, messages);

    expect(empty.tokens).toBe(0);
    expect(filled.tokens).toBeGreaterThan(0);
    // Only `tokens` depends on the messages; the thresholds are window-derived.
    expect({ ...filled, tokens: 0 }).toEqual(empty);
  });
});

describe("retainedUserMessageBudget", () => {
  it("uses the flat cap when the budget can afford it", () => {
    expect(retainedUserMessageBudget({ hardLimit: 224_000 })).toBe(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
    );
  });

  it("clamps against half of the hard limit on a small window", () => {
    expect(retainedUserMessageBudget({ hardLimit: 16_000 })).toBe(8_000);
    expect(retainedUserMessageBudget({ hardLimit: 2_000 })).toBe(1_000);
  });

  it("stays positive when half the budget rounds to zero", () => {
    expect(retainedUserMessageBudget({ hardLimit: 1 })).toBe(1);
  });
});

describe("hosted search target model threading", () => {
  /** A Responses model carrying the identity an adapter stamps. */
  const model = (id: string): Model<"openai-responses"> => ({
    id,
    name: "test",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  const searchHistory = (modelId: string, size: number): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: modelId,
    content: [
      {
        type: "hostedSearch",
        phase: "web_search_call",
        blockId: "search_fixture",
        wire: {
          type: "web_search_call",
          id: "search_fixture",
          status: "completed",
          action: { type: "search", query: "a".repeat(size) },
        },
      },
    ],
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  it("charges the search history the target model replays", () => {
    const target = model("gpt-test");
    const small = contextBudgetFor(target, [searchHistory("gpt-test", 100)]).tokens;
    const large = contextBudgetFor(target, [searchHistory("gpt-test", 10_100)])
      .tokens;
    expect(small).toBeGreaterThan(0);
    expect(large - small).toBe(
      Math.ceil(10_100 / 3.5) - Math.ceil(100 / 3.5),
    );
  });

  it("charges nothing for search the target model cannot replay", () => {
    // The Responses adapter replays `web_search_call` items only for the model
    // that produced them: the request carries nothing for another id, so the
    // budget must not count it either.
    expect(
      contextBudgetFor(model("gpt-test"), [searchHistory("other-model", 10_000)])
        .tokens,
    ).toBe(0);
  });

  it("stays conservative when the caller has partial model facts", () => {
    // Window facts alone say nothing about which items the provider replays;
    // charging them keeps the hard limit safe.
    const tokens = contextBudgetFor(
      { contextWindow: 200_000, maxTokens: 8_192 },
      [searchHistory("other-model", 10_000)],
    ).tokens;
    expect(tokens).toBeGreaterThan(2_000);
  });

  it("derives the same thresholds from a full model as from its window facts", () => {
    const full = model("gpt-test");
    expect(contextBudgetLimitsFor(full)).toEqual(
      contextBudgetLimitsFor({
        contextWindow: full.contextWindow,
        maxTokens: full.maxTokens,
      }),
    );
  });
});
