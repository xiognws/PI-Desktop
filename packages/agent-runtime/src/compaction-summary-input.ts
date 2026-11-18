import {
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { truncateMessageText } from "./agent-messages.js";
import {
  ESTIMATED_TEXT_CHARS_PER_TOKEN,
  estimateTokens,
} from "./pi-runtime-estimates.js";
import { convertToLlm, serializeConversation } from "./pi-runtime-messages.js";
import type { CompactionPreparation } from "./pi-runtime-types.js";
import { DEFAULT_MAX_TOKENS } from "./provider-binding.js";

/**
 * Sizing and retry policy for the automatic summary request (ADR 0282).
 *
 * The desktop summary adapter serializes messages into one text prompt and
 * caps every tool result at 2 000 characters. The budget guard used to add up
 * `estimateTokens` over the raw messages instead,
 * so a session whose bulk was tool output looked several times larger than the
 * prompt it would actually send and was routed to retained-tail recovery
 * without ever asking the model (issue #543). These helpers size the prompt the
 * the way the adapter sends it and shrink the input one bounded step — when
 * even that does not fit, they split the range into chunks that each do, so the
 * budget decides how many requests a summary takes rather than whether the
 * model is asked at all (issue #827).
 */

/**
 * Retries after the first failed summary request. pi-ai only retries responses
 * its classifier calls transient (overload, 5xx, dropped streams, timeouts);
 * quota, auth, and malformed-request failures return on the first attempt.
 * Waits are 2s, 4s, 8s, so a flapping provider costs at most ~14s of extra
 * wall clock before the retained-tail fallback runs.
 */
export const COMPACTION_SUMMARY_MAX_RETRIES = 3;
export const COMPACTION_SUMMARY_RETRY_BASE_MS = 2_000;

export const COMPACTION_SUMMARY_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: COMPACTION_SUMMARY_MAX_RETRIES,
  baseDelayMs: COMPACTION_SUMMARY_RETRY_BASE_MS,
};

/**
 * Per-tool-result character cap on the reduced input. pi already caps at 2 000
 * when serializing; the reduced pass keeps a prefix a quarter of that so the
 * model still sees what each call returned without the bulk.
 */
export const COMPACTION_REDUCED_TOOL_RESULT_CHARS = 500;

const REDUCED_TOOL_RESULT_SUFFIX = "\n\n[... tool output truncated for the summary request]";
/**
 * Tokens held back from the window for the summary prompt template itself, on
 * top of the model's own output allowance. The preflight guard and the chunk
 * planner both subtract it, so their budgets cannot disagree.
 */
export const COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS = 2_048;
/**
 * Upper bound on the summary requests one checkpoint may issue on the target
 * path (see {@link COMPACTION_SUMMARY_CHUNK_TARGET_SHARE}). A range that needs
 * more than this is planned again at the full request budget
 * ({@link COMPACTION_SUMMARY_COVERAGE_MAX_CHUNKS}) rather than dropped, so the
 * request cap never costs a message its coverage.
 */
export const COMPACTION_SUMMARY_MAX_CHUNKS = 8;
/**
 * Coverage ceiling for a split summary, kept at the pre-change bound. It is
 * only reached by a range too large for {@link COMPACTION_SUMMARY_MAX_CHUNKS}
 * chunks at the target size — a checkpoint that would otherwise fall back to
 * retained-tail recovery and lose the summary entirely. Coverage wins over cost
 * there; every other range stays on the cheaper target path.
 */
export const COMPACTION_SUMMARY_COVERAGE_MAX_CHUNKS = 16;
/**
 * Share of a chunk's budget the planner fills. A chunk is sized from
 * `estimateTokens`, while the request carries pi's serialized form — per-message
 * role labels and separators the raw estimate does not count — so the margin
 * keeps every planned request inside the window it was planned for.
 */
export const COMPACTION_SUMMARY_CHUNK_MARGIN = 0.9;
/**
 * Share of the request budget one chunk of a split summary targets. The
 * pre-change sizing filled ~84% of the window in every chunk (measured at a
 * 200k-token request budget: 168k per chunk), so a split summary issued a
 * handful of near-window prompts, each carrying the running summary, and the
 * cap of 16 reached ~3.9M prompt tokens for one checkpoint on a 256k window.
 * A quarter of the budget keeps every request of the common case small and
 * bounds the target path at one half window of prompt per checkpoint. Ranges
 * the target size cannot cover in {@link COMPACTION_SUMMARY_MAX_CHUNKS} requests
 * are re-planned at the full budget instead of being dropped.
 */
export const COMPACTION_SUMMARY_CHUNK_TARGET_SHARE = 0.25;
/** Appended when a single message alone exceeds one chunk's budget. */
export const SUMMARY_CHUNK_TRUNCATION_MARKER =
  "\n\n[message truncated: the summary request budget could not carry it whole]";

export type CompactionSummaryInput = Pick<
  CompactionPreparation,
  "messagesToSummarize" | "turnPrefixMessages" | "isSplitTurn" | "previousSummary"
