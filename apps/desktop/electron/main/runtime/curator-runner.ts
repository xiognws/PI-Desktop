/**
 * The automatic maintenance pass: when the skill library gets a run, and when
 * the memory store gets one.
 *
 * Ported from Hermes' curator (`agent/curator.py`): `should_run_now` for the
 * gates, `run_curator_review` for the state-before-work ordering. What it keeps,
 * and why:
 *
 * 1. **The gates are `enabled ∧ !paused ∧ interval ∧ idle ∧ lock`.** Hermes runs
 *    the pass about once a week, only when the agent has been quiet for a couple
 *    of hours, and never on a fresh install: `last_run_at` absent means "seed now
 *    and defer one interval". Every gate is a default the user can override
 *    through settings; none of them is a fixed constant in this file.
 * 2. **State is written before the work, and put back if the work fails.**
 *    Hermes persists `last_run_at`/`run_count` before its pass so a crash
 *    mid-review still records that a run happened. A *handled* failure is
 *    different: nothing moved, so the timestamp goes back and the next tick
 *    retries — which is the behaviour this file always had, kept.
 * 3. **Every run leaves a report** (`run.json` + `REPORT.md`) and a pre-run
 *    snapshot, so "why did my skill disappear" has an answer on disk. Both are
 *    best-effort: reporting must never turn a completed pass into a failed one.
 *
 * Two operations ride the same tick, as before:
 *
 * 1. **Skill curation** (`skills.curate`): classifies every agent-written skill
 *    by idle days and moves the ones past the archive threshold into
 *    `<skills>/.archive/`. The pass itself lives in host-core; this module owns
 *    *timing*, the snapshot and the report.
 * 2. **Memory retention** (`memory.tidy`): expires memories that were never
 *    recalled, carry low confidence, are not pinned and have long been idle,
 *    and applies the live-row cap. The rules live in `memory/tidy.rs`.
 *
 * There is no second timer in main. Both ride the scheduled runner's existing
 * tick, so an app that is not polling for scheduled tasks is not maintaining
 * either, and the two cannot fire their own intervals out of phase.
 *
 * The two operations are **independent**: each catches its own failure, so a
 * broken archive pass never skips retention and a broken retention pass never
 * skips the archive. A failure is a skipped pass, never a broken tick.
 *
 * The timestamp is a setting (`curatorLastRunAt`), not a file of its own: the
 * cadence is a preference, it travels with the other preferences, and it needs
 * no separate lifecycle.
 *
 * **Cron references are not protected here, because this repository has no cron
 * concept.** Hermes treats a skill referenced by a cron job as pinned
 * (`_cron_referenced_skills` → `cron.jobs.referenced_skill_names`) because a job
 * that loads a missing skill fails on its next run. This workspace's scheduled
 * tasks (`crates/host-core/src/scheduled.rs`, `ScheduledTask`) carry a `title`
 * and a free-text `prompt` and **no field that references a skill**; nothing
 * under `crates/host-core/src/scheduled*` mentions skills at all. Matching skill
 * names inside prompt prose would pin whichever skill a sentence happens to
 * name, so the protection is skipped — and every report says so, in
 * `cron_rewrites.skipped`.
 */
import type { SkillCurationReport } from "@pi-workspace/shared";
import {
  acquireCuratorLock,
  curatorBackupsRoot,
  curatorErrorMessage,
  releaseCuratorLock,
  snapshotSkillLibrary,
  writeCuratorRunReport,
  type CuratorAutoTransitions,
  type CuratorPrunedEntry,
  type CuratorReportPaths,
  type CuratorRunReport,
  type CuratorStateTransition,
} from "./curator-report";

export type CuratorHost = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

