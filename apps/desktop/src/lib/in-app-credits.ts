/**
 * In-app provider credits — one data path for every surface that shows them.
 *
 * The composer chip, its popover and the provider settings card all read this
 * module, so a refresh in any of them updates the others and no two places can
 * show different numbers. The gateway does the billing read; everything here is
 * transport, cache and the single "should this be visible" decision.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";
import { IN_APP_PROVIDER_CHANNELS } from "./in-app-provider-channels";
import {
  creditsVisibility,
  CREDITS_POLL_INTERVAL_MS,
  shouldPollCredits,
  type CreditsFailureReason,
} from "./in-app-credits-visibility";

// `shouldPollCredits` is re-exported so a surface imports its credit rules from
// one module, and the polling decision cannot drift from the hook that polls.
export { IN_APP_PROVIDER_CHANNELS, creditsVisibility, CREDITS_POLL_INTERVAL_MS, shouldPollCredits };
export type { CreditsFailureReason };

export type InAppProviderCreditAccount = { name: string; remain: number; size: number };

export type InAppProviderCredits = {
  total: number;
  accounts: InAppProviderCreditAccount[];
  /** The account is not metered at all (no balance to show). */
  free: boolean;
  fetchedAt: number;
};


export type CreditsResult =
  | { ok: true; credits: InAppProviderCredits }
  | { ok: false; reason: CreditsFailureReason };

/** One in-app provider as Main reports it. */
export type InAppProviderSurface = {
  id: string;
  label: string;
  /** The user's switch, not whether the gateway started. */
  enabled: boolean;
  port: number;
  running: boolean;
  /** Provider row the gateway backs; null until it has been registered. */
  providerId: string | null;
  /** Models the gateway published on its last successful start. */
  models: number;
  /** Why a switched-on gateway is not running, when that is what happened. */
  reason?: string;
  creditsPath?: string;
};

const TTL_MS = 30_000;
const EMPTY: CreditsSnapshot = { result: null, pending: false };

export type CreditsSnapshot = { result: CreditsResult | null; pending: boolean };

const snapshots = new Map<string, CreditsSnapshot>();
const fetchedAt = new Map<string, number>();
const inflight = new Map<string, Promise<CreditsResult>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setSnapshot(providerId: string, next: CreditsSnapshot): void {
  snapshots.set(providerId, next);
  emit();
}

async function load(providerId: string, refresh: boolean): Promise<CreditsResult> {
  const existing = snapshots.get(providerId);
  const at = fetchedAt.get(providerId) ?? 0;
  if (!refresh && existing?.result && Date.now() - at < TTL_MS) return existing.result;
  const pendingRead = inflight.get(providerId);
  if (pendingRead && !refresh) return await pendingRead;
  setSnapshot(providerId, { result: existing?.result ?? null, pending: true });
  const promise = (async () => {
    let result: CreditsResult;
    try {
      result = await api.inAppProviderCredits({ providerId, refresh });
    } catch {
      // A transport failure is a state the UI renders, never a number.
      result = { ok: false, reason: "unavailable" };
    }
    fetchedAt.set(providerId, Date.now());
    inflight.delete(providerId);
    setSnapshot(providerId, { result, pending: false });
    return result;
  })();
  inflight.set(providerId, promise);
  return await promise;
}

/** Read a provider's balance, from the cache unless `refresh` asks otherwise. */
export function readInAppProviderCredits(
  providerId: string,
  options: { refresh?: boolean } = {},
): Promise<CreditsResult> {
  return load(providerId, options.refresh === true);
}

