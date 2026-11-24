/**
 * Per-turn token ledger: what the turn spent, per class, and how much of the
 * compaction budget is left.
 *
 * Context pressure in Pi was only ever a single estimated number, so a turn that
 * carried 70k tokens of tool output and a turn that carried 70k tokens of user
 * conversation looked identical to the compaction trigger, and neither could be
 * attributed afterwards. The ledger keeps the three classes apart —
 * `inputTokens` (what the provider charged for prompts), `outputTokens` (what the
 * model emitted) and `toolResultTokens` (what tools appended to the context and
 * every later request re-sends) — and derives the remaining budget from the same
 * `context-budget.ts` thresholds the trigger uses, so the diagnostic and the
 * decision can never disagree.
 *
 * Accounting rules that matter for the numbers to mean anything:
 * - A usage rollup (`aggregation: "aggregate"`) is not counted on top of the
 *   operations it already contains.
 * - One tool result is capped before it is added: a single 2M-char paste should
 *   not by itself claim the whole budget.
 * - Every counter is monotonic within a turn; the ledger is what proves a turn's
 *   spend, not what predicts the next request.
 */

import type { MessageUsage } from "@pi-workspace/shared";
import {
  AUTO_COMPACTION_TRIGGER_RATIO,
  automaticCompactionThresholdFor,
  type ContextBudget,
} from "./context-budget.js";

/**
 * Floor of the per-result cap in the ledger.
 *
 * A cap exists so one pathological result cannot dominate the turn, but a fixed
 * one is wrong in both directions: the host allows a 128KB Read (~37k tokens),
 * so an 8k ceiling made the tool-result-share trigger read a quarter of reality
 * and wait for seven results where two were already half the budget. The runtime
 * passes a ceiling derived from the session's safe budget; this constant is only
 * the floor under it.
 */
export const TOOL_RESULT_TOKEN_CEILING = 8_000;

/**
 * Share of the safe budget a turn's tool results may reach. Past this the turn is
 * already paying for them on every request, so compaction is worth it even
 * slightly before the context estimate alone would ask for it.
 */
export const TOOL_RESULT_SHARE_TRIGGER = 0.5;

/**
 * The ledger may only pull compaction earlier than the context trigger, never
 * earlier than this fraction of it — otherwise a tool-heavy but still small turn
 * would compact for no reason.
 */
export const LEDGER_EARLY_TRIGGER_FLOOR = 0.8;

export type TurnTokenCounters = {
  /** Turn the counters belong to; empty before the first `beginTurn`. */
  turnId: string;
  /** Sum of provider-reported prompt tokens for the turn's requests. */
  inputTokens: number;
  /** Sum of provider-reported completion tokens. */
  outputTokens: number;
  /** Tokens tool output added to the context during the turn. */
  toolResultTokens: number;
  /** Tool results counted, for attribution. */
  toolResultCount: number;
  /** Provider requests the turn made. */
  requests: number;
};

export type TurnTokenBudget = TurnTokenCounters & {
  /** Estimated tokens the next request would carry. */
  contextTokens: number;
  /** Context size that starts compaction. */
  thresholdTokens: number;
  /** Context size at which no request may be issued. */
  hardLimitTokens: number;
  /** Tokens left before the compaction trigger. Never negative. */
  remainingTokens: number;
  /** Tokens left before the hard boundary. Never negative. */
  remainingToHardLimitTokens: number;
  /** `contextTokens / hardLimitTokens`, 0..1. */
  usedRatio: number;
  /** `toolResultTokens / hardLimitTokens`, 0..1. */
  toolResultShare: number;
  /** Why the ledger wants a compaction now, or null. */
  trigger: "context_threshold" | "tool_result_share" | null;
};

function emptyCounters(turnId: string): TurnTokenCounters {
  return {
    turnId,
    inputTokens: 0,
    outputTokens: 0,
    toolResultTokens: 0,
    toolResultCount: 0,
    requests: 0,
  };
}