/** Settings key: may the app run the maintenance pass on its own? */
export const CURATE_AUTOMATICALLY_SETTING = "curateAutomatically";
/** Settings key: the user asked the pass to stop (`curator.setPaused`). */
export const CURATOR_PAUSED_SETTING = "curatorPaused";
/** Settings key: epoch ms of the last pass that actually ran. */
export const CURATOR_LAST_RUN_SETTING = "curatorLastRunAt";
/** Settings key: how many passes have completed. */
export const CURATOR_RUN_COUNT_SETTING = "curatorRunCount";
/** Settings key: directory of the newest `run.json` + `REPORT.md`. */
export const CURATOR_LAST_REPORT_SETTING = "curatorLastReportPath";
/** Settings key: hours between passes. Hermes `curator.interval_hours`. */
export const CURATOR_INTERVAL_HOURS_SETTING = "curatorIntervalHours";
/** Settings key: hours of quiet required first. Hermes `curator.min_idle_hours`. */
export const CURATOR_MIN_IDLE_HOURS_SETTING = "curatorMinIdleHours";
/** Settings key: days idle before a skill is reported stale. */
export const CURATOR_STALE_AFTER_DAYS_SETTING = "curatorStaleAfterDays";
/** Settings key: days idle before a skill is archived. */
export const CURATOR_ARCHIVE_AFTER_DAYS_SETTING = "curatorArchiveAfterDays";
/** Settings key: snapshot the library before a pass? Hermes `curator.backup.enabled`. */
export const CURATOR_BACKUP_ENABLED_SETTING = "curatorBackupEnabled";
/** Settings key: snapshots to keep. Hermes `curator.backup.keep`. */
export const CURATOR_BACKUP_KEEP_SETTING = "curatorBackupKeep";

/** One week, Hermes' `curator.interval_hours` default. */
export const DEFAULT_INTERVAL_HOURS = 168;
/** Two hours of quiet, Hermes' `curator.min_idle_hours` default. */
export const DEFAULT_MIN_IDLE_HOURS = 2;
/** Hermes' `curator.stale_after_days` default. */
export const DEFAULT_STALE_AFTER_DAYS = 14;
/** Hermes' `curator.archive_after_days` default. */
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;
/** Hermes' `curator.backup.keep` default. */
export const DEFAULT_BACKUP_KEEP = 2;

const HOUR_MS = 60 * 60 * 1000;

export type CuratorLog = (
  level: "info" | "warn",
  message: string,
  data?: Record<string, unknown>,
) => void;

/** The user-facing answer to `curator.status`; a settings page draws it directly. */
export type CuratorStatus = {
  enabled: boolean;
  paused: boolean;
  intervalHours: number;
  minIdleHours: number;
  staleAfterDays: number;
  archiveAfterDays: number;
  /** Epoch ms of the last completed pass, or null before the first one. */
  lastRunAt: number | null;
  runCount: number;
  /** Directory holding the newest `run.json` and `REPORT.md`. */
  lastReportPath: string | null;
};

/** The resolved settings document, every default applied once. */
export type CuratorConfig = CuratorStatus & {
  backupEnabled: boolean;
  backupKeep: number;
};

/**
 * Why a tick did or did not run. `reason` is reported, not thrown: a skipped
 * pass is a normal answer, and the scheduled runner must never see an exception
 * out of housekeeping.
 */
export type CuratorRunOutcome = {
  ran: boolean;
  reason:
    | "completed"
    | "disabled"
    | "paused"
    | "seeded"
    | "interval"
    | "idle"
    | "busy"
    | "locked"
    | "running"
    | "no-host"
    | "failed";
  report?: CuratorRunReport;
  paths?: CuratorReportPaths | null;
  error?: string;
};

type TidyReport = { removed?: number; expired?: number; overflow?: number };

