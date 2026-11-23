import { IPC } from "@pi-workspace/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import {
  createCuratorMaintenance,
  type CuratorMaintenance,
} from "../runtime/curator-runner";
import type { CuratorRunReport } from "../runtime/curator-report";
import type { IpcRegistrar } from "./types";

export type CuratorIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  /** The installation's data directory; reports and snapshots live under it. */
  dataDir: () => string;
  /** True while a turn is running — the automatic pass waits for quiet. */
  isBusy?: () => boolean;
  logger: Pick<Logger, "app">;
  /**
   * The maintenance instance the boot wiring already created. Optional so the
   * IPC surface can be registered on its own (tests, a host-less shell); the
   * lock file, not this instance, is what keeps a pass single-flight across
   * every instance in the process.
   */
  maintenance?: () => CuratorMaintenance;
};

/**
 * The curator's three channels: read the schedule, stop/resume it, and run one
 * pass by hand.
 *
 * These are the only way the settings page can see what the automatic pass did.
 * The report itself is a file (`<dataDir>/logs/curator/<stamp>/run.json`), so
 * `curator.run` answers with that object rather than a summary the page would
 * have to re-interpret.
 */
export function registerCuratorIpc({
  registrar,
  getHost,
  dataDir,
  isBusy,
  logger,
  maintenance,
}: CuratorIpcDependencies): void {
  let instance: CuratorMaintenance | null = null;
  const curator = (): CuratorMaintenance => {
    if (maintenance) return maintenance();
    instance ??= createCuratorMaintenance({
      getHost,
      ...(isBusy ? { isBusy } : {}),
      log: (level, message, data) =>
        logger.app("runtime", level, message, data ? { data } : undefined),
      dataDir,
    });
    return instance;
  };

  registrar.handle(IPC.invoke.curatorStatus, async () => curator().status());

  registrar.handle(
    IPC.invoke.curatorSetPaused,
    async (payload: { paused?: unknown } = {}) => {
      if (typeof payload?.paused !== "boolean") {
        throw new Error("invalid curator pause request");
      }
      // A pause only stops future automatic passes; a pass already running is
      // left to finish rather than being cut in half.
      return curator().setPaused(payload.paused);
    },
  );

  registrar.handle(IPC.invoke.curatorRun, async (payload: { dryRun?: unknown } = {}) => {
    const outcome = await curator().runNow({ dryRun: payload?.dryRun === true });
    if (!outcome.report) {
      // A manual run can still be refused — another pass holds the lock, or the
      // host is gone. Saying so is better than an empty report that reads as
      // "nothing was stale".
      throw new Error(`curator run did not start: ${outcome.reason}`);
    }
    if (outcome.reason === "failed") {
      throw Object.assign(new Error(outcome.error ?? "curator run failed"), {
        data: { report: outcome.report },
      });
    }
    return outcome.report satisfies CuratorRunReport;
  });
}
