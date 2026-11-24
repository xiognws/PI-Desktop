/**
 * Verdict for a run that has already ended: why did the previous launch stop?
 *
 * The app already leaves several independent traces of a run — the run marker
 * (`run-marker.ts`), deliberate `app.exit()` reasons (`exit-reasons.log`),
 * Crashpad minidumps (`crash-report.ts`), and the lifecycle records in the
 * NDJSON log — but each one answers a different part of the question and the
 * reader has to correlate timestamps by hand to decide whether the app was
 * closed, crashed, or killed. On Windows the answer is not even in the traces
 * by default: ending the task in Task Manager writes no minidump and throws no
 * JavaScript error, so the only evidence is "the marker was still there".
 *
 * This module turns those traces into one closed verdict plus the evidence it
 * used, so the boot log carries a single `previousRunVerdict` record that states
 * clean / deliberate / crash / killed / unknown together with the reason. It is
 * pure: the caller reads the filesystem and passes in what it found. Nothing
 * here decides to act on the verdict — reporting is diagnostics only (D602).
 */

/**
 * Closed set of ways a run can end.
 *
 * - `clean` — the confirmed-quit path ran and the marker was cleared.
 * - `deliberate` — the app chose to terminate before the quit path (storage
 *   recovery, a failing boot). The reason is recorded, so this is not a crash.
 * - `crash` — a Chromium process dump or a main-process throw explains the stop.
 * - `killed` — the process disappeared with no crash evidence: a kill, an
 *   unresponsive-process termination, or a power loss.
 * - `unknown` — the run left a marker but nothing says why; kept distinct from
 *   `killed` because a silenced observer should not read as a confirmed kill.
 */
export type PreviousRunOutcome =
  | "clean"
  | "deliberate"
  | "crash"
  | "killed"
  | "unknown";

/** Which trace the verdict rests on, for a reader who wants the raw record. */
export type PreviousRunEvidence =
  | "run-marker"
  | "exit-reason"
  | "crash-dump"
  | "app-log";

export type PreviousRunInput = {
  /** The marker file from the previous launch, or null when it was cleared. */
  marker: { pid: number; startedAt: string; version: string; lastSeenAt?: string } | null;
  /** `exit-reasons.log` tail: the most recent deliberate `app.exit()` reason. */
  lastExitReason: { at: string; reason: string } | null;
  /**
   * Crashpad dumps written after the previous launch began, split by the
   * process whose death produced them. A browser/main dump means the whole app
   * died; a renderer or utility dump only means a child did.
   */
  newCrashDumps: { main: number; renderer: number; gpu: number; utility: number };
  /**
   * Whether the app log holds a fatal main-process record (an
   * `uncaughtException` / `unhandledRejection` at error level) stamped after
   * the previous launch began. Read by the caller, which owns the log file.
   */
  mainProcessErrorSinceStart: boolean;
  /**
   * This process's own pid, so a marker it wrote itself is never read as a
   * previous run. `entry.ts` claims the breadcrumb before the composition root
   * exists; a caller that reads the file afterwards gets this run's marker, and
   * without this guard every healthy start reports the one outcome that is never
   * actionable: `killed`.
   */
  selfPid?: number;
};

export type PreviousRunVerdict = {
  outcome: PreviousRunOutcome;
  evidence: PreviousRunEvidence[];
  /** One-line human summary; the log record carries this as its message. */
  summary: string;
  /** Structured fields for the log record's `data`. */
  detail: Record<string, unknown>;
};

function countDumps(
  dumps: PreviousRunInput["newCrashDumps"],
): number {
  return dumps.main + dumps.renderer + dumps.gpu + dumps.utility;
}

/**
 * Decide how the previous run ended.
 *
 * Precedence is chosen so the verdict states the *most specific* cause known,
 * not the most alarming one: a deliberate exit explains the marker being left
 * behind, so it outranks the absence of a crash; an actual dump or a main
 * throw outranks "no clean quit" because it names the mechanism.
 *
 * Order: no marker → clean; a main/browser dump or a fatal main-process record
 * → crash; a deliberate exit reason → deliberate; a marker with nothing else →
 * killed, which covers a kill, an unresponsive-process termination, or a power
 * loss. `unknown` is reserved for a caller that could read no evidence at all.
 */
export function judgePreviousRun(input: PreviousRunInput): PreviousRunVerdict {
  const { marker, lastExitReason, newCrashDumps, mainProcessErrorSinceStart, selfPid } =
    input;

  // A marker this process wrote is not a previous run. Reading it back is the
  // one way this module could ever call a healthy process `killed`, so the guard
  // sits before every other rule and reports the same "nothing died" verdict as
  // an absent marker.
  if (marker && selfPid !== undefined && marker.pid === selfPid) {
    return {
      outcome: "clean",
      evidence: [],
      summary: "no previous run recorded",
      detail: {},
    };
  }

  if (!marker) {
    return {
      outcome: "clean",
      evidence: ["run-marker"],
      summary: "previous run ended with a graceful quit",
      detail: {},
    };
  }

  const evidence: PreviousRunEvidence[] = ["run-marker"];
  const detail: Record<string, unknown> = {
    pid: marker.pid,
    startedAt: marker.startedAt,
    version: marker.version,
    // The heartbeat's last beat: it turns "it died somewhere in this run" into a
    // bounded window a reader can line up against an OS event or a user's account.
    ...(marker.lastSeenAt ? { lastSeenAt: marker.lastSeenAt } : {}),
  };

  // A dump from the browser process, or a fatal record from the main process,
  // is the app itself dying — that is a crash whatever else is on disk.
  if (newCrashDumps.main > 0 || mainProcessErrorSinceStart) {
    if (newCrashDumps.main > 0) evidence.push("crash-dump");
    if (mainProcessErrorSinceStart) evidence.push("app-log");
    detail.newCrashDumps = newCrashDumps;
    detail.mainProcessError = mainProcessErrorSinceStart;
    const cause = newCrashDumps.main > 0 ? "crash dump" : "main-process error";
    return {
      outcome: "crash",
      evidence,
      summary: `previous run crashed (${cause}; pid ${marker.pid})`,
      detail,
    };
  }

  // The app ended on purpose through a path that records why. Still not a
  // graceful quit, but nothing was lost to an unexplained death either.
  if (lastExitReason) {
    evidence.push("exit-reason");
    detail.deliberateExitAt = lastExitReason.at;
    detail.deliberateExitReason = lastExitReason.reason;
    return {
      outcome: "deliberate",
      evidence,
      summary: `previous run exited deliberately at ${lastExitReason.at}: ${lastExitReason.reason}`,
      detail,
    };
  }

  // No dump at all, but the marker survived: the process vanished. A child
  // dump does not explain the main process leaving, so it is recorded as
  // context rather than promoted into the verdict.
  const childDumps = countDumps(newCrashDumps);
  if (childDumps > 0) {
    evidence.push("crash-dump");
    detail.newCrashDumps = newCrashDumps;
  }
  return {
    outcome: "killed",
    evidence,
    summary: `previous run ended without a graceful quit (pid ${marker.pid}, started ${marker.startedAt}, version ${marker.version})`,
    detail,
  };
}

/** Level the verdict is logged at: only a crash is an error. */
export function previousRunVerdictLevel(
  verdict: PreviousRunVerdict,
): "info" | "warn" | "error" {
  if (verdict.outcome === "crash") return "error";
  if (verdict.outcome === "clean") return "info";
  return "warn";
}
