/**
 * Provider-row registration for a local model entry.
 *
 * The entry is an ordinary provider row: the Host owns it, the Settings list
 * shows it, and the model picker selects it like any other service. This module
 * only decides *which* row belongs to a local source and keeps its endpoint and
 * model bindings in step with what the machine currently offers.
 *
 * The credential is never written here. A local entry's API key is the upstream
 * token the user supplies once through the ordinary provider dialog; an absent
 * key leaves the row registered and visibly waiting for one.
 */
import type { WorkBuddyModel } from "./types.ts";

/** The slice of the Host client this module needs. */
export type ProviderHost = {
  call: <T>(method: string, params?: unknown) => Promise<T>;
};

export type RegisteredProvider = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  hasSecret?: boolean;
  enabled?: boolean;
  models?: { id: string }[];
};

export type ProviderBinding = {
  id: string;
  alias?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
};

export type EnsureProviderInput = {
  host: ProviderHost;
  /** Stable marker so the row is found again across launches. */
  vendorKey: string;
  name: string;
  baseUrl: string;
  models: readonly WorkBuddyModel[];
  /** Off when the local app disappeared; the row and its key are kept. */
  enabled: boolean;
};

export type EnsureProviderResult = {
  provider: RegisteredProvider;
  created: boolean;
  changed: boolean;
};

function bindingsFor(models: readonly WorkBuddyModel[]): ProviderBinding[] {
  return models.map((model) => {
    const binding: ProviderBinding = { id: model.id };
    if (model.name && model.name !== model.id) binding.alias = model.name;
    if (model.contextWindow) binding.contextWindow = model.contextWindow;
    if (model.maxOutputTokens) binding.maxTokens = model.maxOutputTokens;
    if (model.supportsImages !== undefined) binding.supportsImages = model.supportsImages;
    return binding;
  });
}

/** Whether the saved bindings still describe exactly these models. */
function bindingsMatch(
  saved: readonly { id: string }[] | undefined,
  next: readonly ProviderBinding[],
): boolean {
  const current = saved ?? [];
  if (current.length !== next.length) return false;
  const savedIds = new Set(current.map((binding) => binding.id.toLowerCase()));
  return next.every((binding) => savedIds.has(binding.id.toLowerCase()));
}

async function listProviders(host: ProviderHost): Promise<RegisteredProvider[]> {
  const result = await host.call<{ providers?: RegisteredProvider[] }>("providers.list", {
    includeDisabled: true,
  });
  return result?.providers ?? [];
}

/**
 * Create the row on first launch, then keep it pointing at the current endpoint
 * with the current models.
 *
 * `changed` is false when nothing needed writing, so an unchanged launch does
 * not rewrite the row (and does not bump its `updatedAt`).
 */
export async function ensureProvider(input: EnsureProviderInput): Promise<EnsureProviderResult> {
  const providers = await listProviders(input.host);
  const existing = providers.find((provider) => provider.vendorKey === input.vendorKey);
  const models = bindingsFor(input.models);

  if (!existing) {
    const created = await input.host.call<{ provider: RegisteredProvider }>("providers.create", {
      name: input.name,
      vendorKey: input.vendorKey,
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: input.baseUrl,
      authKind: "api_key",
      apiStyle: "chat_completions",
      models,
      defaultModelId: models[0]?.id,
    });
    return { provider: created.provider, created: true, changed: true };
  }

  const endpointChanged = (existing.baseUrl ?? "") !== input.baseUrl;
  const modelsChanged = !bindingsMatch(existing.models, models);
  const enabledChanged = Boolean(existing.enabled) !== input.enabled;
  if (!endpointChanged && !modelsChanged && !enabledChanged) {
    return { provider: existing, created: false, changed: false };
  }

  const updated = await input.host.call<{ provider?: RegisteredProvider | null }>(
    "providers.update",
    {
      id: existing.id,
      baseUrl: input.baseUrl,
      apiStyle: "chat_completions",
      enabled: input.enabled,
      // The saved key stays: an update that omits `secretValue` keeps it, and the
      // model list is the only thing this call owns.
      models,
      ...(modelsChanged ? { defaultModelId: models[0]?.id } : {}),
    },
  );
  return {
    provider: updated?.provider ?? { ...existing, baseUrl: input.baseUrl },
    created: false,
    changed: true,
  };
}

/**
 * Take an existing row out of the model list without creating one.
 *
 * Used when the local app disappears: the row keeps its saved token, so a
 * reinstall of that app comes back working, and a machine that never had the app
 * never gains an entry.
 */
export async function disableProviderIfPresent(input: {
  host: ProviderHost;
  vendorKey: string;
}): Promise<boolean> {
  const providers = await listProviders(input.host);
  const existing = providers.find((provider) => provider.vendorKey === input.vendorKey);
  if (!existing || existing.enabled === false) return false;
  await input.host.call("providers.update", { id: existing.id, enabled: false });
  return true;
}
