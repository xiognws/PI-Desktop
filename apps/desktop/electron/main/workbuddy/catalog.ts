/**
 * Model catalog normalization for the WorkBuddy entry.
 *
 * Two local sources describe the same account-level catalog with different
 * field names: the desktop app's `local_storage` cache (`maxInputTokens`,
 * `descriptionZh`, …) and the optional connector's catalog (`contextWindow`,
 * `reasoning`, `billing`). Both are folded into {@link WorkBuddyModel} here so
 * the bridge and the provider row never have to know which one answered.
 */
import type { WorkBuddyModel } from "./types.ts";

/**
 * Model ids that exist in the catalog but cannot hold a conversation: image and
 * video generators, inline completions, and code-completion variants. Offering
 * them in the picker would produce a session that fails on its first turn.
 */
const NON_CHAT_ID = /image|video|completion|codewise|kling|rewrite|jump|nes-|embedding/i;

export function isChatModel(modelId: string): boolean {
  return !NON_CHAT_ID.test(modelId);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Credit multiplier out of the several spellings the sources use
 * (`"x0.29 credits"`, `"x0.00"`, `0.29`, `null`). Absent means "not stated".
 */
export function parseCredits(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

/** One `local_storage` catalog entry, in either of its field spellings. */
export function normalizeDesktopModel(raw: unknown): WorkBuddyModel | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = stringValue(record.id);
  if (!id) return null;
  const reasoning = asRecord(record.reasoning);
  const billing = asRecord(record.billing);
  return {
    id,
    name: stringValue(record.name) ?? stringValue(record.displayName) ?? id,
    contextWindow:
      positiveInteger(record.maxInputTokens) ?? positiveInteger(record.contextWindow),
    maxOutputTokens:
      positiveInteger(record.maxOutputTokens) ?? positiveInteger(record.maxTokens),
    supportsImages:
      typeof record.supportsImages === "boolean" ? record.supportsImages : undefined,
    supportsReasoning:
      typeof record.supportsReasoning === "boolean"
        ? record.supportsReasoning
        : typeof reasoning?.supports === "boolean"
          ? reasoning.supports
          : undefined,
    supportsToolCall:
      typeof record.supportsToolCall === "boolean" ? record.supportsToolCall : undefined,
    description: stringValue(record.descriptionZh) ?? stringValue(record.description),
    credits: parseCredits(record.credits ?? billing?.credits),
    isDefault: record.isDefault === true,
  };
}

/** Keep the field values of whichever side actually states them. */
function mergeModel(base: WorkBuddyModel, richer: WorkBuddyModel): WorkBuddyModel {
  const merged: WorkBuddyModel = { ...base };
  for (const [key, value] of Object.entries(richer)) {
    if (key === "name") continue;
    if (value !== undefined && value !== null) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  // A display name equal to the id says nothing, so prefer whichever side names
  // the model for real, and fall back to the id.
  const namedBase = base.name && base.name !== base.id ? base.name : undefined;
  const namedRicher = richer.name && richer.name !== richer.id ? richer.name : undefined;
  merged.name = namedBase ?? namedRicher ?? base.id;
  return merged;
}

/**
 * Fold several catalogs into one ordered list.
 *
 * `sources` are applied in priority order: a later source overrides scalar
 * fields it states, while fields it omits keep the earlier value. Chat models
 * come first (default model first), because the picker is used to start a
 * conversation.
 */
export function mergeCatalogs(
  sources: readonly (readonly WorkBuddyModel[])[],
): WorkBuddyModel[] {
  const merged = new Map<string, WorkBuddyModel>();
  for (const source of sources) {
    for (const model of source) {
      const previous = merged.get(model.id);
      merged.set(model.id, previous ? mergeModel(previous, model) : model);
    }
  }
  return [...merged.values()]
    .filter((model) => isChatModel(model.id))
    .sort((left, right) => {
      if (Boolean(right.isDefault) !== Boolean(left.isDefault)) {
        return right.isDefault ? 1 : -1;
      }
      return left.id.localeCompare(right.id);
    });
}

/**
 * Drops models the desktop catalog keeps for inline completion and other
 * account plumbing. The desktop app's own list mixes both families; the
 * account-level models are the ones with a display name or a context window.
 */
export function accountLevelModels(models: readonly WorkBuddyModel[]): WorkBuddyModel[] {
  const candidates = models.filter(
    (model) =>
      !/^(codewise|completion-|default-1|hunyuan-\d+b|codewise-)/.test(model.id),
  );
  return candidates.length >= 5 ? candidates : [...models];
}

export type WorkBuddyModelBinding = {
  id: string;
  alias?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
};

/**
 * Provider-row bindings for the discovered models.
 *
 * Only stated values are sent: an absent context window must stay absent so the
 * host's own default applies instead of a number this module invented.
 */
export function toModelBindings(
  models: readonly WorkBuddyModel[],
): WorkBuddyModelBinding[] {
  return models.map((model) => {
    const binding: WorkBuddyModelBinding = { id: model.id };
    if (model.name && model.name !== model.id) binding.alias = model.name;
    if (model.contextWindow) binding.contextWindow = model.contextWindow;
    if (model.maxOutputTokens) binding.maxTokens = model.maxOutputTokens;
    if (model.supportsImages !== undefined) binding.supportsImages = model.supportsImages;
    return binding;
  });
}
