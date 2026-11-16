/**
 * Stream rules — the matching half of "time-traveling" course correction.
 *
 * A rule is a regular expression over the assistant's own text as it streams. When
 * it matches, the stream is aborted mid-token and the rule's message is injected
 * as a system reminder before the same turn is retried. That is the whole point:
 * the rule costs nothing on the turns that behave, so a project can carry twenty
 * of them without twenty paragraphs of system prompt.
 *
 * This module owns *when a rule fires* and nothing else — no provider calls, no
 * retry loop, no persistence. Keeping the decision pure is what makes it testable:
 * the loop that consumes it only has to ask "did anything fire in this chunk?".
 */

/** One configured rule. `pattern` is a JavaScript regular expression source. */
export type StreamRule = {
  /** Stable identifier; used to count activations and to report which rule fired. */
  id: string;
  /** Short human name, shown in the injected reminder and in the UI. */
  name: string;
  /** Regular expression source, matched against the assistant text of this turn. */
  pattern: string;
  /** `i`, `m`, `s` and `u` are accepted; anything else is rejected. */
  flags?: string;
  /** Injected as a system reminder when the rule fires. */
  message: string;
  /**
   * How many times this rule may fire inside one turn. Defaults to 1: a rule that
   * keeps firing would abort every retry forever.
   */
  maxPerTurn?: number;
  /** Disabled rules stay configured but never match. */
  enabled?: boolean;
};

export type StreamRuleHit = {
  rule: StreamRule;
  /** The matched text, trimmed for the reminder. */
  match: string;
  /** Index into the accumulated text where the match started. */
  index: number;
};

export type ParsedRules =
  | { ok: true; rules: StreamRule[] }
  | { ok: false; error: string };

const ALLOWED_FLAGS = /^[imsug]*$/;
const MAX_PATTERN_CHARS = 400;
const MAX_MESSAGE_CHARS = 2_000;

/**
 * Validate a rule list coming from settings or a file.
 *
 * Every failure names the rule: a silently dropped pattern is the worst outcome
 * here, because the rule then looks configured and never fires.
 */
export function parseStreamRules(input: unknown): ParsedRules {
  if (!Array.isArray(input)) return { ok: false, error: "stream rules must be an array" };
  const seen = new Set<string>();
  const rules: StreamRule[] = [];
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `rule ${index + 1} is not an object` };
    }
    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const pattern = typeof candidate.pattern === "string" ? candidate.pattern : "";
    const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
    const flags = typeof candidate.flags === "string" ? candidate.flags : "";
    const label = id || name || `rule ${index + 1}`;

    if (!id) return { ok: false, error: `${label}: id is required` };
    if (seen.has(id)) return { ok: false, error: `${label}: duplicate id` };
    if (!name) return { ok: false, error: `${label}: name is required` };
    if (!pattern.trim()) return { ok: false, error: `${label}: pattern is required` };
    if (pattern.length > MAX_PATTERN_CHARS) {
      return { ok: false, error: `${label}: pattern exceeds ${MAX_PATTERN_CHARS} characters` };
    }
    if (!message) return { ok: false, error: `${label}: message is required` };
    if (message.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `${label}: message exceeds ${MAX_MESSAGE_CHARS} characters` };
    }
    if (!ALLOWED_FLAGS.test(flags)) {
      return { ok: false, error: `${label}: only the i, m, s, u flags are supported` };
    }
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      return { ok: false, error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (candidate.maxPerTurn !== undefined) {
      const value = candidate.maxPerTurn;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        return { ok: false, error: `${label}: maxPerTurn must be a positive integer` };
      }
    }
    seen.add(id);
    rules.push({
      id,
      name,
      pattern,
      ...(flags ? { flags } : {}),
      message,
      ...(candidate.maxPerTurn === undefined ? {} : { maxPerTurn: candidate.maxPerTurn as number }),
      ...(candidate.enabled === false ? { enabled: false } : {}),
    });
  }
  return { ok: true, rules };
}

/** How a fired rule is handed to the model as a reminder. */
export function renderStreamRuleReminder(hit: StreamRuleHit): string {
  const matched = hit.match.length > 200 ? `${hit.match.slice(0, 200)}…` : hit.match;
  return [
    `<stream-rule name="${hit.rule.name}">`,
    hit.rule.message,
    `(matched: ${JSON.stringify(matched)})`,
    "</stream-rule>",
  ].join("\n");
}

export type StreamRuleMatcher = {
  /**
   * Look for a rule that fires on the assistant text produced so far.
   *
   * `text` is the whole assistant text of the current attempt, not just the latest
   * chunk: `^\s*import` and "the third bullet" only mean something over the full
   * accumulation. A rule that already reached `maxPerTurn` in this turn is skipped,
   * so a retry that trips the same rule again is not an infinite loop.
   */
  check: (text: string) => StreamRuleHit | undefined;
  /** Forget the per-turn activation counts; the loop calls this at turn start. */
  reset: () => void;
  /** Which rules fired so far in this turn, in order. */
  activations: () => { rule: StreamRule; count: number }[];
};

export function createStreamRuleMatcher(rules: readonly StreamRule[]): StreamRuleMatcher {
  const compiled = rules
    .filter((rule) => rule.enabled !== false)
    .map((rule) => ({ rule, regex: new RegExp(rule.pattern, rule.flags ?? "") }));
  let counts = new Map<string, number>();

  return {
    check(text: string): StreamRuleHit | undefined {
      if (!text) return undefined;
      for (const { rule, regex } of compiled) {
        const limit = rule.maxPerTurn ?? 1;
        const used = counts.get(rule.id) ?? 0;
        if (used >= limit) continue;
        // A global or sticky regex keeps state between calls; a fresh lastIndex
        // makes every check independent of the previous chunk.
        regex.lastIndex = 0;
        const match = regex.exec(text);
        if (!match) continue;
        counts.set(rule.id, used + 1);
        return { rule, match: match[0], index: match.index };
      }
      return undefined;
    },
    reset(): void {
      counts = new Map();
    },
    activations(): { rule: StreamRule; count: number }[] {
      return compiled
        .filter(({ rule }) => (counts.get(rule.id) ?? 0) > 0)
        .map(({ rule }) => ({ rule, count: counts.get(rule.id) ?? 0 }));
    },
  };
}
