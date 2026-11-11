/**
 * Lifecycle of the local model entries.
 *
 * One pass at startup is enough for the entry to exist and be usable: detect the
 * app, start its loopback gateway, register the provider row with the account's
 * models. Nothing polls — `/v1/models` re-reads the account on every request, so
 * a model the account gains later appears the next time the picker refreshes.
 *
 * Failure policy: a local entry is optional. Every step logs and degrades to
 * "unavailable" instead of surfacing an error, because a missing or broken
 * WorkBuddy install must never affect the rest of the app.
 */
import { currentEnvironment, type WorkBuddyEnvironment } from "./paths.ts";
import { disableProviderIfPresent, ensureProvider, type ProviderHost } from "./provider.ts";
import { localModelSources, type LocalEntryBridge, type LocalModelSource } from "./sources.ts";
import type { WorkBuddyDiscovery, WorkBuddyStatus } from "./types.ts";

export type WorkBuddyServiceOptions = {
  getHost: () => ProviderHost | null;
  environment?: WorkBuddyEnvironment;
  sources?: LocalModelSource[];
  log?: (event: Record<string, unknown>) => void;
};

export type WorkBuddyService = {
  /** Detect, start the gateway, register the provider row. Safe to call twice. */
  start: () => Promise<WorkBuddyStatus[]>;
  /** Re-read the account and bring the provider row's models up to date. */
  refresh: () => Promise<WorkBuddyStatus[]>;
  /** Last known state per source; empty before the first pass. */
  status: () => WorkBuddyStatus[];
  /** Close every gateway this service opened. */
  dispose: () => Promise<void>;
};

type SourceRuntime = {
  source: LocalModelSource;
  bridge?: LocalEntryBridge;
  status: WorkBuddyStatus;
};

type SourcePass = { status: WorkBuddyStatus; bridge?: LocalEntryBridge };

function unavailable(
  source: LocalModelSource,
  discovery: WorkBuddyDiscovery | null,
  detail?: string,
): WorkBuddyStatus {
  return {
    state: "unavailable",
    modelCount: discovery?.models.length ?? 0,
    endpoint: "none",
    installation: discovery?.installation ?? { installed: false, loggedIn: false, sources: [] },
    detail: detail ?? discovery?.installation.detail ?? `${source.name} is not available`,
  };
}

export function createWorkBuddyService(options: WorkBuddyServiceOptions): WorkBuddyService {
  const sources = options.sources ?? localModelSources();
  const environment = options.environment ?? currentEnvironment();
  const log = options.log ?? (() => {});
  const runtimes = new Map<string, SourceRuntime>();

  async function register(
    source: LocalModelSource,
    discovery: WorkBuddyDiscovery,
    bridge: LocalEntryBridge,
  ): Promise<WorkBuddyStatus> {
    const host = options.getHost();
    if (!host) throw new Error("host unavailable");
    const result = await ensureProvider({
      host,
      vendorKey: source.vendorKey,
      name: source.name,
      baseUrl: bridge.baseUrl,
      models: discovery.models,
      enabled: true,
    });
    return {
      // The row exists either way; `hasSecret` is what separates "paste the
      // token once" from "works now".
      state: result.provider.hasSecret ? "ready" : "needs-credential",
      providerId: result.provider.id,
      baseUrl: bridge.baseUrl,
      modelCount: discovery.models.length,
      endpoint: "bridge",
      installation: discovery.installation,
      detail: result.created
        ? `created provider row ${result.provider.id}`
        : result.changed
          ? `updated provider row ${result.provider.id}`
          : undefined,
    };
  }

  /** Retire a row whose local app disappeared, without creating one. */
  async function disableIfPresent(source: LocalModelSource): Promise<void> {
    const host = options.getHost();
    if (!host) return;
    try {
      await disableProviderIfPresent({ host, vendorKey: source.vendorKey });
    } catch (error) {
      log({ event: "workbuddy_disable_failed", source: source.id, message: String(error) });
    }
  }

  async function runSource(
    source: LocalModelSource,
    previous: SourceRuntime | undefined,
  ): Promise<SourcePass> {
    let discovery: WorkBuddyDiscovery;
    try {
      discovery = source.detect(environment);
    } catch (error) {
      log({ event: "workbuddy_detect_failed", source: source.id, message: String(error) });
      return { status: unavailable(source, null, `${source.name}: local detection failed`) };
    }
    if (!discovery.installation.installed) {
      // The app is gone, so its models cannot answer: park the row when one
      // exists (keeping the saved token) and stop the listener.
      await previous?.bridge?.close().catch(() => {});
      await disableIfPresent(source);
      return { status: unavailable(source, discovery) };
    }

    let bridge = previous?.bridge;
    try {
      bridge ??= await source.startBridge({
        detect: () => source.detect(environment),
        log,
      });
      const status = await register(source, discovery, bridge);
      log({
        event: "workbuddy_ready",
        source: source.id,
        state: status.state,
        providerId: status.providerId,
        models: status.modelCount,
        loggedIn: discovery.installation.loggedIn,
      });
      return { status, bridge };
    } catch (error) {
      await bridge?.close().catch(() => {});
      log({ event: "workbuddy_start_failed", source: source.id, message: String(error) });
      return {
        status: unavailable(source, discovery, `${source.name}: ${(error as Error).message}`),
      };
    }
  }

  async function pass(): Promise<WorkBuddyStatus[]> {
    const results: WorkBuddyStatus[] = [];
    for (const source of sources) {
      const previous = runtimes.get(source.id);
      const { status, bridge } = await runSource(source, previous);
      // A pass that replaced (or retired) the gateway closes the old listener.
      if (previous?.bridge && previous.bridge !== bridge) {
        await previous.bridge.close().catch(() => {});
      }
      runtimes.set(source.id, { source, bridge, status });
      results.push(status);
    }
    return results;
  }

  let started: Promise<WorkBuddyStatus[]> | null = null;

  return {
    start: () => {
      started ??= pass();
      return started;
    },
    refresh: async () => {
      const results = await pass();
      started = Promise.resolve(results);
      return results;
    },
    status: () => [...runtimes.values()].map((runtime) => runtime.status),
    dispose: async () => {
      for (const runtime of runtimes.values()) {
        await runtime.bridge?.close().catch(() => {});
        runtime.bridge = undefined;
      }
      runtimes.clear();
      started = null;
    },
  };
}