function readNumber(value: unknown, fallback: number, minimum: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function readOptionalNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turn the settings document into the pass's configuration.
 *
 * Defaults are Hermes' — on, a week apart, two hours quiet, 14/30 day thresholds,
 * two snapshots — and only an explicit `false`/`true` flips a switch: a settings
 * document written before a key existed has to read as the documented default,
 * never as "off".
 */
export function resolveCuratorConfig(
  settings: Record<string, unknown> | null | undefined,
): CuratorConfig {
  const values = settings ?? {};
  const reportPath = values[CURATOR_LAST_REPORT_SETTING];
  return {
    enabled: values[CURATE_AUTOMATICALLY_SETTING] !== false,
    paused: values[CURATOR_PAUSED_SETTING] === true,
    intervalHours: readNumber(values[CURATOR_INTERVAL_HOURS_SETTING], DEFAULT_INTERVAL_HOURS, 1),
    minIdleHours: readNumber(values[CURATOR_MIN_IDLE_HOURS_SETTING], DEFAULT_MIN_IDLE_HOURS, 0),
    staleAfterDays: readNumber(values[CURATOR_STALE_AFTER_DAYS_SETTING], DEFAULT_STALE_AFTER_DAYS, 1),
    archiveAfterDays: readNumber(
      values[CURATOR_ARCHIVE_AFTER_DAYS_SETTING],
      DEFAULT_ARCHIVE_AFTER_DAYS,
      1,
    ),
    backupEnabled: values[CURATOR_BACKUP_ENABLED_SETTING] !== false,
    backupKeep: Math.trunc(readNumber(values[CURATOR_BACKUP_KEEP_SETTING], DEFAULT_BACKUP_KEEP, 1)),
    lastRunAt: readOptionalNumber(values[CURATOR_LAST_RUN_SETTING]),
    runCount: Math.trunc(readNumber(values[CURATOR_RUN_COUNT_SETTING], 0, 0)),
    lastReportPath: typeof reportPath === "string" && reportPath ? reportPath : null,
  };
}

export function createCuratorMaintenance(options: {
  getHost: () => CuratorHost | null;
  /** True while any session runs a turn, or is still tearing one down. */
  isBusy?: () => boolean;
  log: CuratorLog;
  /** The installation's data directory: snapshots and reports live under it. */
  dataDir: () => string;
  now?: () => number;
  /**
   * How long the app has been quiet. Defaults to time since this instance last
   * saw a busy tick, so a pass never lands in the middle of a turn even when the
   * caller has its own idea of idle time.
   */
  idleMs?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const isBusy = options.isBusy ?? (() => false);
  let running = false;
  // Boot counts as quiet: no turn has run yet, so the idle clock starts here.
  let lastBusyAt = now();
  const idleMs = options.idleMs ?? (() => now() - lastBusyAt);

  const readSettings = async (host: CuratorHost): Promise<Record<string, unknown>> =>
    (await host.call<Record<string, unknown> | null>("settings.get")) ?? {};

  /** Apply the memory retention rules. Never throws: retention is housekeeping. */
  const tidyMemories = async (
    host: CuratorHost,
  ): Promise<{ removed: number; expired: number; overflow: number } | { error: string }> => {
    try {
      const report = await host.call<TidyReport>("memory.tidy");
      // The counts are the point of the line: a user who watches memories
      // disappear should be able to find out how many, and from which rule.
      const counts = {
        removed: report?.removed ?? 0,
        expired: report?.expired ?? 0,
        overflow: report?.overflow ?? 0,
      };
      options.log("info", "memory.tidy_applied", counts);
      return counts;
    } catch (error) {
      options.log("warn", "memory.tidy_failed", { error: String(error) });
      return { error: curatorErrorMessage(error) };
    }
  };

  /** Assemble `run.json` from the two curate reports and the side effects. */
  const buildReport = (input: {
    trigger: "automatic" | "manual";
    dryRun: boolean;
    startedAt: number;
    durationSeconds: number;
    config: CuratorConfig;
    before: SkillCurationReport | null;
    after: SkillCurationReport | null;
    backup: CuratorRunReport["backup"];
    memoryTidy: CuratorRunReport["memory_tidy"];
    error: string | null;
  }): CuratorRunReport => {
    const entries = input.before?.entries ?? [];
    const archivedIds = input.dryRun ? [] : (input.after?.archived ?? []);
    const archived = new Set(archivedIds);
    const candidates = entries.filter((entry) => entry.state === "archive");
    const pruned: CuratorPrunedEntry[] = input.dryRun
      ? candidates.map((entry) => ({
          name: entry.name,
          id: entry.id,
          reason: `would archive — idle ${entry.idleDays}d (dry run)`,
          idle_days: entry.idleDays,
        }))
      : candidates
          .filter((entry) => archived.has(entry.id))
          .map((entry) => ({
            name: entry.name,
            id: entry.id,
            reason: `idle ${entry.idleDays}d`,
            idle_days: entry.idleDays,
          }));
    // Every id that moved belongs in the report, even one this pass cannot
    // explain: an unexplained archival is exactly what a reader must see.
    for (const id of archivedIds) {
      if (!pruned.some((entry) => entry.id === id)) {
        pruned.push({ name: id, id, reason: "archived", idle_days: 0 });
      }
    }
    const transitions: CuratorStateTransition[] = input.dryRun
      ? []
      : pruned.map((entry) => ({
          name: entry.name,
          from: "active",
          to: "archived",
          idle_days: entry.idle_days,
        }));
    const autoTransitions: CuratorAutoTransitions = {
      checked: entries.length,
      marked_stale: entries.filter((entry) => entry.state === "stale").length,
      archived: archivedIds.length,
      // This library has no persisted per-skill state machine, so no pass can
      // move a skill *back*: nothing is ever reactivated or seeded.
      reactivated: 0,
      seeded: 0,
    };
    return {
      started_at: new Date(input.startedAt).toISOString(),
      duration_seconds: Math.max(0, Math.round(input.durationSeconds * 100) / 100),
      trigger: input.trigger,
      dry_run: input.dryRun,
      auto_transitions: autoTransitions,
      counts: {
        before: entries.length,
        after: entries.length - archivedIds.length,
        delta: -archivedIds.length,
        archived_this_run: archivedIds.length,
        added_this_run: 0,
        consolidated_this_run: 0,
        pruned_this_run: pruned.length,
        state_transitions: transitions.length,
        cron_jobs_rewritten: 0,
        tool_calls_total: 0,
      },
      policy: {
        stale_after_days: input.config.staleAfterDays,
        archive_after_days: input.config.archiveAfterDays,
      },
      archived: archivedIds,
      consolidated: [],
      pruned,
      pruned_names: pruned.map((entry) => entry.name),
      added: [],
      state_transitions: transitions,
      cron_rewrites: {
        rewritten: 0,
        skipped:
          "No cron jobs in this host: scheduled tasks carry a free-text prompt and no skill reference, so there is nothing to rewrite.",
      },
      memory_tidy: input.memoryTidy,
      backup: input.backup,
      llm_final: "",
      llm_summary:
        "llm: skipped (this host runs the deterministic pass only; no consolidation fork exists here)",
      llm_error: null,
      tool_calls: [],
      error: input.error,
      entries,
    };
  };

  /**
   * One pass with the gates already open: state first, then the snapshot, the
   * curation, retention, and the report — and the state put back if the pass
   * failed, so a failure keeps its next-tick retry.
   */
  const pass = async (input: {
    host: CuratorHost;
    config: CuratorConfig;
    trigger: "automatic" | "manual";
    dryRun: boolean;
  }): Promise<CuratorRunOutcome> => {
    const { host, config, trigger, dryRun } = input;
    const dataDir = options.dataDir();
    const startedAt = now();
    const previous = { lastRunAt: config.lastRunAt, runCount: config.runCount };
    let stateWritten = false;
    if (!dryRun) {
      try {
        // Recorded before a document moves: a crash mid-pass still says a run
        // happened, which is what Hermes does and what keeps a boot loop from
        // retrying a pass that never finishes.
        await host.call("settings.set", {
          [CURATOR_LAST_RUN_SETTING]: startedAt,
          [CURATOR_RUN_COUNT_SETTING]: previous.runCount + 1,
        });
        stateWritten = true;
      } catch (error) {
        options.log("warn", "curator.state_failed", { error: String(error) });
      }
    }

    const policy = {
      staleAfterDays: config.staleAfterDays,
      archiveAfterDays: config.archiveAfterDays,
    };
    let before: SkillCurationReport | null = null;
    let after: SkillCurationReport | null = null;
    let backup: CuratorRunReport["backup"] = null;
    let errorText: string | null = null;
    try {
      // The dry run is the "before" picture *and* the root the snapshot needs:
      // the host is the only thing that knows where a library lives.
      const planned = await host.call<{ report: SkillCurationReport; root?: string }>(
        "skills.curate",
        { ...policy, dryRun: true },
      );
      before = planned?.report ?? null;
      const skillsRoot = planned?.root;
      if (!dryRun && config.backupEnabled) {
        backup = skillsRoot
          ? ((await snapshotSkillLibrary({
              skillsRoot,
              backupsDir: curatorBackupsRoot(dataDir),
              keep: config.backupKeep,
              reason: `pre-curator-run (${trigger})`,
              at: now(),
            })) ?? { error: "snapshot could not be written" })
          : { error: "host did not report the skill library root" };
        if (backup && "error" in backup) {
          // Safety netting that cannot be raised must not stop the pass.
          options.log("warn", "curator.backup_failed", { error: backup.error });
        }
      }
      if (!dryRun) {
        const applied = await host.call<{ report: SkillCurationReport }>("skills.curate", {
          ...policy,
          dryRun: false,
        });
        after = applied?.report ?? null;
      }
    } catch (error) {
      errorText = curatorErrorMessage(error);
      // Archiving is a move, and a move that failed moved nothing: the next
      // tick retries it.
      options.log("warn", "curator.auto_failed", { trigger, error: errorText });
    }
    // Retention has its own failure path: one broken pass must not cost the other.
    const memoryTidy = await tidyMemories(host);

    const report = buildReport({
      trigger,
      dryRun,
      startedAt,
      durationSeconds: (now() - startedAt) / 1000,
      config,
      before,
      after,
      backup,
      memoryTidy,
      error: errorText,
    });
    // Best-effort: a report that cannot be written is a missing record, not a
    // failed pass.
    const paths = await writeCuratorRunReport({ dataDir, report, at: startedAt }).catch(() => null);

    if (errorText) {
      if (!dryRun && stateWritten) {
        // Nothing moved, so the cadence must not move either.
        const restore: Record<string, unknown> = { [CURATOR_RUN_COUNT_SETTING]: previous.runCount };
        if (typeof previous.lastRunAt === "number") {
          restore[CURATOR_LAST_RUN_SETTING] = previous.lastRunAt;
        }
        await host.call("settings.set", restore).catch((error: unknown) => {
          options.log("warn", "curator.state_restore_failed", { error: String(error) });
        });
      }
      return { ran: false, reason: "failed", report, paths, error: errorText };
    }

    if (!dryRun && paths) {
      await host
        .call("settings.set", { [CURATOR_LAST_REPORT_SETTING]: paths.directory })
        .catch(() => undefined);
    }
    options.log("info", "curator.auto_applied", {
      trigger,
      dryRun,
      archived: report.counts.archived_this_run,
      archivedIds: report.archived,
      skillsScanned: report.counts.before,
      runCount: dryRun ? config.runCount : previous.runCount + 1,
      reportPath: paths?.directory ?? null,
    });
    return { ran: true, reason: "completed", report, paths };
  };

  /**
   * One attempt. Safe to call on every tick: it returns immediately unless every
   * gate is open, and it never throws — a failed pass is a skipped pass, and a
   * skipped pass must never break the tick that called it.
   */
  const attempt = async (
    trigger: "automatic" | "manual",
    dryRun: boolean,
  ): Promise<CuratorRunOutcome> => {
    if (running) return { ran: false, reason: "running" };
    const host = options.getHost();
    if (!host) return { ran: false, reason: "no-host" };
    if (isBusy()) {
      // A turn is mid-flight. Today's answer is "not now", and the idle clock
      // restarts from here: curation moves documents, and pulling one out from
      // under a turn that is reading it is not a maintenance decision.
      lastBusyAt = now();
      if (trigger === "automatic") return { ran: false, reason: "busy" };
    }

    let settings: Record<string, unknown>;
    try {
      settings = await readSettings(host);
    } catch (error) {
      options.log("warn", "curator.auto_failed", { trigger, error: String(error) });
      return { ran: false, reason: "failed", error: curatorErrorMessage(error) };
    }
    const config = resolveCuratorConfig(settings);

    if (trigger === "automatic") {
      if (!config.enabled) return { ran: false, reason: "disabled" };
      if (config.paused) return { ran: false, reason: "paused" };
      const startedAt = now();
      if (config.lastRunAt === null) {
        // First sight: seed and defer one interval. Hermes does the same, and it
        // is what keeps a fresh install or an update from rewriting a library
        // nobody has seen the curator touch.
        try {
          await host.call("settings.set", { [CURATOR_LAST_RUN_SETTING]: startedAt });
        } catch (error) {
          options.log("warn", "curator.seed_failed", { error: String(error) });
        }
        options.log("info", "curator.seeded", { lastRunAt: startedAt });
        return { ran: false, reason: "seeded" };
      }
      // A future timestamp means the clock moved; it still counts as not due.
      if (startedAt - config.lastRunAt < config.intervalHours * HOUR_MS) {
        return { ran: false, reason: "interval" };
      }
      if (idleMs() < config.minIdleHours * HOUR_MS) return { ran: false, reason: "idle" };
    }

    running = true;
    try {
      const dataDir = options.dataDir();
      if (!(await acquireCuratorLock(dataDir, { now }))) {
        return { ran: false, reason: "locked" };
      }
      try {
        return await pass({ host, config, trigger, dryRun });
      } finally {
        await releaseCuratorLock(dataDir);
      }
    } catch (error) {
      options.log("warn", "curator.auto_failed", { trigger, error: String(error) });
      return { ran: false, reason: "failed", error: curatorErrorMessage(error) };
    } finally {
      running = false;
    }
  };

  /** The scheduled tick's entry point: the gates apply, nothing is thrown. */
  const run = (): Promise<CuratorRunOutcome> => attempt("automatic", false);

  /**
   * The user's explicit run (`curator.run`). The gates do not apply — the click
   * *is* the interval — but the lock does, and a dry run changes nothing: no
   * state write, no snapshot, only `skills.curate` in its own dry-run mode.
   */
  const runNow = (request: { dryRun?: boolean } = {}): Promise<CuratorRunOutcome> =>
    attempt("manual", request.dryRun === true);

  const status = async (): Promise<CuratorStatus> => {
    const host = options.getHost();
    if (!host) throw new Error("host unavailable");
    const config = resolveCuratorConfig(await readSettings(host));
    const { backupEnabled: _backupEnabled, backupKeep: _backupKeep, ...visible } = config;
    return visible;
  };

  /** Stop or resume the automatic pass. A pause never cancels a run in flight. */
  const setPaused = async (paused: boolean): Promise<CuratorStatus> => {
    if (typeof paused !== "boolean") throw new Error("curatorPaused must be a boolean");
    const host = options.getHost();
    if (!host) throw new Error("host unavailable");
    await host.call("settings.set", { [CURATOR_PAUSED_SETTING]: paused });
    options.log("info", paused ? "curator.paused" : "curator.resumed", {});
    return status();
  };

  return { run, runNow, status, setPaused };
}

export type CuratorMaintenance = ReturnType<typeof createCuratorMaintenance>;
