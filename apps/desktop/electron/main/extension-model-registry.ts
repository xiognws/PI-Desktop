/**
 * The read-only model registry a trusted extension's command sees
 * (spec 07-plugins/16 §5; ADR 0258 §4).
 *
 * Under the Rust kernel main is the JavaScript host, so it — not the runtime —
 * builds this projection. It is the same one the Node runtime builds
 * (`extensionModelRegistry` in `packages/agent-runtime/src/runtime.ts`): the
 * session's own binding plus the plugin agents the loaded modules registered,
 * each addressable by provider id and model id, with auth *availability*.
 *
 * What may never appear here: endpoints, headers, API keys, OAuth tokens, secret
 * refs, or any host provider internals. A registry entry exists so a command can
 * choose a model; a credential is not part of that choice.
 */
import type { RegisteredTrustedExtensionAgent } from "@pi-workspace/agent-runtime";
import type { ExtensionSessionBinding } from "./agent-extensions";

/** One entry of the projection: ids and public limits only. */
export type ExtensionRegistryModel = {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
};

export type ExtensionModelRegistryInput = {
  /** The session's live Runner registrations, read on every call. */
  agents: () => RegisteredTrustedExtensionAgent[];
  /** The session's own model binding, read when the Runner was built. */
  binding: ExtensionSessionBinding | undefined;
};

function project(
  agent: RegisteredTrustedExtensionAgent,
  model: RegisteredTrustedExtensionAgent["models"][number],
): ExtensionRegistryModel {
  return {
    id: model.id,
    name: model.name,
    provider: agent.providerId,
    ...(typeof model.api === "string" ? { api: model.api } : {}),
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? [...model.input] : ["text"],
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
  };
}

export function createExtensionModelRegistry(
  input: ExtensionModelRegistryInput,
): Record<string, unknown> {
  const entries = (): ExtensionRegistryModel[] => {
    const pluginModels = input.agents().flatMap((agent) =>
      agent.models.map((model) => project(agent, model)),
    );
    const own: ExtensionRegistryModel[] = input.binding
      ? [{ id: input.binding.modelId, name: input.binding.modelId, provider: input.binding.providerId }]
      : [];
    // Keyed the way the Node registry keys it, so one agent listed twice is one
    // entry rather than a duplicate the extension has to dedupe.
    const byKey = new Map<string, ExtensionRegistryModel>();
    for (const model of [...own, ...pluginModels]) {
      byKey.set(`${model.provider}/${model.id}`, model);
    }
    return [...byKey.values()];
  };
  // `setModel` switches to a plugin agent only, so a provider is "configured"
  // exactly when main knows how to reach it: the session's own binding, or an
  // agent a loaded module registered. Nothing here reads a secret to say so.
  const configured = (providerId: string): boolean =>
    providerId === input.binding?.providerId ||
    input.agents().some((agent) => agent.providerId === providerId);
  return {
    getAll: () => entries(),
    getAvailable: () => entries(),
    find: (providerId: string, modelId: string) =>
      entries().find((model) => model.provider === providerId && model.id === modelId),
    getProviderDisplayName: (providerId: string) =>
      input.agents().find((agent) => agent.providerId === providerId)?.name ?? providerId,
    getProviderAuthStatus: (providerId: string) => ({
      configured: configured(providerId),
      source: "plugin",
    }),
    hasConfiguredAuth: (model: { provider?: unknown }) =>
      typeof model?.provider === "string" && configured(model.provider),
  };
}

/**
 * The plugin agent a `setModel` argument names, if a loaded module registered it.
 *
 * The same rule as the Node runtime's `findAgentModel`: the argument must carry
 * both the provider id the host assigned (`extension-agent:…`) and a model id
 * that agent declared. A Host row's model, or a guess, is not a switch an
 * extension may perform.
 */
export function findRegisteredAgentModel(
  agents: RegisteredTrustedExtensionAgent[],
  model: unknown,
): { providerId: string; modelId: string } | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
  const agent = agents.find((entry) => entry.providerId === candidate.provider);
  if (!agent?.models.some((entry) => entry.id === candidate.id)) return undefined;
  return { providerId: agent.providerId, modelId: candidate.id };
}
