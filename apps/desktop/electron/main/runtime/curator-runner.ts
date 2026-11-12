/**
 * The automatic skill-curation pass: when the library gets a maintenance run.
 *
 * The pass itself lives in host-core (`skills.curate`): it classifies every
 * agent-written skill by idle days and moves the ones past the archive
 * threshold into `<skills>/.archive/`. This module only owns *timing*.
 *
 * There is no second timer in main. The pass rides the scheduled runner's
 * existing tick, so an app that is not polling for scheduled tasks is not
 * curating either, and the two cannot fire their own intervals out of phase.
 *
 * Three gates decide whether a tick runs it, cheapest first:
 *
 * 1. a session is running a turn — the pass moves documents, and taking a skill
 *    out from under a turn that is reading it is not a maintenance decision;
 * 2. `curateAutomatically` is off in settings — the user's answer, and the
 *    default is on;
 * 3. the last automatic pass is younger than 24h.
 *
 * The timestamp is a setting (`curatorLastRunAt`), not a file of its own: the
 * daily cadence is a preference, it travels with the other preferences, and it
 * needs no separate lifecycle.
 */
export type CuratorHost = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

/** Settings key: may the app run the maintenance pass on its own? */
export const CURATE_AUTOMATICALLY_SETTING = "curateAutomatically";
/** Settings key: epoch ms of the last automatic pass. */
export const CURATOR_LAST_RUN_SETTING = "curatorLastRunAt";
/** At most one automatic pass a day. */
export const CURATOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CurationReport = { archived?: string[]; entries?: unknown[] };

export type CuratorLog = (
  level: "info" | "warn",
  message: string,
  data?: Record<string, unknown>,
) => void;

export function createCuratorMaintenance(options: {
  getHost: () => CuratorHost | null;
  /** True while any session runs a turn, or is still tearing one down. */
  isBusy: () => boolean;
  log: CuratorLog;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  let running = false;

  /**
   * One attempt. Safe to call on every tick: it returns immediately unless all
   * three gates are open, and it never throws — a failed pass is a skipped
   * pass, and a skipped pass must never break the tick that called it.
   */
  const run = async (): Promise<void> => {
    if (running) return;
    const host = options.getHost();
    if (!host) return;
    if (options.isBusy()) return;
    running = true;
    try {
      const settings = await host.call<Record<string, unknown> | null>("settings.get");
      // Only an explicit `false` turns it off: a settings document written
      // before this preference existed reads as the default, which is on.
      if (settings?.[CURATE_AUTOMATICALLY_SETTING] === false) return;
      const last = Number(settings?.[CURATOR_LAST_RUN_SETTING]);
      const startedAt = now();
      // A future timestamp means the clock moved; it still counts as "not due".
      if (Number.isFinite(last) && startedAt - last < CURATOR_INTERVAL_MS) return;

      const { report } = await host.call<{ report: CurationReport }>("skills.curate", {
        dryRun: false,
      });
      const archived = report?.archived ?? [];
      // Recorded before the log line: a crash between the two must not leave a
      // pass that ran unrecorded, or the next tick would run it again.
      await host.call("settings.set", { [CURATOR_LAST_RUN_SETTING]: startedAt });
      options.log("info", "curator.auto_applied", {
        archived: archived.length,
        archivedIds: archived,
        skillsScanned: report?.entries?.length ?? 0,
      });
    } catch (error) {
      // The timestamp stays unwritten, so the next tick retries. Nothing is
      // lost: archiving is a move, and a move that failed moved nothing.
      options.log("warn", "curator.auto_failed", { error: String(error) });
    } finally {
      running = false;
    }
  };

  return { run };
}
