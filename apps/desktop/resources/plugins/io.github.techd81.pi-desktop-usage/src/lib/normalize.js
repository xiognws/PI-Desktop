"use strict";

/**
 * The single owner of the normalized usage record that both source adapters
 * produce. Everything is defensive: a malformed payload degrades to zeroes or
 * to `null` (dropped) but never throws, because session files on disk are
 * written by other processes and may be truncated mid-line.
 *
 * @typedef {"cli" | "desktop"} UsageSource
 * @typedef {"assistant" | "summary"} UsageKind
 * @typedef {"recorded" | "estimated" | "unknown"} CostStatus
 *
 * @typedef {Object} UsageRecord
 * @property {string} id            `${source}:${sessionId}:${entryId}` — idempotent dedupe key
 * @property {UsageSource} source
 * @property {string} sessionId
 * @property {string} entryId
 * @property {number} timestampMs
 * @property {string} provider      display name (may be a short provider id before enrichment)
 * @property {string} providerKey   raw provider id, used for name resolution
 * @property {string} model
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} totalTokens   always recomputed, never trusted from the payload
 * @property {number | null} costUsd
 * @property {CostStatus} costStatus
 * @property {string | null} projectPath
 * @property {UsageKind} kind
 * @property {number} requestCount
 */

const COST_RECORDED = "recorded";
const COST_ESTIMATED = "estimated";
const COST_UNKNOWN = "unknown";

/** @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Token counts are discrete and non-negative: anything else degrades to zero.
 * @param {unknown} value
 * @returns {number}
 */
function tokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Number.isInteger(value) ? value : Math.floor(value);
}

/**
 * Upper bound of a representable Date. A larger epoch (a clock glitch, a
 * corrupted field, `1e300`) cannot be turned into a calendar day, so it is
 * rejected here instead of poisoning every downstream window.
 */
const MAX_TIMESTAMP_MS = 8.64e15;

/**
 * Epoch milliseconds from a number or an ISO string; `null` when unusable.
 * @param {unknown} value
 * @returns {number | null}
 */
function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_TIMESTAMP_MS) {
    return value;
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TIMESTAMP_MS) return parsed;
  }
  return null;
}

/**
 * A cost object is only trusted when its `total` is a finite non-negative
 * number; component fields are never summed because Pi already reports the
 * authoritative total and floating-point re-addition would drift. A bare
 * number is accepted as that total, so an upstream shape change degrades to
 * "same number" instead of "every price unknown".
 * @param {unknown} cost
 * @returns {number | null}
 */
function readCostTotal(cost) {
  if (typeof cost === "number") {
    return Number.isFinite(cost) && cost >= 0 ? cost : null;
  }
  if (!isObject(cost)) return null;
  const total = cost.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return null;
  return total;
}

/**
 * @param {unknown} value
 * @returns {CostStatus}
 */
function normalizeCostStatus(value, hasCost) {
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "reported" || lowered === "recorded") return COST_RECORDED;
    if (lowered === "estimated") return COST_ESTIMATED;
    if (lowered === "unknown" || lowered === "unavailable") return COST_UNKNOWN;
  }
  if (hasCost) return COST_ESTIMATED;
  return COST_UNKNOWN;
}

/**
 * Build one canonical record, or `null` when the entry carries no measurable
 * usage at all (no tokens and no cost) or is missing its identity.
 *
 * @param {{
 *   source: UsageSource,
 *   sessionId: string,
 *   entryId: string,
 *   timestampMs: number,
 *   provider?: string,
 *   providerKey?: string,
 *   model?: string,
 *   requestCount?: number,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number,
 *   costUsd?: number | null,
 *   costStatus?: unknown,
 *   projectPath?: string | null,
 *   kind?: UsageKind,
 * }} input
 * @returns {UsageRecord | null}
 */
function createRecord(input) {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const entryId = typeof input.entryId === "string" ? input.entryId : "";
  if (sessionId === "" || entryId === "") return null;

  const inputTokens = tokenCount(input.inputTokens);
  const outputTokens = tokenCount(input.outputTokens);
  const cacheReadTokens = tokenCount(input.cacheReadTokens);
  const cacheWriteTokens = tokenCount(input.cacheWriteTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const costUsd =
    typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0
      ? input.costUsd
      : null;

  if (totalTokens <= 0 && !(typeof costUsd === "number" && costUsd > 0)) return null;

  const timestampMs = parseTimestampMs(input.timestampMs) ?? 0;
  // A record that only carries the remainder of an aggregate already-counted
  // request passes 0 here: it must add tokens and money, not another request.
  const requestCount =
    typeof input.requestCount === "number" && Number.isFinite(input.requestCount) && input.requestCount >= 0
      ? input.requestCount
      : 1;

  const provider = typeof input.provider === "string" ? input.provider : "";
  const providerKey = typeof input.providerKey === "string" && input.providerKey !== "" ? input.providerKey : provider;
  const projectPath =
    typeof input.projectPath === "string" && input.projectPath !== "" ? input.projectPath : null;

  return {
    id: `${input.source}:${sessionId}:${entryId}`,
    source: input.source,
    sessionId,
    entryId,
    timestampMs,
    provider,
    providerKey,
    model: typeof input.model === "string" ? input.model : "",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    costStatus: normalizeCostStatus(input.costStatus, costUsd !== null),
    projectPath,
    kind: input.kind === "summary" ? "summary" : "assistant",
    requestCount,
  };
}

/**
 * Last path segment of a project path, for display.
 * @param {string | null} projectPath
 * @returns {string | null}
 */
function projectNameOf(projectPath) {
  if (typeof projectPath !== "string" || projectPath === "") return null;
  const normalized = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const name = index === -1 ? normalized : normalized.slice(index + 1);
  return name === "" ? normalized : name;
}

module.exports = {
  COST_RECORDED,
  COST_ESTIMATED,
  COST_UNKNOWN,
  MAX_TIMESTAMP_MS,
  isObject,
  tokenCount,
  parseTimestampMs,
  readCostTotal,
  normalizeCostStatus,
  createRecord,
  projectNameOf,
};
