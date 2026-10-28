import { describe, expect, it } from "vitest";
import {
  isBenchmarkCacheFresh,
  loadModelBenchmarkTable,
  lookupModelBenchmark,
  MODEL_BENCHMARK_TTL_MS,
  normalizeModelIdForScore,
  parseModelBenchmarkTable,
  pickModelBenchmarkBadge,
  type ModelBenchmarkCacheEntry,
  type ModelBenchmarkStore,
} from "./model-benchmarks.js";

/** Trimmed copy of a real `modelgrep.com/api/v1/models` response. */
const payload = {
  data: [
    {
      id: "anthropic/claude-fable-5.1",
      name: "Anthropic: Claude Fable 5.1",
      benchmarks: {
        artificial_analysis: { coding: 81.6, coding_pct: 100, intelligence: 53.4, agentic: null },
      },
    },
    {
      id: "openai/gpt-next",
      name: "OpenAI: GPT Next",
      benchmarks: { artificial_analysis: { coding: 74.2, coding_pct: 88, intelligence: 49.1 } },
    },
    { id: "vendor/unmeasured", name: "Vendor: Unmeasured" },
    {
      id: "vendor/all-null",
      benchmarks: { artificial_analysis: { coding: null, coding_pct: null, intelligence: null } },
    },
    { name: "no id" },
    "not a row",
  ],
};

describe("parseModelBenchmarkTable", () => {
  it("keeps rows that carry a measurement", () => {
    const table = parseModelBenchmarkTable(payload);
    expect(Object.keys(table).sort()).toEqual(["claude-fable-5.1", "gpt-next"]);
    expect(table["claude-fable-5.1"]).toEqual({
      coding: 81.6,
      codingPercentile: 100,
      intelligence: 53.4,
      rank: 1,
    });
  });

  it("drops rows without benchmarks, without numbers, or without an id", () => {
    const table = parseModelBenchmarkTable(payload);
    expect(table.unmeasured).toBeUndefined();
    expect(table["all-null"]).toBeUndefined();
  });

  it("returns an empty table for a payload it does not recognize", () => {
    expect(parseModelBenchmarkTable(null)).toEqual({});
    expect(parseModelBenchmarkTable({})).toEqual({});
    expect(parseModelBenchmarkTable({ data: "nope" })).toEqual({});
  });

  it("prefers the higher coding score when ids collide", () => {
    const table = parseModelBenchmarkTable({
      data: [
        { id: "a/model", benchmarks: { artificial_analysis: { coding: 40 } } },
        { id: "b/model", benchmarks: { artificial_analysis: { coding: 70 } } },
        { id: "c/model", benchmarks: { artificial_analysis: { coding: 55 } } },
      ],
    });
    expect(table.model?.coding).toBe(70);
    expect(table.model?.rank).toBe(2);
  });
});

describe("normalizeModelIdForScore", () => {
  it("keeps only the leaf id, lowercased", () => {
    expect(normalizeModelIdForScore("Anthropic/Claude-Fable-5.1")).toBe("claude-fable-5.1");
    expect(normalizeModelIdForScore("  gpt-next  ")).toBe("gpt-next");
    expect(normalizeModelIdForScore("")).toBe("");
  });
});

describe("lookupModelBenchmark", () => {
  const table = parseModelBenchmarkTable(payload);

  it("finds a model through a provider prefix on either side", () => {
    expect(lookupModelBenchmark(table, "claude-fable-5.1")?.coding).toBe(81.6);
    expect(lookupModelBenchmark(table, "openrouter/openai/gpt-next")?.coding).toBe(74.2);
    expect(lookupModelBenchmark(table, "GPT-Next")?.coding).toBe(74.2);
  });

  it("returns undefined for unknown or empty ids", () => {
    expect(lookupModelBenchmark(table, "unknown-model")).toBeUndefined();
    expect(lookupModelBenchmark(table, "")).toBeUndefined();
  });
});

describe("pickModelBenchmarkBadge", () => {
  it("prefers the coding index", () => {
    expect(pickModelBenchmarkBadge({ coding: 81.6, codingPercentile: 100, intelligence: 53.4 })).toEqual({
      kind: "coding",
      value: 82,
    });
  });

  it("falls back to intelligence when coding was not measured", () => {
    expect(
      pickModelBenchmarkBadge({ coding: null, codingPercentile: null, intelligence: 39.5 }),
    ).toEqual({ kind: "intelligence", value: 40 });
  });

  it("returns nothing when neither index exists or there is no score", () => {
    expect(
      pickModelBenchmarkBadge({ coding: null, codingPercentile: null, intelligence: null }),
    ).toBeUndefined();
    expect(pickModelBenchmarkBadge(undefined)).toBeUndefined();
  });
});

