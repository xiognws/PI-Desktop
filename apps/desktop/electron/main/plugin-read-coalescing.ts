/**
 * Share one host read between the identical reads a plugin makes in a burst.
 *
 * A panel that polls re-asks for the same snapshot far faster than the snapshot
 * can change: the install this came from requested `session/get` every 37 ms for
 * 80 minutes — 12 716 full session snapshots, 20 039 calls in total — which is
 * cheap per call but expensive in aggregate and slow for every other plugin
 * sharing the host. A per-plugin rate ceiling does not catch it, because the
 * rate itself is modest (4.3 calls/second).
 *
 * Within `windowMs`, one plugin asking the same question of the same arguments
 * gets the answer that is already in flight or was just produced. A read is
 * therefore at most `windowMs` old — far below what a polling UI can display and
 * well inside the debounce every watcher in this app already applies.
 *
 * Rules that keep it honest:
 * - keys are per plugin, so a cache hit can never answer across a permission
 *   boundary;
 * - failures are never stored, so an error is always a real attempt;
 * - a plugin's own write clears that plugin's cache, so "save, then read back"
 *   still reads what was written.
 */

export type PluginReadCoalescerOptions = {
  /** How long a produced answer may be reused. */
  windowMs: number;
  /** Entries kept before the oldest are dropped. */
  maxEntries?: number;
  /** Injected in tests so the window does not wait in real time. */
  now?: () => number;
};

export type PluginReadCoalescerStats = {
  cached: number;
  inflight: number;
  hits: number;
  misses: number;
};

/** How long one answer is reused when a plugin repeats the same read. */
export const DEFAULT_COALESCED_READ_WINDOW_MS = 250;

const DEFAULT_MAX_ENTRIES = 200;

type Cached = { value: unknown; at: number };

export class PluginReadCoalescer {
  private readonly cached = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: PluginReadCoalescerOptions) {
    this.windowMs = Math.max(0, options.windowMs);
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Answer `key` from a read that is in flight or younger than the window;
   * otherwise run `load` and remember its result. Concurrent calls with the same
   * key await the same promise, so a burst costs one host call.
   */
  async run<T>(pluginId: string, key: string, load: () => Promise<T>): Promise<T> {
    const full = `${pluginId}\u0000${key}`;
    const cached = this.cached.get(full);
    if (cached && this.now() - cached.at <= this.windowMs) {
      this.hits += 1;
      return cached.value as T;
    }
    const pending = this.inflight.get(full);
    if (pending) {
      this.hits += 1;
      return pending as Promise<T>;
    }
    this.misses += 1;
    const attempt = load();
    this.inflight.set(full, attempt as Promise<unknown>);
    try {
      const value = await attempt;
      this.cached.delete(full);
      this.cached.set(full, { value, at: this.now() });
      this.evict();
      return value;
    } finally {
      this.inflight.delete(full);
    }
  }

  /** Drop one plugin's answers. Called when that plugin may have written. */
  clear(pluginId: string): void {
    const prefix = `${pluginId}\u0000`;
    for (const key of [...this.cached.keys()]) {
      if (key.startsWith(prefix)) this.cached.delete(key);
    }
  }

  clearAll(): void {
    this.cached.clear();
  }

  stats(): PluginReadCoalescerStats {
    return {
      cached: this.cached.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  private evict(): void {
    while (this.cached.size > this.maxEntries) {
      const oldest = this.cached.keys().next();
      if (oldest.done) return;
      this.cached.delete(oldest.value);
    }
  }
}

/**
 * A key that is stable for equal arguments: object keys are sorted, so
 * `{a:1,b:2}` and `{b:2,a:1}` are the same read rather than two.
 */
export function stableArgsKey(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
    return sorted;
  }
  return value;
}
