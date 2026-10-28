/**
 * Benchmark-score overlay for the model picker, main-process side.
 *
 * The desktop catalog lives in host-core; this module only decorates it with
 * published benchmark numbers, so nothing here touches SQLite or the provider
 * schema. Everything fetched is cached as one JSON file under the app's user
 * data directory, and the refresh policy itself lives in
 * `@pi-desktop/shared` so it is unit-tested without Electron.
 *
 * Network goes through the same strict public-HTTPS client the other
 * third-party catalogs use: no private or loopback address, redirects
 * re-validated per hop, and the relaxed fake-IP policy honoured only when the
 * user already opted into it.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, net, session } from "electron";
import {
  loadModelBenchmarkTable,
  type ModelBenchmarkCacheEntry,
  type ModelBenchmarkLoad,
} from "@pi-desktop/shared";
import { relaxedNetworkPolicyEnabled } from "./endpoint-policy";
import { fetchPinnedDirect } from "./public-https-direct";
import { createPublicHttpsClient } from "./public-https-fetch";

/** Coding-sorted catalog page; 200 rows covers every model a user can pick. */
export const MODEL_BENCHMARK_URL =
  "https://modelgrep.com/api/v1/models?sort=coding&order=desc&limit=200";

const client = createPublicHttpsClient({
  fetchImpl: (url, init) => net.fetch(url, init),
  pinnedFetchImpl: (url, init, address) => fetchPinnedDirect(url, init, address),
  routeImpl: (url) => session.defaultSession.resolveProxy(url),
  allowFakeIp: () => relaxedNetworkPolicyEnabled(),
  timeoutMs: 10_000,
});

function cachePath(): string {
  return join(app.getPath("userData"), "cache", "model-benchmarks.json");
}

async function readCache(): Promise<ModelBenchmarkCacheEntry | undefined> {
  try {
    const raw = JSON.parse(await readFile(cachePath(), "utf8")) as {
      fetchedAt?: unknown;
      table?: unknown;
    };
    if (typeof raw.fetchedAt !== "number" || typeof raw.table !== "object" || raw.table === null) {
      return undefined;
    }
    return { fetchedAt: raw.fetchedAt, table: raw.table as ModelBenchmarkCacheEntry["table"] };
  } catch {
    return undefined;
  }
}

async function writeCache(entry: ModelBenchmarkCacheEntry): Promise<void> {
  const path = cachePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry), "utf8");
}

/** `PI_DESKTOP_MODEL_SCORES=off` keeps the app entirely offline for this data. */
export function modelBenchmarksDisabled(): boolean {
  return process.env.PI_DESKTOP_MODEL_SCORES?.trim().toLowerCase() === "off";
}

let inFlight: Promise<ModelBenchmarkLoad> | undefined;

/**
 * Load the overlay, at most once per TTL, coalescing concurrent callers so a
 * picker opened twice does not issue two requests.
 */
export function loadModelBenchmarks(options: { forceRefresh?: boolean } = {}): Promise<ModelBenchmarkLoad> {
  if (modelBenchmarksDisabled()) {
    return Promise.resolve({ table: {}, stale: false, source: "none" });
  }
  if (!options.forceRefresh && inFlight) return inFlight;
  const run = loadModelBenchmarkTable(
    {
      now: () => Date.now(),
      readCache,
      writeCache,
      fetchPayload: () => client.request(MODEL_BENCHMARK_URL, "json"),
    },
    options,
  ).finally(() => {
    inFlight = undefined;
  });
  inFlight = run;
  return run;
}