describe("isBenchmarkCacheFresh", () => {
  it("keeps a payload for one day", () => {
    const fetchedAt = 1_000_000;
    expect(isBenchmarkCacheFresh(fetchedAt, fetchedAt)).toBe(true);
    expect(isBenchmarkCacheFresh(fetchedAt, fetchedAt + MODEL_BENCHMARK_TTL_MS - 1)).toBe(true);
    expect(isBenchmarkCacheFresh(fetchedAt, fetchedAt + MODEL_BENCHMARK_TTL_MS)).toBe(false);
  });

  it("rejects a timestamp from the future or a non-number", () => {
    expect(isBenchmarkCacheFresh(2_000, 1_000)).toBe(false);
    expect(isBenchmarkCacheFresh(Number.NaN, 1_000)).toBe(false);
  });
});

describe("loadModelBenchmarkTable", () => {
  const NOW = 10_000_000_000;
  const cachedEntry: ModelBenchmarkCacheEntry = {
    fetchedAt: NOW - 1_000,
    table: { cached: { coding: 10, codingPercentile: 5, intelligence: 3, rank: 1 } },
  };

  const harnessFor = (overrides: Partial<ModelBenchmarkStore> = {}) => {
    const writes: ModelBenchmarkCacheEntry[] = [];
    let fetches = 0;
    const store: ModelBenchmarkStore = {
      now: () => NOW,
      readCache: async () => cachedEntry,
      writeCache: async (entry) => {
        writes.push(entry);
      },
      fetchPayload: async () => {
        fetches += 1;
        return payload;
      },
      ...overrides,
    };
    return { store, writes, fetches: () => fetches };
  };

  it("serves a fresh cache without touching the network", async () => {
    const harness = harnessFor();
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load.source).toBe("cache");
    expect(load.stale).toBe(false);
    expect(load.table.cached?.coding).toBe(10);
    expect(harness.fetches()).toBe(0);
  });

  it("refreshes an expired cache and writes the new table", async () => {
    const harness = harnessFor({
      readCache: async () => ({ ...cachedEntry, fetchedAt: NOW - MODEL_BENCHMARK_TTL_MS - 1 }),
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load.source).toBe("network");
    expect(load.table["claude-fable-5.1"]?.coding).toBe(81.6);
    expect(harness.fetches()).toBe(1);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.fetchedAt).toBe(NOW);
  });

  it("refreshes on demand even when the cache is fresh", async () => {
    const harness = harnessFor();
    const load = await loadModelBenchmarkTable(harness.store, { forceRefresh: true });
    expect(load.source).toBe("network");
    expect(harness.fetches()).toBe(1);
  });

  it("keeps the expired cache when the refresh fails", async () => {
    const harness = harnessFor({
      readCache: async () => ({ ...cachedEntry, fetchedAt: NOW - MODEL_BENCHMARK_TTL_MS - 1 }),
      fetchPayload: async () => {
        throw new Error("offline");
      },
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load).toMatchObject({ source: "cache", stale: true });
    expect(load.table.cached?.coding).toBe(10);
    expect(harness.writes).toHaveLength(0);
  });

  it("does not overwrite a good cache with an unusable payload", async () => {
    const harness = harnessFor({
      readCache: async () => ({ ...cachedEntry, fetchedAt: NOW - MODEL_BENCHMARK_TTL_MS - 1 }),
      fetchPayload: async () => ({ data: [] }),
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load).toMatchObject({ source: "cache", stale: true });
    expect(harness.writes).toHaveLength(0);
  });

  it("reports nothing when there is no cache and no network", async () => {
    const harness = harnessFor({
      readCache: async () => undefined,
      fetchPayload: async () => {
        throw new Error("offline");
      },
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load).toMatchObject({ source: "none", stale: false });
    expect(load.table).toEqual({});
  });

  it("survives a cache read that throws", async () => {
    const harness = harnessFor({
      readCache: async () => {
        throw new Error("permission denied");
      },
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load.source).toBe("network");
  });

  it("still serves the table when the cache write fails", async () => {
    const harness = harnessFor({
      readCache: async () => ({ ...cachedEntry, fetchedAt: NOW - MODEL_BENCHMARK_TTL_MS - 1 }),
      writeCache: async () => {
        throw new Error("disk full");
      },
    });
    const load = await loadModelBenchmarkTable(harness.store);
    expect(load.source).toBe("network");
    expect(load.table["gpt-next"]?.coding).toBe(74.2);
  });
});
