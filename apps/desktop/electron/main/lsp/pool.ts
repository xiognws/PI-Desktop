/**
 * Session-scoped language-server pool with an idle reclaim.
 *
 * ADR 0401 keeps one server per language per session, reused across turns, and
 * that is still the rule while a turn is working. What it did not bound was
 * *how long* a server outlives its last query: a server indexes a workspace and
 * then holds that index in memory, and the only trigger that shut one down was
 * the session ending. A user who opens several sessions in a day kept one
 * language server process per session per language alive for the whole app run.
 *
 * The pool adds the two bounds the browser guest host already has:
 *
 *  - **Idle reclaim** — a server untouched for `idleMs` is shut down; the next
 *    query in that session starts it again. The cost is the re-index the ADR
 *    warned about, paid once after a long gap instead of never being paid back.
 *  - **Ceiling** — a new server may not push the live count past `maxLive`;
 *    the least recently used idle one gives up its slot first.
 *
 * Two invariants make this safe to put under running tools:
 *
 *  - A call in flight (`begin`/`end`) is never reclaimed. Reclaiming a server
 *    mid-request would fail the agent's tool call for a reason it cannot see.
 *  - Both bounds *yield* when every live server is busy: an unbounded live
 *    count for a moment is better than killing the thing serving a request.
 */
export const DEFAULT_LSP_IDLE_MS = 10 * 60_000;
export const DEFAULT_LSP_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_LSP_MAX_LIVE = 4;

/** The part of `LspClient` the pool needs; kept structural so tests can stand in. */
export type PooledServer = {
  isClosed: boolean;
  shutdown(): Promise<void>;
};

type Entry<T> = {
  key: string;
  server: T;
  lastUsedAt: number;
  /** Calls in flight. A non-zero count is what protects a server from reclaim. */
  busy: number;
};

export type LspServerPoolOptions = {
  idleMs?: number;
  maxLive?: number;
  /** `0` disables the timer, for tests that drive `sweep()` themselves. */
  sweepIntervalMs?: number;
  now?: () => number;
  /** Reclaim failures are not fatal: the entry is dropped either way. */
  onError?: (error: unknown) => void;
};

export class LspServerPool<T extends PooledServer = PooledServer> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly idleMs: number;
  private readonly maxLive: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(options: LspServerPoolOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_LSP_IDLE_MS;
    this.maxLive = options.maxLive ?? DEFAULT_LSP_MAX_LIVE;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    const interval = options.sweepIntervalMs ?? DEFAULT_LSP_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.sweep();
      }, interval);
      // A sweeper must never be the reason the app refuses to exit.
      this.timer.unref?.();
    }
  }

  /**
   * The server for `key`, started by `create` when there is none.
   *
   * A server that closed on its own (a crash, an exit) is replaced rather than
   * handed out: callers only ever see a usable server or an error.
   */
  async acquire(key: string, create: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.server.isClosed) {
        existing.lastUsedAt = this.now();
        return existing.server;
      }
      this.entries.delete(key);
    }
    await this.reclaimFor(key);
    const server = await create();
    this.entries.set(key, { key, server, lastUsedAt: this.now(), busy: 0 });
    return server;
  }

  /** Mark a call in flight, so the sweeper and the ceiling leave this server be. */
  begin(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.busy += 1;
    entry.lastUsedAt = this.now();
  }

  /** The call finished; its own duration does not count as idle time. */
  end(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.busy = Math.max(0, entry.busy - 1);
    entry.lastUsedAt = this.now();
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Close every server idle for longer than `idleMs`. Returns the keys reclaimed. */
  async sweep(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const now = this.now();
      const stale = [...this.entries.values()]
        .filter((entry) => entry.busy === 0 && now - entry.lastUsedAt >= this.idleMs)
        .map((entry) => entry.key);
      for (const key of stale) await this.reclaim(key);
      return stale;
    } finally {
      this.sweeping = false;
    }
  }

  /** Shut down one session's servers; called when the session ends. */
  async shutdownSession(sessionId: string): Promise<void> {
    const prefix = `${sessionId}::`;
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) await this.reclaim(key);
  }

  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const keys = [...this.entries.keys()];
    for (const key of keys) await this.reclaim(key);
  }

  /** Test/diagnostic view of the pool. */
  stats(): { live: number; busy: number; keys: string[] } {
    const values = [...this.entries.values()];
    return {
      live: values.length,
      busy: values.filter((entry) => entry.busy > 0).length,
      keys: values.map((entry) => entry.key),
    };
  }

  /**
   * Make room for `keepKey`.
   *
   * Only idle entries are candidates, and never the one being acquired. When
   * every slot is busy the ceiling yields — the count is a budget, not a
   * correctness rule.
   */
  private async reclaimFor(keepKey: string): Promise<void> {
    while (this.entries.size >= this.maxLive) {
      const candidates = [...this.entries.values()]
        .filter((entry) => entry.key !== keepKey && entry.busy === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const oldest = candidates[0];
      if (!oldest) return;
      await this.reclaim(oldest.key);
    }
  }

  private async reclaim(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    // Dropped from the map before the shutdown so a concurrent `acquire` starts a
    // fresh server instead of finding one that is already closing.
    await entry.server.shutdown().catch((error) => this.onError(error));
  }
}
