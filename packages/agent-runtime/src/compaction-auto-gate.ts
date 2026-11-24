/**
 * The automatic-compaction gate: the one place where a turn's token ledger and
 * the compression-failure cooldown decide whether the runtime compacts.
 *
 * Before this module the runtime compared one estimated number against
 * `automaticCompactionThresholdFor(budget)`, so a turn could only ever compact
 * for one reason and nothing could hold an attempt back after a failure. The
 * gate keeps the threshold identical — `turnTokenBudget` derives
 * `thresholdTokens` from the same `context-budget.ts` formula — and adds the two
 * things the runtime was missing: the tool-result-share early trigger and the
 * cooldown that stops a structurally failing summary from being re-issued every
 * turn.
 *
 * Why the gate rather than three call sites reading three modules: the trigger
 * and the diagnostic have to agree, and the cooldown has to be consulted exactly
 * where the trigger is (not one layer up, where `prepareNextTurn` and
 * `promptTurn` would each need their own copy of the rule).
 *
 * The hard limit is never gated. A cooldown that suppressed a compaction the
 * hard boundary demands would replace a failed summary with a rejected provider
 * request, which is strictly worse — so an attempt the hard limit forces always
 * runs.
 */

import type { ContextBudget } from "./context-budget.js";
import {
  type ActiveCompressionCooldown,
  type CompressionFailureCooldownStore,
} from "./compaction-cooldown.js";
import { turnTokenBudget, type TurnTokenBudget, type TurnTokenLedger } from "./turn-token-ledger.js";

export type AutomaticCompactionGate = {
  /** The ledger's projection of this turn onto the session budget. */
  view: TurnTokenBudget;
  /** Why an automatic compaction is wanted, or null. */
  trigger: TurnTokenBudget["trigger"];
  /** Live failure cooldown, when one is armed. */
  cooldown?: ActiveCompressionCooldown;
  /** True when the cooldown held back an attempt the trigger asked for. */
  suppressedByCooldown: boolean;
  /** What the caller acts on: run an automatic compaction this boundary. */
  compact: boolean;
};

export type AutomaticCompactionGateInput = {
  ledger: TurnTokenLedger;
  /** The estimate for the next request, as `contextBudget()` produced it. */
  budget: Pick<ContextBudget, "tokens" | "hardLimit"> & { window?: number };
  cooldowns: CompressionFailureCooldownStore;
  sessionId: string;
  /** Evaluation clock, epoch ms. Injected so expiry is testable. */
  at: number;
};

/**
 * Decide whether this boundary compacts automatically.
 *
 * `compact` is false whenever the context trigger is not reached, so a runtime
 * with the ledger attached still does nothing on a turn that used to do nothing.
 */
export function automaticCompactionGate(
  input: AutomaticCompactionGateInput,
): AutomaticCompactionGate {
  const view = turnTokenBudget(input.ledger, input.budget);
  const cooldown = input.cooldowns.active(input.sessionId, input.at);
  const trigger = view.trigger;
  // The hard limit outranks the cooldown: the request that follows a held-back
  // attempt would be rejected, so an attempt that boundary forces still runs.
  const atHardLimit = view.contextTokens >= view.hardLimitTokens;
  const suppressedByCooldown = trigger !== null && cooldown !== undefined && !atHardLimit;
  return {
    view,
    trigger,
    ...(cooldown ? { cooldown } : {}),
    suppressedByCooldown,
    compact: trigger !== null && !suppressedByCooldown,
  };
}
