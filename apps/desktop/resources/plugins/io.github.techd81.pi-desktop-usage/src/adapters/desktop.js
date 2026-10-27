"use strict";

/**
 * PI-Desktop session adapter.
 *
 * Source files: `~/.pi-desktop/sessions/<session id>.jsonl`.
 * Unlike the Pi CLI, the session header carries no `cwd`, and the provider is
 * referenced by its catalogue id (a UUID), never by name — provider names and
 * project paths are resolved later, best-effort, by `src/lib/enrich.js`.
 *
 * Recognised entries:
 * - `{ "type": "session", "sessionId", "schema" }` → header
 * - `{ "type": "message", "role": "assistant", "meta": { "usage": {...} } }`
 *   → `meta.usage` is the operation-level accounting of one request
 * - `{ "type": "compaction", "desktopUsage": {...} }` → summary usage
 *
 * `meta.usage` may also appear in aggregate form (`aggregation: "aggregate"`
 * with an `operations` array). The aggregate total is the authoritative one, so
 * its operations are counted and any shortfall is added back as one extra
 * record: a trimmed operations list must under-report neither tokens nor money.
 */

const {
  createRecord,
  isObject,
  parseTimestampMs,
  readCostTotal,
  tokenCount,
} = require("../lib/normalize.js");

const SOURCE = "desktop";

/**
 * @param {string} line
 * @returns {unknown}
 */
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} parsed
 * @returns {{ sessionId: string, projectPath: null } | null}
 */
function parseHeader(parsed) {
  if (!isObject(parsed) || parsed.type !== "session") return null;
  const sessionId =
    typeof parsed.sessionId === "string" && parsed.sessionId !== ""
      ? parsed.sessionId
      : typeof parsed.id === "string"
        ? parsed.id
        : "";
  if (sessionId === "") return null;
  return { sessionId, projectPath: null };
}

/**
 * Token fields appear in camelCase on the desktop side and in lowerCamel on the
 * Pi side; both are accepted so a payload shape shift never zeroes the numbers.
 * @param {Record<string, any>} usage
 * @param {"input" | "output" | "cacheRead" | "cacheWrite" | "total"} field
 * @returns {any}
 */
function tokenField(usage, field) {
  const camel = `$${field}Tokens`.slice(1);
  if (usage[camel] !== undefined) return usage[camel];
  return usage[field];
}

/**
 * @param {Record<string, any>} usage
 * @param {{ sessionId: string, projectPath: string | null, entryId: string, timestampMs: number, kind: "assistant" | "summary" }} ctx
 * @returns {import("../lib/normalize.js").UsageRecord[]}
 */
function recordFromUsage(usage, ctx) {
  if (!isObject(usage)) return [];
  const record = createRecord({
    source: SOURCE,
    sessionId: ctx.sessionId,
    entryId: ctx.entryId,
    timestampMs: ctx.timestampMs,
    provider: typeof usage.providerId === "string" ? usage.providerId : "",
    providerKey: typeof usage.providerId === "string" ? usage.providerId : "",
    model: typeof usage.modelId === "string" ? usage.modelId : "",
    inputTokens: tokenField(usage, "input"),
    outputTokens: tokenField(usage, "output"),
    cacheReadTokens: tokenField(usage, "cacheRead"),
    cacheWriteTokens: tokenField(usage, "cacheWrite"),
    costUsd: readCostTotal(usage.cost),
    costStatus: usage.costStatus,
    projectPath: ctx.projectPath,
    kind: ctx.kind,
  });
  return record ? [record] : [];
}

/**
 * The gap between the aggregate total and the operations it ships with.
 *
 * A payload can carry a subset of its operations (a trimmed list, a partially
 * written row). Counting the operations alone then silently loses both tokens
 * and money, with `costComplete` still reporting a complete number.
 *
 * @param {Record<string, any>} usage
 * @param {import("../lib/normalize.js").UsageRecord[]} records
 * @param {{ sessionId: string, projectPath: string | null, entryId: string, timestampMs: number, kind: "assistant" | "summary" }} ctx
 * @returns {import("../lib/normalize.js").UsageRecord | null}
 */
