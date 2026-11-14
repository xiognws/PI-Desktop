/**
 * Bulk limit editing for the models of one service.
 *
 * A service that publishes nothing about its model capacities leaves every row
 * at the generic default, and correcting twenty rows through twenty advanced
 * sheets is the reason this control exists: one draft, applied to the whole
 * list. Only the fields the draft states are written, and every write is pinned
 * as the user's own number (`…Source: "user"`), so a later catalog refresh
 * cannot quietly replace what was just chosen.
 */
import type { ModelBinding } from "@pi-workspace/shared";

/** One bulk edit: a field that is absent or null is left exactly as it is. */
export type BulkLimitDraft = {
  contextWindow?: number | null;
  maxTokens?: number | null;
};

/** Token counts are whole positive numbers; anything else means "not stated". */
function positiveTokenCount(value?: number | null): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

/** Whether a draft states no field at all, so applying it would do nothing. */
export function bulkLimitDraftIsEmpty(draft: BulkLimitDraft): boolean {
  return (
    positiveTokenCount(draft.contextWindow) === undefined &&
    positiveTokenCount(draft.maxTokens) === undefined
  );
}

/**
 * Apply a draft to every binding.
 *
 * Returns the input array itself when nothing changed, so a draft that repeats
 * the stored numbers does not churn the list or mark the provider dirty.
 */
export function applyBulkLimits(
  bindings: readonly ModelBinding[],
  draft: BulkLimitDraft,
): ModelBinding[] {
  const contextWindow = positiveTokenCount(draft.contextWindow);
  const maxTokens = positiveTokenCount(draft.maxTokens);
  if (contextWindow === undefined && maxTokens === undefined) {
    return bindings as ModelBinding[];
  }
  let changed = false;
  const next = bindings.map((binding) => {
    const patch: Partial<ModelBinding> = {};
    if (contextWindow !== undefined) {
      if (binding.contextWindow !== contextWindow) patch.contextWindow = contextWindow;
      if (binding.contextWindowSource !== "user") patch.contextWindowSource = "user";
    }
    if (maxTokens !== undefined) {
      if (binding.maxTokens !== maxTokens) patch.maxTokens = maxTokens;
      if (binding.maxTokensSource !== "user") patch.maxTokensSource = "user";
    }
    if (Object.keys(patch).length === 0) return binding;
    changed = true;
    return { ...binding, ...patch };
  });
  return changed ? next : (bindings as ModelBinding[]);
}
