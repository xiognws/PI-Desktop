/**
 * Remaining credit for an in-app provider's signed-in account.
 *
 * The gateway does the billing read; this module only maps its answer, keeps
 * one short-lived cache, and refuses to invent a number. `core.cjs` is explicit
 * about why: an upstream body it cannot parse is a hard error, because a
 * plausible `0` hid a real "insufficient credit" bug for weeks.
 */

export type InAppProviderCreditAccount = {
  /** Package name as the billing backend spells it. */
  name: string;
  remain: number;
  size: number;
};

export type InAppProviderCredits = {
  total: number;
  accounts: InAppProviderCreditAccount[];
  /**
   * True when the account is not metered at all — every catalog model reports
   * a free (`x0.0…`) credit multiplier, so there is no balance to show.
   */
  free: boolean;
  /** Epoch ms of the read that produced this balance. */
  fetchedAt: number;
};

export type CreditsFailureReason =
  | "hard_credit"
  | "session_dead"
  | "signed_out"
  | "unavailable"
  | "no_credits_path"
  | "not_running";

export type CreditsResult =
  | { ok: true; credits: InAppProviderCredits }
  | { ok: false; reason: CreditsFailureReason };

export type ReadCreditsInput = {
  /** Loopback origin, e.g. `http://127.0.0.1:18765`. */
  origin: string;
  /** Descriptor's credits route, e.g. `/workbuddy/v1/credits`. */
  creditsPath: string;
  /** The local API key the gateway was started with. */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map one gateway answer to a result; never throws. */
export async function readCredits(input: ReadCreditsInput): Promise<CreditsResult> {
  const request = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await request(`${input.origin}${input.creditsPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === "object"
        ? (payload as { error?: { type?: unknown } }).error?.type
        : undefined;
    if (code === "hard_credit") return { ok: false, reason: "hard_credit" };
    if (code === "session_dead") return { ok: false, reason: "session_dead" };
    if (code === "not_signed_in") return { ok: false, reason: "signed_out" };
    if (response.status === 402) return { ok: false, reason: "hard_credit" };
    if (response.status === 401) return { ok: false, reason: "session_dead" };
    return { ok: false, reason: "unavailable" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "unavailable" };
  }
  const body = payload as {
    total?: unknown;
    accounts?: unknown;
    free?: unknown;
    fetchedAt?: unknown;
  };
  const total = finite(body.total);
  // A reading with no usable total is a failed read, not a zero balance.
  if (total === null) return { ok: false, reason: "unavailable" };
  const accounts: InAppProviderCreditAccount[] = [];
  if (Array.isArray(body.accounts)) {
    for (const entry of body.accounts) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { name?: unknown; remain?: unknown; size?: unknown };
      const remain = finite(row.remain);
      if (remain === null) continue;
      if (typeof row.name !== "string") continue;
      accounts.push({ name: row.name, remain, size: finite(row.size) ?? 0 });
    }
  }
  const fetchedAt = finite(body.fetchedAt);
  return {
    ok: true,
    credits: {
      total,
      accounts,
      free: body.free === true,
      fetchedAt: fetchedAt ?? Date.now(),
    },
  };
}

/**
 * One cache for every reader of a provider's balance: the composer chip, its
 * popover and the settings card. The TTL keeps a burst of mounts to one read;
 * `refresh` bypasses it and updates every reader, so the three surfaces cannot
 * show different numbers.
 */
export class CreditsCache {
  private readonly load: (providerId: string) => Promise<CreditsResult>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { result: CreditsResult; at: number }>();
  private readonly inflight = new Map<string, Promise<CreditsResult>>();

  constructor(
    load: (providerId: string) => Promise<CreditsResult>,
    options: { now?: () => number; ttlMs?: number } = {},
  ) {
    this.load = load;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  /** Forget one provider's reading; the next read goes to the gateway. */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  async read(providerId: string, options: { refresh?: boolean } = {}): Promise<CreditsResult> {
    const cached = this.cache.get(providerId);
    if (!options.refresh && cached && this.now() - cached.at < this.ttlMs) {
      return cached.result;
    }
    const pending = this.inflight.get(providerId);
    if (pending) return await pending;
    const promise = (async () => {
      let result: CreditsResult;
      try {
        result = await this.load(providerId);
      } catch {
        result = { ok: false, reason: "unavailable" };
      }
      // A failed read is cached too: an unreachable gateway must not be polled
      // once per surface, and the reason is what the UI needs to explain it.
      this.cache.set(providerId, { result, at: this.now() });
      return result;
    })();
    this.inflight.set(providerId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(providerId);
    }
  }
}