>;

/**
 * Tokens the summary request(s) will carry for this input, using pi's own
 * serialization and text-token estimate. A split turn issues two requests
 * (history, then turn prefix);
 * the larger one is the one that has to fit.
 */
export function estimateSummaryPromptTokens(input: CompactionSummaryInput): number {
  const historyChars =
    serializeConversation(convertToLlm(input.messagesToSummarize)).length +
    (input.previousSummary?.length ?? 0);
  const turnPrefixChars =
    input.isSplitTurn && input.turnPrefixMessages.length > 0
      ? serializeConversation(convertToLlm(input.turnPrefixMessages)).length
      : 0;
  return Math.ceil(
    Math.max(historyChars, turnPrefixChars) / ESTIMATED_TEXT_CHARS_PER_TOKEN,
  );
}

/**
 * One bounded reduction of the summary input: tool results keep a short prefix
 * and assistant thinking is dropped. User text, assistant text, and tool call
 * arguments survive intact, so the summary still covers every message the
 * checkpoint will file behind its boundary. Returns undefined when nothing was
 * reducible, so the caller can fall back without a pointless second request.
 *
 * The tool-result cut is the cheapest thing in this file: a summary only has to
 * know that a call happened and roughly what it returned, so every result is
 * bounded regardless of age — including the newest ones, and including both
 * sides of a split turn. Tool output is what makes a tool-heavy range large, and
 * the summary request pays for it once per chunk, so a recency exemption would
 * put the whole cost of a fresh result back on every chunk it lands in.
 */
export function reduceSummaryInput<T extends CompactionSummaryInput>(
  input: T,
): T | undefined {
  let changed = false;
  const reduce = (messages: AgentMessage[]) =>
    messages.map((message) => {
      const reduced = reduceMessage(message);
      if (reduced !== message) changed = true;
      return reduced;
    });
  const messagesToSummarize = reduce(input.messagesToSummarize);
  const turnPrefixMessages = reduce(input.turnPrefixMessages);
  if (!changed) return undefined;
  return { ...input, messagesToSummarize, turnPrefixMessages };
}

function reduceMessage(message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") {
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "text") return block;
      const text = boundToolResultText(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });
    return changed ? { ...message, content } : message;
  }
  if (message.role === "assistant") {
    if (!message.content.some((block) => block.type === "thinking")) return message;
    return {
      ...message,
      content: message.content.filter((block) => block.type !== "thinking"),
    };
  }
  return message;
}

function boundToolResultText(text: string): string {
  if (text.length <= COMPACTION_REDUCED_TOOL_RESULT_CHARS) return text;
  return text.slice(0, COMPACTION_REDUCED_TOOL_RESULT_CHARS) + REDUCED_TOOL_RESULT_SUFFIX;
}

/**
 * Output allowance one summary request gets: the smaller of 80% of the request
 * headroom and the model's own output budget. pi makes the same computation
 * when it caps the summary request, so the chunk planner and the guard agree.
 */
export function compactionSummaryOutputBudget(input: {
  requestHeadroom: number;
  modelMaxTokens?: number;
}): number {
  return Math.min(
    Math.floor(input.requestHeadroom * 0.8),
    Math.max(1, Math.round(input.modelMaxTokens || DEFAULT_MAX_TOKENS)),
  );
}

/**
 * Tokens the summary prompt may carry inside this window. A prompt at or above
 * it cannot be sent with room for the summary itself, so the guard rejects it —
 * and the chunk planner splits the range so every chunk stays below it.
 */
export function compactionSummaryInputLimit(input: {
  hardLimit: number;
  requestHeadroom: number;
  modelMaxTokens?: number;
}): number {
  return Math.max(
    1,
    input.hardLimit +
      input.requestHeadroom -
      compactionSummaryOutputBudget(input) -
      COMPACTION_SUMMARY_PROMPT_SAFETY_TOKENS,
  );
}

/**
 * Room one chunk keeps for the summary its prompt carries. The first chunk
 * carries `previousSummary`; every later chunk carries a summary no larger
 * than the model's output budget. The carried text is measured with the same
 * character estimate as {@link estimateSummaryPromptTokens}. Reserving it at
 * four characters per token under-counts the guard by 12.5%, and the chunk
 * margin applies only to what remains, so the first chunk can leave the window
 * it was planned for.
 */
export function compactionSummaryReserveTokens(input: {
  previousSummary?: string;
  outputBudget: number;
}): number {
  return Math.max(
    Math.ceil((input.previousSummary?.length ?? 0) / ESTIMATED_TEXT_CHARS_PER_TOKEN),
    input.outputBudget,
  );
}

