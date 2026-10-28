import { IPC, type ModelBenchmarkLoad } from "@pi-desktop/shared";
import { loadModelBenchmarks } from "../model-benchmarks-service";
import type { IpcRegistrar } from "./types";

/**
 * Read the cached benchmark overlay for the model picker.
 *
 * Read-only and offline-capable: the renderer asks whenever a picker opens, the
 * service answers from its day-long cache, and a failed refresh returns the
 * last good table (or an empty one) instead of an error the UI has to render.
 */
export function registerModelBenchmarksIpc(registrar: IpcRegistrar): void {
  registrar.handle(
    IPC.invoke.modelsBenchmarks,
    async (input?: { forceRefresh?: boolean }): Promise<ModelBenchmarkLoad> =>
      loadModelBenchmarks({ forceRefresh: input?.forceRefresh === true }),
  );
}