function remainderRecord(usage, records, ctx) {
  if (usage.aggregation !== "aggregate") return null;

  const aggTotal = tokenCount(tokenField(usage, "total"));
  const seenTotal = records.reduce((sum, record) => sum + record.totalTokens, 0);
  const totalGap = aggTotal - seenTotal;

  const aggCost = readCostTotal(usage.cost);
  const seenCost = records.reduce(
    (sum, record) => sum + (typeof record.costUsd === "number" ? record.costUsd : 0),
    0,
  );
  const costGap = aggCost === null ? 0 : aggCost - seenCost;

  const gapOf = (field, recordField) =>
    Math.max(0, tokenCount(tokenField(usage, field)) - records.reduce((sum, record) => sum + record[recordField], 0));
  let inputTokens = gapOf("input", "inputTokens");
  const outputTokens = gapOf("output", "outputTokens");
  const cacheReadTokens = gapOf("cacheRead", "cacheReadTokens");
  const cacheWriteTokens = gapOf("cacheWrite", "cacheWriteTokens");
  const parts = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  // A payload can omit `totalTokens` and still ship more per-field usage than its
  // operations cover, so the field difference counts on its own.
  if (totalGap <= 0 && costGap <= 1e-9 && parts <= 0) return null;

  // A row that only reports its total still has to be counted in full.
  if (totalGap > parts) inputTokens += totalGap - parts;

  return createRecord({
    source: SOURCE,
    sessionId: ctx.sessionId,
    entryId: `${ctx.entryId}#remainder`,
    timestampMs: ctx.timestampMs,
    provider: typeof usage.providerId === "string" ? usage.providerId : "",
    providerKey: typeof usage.providerId === "string" ? usage.providerId : "",
    model: typeof usage.modelId === "string" ? usage.modelId : "",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: costGap > 1e-9 ? costGap : null,
    costStatus: usage.costStatus,
    projectPath: ctx.projectPath,
    kind: ctx.kind,
    // The aggregate row is the same request as its operations, so the remainder
    // adds tokens and money without inventing another request.
    requestCount: 0,
  });
}

/**
 * Expand one usage object into records, unwrapping aggregate payloads.
 *
 * @param {Record<string, any>} usage
 * @param {{ sessionId: string, projectPath: string | null, entryId: string, timestampMs: number, kind: "assistant" | "summary" }} ctx
 * @returns {import("../lib/normalize.js").UsageRecord[]}
 */
function expandUsage(usage, ctx) {
  if (!isObject(usage)) return [];

  const operations = Array.isArray(usage.operations) ? usage.operations : [];
  if (operations.length > 0) {
    const records = [];
    operations.forEach((operation, index) => {
      if (!isObject(operation)) return;
      const operationId =
        typeof operation.operationId === "string" && operation.operationId !== ""
          ? operation.operationId
          : `op${index}`;
      // Operations may omit the provider/model; fall back to the message-level ids.
      const merged = { ...operation };
      if (merged.providerId === undefined) merged.providerId = usage.providerId;
      if (merged.modelId === undefined) merged.modelId = usage.modelId;
      records.push(...recordFromUsage(merged, { ...ctx, entryId: `${ctx.entryId}#${operationId}` }));
    });
    const remainder = remainderRecord(usage, records, ctx);
    if (remainder) records.push(remainder);
    return records;
  }

  // A bare aggregate without its operations cannot be split, and counting it
  // would double the operations once they are written; skip it.
  if (usage.aggregation === "aggregate") return [];

  return recordFromUsage(usage, ctx);
}

/**
 * One JSONL entry → zero or more records.
 *
 * @param {unknown} parsed
 * @param {{ sessionId: string, projectPath: string | null, fallbackTimestampMs: number }} ctx
 * @returns {import("../lib/normalize.js").UsageRecord[]}
 */
function parseEntry(parsed, ctx) {
  if (!isObject(parsed)) return [];

  if (parsed.type === "compaction" || parsed.type === "branch_summary") {
    const usage = isObject(parsed.desktopUsage) ? parsed.desktopUsage : parsed.usage;
    const timestampMs =
      parseTimestampMs(parsed.timestamp) ??
      parseTimestampMs(parsed.createdAt) ??
      parseTimestampMs(parsed.endedAt) ??
      ctx.fallbackTimestampMs;
    const entryId = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : `summary:${timestampMs}`;
    return expandUsage(usage, {
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      entryId,
      timestampMs,
      kind: "summary",
    });
  }

  if (parsed.type !== "message") return [];
  if (parsed.role !== "assistant") return [];
  const meta = isObject(parsed.meta) ? parsed.meta : null;
  const usage = meta && isObject(meta.usage) ? meta.usage : null;
  if (!usage) return [];

  const timestampMs =
    parseTimestampMs(parsed.createdAt) ??
    parseTimestampMs(parsed.timestamp) ??
    parseTimestampMs(usage.completedAt) ??
    ctx.fallbackTimestampMs;
  const entryId = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : `message:${timestampMs}`;

  return expandUsage(
    {
      ...usage,
      providerId: usage.providerId ?? meta?.providerId,
      modelId: usage.modelId ?? meta?.modelId,
    },
    {
      sessionId: ctx.sessionId,
      projectPath: ctx.projectPath,
      entryId,
      timestampMs,
      kind: "assistant",
    },
  );
}

module.exports = {
  SOURCE,
  safeParse,
  parseHeader,
  parseEntry,
  expandUsage,
};
