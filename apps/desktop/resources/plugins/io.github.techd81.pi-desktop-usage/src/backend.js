"use strict";

/**
 * Plugin backend.
 *
 * Owns the cache, the two scan passes, the read-only enrichment and the query
 * contract the panel consumes. Deliberately timer-free and watcher-free: nothing
 * runs between calls, `onLoad` touches no session file, and every channel is a
 * bounded request so the 30 s panel bridge timeout is never reached.
 *
 * Channels:
 *   usage.hello       → version, roots, availability, preferences, scan state
 *   usage.get         → aggregates over the cache (never starts a scan)
 *   usage.scan        → bounded incremental pass over both roots
 *   usage.prefs.set   → persist the panel's range/source selection
 */

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const manifest = require("../manifest.json");
const { RecordStore } = require("./lib/store.js");
const { scanRoot } = require("./lib/scan.js");
const { query } = require("./lib/aggregate.js");
const { loadEnrichment } = require("./lib/enrich.js");
const { resolveRoots } = require("./lib/paths.js");
const cliAdapter = require("./adapters/cli.js");
const desktopAdapter = require("./adapters/desktop.js");

const RANGES = ["today", "7d", "30d", "90d", "all", "custom"];
const SOURCE_IDS = ["cli", "desktop"];
const ACCENTS = ["blue", "violet", "green", "amber", "rose"];
const THEMES = ["system", "light", "dark"];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_PREFS = { range: "7d", sources: [], accent: "blue", theme: "system", fromMs: 0, toMs: 0 };
const DEFAULT_BUDGET_MS = 12000;
const MAX_BUDGET_MS = 20000;
const ENRICH_REFRESH_MS = 60 * 1000;
const AVAILABILITY_TTL_MS = 30 * 1000;

const LIMITATIONS = [
  "session-imports-may-double-count",
  "desktop-project-requires-enrichment",
  "summary-usage-counted-separately",
];

/** Named palette or a free `#rrggbb`; anything else falls back to the default. */
function sanitizeAccent(value) {
  if (ACCENTS.includes(value)) return value;
  return HEX_COLOR.test(String(value ?? "")) ? String(value).toLowerCase() : DEFAULT_PREFS.accent;
}

/**
 * @param {unknown} value
 * @returns {{ range: string, sources: string[], accent: string, theme: string, fromMs: number, toMs: number }}
 */
