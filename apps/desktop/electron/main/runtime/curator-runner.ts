/**
 * The automatic maintenance pass: when the skill library gets a run, and when
 * the memory store gets one.
 *
 * Two operations ride the same daily tick:
 *
 * 1. **Skill curation** (`skills.curate`): classifies every agent-written skill
 *    by idle days and moves the ones past the archive threshold into
 *    `<skills>/.archive/`. The pass itself lives in host-core; this module only
 *    owns *timing*.
 * 2. **Memory retention** (`memory.tidy`): expires memories that were never
 *    recalled, carry low confidence, are not pinned and have long been idle,
 *    and applies the live-row cap. The rules live in `memory/tidy.rs`.
 *
 * There is no second timer in main. Both ride the scheduled runner's existing
 * tick, so an app that is not polling for scheduled tasks is not maintaining
 * either, and the two cannot fire their own intervals out of phase.
 *
 * Three gates decide whether a tick runs them, cheapest first:
 *
 * 1. a session is running a turn — curation moves documents, and taking a skill
 *    out from under a turn that is reading it is not a maintenance decision;
 * 2. `curateAutomatically` is off in settings — the user's answer, and it covers
 *    both operations; the default is on;
 * 3. the last automatic pass is younger than 24h.
 *
 * The two operations are **independent**: each catches its own failure, so a
 * broken archive pass never skips retention and a broken retention pass never
 * skips the archive. A failure is a skipped pass, never a broken tick.
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
type TidyReport = { removed?: number; expired?: number; overflow?: number };

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
   * Move idle agent-written skills into the archive. Returns whether the pass
   * ran, so the caller can decide the shared timestamp without re-reading logs.
   */
  const curateSkills = async (host: CuratorHost): Promise<boolean> => {
    try {
      const { report } = await host.call<{ report: CurationReport }>("skills.curate", {
        dryRun: false,
      });
      const archived = report?.archived ?? [];
      options.log("info", "curator.auto_applied", {
        archived: archived.length,
        archivedIds: archived,
        skillsScanned: report?.entries?.length ?? 0,
      });
      return true;
    } catch (error) {
      // Archiving is a move, and a move that failed moved nothing: the next
      // tick retries it.
      options.log("warn", "curator.auto_failed", { error: String(error) });
      return false;
    }
  };

  /**
   * Apply the memory retention rules. Never throws: retention is housekeeping,
   * and the tick carrying it also carries the archive pass.
   */
  const tidyMemories = async (host: CuratorHost): Promise<void> => {
    try {
      const report = await host.call<TidyReport>("memory.tidy");
      // The counts are the point of the line: a user who watches memories
      // disappear should be able to find out how many, and from which rule.
      options.log("info", "memory.tidy_applied", {
        removed: report?.removed ?? 0,
        expired: report?.expired ?? 0,
        overflow: report?.overflow ?? 0,
      });
    } catch (error) {
      options.log("warn", "memory.tidy_failed", { error: String(error) });
    }
  };

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

      const curated = await curateSkills(host);
      // Independent of the archive: retention has its own failure path, so one
      // broken pass cannot cost the app the other.
      await tidyMemories(host);
      // Written only when the archive pass actually ran: the timestamp is that
      // pass's cadence, so a failed archive keeps its next-tick retry instead of
      // waiting a day. Retention is not what this timestamp records.
      if (curated) {
        await host.call("settings.set", { [CURATOR_LAST_RUN_SETTING]: startedAt });
      }
    } catch (error) {
      // Settings could not be read or written. The timestamp stays unwritten,
      // so the next tick retries. Nothing is lost: archiving is a move, and a
      // move that failed moved nothing.
      options.log("warn", "curator.auto_failed", { error: String(error) });
    } finally {
      running = false;
    }
  };

  return { run };
}