/** Drop the cached reading so every surface re-reads on its next render. */
export function invalidateInAppProviderCredits(providerId: string): void {
  fetchedAt.delete(providerId);
  snapshots.delete(providerId);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshotFor(providerId: string | null): CreditsSnapshot {
  if (!providerId) return EMPTY;
  return snapshots.get(providerId) ?? EMPTY;
}

/**
 * Credits for one provider row.
 *
 * `providerId` is null when the current session is on a provider without a
 * credit surface: nothing is fetched and nothing is rendered.
 */
export function useInAppProviderCredits(
  providerId: string | null,
  options: { polling?: boolean } = {},
): {
  result: CreditsResult | null;
  pending: boolean;
  refresh: () => void;
} {
  const polling = options.polling === true;
  // The third argument is what makes this component renderable on the server:
  // React 19 throws without it when a static render reaches the hook, and the
  // store is empty there, so the server answer is simply "nothing yet".
  const snapshot = useSyncExternalStore(
    subscribe,
    () => snapshotFor(providerId),
    () => snapshotFor(providerId),
  );
  const refresh = useCallback(() => {
    if (!providerId) return;
    void load(providerId, true);
  }, [providerId]);
  useEffect(() => {
    if (providerId) void load(providerId, false);
  }, [providerId]);
  useEffect(() => {
    if (!providerId || !polling) return;
    // The mount read was issued by the effect above; this only schedules the
    // recurring reads, so the first interval does not double a request.
    const timer = setInterval(() => void load(providerId, true), CREDITS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [providerId, polling]);
  return { result: snapshot.result, pending: snapshot.pending, refresh };
}

let surfaces: InAppProviderSurface[] | null = null;
let surfacesInflight: Promise<InAppProviderSurface[]> | null = null;
const surfaceListeners = new Set<() => void>();
/**
 * Stable empty value.
 *
 * `useSyncExternalStore` compares snapshots by identity: returning a fresh
 * `[]` before the first read arrives makes every render look like a change and
 * the component re-renders forever.
 */
const NO_SURFACES: InAppProviderSurface[] = [];

function subscribeSurfaces(listener: () => void): () => void {
  surfaceListeners.add(listener);
  return () => surfaceListeners.delete(listener);
}

/** A gateway registers its provider row a few seconds after launch. */
const SURFACE_RETRY_MS = 3_000;
const SURFACE_RETRY_LIMIT = 12;
let surfaceRetries = 0;
let surfaceRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSurfaceRetry(): void {
  if (surfaceRetryTimer !== null || surfaceRetries >= SURFACE_RETRY_LIMIT) return;
  surfaceRetries += 1;
  surfaceRetryTimer = setTimeout(() => {
    surfaceRetryTimer = null;
    loadSurfaces(true);
  }, SURFACE_RETRY_MS);
}

function loadSurfaces(force: boolean): void {
  if (!force && surfaces) return;
  if (surfacesInflight) return;
  surfacesInflight = api
    .inAppProviders()
    .then((response) => response.providers ?? [])
    .catch(() => null)
    .then((providers) => {
      if (providers === null) {
        // A failed read is not an answer: keep whatever we had and try again.
        scheduleSurfaceRetry();
        return [] as InAppProviderSurface[];
      }
      surfaces = providers;
      for (const listener of surfaceListeners) listener();
      // `providerId` is null until the gateway has registered its row, so an
      // early read is not the final answer either.
      if (providers.some((provider) => provider.providerId === null)) {
        scheduleSurfaceRetry();
      } else {
        surfaceRetries = 0;
      }
      return providers;
    })
    .finally(() => {
      surfacesInflight = null;
    });
}

/** Every in-app provider Main knows about, read once per app run. */
export function useInAppProviderSurfaces(): InAppProviderSurface[] {
  const current = useSyncExternalStore(
    subscribeSurfaces,
    () => surfaces ?? NO_SURFACES,
    () => surfaces ?? NO_SURFACES,
  );
  useEffect(() => {
    loadSurfaces(false);
  }, []);
  return current;
}

/**
 * Forget the cached surface list so the next render re-reads it.
 *
 * The list is read once per app run, but a gateway registers its provider row
 * a few seconds after launch — a cache taken before that registration would
 * report `providerId: null` for the rest of the session and the chip would
 * never appear.
 */
export function refreshInAppProviderSurfaces(): void {
  surfaces = null;
  for (const listener of surfaceListeners) listener();
  loadSurfaces(true);
}

/**
 * Drop everything cached about in-app providers.
 *
 * Called when the app has just refreshed its gateways: the previous surface
 * list, the row ids it named and the balances those gateways reported all
 * describe processes that no longer exist. Keeping any of them would leave a
 * surface pointing at a dead endpoint — which the runtime answers by retrying —
 * or a credit chip showing a number nothing produced.
 */
export function resetInAppProviderCaches(): void {
  surfaces = null;
  surfaceRetries = 0;
  if (surfaceRetryTimer !== null) {
    clearTimeout(surfaceRetryTimer);
    surfaceRetryTimer = null;
  }
  fetchedAt.clear();
  snapshots.clear();
  inflight.clear();
  for (const listener of surfaceListeners) listener();
  emit();
}

/** Credits data for the composer chip of the session's provider. */
export function inAppProviderSurfaceFor(
  providers: InAppProviderSurface[],
  providerId: string | undefined,
): InAppProviderSurface | undefined {
  if (!providerId) return undefined;
  return providers.find((provider) => provider.providerId === providerId);
}
