/**
 * Benchmark scores for the model picker.
 *
 * The desktop owns its model catalog in host-core; this module only decorates
 * catalog rows with published third-party benchmark numbers. Nothing here is
 * persisted in the database: the scores are a cached read-only overlay, so a
 * stale or missing payload degrades to "no badge" instead of a schema change.
 *
 * Parsing is pure and versioned by the payload shape it accepts:
 * `modelgrep.com/api/v1/models` rows carry
 * `benchmarks.artificial_analysis.{coding, coding_pct, intelligence}`.
 */

/** One model's published benchmark numbers. Every field is nullable upstream. */
export type ModelBenchmarkScore = {
  /** Artificial Analysis coding index (0–100). */
  coding: number | null;
  /** Percentile of `coding` across the catalog (0–100). */
  codingPercentile: number | null;
  /** Artificial Analysis intelligence index. */
  intelligence: number | null;
  /** 1-based position in the coding-sorted catalog, when the row carried one. */
  rank?: number;
};

export type ModelBenchmarkTable = Readonly<Record<string, ModelBenchmarkScore>>;

/** Lowercase, drop a provider prefix and a `provider/` path, keep the leaf id. */
export function normalizeModelIdForScore(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return "";
  const leaf = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return leaf || trimmed;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Turn a modelgrep payload into a lookup table.
 *
 * Rows without an id, or without any usable number, are skipped: a badge that
 * says nothing is worse than no badge. When two rows normalize to the same id
 * the higher coding score wins, so a provider-prefixed duplicate cannot hide
 * the better measurement.
 */
export function parseModelBenchmarkTable(payload: unknown): ModelBenchmarkTable {
  const rows = asRecord(payload)?.data;
  if (!Array.isArray(rows)) return {};
  const table: Record<string, ModelBenchmarkScore> = {};
  rows.forEach((row, index) => {
    const entry = asRecord(row);
    if (!entry) return;
    const id = typeof entry.id === "string" ? normalizeModelIdForScore(entry.id) : "";
    if (!id) return;
    const benchmarks = asRecord(asRecord(entry.benchmarks)?.artificial_analysis);
    if (!benchmarks) return;
    const coding = asNumber(benchmarks.coding);
    const codingPercentile = asNumber(benchmarks.coding_pct);
    const intelligence = asNumber(benchmarks.intelligence);
    if (coding === null && codingPercentile === null && intelligence === null) return;
    const score: ModelBenchmarkScore = {
      coding,
      codingPercentile,
      intelligence,
      rank: index + 1,
    };
    const existing = table[id];
    if (existing && (existing.coding ?? -1) >= (coding ?? -1)) return;
    table[id] = score;
  });
  return table;
}

/** Look one model up, tolerating a provider prefix on either side. */
export function lookupModelBenchmark(
  table: ModelBenchmarkTable,
  modelId: string,
): ModelBenchmarkScore | undefined {
  const key = normalizeModelIdForScore(modelId);
  if (!key) return undefined;
  return table[key];
}

/**
 * What one picker badge should say: the coding index when the catalog measured
 * it, otherwise the intelligence index so a model the user actually runs is not
 * left unlabelled. Both come from the same Artificial Analysis block, so the
 * two kinds never disagree about provenance.
 */
export type ModelBenchmarkBadge = { kind: "coding" | "intelligence"; value: number };

/** Choose the badge for one score, or undefined when neither index exists. */
export function pickModelBenchmarkBadge(
  score: ModelBenchmarkScore | undefined,
): ModelBenchmarkBadge | undefined {
  if (!score) return undefined;
  if (typeof score.coding === "number" && Number.isFinite(score.coding)) {
    return { kind: "coding", value: Math.round(score.coding) };
  }
  if (typeof score.intelligence === "number" && Number.isFinite(score.intelligence)) {
    return { kind: "intelligence", value: Math.round(score.intelligence) };
  }
  return undefined;
}

/** A cached payload is fresh for one day; the source refreshes daily. */
export const MODEL_BENCHMARK_TTL_MS = 24 * 60 * 60 * 1000;

/** True when a payload fetched at `fetchedAt` may be reused at `now`. */
export function isBenchmarkCacheFresh(fetchedAt: number, now: number): boolean {
  if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) return false;
  const age = now - fetchedAt;
  return age >= 0 && age < MODEL_BENCHMARK_TTL_MS;
}

/** What the cache file holds. `table` is the parsed lookup, not the raw payload. */
export type ModelBenchmarkCacheEntry = {
  fetchedAt: number;
  table: ModelBenchmarkTable;
};

/**
 * The I/O the loader needs, injected so the refresh policy is testable without
 * a network or a disk: main supplies a policy-checked fetcher and a file cache.
 */
export type ModelBenchmarkStore = {
  /** Fetch the raw payload from the upstream catalog. May reject. */
  fetchPayload: () => Promise<unknown>;
  readCache: () => Promise<ModelBenchmarkCacheEntry | undefined>;
  writeCache: (entry: ModelBenchmarkCacheEntry) => Promise<void>;
  now: () => number;
};

export type ModelBenchmarkLoad = {
  table: ModelBenchmarkTable;
  /** Epoch millis the table was fetched at; absent when nothing was ever loaded. */
  fetchedAt?: number;
  /** True when the returned table came from an expired cache after a failure. */
  stale: boolean;
  source: "cache" | "network" | "none";
};

/**
 * Serve the benchmark table, refreshing it at most once per TTL.
 *
 * Failure never throws and never degrades the caller: an expired cache is
 * preferred over an empty table, an empty or unrecognized payload is treated as
 * a failed refresh (so a bad upstream response cannot erase good data), and no
 * cache plus no network yields `source: "none"` with an empty table.
 */
export async function loadModelBenchmarkTable(
  store: ModelBenchmarkStore,
  options: { forceRefresh?: boolean } = {},
): Promise<ModelBenchmarkLoad> {
  let cached: ModelBenchmarkCacheEntry | undefined;
  try {
    cached = await store.readCache();
  } catch {
    cached = undefined;
  }
  const now = store.now();
  if (cached && !options.forceRefresh && isBenchmarkCacheFresh(cached.fetchedAt, now)) {
    return { table: cached.table, fetchedAt: cached.fetchedAt, stale: false, source: "cache" };
  }
  let table: ModelBenchmarkTable = {};
  try {
    table = parseModelBenchmarkTable(await store.fetchPayload());
  } catch {
    table = {};
  }
  if (Object.keys(table).length > 0) {
    const entry: ModelBenchmarkCacheEntry = { fetchedAt: now, table };
    try {
      await store.writeCache(entry);
    } catch {
      // A cache we cannot write is still a table we can serve.
    }
    return { table, fetchedAt: now, stale: false, source: "network" };
  }
  if (cached) {
    return { table: cached.table, fetchedAt: cached.fetchedAt, stale: true, source: "cache" };
  }
  return { table, stale: false, source: "none" };
}
