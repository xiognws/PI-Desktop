/**
 * Supervisor for {@link IN_APP_PROVIDERS}.
 *
 * One boot does four things per provider, in this order, and each of them may
 * fail without stopping the app from starting:
 *
 *   1. read `inAppProvider.<id>.enabled` / `.port` from settings,
 *   2. start the gateway in its own process on the loopback port,
 *   3. wait for its `/healthz` (loopback key required) with a bounded timeout,
 *   4. create or refresh the provider row that points at it, then set its
 *      secret and model bindings.
 *
 * Step 4 is idempotent: the row is found by its reserved vendor key
 * (`builtin:<id>`, see `./types.ts`), so a second boot updates instead of
 * creating a second WorkBuddy next to the first.
 */
import {
  IN_APP_PROVIDERS,
  inAppProviderVendorKey,
  type InAppProvider,
} from "./types.ts";
import { CreditsCache, readCredits, type CreditsResult } from "./credits.ts";

/** Settings keys owned by the supervisor: `inAppProvider.<id>.{enabled,port}`. */
export const IN_APP_PROVIDER_SETTINGS_KEY = "inAppProvider";

export type ResolvedProviderSettings = { enabled: boolean; port: number };

export type HostCaller = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export type GatewayHandle = { stop(): Promise<void> };

export type StartGatewayInput = {
  provider: InAppProvider;
  port: number;
  apiKey: string;
};

export type StartGateway = (input: StartGatewayInput) => Promise<GatewayHandle>;