function add(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/** One turn's counters. Reset by `beginTurn`, never shared between turns. */
export class TurnTokenLedger {
  private counters: TurnTokenCounters = emptyCounters("");

  beginTurn(turnId: string): void {
    this.counters = emptyCounters(turnId);
  }

  /**
   * Account one provider request's usage.
   *
   * An aggregate rollup is skipped: it already contains the operations that were
   * reported individually, so adding it would double the turn's spend.
   */
  recordUsage(usage: Pick<MessageUsage, "inputTokens" | "outputTokens" | "aggregation">): void {
    if (usage.aggregation === "aggregate") return;
    this.counters = {
      ...this.counters,
      inputTokens: this.counters.inputTokens + add(usage.inputTokens),
      outputTokens: this.counters.outputTokens + add(usage.outputTokens),
      requests: this.counters.requests + 1,
    };
  }

  /**
   * Account tool output the turn appended to its context.
   *
   * `ceilingTokens` is the caller's per-result cap, derived from the session's
   * safe budget so a legitimately large result is counted at its real size. The
   * fixed floor only applies when the caller has no budget to offer.
   */
  recordToolResult(tokens: number, ceilingTokens?: number): void {
    const ceiling = Math.max(TOOL_RESULT_TOKEN_CEILING, ceilingTokens ?? 0);
    const bounded = Math.min(add(tokens), ceiling);
    this.counters = {
      ...this.counters,
      toolResultTokens: this.counters.toolResultTokens + bounded,
      toolResultCount: this.counters.toolResultCount + 1,
    };
  }

  snapshot(): TurnTokenCounters {
    return { ...this.counters };
  }
}

/**
 * The turn's counters projected onto the session's budget, including what is left
 * of it. `budget.tokens` is the estimate for the *next* request, so it is read at
 * projection time rather than stored in the ledger.
 */
export function turnTokenBudget(
  ledger: TurnTokenLedger,
  budget: Pick<ContextBudget, "tokens" | "hardLimit"> & { window?: number },
  options: { toolResultShare?: number; earlyTriggerFloor?: number } = {},
): TurnTokenBudget {
  const counters = ledger.snapshot();
  const contextTokens = Math.max(0, Math.round(budget.tokens));
  const hardLimitTokens = Math.max(1, Math.round(budget.hardLimit));
  const thresholdTokens = automaticCompactionThresholdFor({
    hardLimit: hardLimitTokens,
    window: budget.window,
  });
  const share = options.toolResultShare ?? TOOL_RESULT_SHARE_TRIGGER;
  const floor = options.earlyTriggerFloor ?? LEDGER_EARLY_TRIGGER_FLOOR;
  const toolResultShare = counters.toolResultTokens / hardLimitTokens;
  const earlyFloor = thresholdTokens * Math.max(0, Math.min(1, floor));
  const trigger: TurnTokenBudget["trigger"] =
    contextTokens >= thresholdTokens
      ? "context_threshold"
      : counters.toolResultTokens > 0 &&
          toolResultShare >= share &&
          contextTokens >= earlyFloor
        ? "tool_result_share"
        : null;
  return {
    ...counters,
    contextTokens,
    thresholdTokens,
    hardLimitTokens,
    remainingTokens: Math.max(0, thresholdTokens - contextTokens),
    remainingToHardLimitTokens: Math.max(0, hardLimitTokens - contextTokens),
    usedRatio:
      hardLimitTokens > 0 ? Math.min(1, contextTokens / hardLimitTokens) : 1,
    toolResultShare: Math.min(1, toolResultShare),
    trigger,
  };
}

/**
 * Stable, bounded fields for `compaction-diagnostics`. Counts only: no prompt,
 * tool output, or model text ever rides a diagnostic.
 */
export function turnTokenDiagnostic(view: TurnTokenBudget): Record<string, unknown> {
  return {
    /** Tokens left before automatic compaction starts. */
    remainingBudgetTokens: view.remainingTokens,
    /** Tokens left before the hard boundary. */
    remainingHardLimitTokens: view.remainingToHardLimitTokens,
    budgetUsedRatio: Number(view.usedRatio.toFixed(3)),
    inputTokens: view.inputTokens,
    outputTokens: view.outputTokens,
    toolResultTokens: view.toolResultTokens,
    toolResultCount: view.toolResultCount,
    requests: view.requests,
    compactionTrigger: view.trigger,
  };
}

/** Fraction of the safe budget the context trigger already represents. */
export const LEDGER_CONTEXT_TRIGGER_RATIO = AUTO_COMPACTION_TRIGGER_RATIO;