/**
 * Split a summary input into contiguous chunks that each fit the request
 * budget, so a range too large for one prompt is still summarized instead of
 * skipped (issue #827).
 *
 * Every chunk is summarized by its own request and each request carries the
 * summary of the chunk before it — pi's update-the-summary prompt — so the chain
 * ends on one summary covering the whole range. `reserveTokens` is the room the
 * running summary and the previous summary may take in a chunk's prompt.
 *
 * Three plans, cheapest first:
 *
 * 1. the whole range in one chunk when it fits the request budget — one request
 *    is always the cheapest checkpoint, and the range is not split for its own
 *    sake;
 * 2. chunks at {@link COMPACTION_SUMMARY_CHUNK_TARGET_SHARE} of that budget,
 *    at most {@link COMPACTION_SUMMARY_MAX_CHUNKS} requests;
 * 3. chunks at the full budget, at most
 *    {@link COMPACTION_SUMMARY_COVERAGE_MAX_CHUNKS} requests.
 *
 * Plan 2 leaves plan 3 for a range it cannot cover intact, and plan 3 is the
 * pre-change sizing, so a smaller chunk never costs a message its place in the
 * summary. Returns undefined only when even plan 3 cannot cover the range: it
 * is empty, or it would need more requests than the coverage ceiling allows. A
 * single message larger than the chunk budget is truncated rather than dropped,
 * so no message ever leaves the summary's scope.
 */
export function planSummaryChunks(
  input: CompactionSummaryInput,
  options: { summaryInputLimit: number; reserveTokens: number },
): AgentMessage[][] | undefined {
  const range = [
    ...input.messagesToSummarize,
    ...(input.isSplitTurn ? input.turnPrefixMessages : []),
  ];
  if (range.length === 0) return undefined;
  const costs = range.map((message) => Math.max(1, Math.ceil(estimateTokens(message))));
  const fullBudget = Math.max(
    1,
    Math.floor(
      (options.summaryInputLimit - Math.max(0, options.reserveTokens)) *
        COMPACTION_SUMMARY_CHUNK_MARGIN,
    ),
  );
  // One request is cheaper than any split: fewer carried summaries and no
  // repeated prompt overhead. Only a range that does not fit is planned apart.
  if (costs.reduce((sum, cost) => sum + cost, 0) <= fullBudget) return [range];
  const targetBudget = Math.max(
    1,
    Math.floor(fullBudget * COMPACTION_SUMMARY_CHUNK_TARGET_SHARE),
  );
  const targeted = planSummaryChunksAtBudget(
    range,
    costs,
    targetBudget,
    COMPACTION_SUMMARY_MAX_CHUNKS,
    false,
  );
  if (targeted) return targeted;
  // The cheaper plan cannot cover this range: fall back to the pre-change
  // sizing, which carries whole messages and reaches further, instead of
  // dropping history out of the summary.
  return planSummaryChunksAtBudget(
    range,
    costs,
    fullBudget,
    COMPACTION_SUMMARY_COVERAGE_MAX_CHUNKS,
    true,
  );
}

/**
 * Pack `range` into contiguous chunks of at most `budgetTokens`. With
 * `truncateOversized` a message larger than the budget keeps a bounded prefix
 * instead of leaving the range uncovered; without it such a message makes the
 * whole plan fail, which is how the target pass hands the range to the coverage
 * pass rather than silently trimming a message the cheaper budget cannot carry.
 */
function planSummaryChunksAtBudget(
  range: AgentMessage[],
  costs: number[],
  budgetTokens: number,
  maxChunks: number,
  truncateOversized: boolean,
): AgentMessage[][] | undefined {
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let tokens = 0;
  for (const [index, message] of range.entries()) {
    const cost = costs[index] ?? 1;
    if (cost > budgetTokens && !truncateOversized) return undefined;
    const fit = Math.min(cost, budgetTokens);
    if (current.length > 0 && tokens + fit > budgetTokens) {
      chunks.push(current);
      if (chunks.length >= maxChunks) return undefined;
      current = [];
      tokens = 0;
    }
    current.push(
      cost > budgetTokens
        ? truncateMessageText(
            message,
            Math.floor(budgetTokens * ESTIMATED_TEXT_CHARS_PER_TOKEN),
            SUMMARY_CHUNK_TRUNCATION_MARKER,
          )
        : message,
    );
    tokens += fit;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : undefined;
}

/**
 * Sum the provider usage of the requests that produced one summary. pi reports
 * one usage object per request and a chunked summary spends several, so the
 * checkpoint — and the cost the context inspector shows — carries the total of
 * the requests the summary actually took.
 */
export function addSummaryUsage(
  total: Usage | undefined,
  next: Usage | undefined,
): Usage | undefined {
  if (!next) return total;
  if (!total) return next;
  const cacheWrite1h = total.cacheWrite1h ?? next.cacheWrite1h;
  const reasoning = total.reasoning ?? next.reasoning;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    ...(reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: (total.cost?.input ?? 0) + (next.cost?.input ?? 0),
      output: (total.cost?.output ?? 0) + (next.cost?.output ?? 0),
      cacheRead: (total.cost?.cacheRead ?? 0) + (next.cost?.cacheRead ?? 0),
      cacheWrite: (total.cost?.cacheWrite ?? 0) + (next.cost?.cacheWrite ?? 0),
      total: (total.cost?.total ?? 0) + (next.cost?.total ?? 0),
    },
  };
}