function sanitizePrefs(value) {
  const input = /** @type {Record<string, any>} */ (value && typeof value === "object" ? value : {});
  let range = RANGES.includes(input.range) ? input.range : DEFAULT_PREFS.range;
  const sources = Array.isArray(input.sources)
    ? [...new Set(input.sources.filter((source) => SOURCE_IDS.includes(source)))]
    : [...DEFAULT_PREFS.sources];
  const accent = sanitizeAccent(input.accent);
  const theme = THEMES.includes(input.theme) ? input.theme : DEFAULT_PREFS.theme;
  const fromMs = Number.isFinite(input.fromMs) && input.fromMs > 0 ? Math.floor(input.fromMs) : 0;
  const toMs = Number.isFinite(input.toMs) && input.toMs > 0 ? Math.floor(input.toMs) : 0;
  if (range === "custom" && !(toMs > fromMs)) range = DEFAULT_PREFS.range;
  return { range, sources, accent, theme, fromMs, toMs };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Provider names and project paths are enrichment, not data: a record keeps its
 * own values when the catalogue cannot answer.
 *
 * @param {import("./lib/normalize.js").UsageRecord[]} records
 * @param {any} enrichment
 */
function applyEnrichment(records, enrichment) {
  if (!enrichment || !enrichment.available) return records;
  return records.map((record) => {
    if (record.source !== "desktop") return record;
    const providerName = enrichment.providers?.[record.providerKey];
    const session = enrichment.sessions?.[record.sessionId];
    const projectPath = record.projectPath ?? session?.projectPath ?? null;
    if (!providerName && projectPath === record.projectPath) return record;
    return {
      ...record,
      provider: providerName || record.provider,
      projectPath,
    };
  });
}

/**
 * @param {{ pi?: any, env?: NodeJS.ProcessEnv, now?: () => number, roots?: { cli: string, desktop: string } }} [options]
 */
function createBackend(options = {}) {
  const pi = options.pi;
  const now = options.now ?? (() => Date.now());
  const roots = options.roots ?? resolveRoots(options.env ?? process.env);

  /** @type {RecordStore | null} */
  let store = null;
  /** @type {Promise<RecordStore> | null} */
  let storePromise = null;
  let dataDir = "";
  let dataDirIsFallback = false;
  let prefs = { ...DEFAULT_PREFS };
  /** @type {any} */
  let enrichment = null;
  let enrichmentAt = 0;
  /** @type {Promise<any> | null} */
  let scanPromise = null;
  /** @type {any} */
  let lastScan = null;
  let availabilityAt = 0;
  let cancelled = false;
  const availability = { cli: false, desktop: false };

  async function resolveDataDir() {
    try {
      const resolved = await pi.plugin.getDataPath();
      if (typeof resolved === "string" && resolved !== "") return { dir: resolved, fallback: false };
    } catch {
      // fall through
    }
    return { dir: path.join(os.tmpdir(), "pi-desktop-usage"), fallback: true };
  }

  async function refreshAvailability() {
    if (Date.now() - availabilityAt < AVAILABILITY_TTL_MS) return;
    for (const source of SOURCE_IDS) {
      const root = roots[source];
      try {
        await fs.access(root);
        availability[source] = true;
      } catch {
        availability[source] = false;
      }
    }
    availabilityAt = Date.now();
  }

  /**
   * One store per backend, always returned fully loaded.
   *
   * A plain `if (store) return store` would let a second caller through during
   * the first `await` (data path round-trip + cache load) and hand out two
   * instances that share one cache directory: each keeps its own record map and
   * rewrites the other's log. A single in-flight promise removes that window and
   * also stops a half-loaded store from answering `usage.get` with zeroes.
   */
  async function ensureStore() {
    if (store) return store;
    if (!storePromise) {
      storePromise = (async () => {
        const resolved = await resolveDataDir();
        dataDir = resolved.dir;
        dataDirIsFallback = resolved.fallback;
        const created = new RecordStore({ dir: path.join(dataDir, "cache") });
        await created.load();
        try {
          const settings = (await pi.plugin.getSettings()) ?? {};
          prefs = sanitizePrefs(settings.usagePrefs ?? {});
        } catch {
          prefs = { ...DEFAULT_PREFS };
        }
        await refreshAvailability();
        store = created;
        return created;
      })().catch((error) => {
        storePromise = null;
        throw error;
      });
    }
    return storePromise;
  }

  /**
   * @param {boolean} [force]
   */
  async function ensureEnrichment(force = false) {
    if (!force && enrichment && now() - enrichmentAt < ENRICH_REFRESH_MS) return enrichment;
    try {
      enrichment = await loadEnrichment({
        pi,
        cacheDir: path.join(dataDir, "cache"),
        now: now(),
        force,
      });
    } catch (error) {
      enrichment = {
        available: false,
        providers: {},
        sessions: {},
        projects: {},
        updatedAt: 0,
        diagnostics: {
          reason: "enrichment failed",
          ops: [],
          errors: [error instanceof Error ? error.message : String(error)],
        },
      };
    }
    enrichmentAt = now();
    return enrichment;
  }

  function enrichmentSummary() {
    if (!enrichment) return { available: false, updatedAt: 0, errors: [] };
    return {
      available: enrichment.available === true,
      updatedAt: enrichment.updatedAt ?? 0,
      errors: Array.isArray(enrichment.diagnostics?.errors)
        ? enrichment.diagnostics.errors.slice(0, 5)
        : [],
    };
  }

  function scanSummary() {
    return {
      scannedAt: store?.scannedAt ?? 0,
      records: store?.size ?? 0,
      partial: lastScan?.partial === true,
    };
  }

  async function hello() {
    const current = await ensureStore();
    await refreshAvailability();
    return {
      ok: true,
      version: manifest.version,
      roots,
      availability,
      prefs,
      scan: scanSummary(),
      dataDir,
      dataDirIsFallback,
      limitations: LIMITATIONS,
      records: current.size,
    };
  }

  /**
   * @param {any} payload
   */
  async function getUsage(payload) {
    const current = await ensureStore();
    const range = RANGES.includes(payload?.range) ? payload.range : prefs.range;
    const sources = Array.isArray(payload?.sources)
      ? payload.sources.filter((source) => SOURCE_IDS.includes(source))
      : prefs.sources;
    const nowMs = Number.isFinite(payload?.nowMs) ? payload.nowMs : now();

    await ensureEnrichment();
    const records = applyEnrichment(current.all(), enrichment);
    const fromMs = Number.isFinite(payload?.fromMs) ? payload.fromMs : prefs.fromMs;
    const toMs = Number.isFinite(payload?.toMs) ? payload.toMs : prefs.toMs;
    // A custom range without a usable window falls back to the default, so the
    // reported range and the numbers on screen can never disagree.
    const windowRange = range === "custom" && !(toMs > fromMs) ? "7d" : range;
    const result = query(records, {
      range: windowRange,
      sources,
      nowMs,
      fromMs: windowRange === "custom" ? fromMs : 0,
      toMs: windowRange === "custom" ? toMs : 0,
    });

    return {
      ...result,
      meta: {
        version: manifest.version,
        ...scanSummary(),
        availability,
        invalidCacheLines: current.invalidLines,
        enrichment: enrichmentSummary(),
        limitations: LIMITATIONS,
      },
    };
  }

  /**
   * @param {any} payload
   */
  async function scan(payload) {
    // A disposed instance must say so instead of returning an "ok" pass that
    // scanned nothing, which would look like a refresh that does nothing.
    if (cancelled) return { ok: false, code: "DISPOSED", message: "backend disposed" };
    const current = await ensureStore();
    const rebuild = payload?.rebuild === true;
    if (scanPromise) {
      // A pass that is already running is shared; a rebuild has to wait for it
      // instead of being silently answered with the non-rebuild result.
      if (!rebuild) return scanPromise;
      try {
        await scanPromise;
      } catch {
        // the previous pass failing must not block the rebuild
      }
    }

    const budgetMs = clamp(
      Number.isFinite(payload?.budgetMs) ? Number(payload.budgetMs) : DEFAULT_BUDGET_MS,
      1000,
      MAX_BUDGET_MS,
    );
    const shouldStop = () => cancelled;

    scanPromise = (async () => {
      const startedAt = Date.now();
      if (rebuild) {
        await current.reset();
        enrichment = null;
        enrichmentAt = 0;
      }

      const cli = await scanRoot({
        root: roots.cli,
        source: "cli",
        adapter: cliAdapter,
        store: current,
        budgetMs,
        startedAt,
        shouldStop,
      });
      const desktopBudget = Math.max(1000, budgetMs - (Date.now() - startedAt));
      const desktop = await scanRoot({
        root: roots.desktop,
        source: "desktop",
        adapter: desktopAdapter,
        store: current,
        budgetMs: desktopBudget,
        startedAt: Date.now(),
        shouldStop,
      });

      const scannedAt = now();
      await current.flush({ scannedAt });
      availabilityAt = 0;
      await refreshAvailability();
      lastScan = {
        partial: cli.partial || desktop.partial,
        budgetExhausted: cli.budgetExhausted || desktop.budgetExhausted,
        scannedAt,
        cli,
        desktop,
      };

      return {
        ok: true,
        partial: lastScan.partial,
        budgetExhausted: lastScan.budgetExhausted,
        scannedAt,
        records: current.size,
        progress: {
          cli: { totalFiles: cli.totalFiles, scannedFiles: cli.scannedFiles, skippedFiles: cli.skippedFiles },
          desktop: {
            totalFiles: desktop.totalFiles,
            scannedFiles: desktop.scannedFiles,
            skippedFiles: desktop.skippedFiles,
          },
          appendedRecords: cli.appendedRecords + desktop.appendedRecords,
          errors: [...cli.errors, ...desktop.errors].slice(0, 20),
        },
      };
    })().finally(() => {
      scanPromise = null;
    });

    return scanPromise;
  }

  /**
   * @param {any} payload
   */
  async function setPrefs(payload) {
    await ensureStore();
    prefs = sanitizePrefs({ ...prefs, ...(payload ?? {}) });
    try {
      await pi.plugin.setSettings({ usagePrefs: prefs });
    } catch {
      // Preferences are a convenience; failing to persist them must not fail the panel.
    }
    return { ok: true, prefs };
  }

  /** @type {Record<string, (payload: any) => Promise<any>>} */
  const CHANNELS = {
    "usage.hello": () => hello(),
    "usage.get": (payload) => getUsage(payload),
    "usage.scan": (payload) => scan(payload),
    "usage.prefs.set": (payload) => setPrefs(payload),
  };

  /**
   * @param {string} channel
   * @param {any} payload
   */
  async function invoke(channel, payload) {
    const handler = CHANNELS[channel];
    if (!handler) {
      return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
    }
    try {
      return await handler(payload ?? {});
    } catch (error) {
      return {
        ok: false,
        code: "FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function dispose() {
    // Stop the pass in flight before the host drops this instance: a half-applied
    // scan writing into the same cache as the next instance would lose records.
    cancelled = true;
    if (scanPromise) {
      try {
        await scanPromise;
      } catch {
        // unloading must not surface a scan failure
      }
    }
    scanPromise = null;
    storePromise = null;
  }

  return {
    invoke,
    dispose,
    ensureStore,
    /** @internal exposed for tests */
    state: () => ({ prefs, enrichment, roots, availability, dataDir }),
  };
}

module.exports = {
  RANGES,
  ACCENTS,
  THEMES,
  SOURCE_IDS,
  DEFAULT_PREFS,
  LIMITATIONS,
  sanitizePrefs,
  applyEnrichment,
  createBackend,
};