export type SupervisorLogger = (
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type InAppProvidersDeps = {
  providers?: readonly InAppProvider[];
  /** Host RPC (`providers.*`). */
  callHost: HostCaller;
  startGateway: StartGateway;
  /** `settings.get` result. */
  readSettings: () => Promise<Record<string, unknown>>;
  /** The loopback key the gateway is started with, generated on first use. */
  readApiKey: (provider: InAppProvider) => Promise<string>;
  fetchImpl?: typeof fetch;
  log: SupervisorLogger;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  now?: () => number;
  creditsTtlMs?: number;
};

export type InAppProviderStatus = {
  id: string;
  label: string;
  /** The user's switch (`inAppProvider.<id>.enabled`), not whether it started. */
  enabled: boolean;
  port: number;
  running: boolean;
  /** Provider row this gateway backs, once it has been registered. */
  providerId: string | null;
  /** Models the gateway published on the last successful start. */
  models: number;
  /** Why the gateway is not running, when it should be. Settings shows it. */
  reason?: string;
  creditsPath?: string;
};

type RuntimeProviderRow = {
  id: string;
  vendorKey?: string;
  baseUrl?: string;
  models?: Array<{ id: string }>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one provider's settings, defaulting to enabled on the descriptor port. */
export function resolveProviderSettings(
  provider: InAppProvider,
  settings: Record<string, unknown>,
): ResolvedProviderSettings {
  const root = settings[IN_APP_PROVIDER_SETTINGS_KEY];
  const scoped =
    root && typeof root === "object" && !Array.isArray(root)
      ? (root as Record<string, unknown>)[provider.id]
      : undefined;
  const record =
    scoped && typeof scoped === "object" && !Array.isArray(scoped)
      ? (scoped as Record<string, unknown>)
      : {};
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const requested = record.port;
  const port =
    typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= 1 &&
    requested <= 65535
      ? requested
      : provider.defaultPort;
  return { enabled, port };
}
export function inAppProviderOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export class InAppProviders {
  private readonly providers: readonly InAppProvider[];
  private readonly callHost: HostCaller;
  private readonly startGateway: StartGateway;
  private readonly readSettings: () => Promise<Record<string, unknown>>;
  private readonly readApiKey: (provider: InAppProvider) => Promise<string>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log: SupervisorLogger;
  private readonly healthTimeoutMs: number;
  private readonly healthPollMs: number;
  private readonly handles = new Map<string, GatewayHandle>();
  private readonly ports = new Map<string, number>();
  private readonly rowIds = new Map<string, string>();
  private readonly enabledById = new Map<string, boolean>();
  private readonly modelCounts = new Map<string, number>();
  private readonly failureReasons = new Map<string, string>();
  private readonly credits: CreditsCache;

  constructor(deps: InAppProvidersDeps) {
    this.providers = deps.providers ?? IN_APP_PROVIDERS;
    this.callHost = deps.callHost;
    this.startGateway = deps.startGateway;
    this.readSettings = deps.readSettings;
    this.readApiKey = deps.readApiKey;
    this.fetchImpl = deps.fetchImpl;
    this.log = deps.log;
    this.healthTimeoutMs = deps.healthTimeoutMs ?? 10_000;
    this.healthPollMs = deps.healthPollMs ?? 200;
    this.credits = new CreditsCache(
      (providerId) => this.loadCredits(providerId),
      { now: deps.now, ttlMs: deps.creditsTtlMs },
    );
  }

  /** Start every enabled provider. Never throws. */
  async start(): Promise<void> {
    for (const provider of this.providers) {
      try {
        await this.startOne(provider);
      } catch (error) {
        this.failureReasons.set(provider.id, describeError(error));
        this.log("warn", `[in-app] ${provider.id}: gateway start failed`, {
          error: describeError(error),
        });
      }
    }
  }

  /** Stop every gateway this supervisor owns. Never throws. */
  async stop(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    this.ports.clear();
    const settled = await Promise.allSettled(handles.map((handle) => handle.stop()));
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        this.log("warn", "[in-app] gateway stop failed", { error: describeError(outcome.reason) });
      }
    }
  }

  status(): InAppProviderStatus[] {
    return this.providers.map((provider) => {
      const running = this.handles.has(provider.id);
      const reason = this.failureReasons.get(provider.id);
      return {
        id: provider.id,
        label: provider.label,
        enabled: this.enabledById.get(provider.id) ?? true,
        port: this.ports.get(provider.id) ?? provider.defaultPort,
        running,
        providerId: this.rowIds.get(provider.id) ?? null,
        models: this.modelCounts.get(provider.id) ?? 0,
        ...(reason && !running ? { reason } : {}),
        ...(provider.creditsPath ? { creditsPath: provider.creditsPath } : {}),
      };
    });
  }

  /**
   * Turn one gateway on or off from settings.
   *
   * The switch is the persisted setting, not the running process: it survives a
   * restart, and it is the only thing that keeps a gateway off when the app
   * starts again. A failed start is reported through {@link status} rather than
   * thrown, because the card that asked for it has to keep rendering.
   */
  async setEnabled(providerId: string, enabled: boolean): Promise<InAppProviderStatus[]> {
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error(`unknown in-app provider: ${providerId}`);
    const settings = await this.readSettings();
    const existingRoot = settings[IN_APP_PROVIDER_SETTINGS_KEY];
    const root: Record<string, unknown> =
      existingRoot && typeof existingRoot === "object" && !Array.isArray(existingRoot)
        ? { ...(existingRoot as Record<string, unknown>) }
        : {};
    const existingScope = root[providerId];
    root[providerId] = {
      ...(existingScope && typeof existingScope === "object" && !Array.isArray(existingScope)
        ? (existingScope as Record<string, unknown>)
        : {}),
      enabled,
    };
    await this.callHost("settings.set", { [IN_APP_PROVIDER_SETTINGS_KEY]: root });
    await this.forget(providerId);
    this.failureReasons.delete(providerId);
    this.enabledById.set(providerId, enabled);
    if (!enabled) {
      this.modelCounts.delete(providerId);
      this.log("info", `[in-app] ${provider.id}: switched off in settings`);
      return this.status();
    }
    try {
      await this.startOne(provider);
    } catch (error) {
      this.failureReasons.set(providerId, describeError(error));
      this.log("warn", `[in-app] ${provider.id}: gateway start failed`, {
        error: describeError(error),
      });
    }
    return this.status();
  }

  /** Remaining credit for the provider the renderer is showing. */
  async readProviderCredits(
    input: { providerId: string; refresh?: boolean },
  ): Promise<CreditsResult> {
    const provider = this.providerForRow(input.providerId);
    if (!provider) return { ok: false, reason: "unavailable" };
    if (!provider.creditsPath) return { ok: false, reason: "no_credits_path" };
    return await this.credits.read(provider.id, { refresh: input.refresh === true });
  }

  /**
   * Resolve the provider a credits request is about.
   *
   * The renderer knows both handles: the descriptor id it renders (`workbuddy`)
   * and the provider row the gateway registered. Accept either, so a caller
   * cannot get an "unavailable" balance merely by naming the provider the way
   * the status list names it.
   */
  private providerForRow(requested: string): InAppProvider | undefined {
    const byDescriptor = this.providers.find((provider) => provider.id === requested);
    if (byDescriptor) return byDescriptor;
    for (const [id, row] of this.rowIds) {
      if (row === requested) return this.providers.find((provider) => provider.id === id);
    }
    return undefined;
  }

  private async loadCredits(providerId: string): Promise<CreditsResult> {
    const provider = this.providers.find((candidate) => candidate.id === providerId);
    if (!provider?.creditsPath) return { ok: false, reason: "no_credits_path" };
    const port = this.ports.get(providerId);
    if (!this.handles.has(providerId) || port === undefined) {
      return { ok: false, reason: "not_running" };
    }
    const apiKey = await this.readApiKey(provider);
    return await readCredits({
      origin: inAppProviderOrigin(port),
      creditsPath: provider.creditsPath,
      apiKey,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
  }

  private async startOne(provider: InAppProvider): Promise<void> {
    const settings = resolveProviderSettings(provider, await this.readSettings());
    this.enabledById.set(provider.id, settings.enabled);
    if (!settings.enabled) {
      this.log("info", `[in-app] ${provider.id}: disabled in settings`);
      return;
    }
    const apiKey = await this.readApiKey(provider);
    const started = await this.startOnFreePort(provider, settings.port, apiKey);
    const { handle, port } = started;
    this.handles.set(provider.id, handle);
    this.ports.set(provider.id, port);
    if (!(await this.waitForHealth(provider, port))) {
      this.failureReasons.set(provider.id, `no healthy gateway on port ${port}`);
      this.log("warn", `[in-app] ${provider.id}: gateway did not become healthy`, {
        port,
      });
      await this.forget(provider.id);
      return;
    }
    const models = await this.fetchModels(provider, port, apiKey);
    if (models.length === 0) {
      this.failureReasons.set(provider.id, "the gateway published no models");
      this.log("warn", `[in-app] ${provider.id}: gateway published no models`);
      return;
    }
    const rowId = await this.upsertProviderRow(provider, port, models, apiKey);
    this.rowIds.set(provider.id, rowId);
    this.modelCounts.set(provider.id, models.length);
    this.failureReasons.delete(provider.id);
    this.log("info", `[in-app] ${provider.id}: ready`, {
      port,
      providerId: rowId,
      models: models.length,
    });
  }

  /**
   * Start the gateway, moving to the next port when the configured one is taken.
   *
   * The bundled `community.workbuddy-connect` plugin runs an older copy of the
   * same bridge and defaults to the same port, and a machine that enabled that
   * plugin before this supervisor existed boots it first. Failing outright there
   * left the provider row pointing at a gateway this process does not own — its
   * key does not open that bridge — so a busy port is retried on the next few
   * instead. The row is always rewritten from the port that actually answered.
   */
  private async startOnFreePort(
    provider: InAppProvider,
    port: number,
    apiKey: string,
  ): Promise<{ handle: GatewayHandle; port: number }> {
    let candidate = port;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await this.startGateway({ provider, port: candidate, apiKey });
        if (candidate !== port) {
          this.log(
            "warn",
            `[in-app] ${provider.id}: port ${port} was in use, using ${candidate}`,
            { port: candidate, requestedPort: port },
          );
        }
        return { handle, port: candidate };
      } catch (error) {
        const busy = /EADDRINUSE/.test(describeError(error));
        if (!busy || candidate >= 65_535) throw error;
        candidate += 1;
        if (attempt < 3) {
          this.log("warn", `[in-app] ${provider.id}: port ${candidate - 1} is in use`, {
            nextPort: candidate,
          });
        }
      }
    }
    throw new Error(`[in-app] ${provider.id}: no free port near ${port}`);
  }

  private async forget(providerId: string): Promise<void> {
    const handle = this.handles.get(providerId);
    this.handles.delete(providerId);
    this.ports.delete(providerId);
    if (!handle) return;
    try {
      await handle.stop();
    } catch {
      // The port is already the state we wanted.
    }
  }

  private async waitForHealth(provider: InAppProvider, port: number): Promise<boolean> {
    const request = this.fetchImpl ?? fetch;
    const origin = inAppProviderOrigin(port);
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(500, this.healthPollMs * 4));
      try {
        const response = await request(`${origin}${provider.healthPath}`, {
          signal: controller.signal,
        });
        // 401 means the gateway is listening and enforcing its loopback key; the
        // key itself is proven by the model fetch that follows.
        if (response.status === 401) return true;
        if (response.ok) {
          const body: unknown = await response.json().catch(() => undefined);
          if (body && typeof body === "object" && (body as { ok?: unknown }).ok === true) {
            return true;
          }
        }
      } catch {
        // Not listening yet; the next poll answers.
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.healthPollMs));
    }
  }

  private async fetchModels(
    provider: InAppProvider,
    port: number,
    apiKey: string,
  ): Promise<string[]> {
    const request = this.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await request(
        `${inAppProviderOrigin(port)}${provider.openaiBasePath}/models`,
        {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        },
      );
      if (!response.ok) return [];
      const payload: unknown = await response.json();
      const data =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { data?: unknown }).data
          : undefined;
      if (!Array.isArray(data)) return [];
      const ids: string[] = [];
      for (const entry of data) {
        if (!entry || typeof entry !== "object") continue;
        const id = (entry as { id?: unknown }).id;
        if (typeof id === "string" && id.trim() !== "" && !ids.includes(id)) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async upsertProviderRow(
    provider: InAppProvider,
    port: number,
    models: readonly string[],
    apiKey: string,
  ): Promise<string> {
    const vendorKey = inAppProviderVendorKey(provider.id);
    const listed = await this.callHost<{ providers: RuntimeProviderRow[] }>("providers.list", {
      includeDisabled: true,
    });
    const existing = (listed.providers ?? []).find((row) => row.vendorKey === vendorKey);
    const fields = {
      name: provider.label,
      vendorKey,
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: `${inAppProviderOrigin(port)}${provider.openaiBasePath}`,
      authKind: "api_key_and_base_url",
      apiStyle: "chat_completions",
      models: models.map((id) => ({ id })),
      defaultModelId: models[0],
      secretValue: apiKey,
    };
    if (existing) {
      await this.callHost("providers.update", { id: existing.id, ...fields });
      // `providers.update` keeps the stored credential when no new value is
      // given; the loopback key is ours to (re)assert on every boot.
      await this.callHost("providers.setSecret", { id: existing.id, secretValue: apiKey });
      return existing.id;
    }
    const created = await this.callHost<{ provider: RuntimeProviderRow }>(
      "providers.create",
      fields,
    );
    await this.callHost("providers.setSecret", {
      id: created.provider.id,
      secretValue: apiKey,
    });
    return created.provider.id;
  }
}
