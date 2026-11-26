/**
 * Per-plugin budget for host API calls.
 *
 * Every plugin API call crosses one broker in `plugin-runtime.ts`, and all of
 * them are served by the same main process and the same shared plugin host. One
 * plugin that polls in a loop therefore queues every other plugin's calls behind
 * it: a real install logged one plugin issuing 20 039 calls in 80 minutes
 * (`session/get` every 37 ms) and another issuing 11 848 `fs.list` calls in four
 * minutes (~50/s), which the user experiences as "all the plugins got slow".
 *
 * The budget is a token bucket per plugin. A plugin under its ceiling never
 * waits; a plugin over it is delayed instead of being refused, so a legitimate
 * bulk scan still finishes and a busy panel still renders — it just cannot
 * monopolise the broker while doing so.
 *
 * Delays are bounded by `maxWaitMs`. This is a fairness control, not a security
 * boundary: the worst case for an over-limit plugin is that its own calls take
 * longer than it expected.
 */

export type PluginApiRateLimitOptions = {
  /** Sustained calls per second for a single plugin. */
  perSecond: number;
  /** Calls a plugin may make back to back before the ceiling applies. */
  burst: number;
  /** Longest one call is held back before it runs anyway. */
  maxWaitMs: number;
  /** Injected in tests so a delay does not wait in real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type PluginApiRateLimitDecision = {
  pluginId: string;
  /** How long this call was held back. */
  waitedMs: number;
  /** Whether the plugin was over its ceiling when this call arrived. */
  limited: boolean;
  /** Calls this plugin issued in the current one-second window, this one included. */
  observedInWindow: number;
};

/** Twenty calls a second is far above any panel's UI polling and still cuts a runaway scan. */
export const DEFAULT_PLUGIN_API_PER_SECOND = 20;

/** A short spike (opening a folder, running one command) never waits. */
export const DEFAULT_PLUGIN_API_BURST = 40;

/**
 * The delay a single call may take. A longer hold would turn "slow" into
 * "broken" for the calling plugin, which is worse than a call that runs a little
 * early.
 */
export const DEFAULT_PLUGIN_API_MAX_WAIT_MS = 750;

type Bucket = { tokens: number; updatedAt: number };
type Window = { start: number; count: number };

export class PluginApiRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, Window>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PluginApiRateLimitOptions) {
    this.perSecond = Number.isFinite(options.perSecond) ? Math.max(0, options.perSecond) : 0;
    this.burst = Math.max(1, Math.trunc(options.burst));
    this.maxWaitMs = Math.max(0, Math.trunc(options.maxWaitMs));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Count this call against the plugin's window and take a token, waiting when
   * the bucket is empty. `perSecond` of zero disables the budget entirely: the
   * call is still counted and then runs immediately.
   */
  async acquire(pluginId: string): Promise<PluginApiRateLimitDecision> {
    const observedInWindow = this.noteCall(pluginId);
    if (this.perSecond <= 0) {
      return { pluginId, waitedMs: 0, limited: false, observedInWindow };
    }
    const waitedMs = this.waitNeeded(pluginId);
    if (waitedMs > 0) await this.sleep(waitedMs);
    this.charge(pluginId);
    return { pluginId, waitedMs, limited: waitedMs > 0, observedInWindow };
  }

  /** Occupied plugins, for a diagnostic dump. Never waits and never charges. */
  snapshot(): Array<{ pluginId: string; tokens: number; observedInWindow: number; limit: number }> {
    const now = this.now();
    return [...this.buckets.entries()].map(([pluginId, bucket]) => ({
      pluginId,
      tokens: Number(this.refill(pluginId, bucket, now).tokens.toFixed(2)),
      observedInWindow: this.windows.get(pluginId)?.count ?? 0,
      limit: this.perSecond,
    }));
  }

  private waitNeeded(pluginId: string): number {
    const bucket = this.refill(pluginId, this.buckets.get(pluginId), this.now());
    if (bucket.tokens >= 1) return 0;
    const needed = ((1 - bucket.tokens) / this.perSecond) * 1000;
    return Math.min(this.maxWaitMs, Math.max(1, Math.ceil(needed)));
  }

  private charge(pluginId: string): void {
    const bucket = this.refill(pluginId, this.buckets.get(pluginId), this.now());
    // The wait above paid for one token. Clamp at zero so a capped wait forgives
    // the rest of the debt rather than compounding it.
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    this.buckets.set(pluginId, bucket);
  }

  private refill(pluginId: string, existing: Bucket | undefined, now: number): Bucket {
    const bucket: Bucket = existing ? { ...existing } : { tokens: this.burst, updatedAt: now };
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + (Math.max(0, now - bucket.updatedAt) / 1000) * this.perSecond,
    );
    bucket.updatedAt = now;
    this.buckets.set(pluginId, bucket);
    return bucket;
  }

  private noteCall(pluginId: string): number {
    const now = this.now();
    const window = this.windows.get(pluginId);
    if (!window || now - window.start >= 1000) {
      this.windows.set(pluginId, { start: now, count: 1 });
      return 1;
    }
    window.count += 1;
    return window.count;
  }
}
