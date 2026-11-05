import type { ModelBinding } from "@pi-workspace/shared";
import { useListReorder } from "../../hooks/use-list-reorder";
import { reorderItem } from "../../lib/list-reorder";

export function useModelReorder(
  visibleModels: ModelBinding[],
  setModels: (update: (current: ModelBinding[]) => ModelBinding[]) => void,
  busy: boolean,
) {
  return useListReorder(visibleModels, (source, target, placement) => {
    setModels((current) => reorderItem(current, source, target, placement));
  }, busy, "application/x-pi-desktop-model");
}
