"use strict";

/**
 * Query layer: one pass over the normalized records produces everything the
 * panel draws (totals, previous-period totals, the trend series, the source /
 * model / project rankings and the activity heatmap).
 *
 * Bucketing is calendar based (local time), never `floor((ts - from) / width)`:
 * day/hour keys are built from the local `Date` parts so a DST switch can neither
 * create an empty phantom bucket nor merge two real ones.
 */

const { projectNameOf } = require("./normalize.js");

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };
const HEATMAP_MAX_DAYS = 366;
const MAX_BUCKETS = 400;
const MAX_ROWS = 50;
/** Models listed under one heatmap square; the rest fold into one remainder row. */
const HEAT_MODEL_ROWS = 5;

/** @param {number} ms */
function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** @param {number} ms */
function startOfHour(ms) {
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** @param {number} ms */
function startOfMonth(ms) {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * @param {number} ms
 * @param {number} days
 */
function addDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * Local midnight on January 1st of the year containing `ms`. The heatmap shows
 * the current year to date, which is what makes month headers meaningful.
 * @param {number} ms
 * @returns {number}
 */
function startOfYear(ms) {
  const date = new Date(ms);
  date.setMonth(0, 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * @param {number} ms
 * @param {number} hours
 */
function addHours(ms, hours) {
  const date = new Date(ms);
  date.setHours(date.getHours() + hours);
  return date.getTime();
}

/**
 * @param {number} ms
 * @param {number} months
 */
function addMonths(ms, months) {
  const date = new Date(ms);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

/**
 * @param {number} ms
 * @param {"hour" | "day" | "month"} bucket
 * @returns {string}
 */
function bucketKey(ms, bucket) {
  const date = new Date(ms);
  if (bucket === "hour") {
    // The absolute hour, not the wall clock: when a DST fall-back repeats 01:00
    // two different hours would otherwise collapse into one bucket.
    return String(startOfHour(ms));
  }
  if (bucket === "month") return `${date.getFullYear()}-${date.getMonth()}`;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** @returns {object} a zeroed totals accumulator */
function emptyTotals() {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    cost: 0,
    costMissing: 0,
    costComplete: true,
  };
}

/**
 * @param {ReturnType<typeof emptyTotals>} totals
 * @param {import("./normalize.js").UsageRecord} record
 */
function accumulate(totals, record) {
  totals.tokens += record.totalTokens;
  totals.input += record.inputTokens;
  totals.output += record.outputTokens;
  totals.cacheRead += record.cacheReadTokens;
  totals.cacheWrite += record.cacheWriteTokens;
  totals.requests += record.requestCount ?? 1;
  if (typeof record.costUsd === "number") totals.cost += record.costUsd;
  else totals.costMissing += 1;
  totals.costComplete = totals.costMissing === 0;
}

/**
 * Resolve the window and the trend bucket for one range preset.
 *
 * @param {"today" | "7d" | "30d" | "90d" | "all"} range
 * @param {number} nowMs
 * @param {number} earliestMs
 * @returns {{ fromMs: number, toMs: number, bucket: "hour" | "day" | "month", previousFromMs: number, previousToMs: number }}
 */
function resolveWindow(range, nowMs, earliestMs) {
  const toMs = nowMs;
  if (range === "today") {
    const fromMs = startOfDay(nowMs);
    // Equal-length previous window: a partial day must not be compared to a full one.
    const spanMs = toMs - fromMs;
    return { fromMs, toMs, bucket: "hour", previousFromMs: fromMs - spanMs - 1, previousToMs: fromMs - 1 };
  }
  if (range === "all") {
    const todayStart = startOfDay(nowMs);
    // A record carrying a clock-skewed future timestamp must not invert the
    // window: an inverted window renders zero buckets and a silently empty view.
    const earliestDay = Number.isFinite(earliestMs) && earliestMs > 0 ? startOfDay(earliestMs) : NaN;
    const fromMs = Number.isFinite(earliestDay) ? Math.min(earliestDay, todayStart) : todayStart;
    const spanDays = Math.max(1, Math.round((toMs - fromMs) / 86400000));
    return {
      fromMs,
      toMs,
      bucket: spanDays > 366 ? "month" : "day",
      previousFromMs: 0,
      previousToMs: 0,
    };
  }
  const days = RANGE_DAYS[range] ?? 7;
  const fromMs = startOfDay(addDays(nowMs, -(days - 1)));
  const spanMs = toMs - fromMs;
  return { fromMs, toMs, bucket: "day", previousFromMs: fromMs - spanMs - 1, previousToMs: fromMs - 1 };
}

/**
 * @param {{ fromMs: number, toMs: number, bucket: "hour" | "day" | "month" }} options
 * @returns {Array<{ startMs: number, key: string }>}
 */
function buildBuckets({ fromMs, toMs, bucket }) {
  const buckets = [];
  if (bucket === "hour") {
    let cursor = startOfHour(fromMs);
    while (cursor <= toMs && buckets.length < 50) {
      buckets.push({ startMs: cursor, key: bucketKey(cursor, "hour") });
      cursor = addHours(cursor, 1);
    }
    return buckets;
  }
  if (bucket === "month") {
    let cursor = startOfMonth(fromMs);
    while (cursor <= toMs && buckets.length < MAX_BUCKETS) {
      buckets.push({ startMs: cursor, key: bucketKey(cursor, "month") });
      cursor = addMonths(cursor, 1);
    }
    return buckets;
  }
  let cursor = startOfDay(fromMs);
  while (cursor <= toMs && buckets.length < MAX_BUCKETS) {
    buckets.push({ startMs: cursor, key: bucketKey(cursor, "day") });
    cursor = addDays(cursor, 1);
  }
  return buckets;
}

/**
 * Explicit window coming from the custom range picker. Two days or less is
 * bucketed by hour so a short window still shows a useful curve.
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {{ fromMs: number, toMs: number, bucket: "hour" | "day" | "month", previousFromMs: number, previousToMs: number }}
 */
function resolveCustomWindow(fromMs, toMs) {
  const span = toMs - fromMs;
  // Buckets are capped, so the bucket size has to grow with the window: otherwise
  // the tail of a long custom range would land in totals but in no bucket.
  const bucket = span <= 2 * 86400000 ? "hour" : span > 366 * 86400000 ? "month" : "day";
  return {
    fromMs,
    toMs,
    bucket,
    previousFromMs: fromMs - span - 1,
    previousToMs: fromMs - 1,
  };
}

/**
 * @param {import("./normalize.js").UsageRecord[]} records
 * @param {{
 *   range?: "today" | "7d" | "30d" | "90d" | "all" | "custom",
 *   sources?: string[],
 *   nowMs?: number,
 *   fromMs?: number,
 *   toMs?: number,
 * }} options
 */
function query(records, options = {}) {
  const range = options.range ?? "7d";
  const nowMs = options.nowMs ?? Date.now();
  const sourceFilter =
    Array.isArray(options.sources) && options.sources.length > 0 ? new Set(options.sources) : null;

  const relevant = sourceFilter ? records.filter((record) => sourceFilter.has(record.source)) : records;

  let earliestMs = 0;
  for (const record of relevant) {
    if (record.timestampMs > 0 && (earliestMs === 0 || record.timestampMs < earliestMs)) {
      earliestMs = record.timestampMs;
    }
  }

  const window =
    Number.isFinite(options.fromMs) && Number.isFinite(options.toMs) && options.toMs > options.fromMs
      ? resolveCustomWindow(options.fromMs, options.toMs)
      : resolveWindow(range === "custom" ? "7d" : range, nowMs, earliestMs);
  const { fromMs, toMs, bucket, previousFromMs, previousToMs } = window;

  const buckets = buildBuckets({ fromMs, toMs, bucket });
  const series = buckets.map((entry) => ({
    startMs: entry.startMs,
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    requests: 0,
  }));
  const indexByKey = new Map(buckets.map((entry, index) => [entry.key, index]));

  const totals = emptyTotals();
  const previous = emptyTotals();
  /** @type {Map<string, any>} */
  const bySource = new Map();
  /** @type {Map<string, any>} */
  const byModel = new Map();
  /** @type {Map<string, any>} */
  const byProject = new Map();

  /** @type {Map<string, any>} */
  const heatmapByDay = new Map();
  const heatmapStart = startOfYear(nowMs);

  for (const record of relevant) {
    const ts = record.timestampMs;

    if (ts >= heatmapStart && ts <= toMs) {
      const key = bucketKey(ts, "day");
      const dayRow = heatmapByDay.get(key) ?? {
        tokens: 0,
        cost: 0,
        requests: 0,
        costMissing: 0,
        /** @type {Map<string, any>} */
        models: new Map(),
      };
      dayRow.tokens += record.totalTokens;
      dayRow.requests += record.requestCount ?? 1;
      if (typeof record.costUsd === "number") dayRow.cost += record.costUsd;
      else dayRow.costMissing += 1;
      const dayModelKey = `${record.source}|${record.model || ""}`;
      const dayModel = dayRow.models.get(dayModelKey) ?? {
        model: record.model || "",
        source: record.source,
        provider: record.provider || "",
        tokens: 0,
      };
      dayModel.tokens += record.totalTokens;
      if (!dayModel.provider && record.provider) dayModel.provider = record.provider;
      dayRow.models.set(dayModelKey, dayModel);
      heatmapByDay.set(key, dayRow);
    }

    if (ts >= fromMs && ts <= toMs) {
      accumulate(totals, record);

      const index = indexByKey.get(bucketKey(ts, bucket));
      if (index !== undefined) {
        const point = series[index];
        point.total += record.totalTokens;
        point.input += record.inputTokens;
        point.output += record.outputTokens;
        point.cacheRead += record.cacheReadTokens;
        point.cacheWrite += record.cacheWriteTokens;
        point.requests += record.requestCount ?? 1;
        if (typeof record.costUsd === "number") point.cost += record.costUsd;
      }

      const sourceRow = bySource.get(record.source) ?? {
        source: record.source,
        tokens: 0,
        cost: 0,
        requests: 0,
        costMissing: 0,
        costComplete: true,
      };
      sourceRow.tokens += record.totalTokens;
      sourceRow.requests += record.requestCount ?? 1;
      if (typeof record.costUsd === "number") sourceRow.cost += record.costUsd;
      else sourceRow.costMissing += 1;
      sourceRow.costComplete = sourceRow.costMissing === 0;
      bySource.set(record.source, sourceRow);

      const modelKey = `${record.source}|${record.model || ""}`;
      const modelRow = byModel.get(modelKey) ?? {
        model: record.model || "",
        source: record.source,
        provider: record.provider || "",
        tokens: 0,
        cost: 0,
        requests: 0,
        costMissing: 0,
        costComplete: true,
      };
      modelRow.tokens += record.totalTokens;
      modelRow.requests += record.requestCount ?? 1;
      if (typeof record.costUsd === "number") modelRow.cost += record.costUsd;
      else modelRow.costMissing += 1;
      if (!modelRow.provider && record.provider) modelRow.provider = record.provider;
      modelRow.costComplete = modelRow.costMissing === 0;
      byModel.set(modelKey, modelRow);

      const projectKey = `${record.source}|${record.projectPath ?? ""}`;
      const projectRow = byProject.get(projectKey) ?? {
        projectPath: record.projectPath ?? null,
        projectName: projectNameOf(record.projectPath ?? null),
        source: record.source,
        tokens: 0,
        cost: 0,
        requests: 0,
        costMissing: 0,
        costComplete: true,
      };
      projectRow.tokens += record.totalTokens;
      projectRow.requests += record.requestCount ?? 1;
      if (typeof record.costUsd === "number") projectRow.cost += record.costUsd;
      else projectRow.costMissing += 1;
      projectRow.costComplete = projectRow.costMissing === 0;
      byProject.set(projectKey, projectRow);
    } else if (previousFromMs > 0 && ts >= previousFromMs && ts <= previousToMs) {
      accumulate(previous, record);
    }
  }

  const heatmap = [];
  for (let day = heatmapStart, guard = 0; day <= toMs && guard < HEATMAP_MAX_DAYS; day = addDays(day, 1), guard += 1) {
    const row = heatmapByDay.get(bucketKey(day, "day"));
    // The square's tooltip names the models behind the day; only the largest few
    // are kept per day, so a whole year of detail still fits one panel payload.
    const ranked = row ? [...row.models.values()].sort((a, b) => b.tokens - a.tokens) : [];
    heatmap.push({
      dateMs: day,
      tokens: row?.tokens ?? 0,
      cost: row?.cost ?? 0,
      requests: row?.requests ?? 0,
      costComplete: (row?.costMissing ?? 0) === 0,
      models: ranked.slice(0, HEAT_MODEL_ROWS),
      otherTokens: ranked.slice(HEAT_MODEL_ROWS).reduce((sum, entry) => sum + entry.tokens, 0),
    });
  }

  const modelRows = [...byModel.values()]
    .map((row) => ({
      model: row.model,
      source: row.source,
      provider: row.provider,
      tokens: row.tokens,
      cost: row.cost,
      requests: row.requests,
      avgCost: row.requests > 0 ? row.cost / row.requests : 0,
      costComplete: row.costComplete,
      costMissing: row.costMissing,
    }))
    .sort(
      (a, b) =>
        b.tokens - a.tokens ||
        (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    )
    .slice(0, MAX_ROWS);

  const projectRows = [...byProject.values()]
    .sort(
      (a, b) =>
        b.tokens - a.tokens ||
        (a.projectPath < b.projectPath ? -1 : a.projectPath > b.projectPath ? 1 : 0) ||
        (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
    )
    .slice(0, MAX_ROWS)
    .map((row) => ({
      projectPath: row.projectPath,
      projectName: row.projectName,
      source: row.source,
      tokens: row.tokens,
      cost: row.cost,
      requests: row.requests,
      costComplete: row.costComplete,
      costMissing: row.costMissing,
    }));

  return {
    range,
    fromMs,
    toMs,
    bucket,
    totals,
    previous,
    series,
    bySource: [...bySource.values()].sort((a, b) => b.tokens - a.tokens),
    byModel: modelRows,
    byProject: projectRows,
    heatmap,
  };
}

module.exports = {
  RANGE_DAYS,
  HEATMAP_MAX_DAYS,
  startOfYear,
  startOfDay,
  startOfHour,
  addDays,
  addHours,
  bucketKey,
  buildBuckets,
  resolveWindow,
  resolveCustomWindow,
  emptyTotals,
  query,
};