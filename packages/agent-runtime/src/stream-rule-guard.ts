/**
 * The execution half of stream rules: watch assistant text, stop the turn once.
 *
 * `stream-rules.ts` decides *which* rule fires; this decides *what the loop does
 * about it* and owns the two pieces of state that keep that from running away:
 * the per-turn retry budget and the rule that already fired on this attempt.
 *
 * It is deliberately transport-agnostic: the runtime hands it the assistant text
 * as it arrives and an `abort` callback, and gets back the reminder to inject.
 * Keeping the policy here means the hook in the (large) runtime stays a few lines
 * and this part can be tested without a provider.
 */
import {
  createStreamRuleMatcher,
  renderStreamRuleReminder,
  type StreamRule,
  type StreamRuleHit,
} from "./stream-rules.js";

/** How many rule-triggered retries one turn may make before the loop gives up. */
export const MAX_RULE_RETRIES = 3;

export type StreamRuleFire = {
  /** The rule that fired. */
  hit: StreamRuleHit;
  /** Message to append as a system reminder before retrying. */
  reminder: string;
  /** Which retry this is, starting at 1. */
  attempt: number;
};

export type StreamRuleGuardOptions = {
  rules: readonly StreamRule[];
  /** Interrupt the in-flight stream. Called at most once per firing. */
  abort: () => void;
  maxRetries?: number;
};

export class StreamRuleGuard {
  private matcher;
  private readonly rules: readonly StreamRule[];
  private readonly abort: () => void;
  private readonly maxRetries: number;
  private retries = 0;
  /** Rules already reported to the caller on this attempt. */
  private firedThisAttempt = new Set<string>();
  /** Fire counts across the whole turn; the matcher itself is re-armed per attempt. */
  private turnCounts = new Map<string, number>();
  private stopped = false;

  constructor(options: StreamRuleGuardOptions) {
    this.rules = options.rules;
    this.matcher = createStreamRuleMatcher(options.rules);
    this.abort = options.abort;
    this.maxRetries = options.maxRetries ?? MAX_RULE_RETRIES;
  }

  /**
   * Observe the assistant text accumulated so far.
   *
   * Returns a firing when a rule matched, or `undefined` when the text is fine and
   * the turn should continue. The stream is aborted before this returns, so the
   * caller can append the reminder and retry without racing the provider.
   *
   * Once the retry budget is exhausted the guard stops aborting: an extra rule hit
   * only produces `undefined`, so a turn whose rules can never be satisfied still
   * terminates instead of looping.
   */
  observe(text: string): StreamRuleFire | undefined {
    if (this.stopped) return undefined;
    const hit = this.matcher.check(text);
    if (!hit) return undefined;
    if (this.firedThisAttempt.has(hit.rule.id)) return undefined;
    if (this.retries >= this.maxRetries) {
      this.stopped = true;
      return undefined;
    }
    this.firedThisAttempt.add(hit.rule.id);
    this.turnCounts.set(hit.rule.id, (this.turnCounts.get(hit.rule.id) ?? 0) + 1);
    this.retries += 1;
    this.abort();
    return { hit, reminder: renderStreamRuleReminder(hit), attempt: this.retries };
  }

  /** A new attempt started: rules may fire again, but the budget does not reset. */
  beginAttempt(): void {
    this.firedThisAttempt = new Set();
    // The matcher's own `maxPerTurn` is a guard against looping *within* one attempt;
    // across a retry, the retry budget above is the thing that bounds the turn. Without
    // this reset a rule could never fire twice and the second retry would be wasted.
    this.matcher.reset();
  }

  /** Reset for the next turn. */
  reset(): void {
    this.matcher.reset();
    this.retries = 0;
    this.firedThisAttempt = new Set();
    this.turnCounts = new Map();
    this.stopped = false;
  }

  /** Retries used so far, for the turn summary. */
  get retriesUsed(): number {
    return this.retries;
  }

  /** Rules that fired this turn, for the transcript event. */
  activations(): { rule: StreamRule; count: number }[] {
    return this.rules
      .map((rule) => ({ rule, count: this.turnCounts.get(rule.id) ?? 0 }))
      .filter((entry) => entry.count > 0);
  }
}

/** Assistant text from a pi message, which may be a string or an array of blocks. */
export function assistantTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") {
      out += block;
      continue;
    }
    if (block && typeof block === "object") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") out += text;
    }
  }
  return out;
}
