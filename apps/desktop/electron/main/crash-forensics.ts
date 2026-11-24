/**
 * What is left of a crash that produced no dump.
 *
 * The verdict states *that* a run ended badly; a Crashpad minidump would state
 * where. On a machine whose build ships no `chrome_crashpad_handler.exe` — which
 * is every Windows build today, and the diagnostics log says so at every boot —
 * there is no dump, and the answer to "why did it disappear" has to come from
 * something else. Three traces survive a hard death and are worth one file each:
 *
 *   1. a renderer or utility process that died while the app was up
 *      (`render-process-gone`: reason and exit code),
 *   2. a child process that died in the same window (host-core, agent sidecar:
 *      exit code, signal, stderr tail),
 *   3. the previous run's own log, which is on disk even when the process that
 *      wrote it is gone — the last lines before it vanished bound *what it was
 *      doing* to the second.
 *
 * Reports are diagnostics, never a decision: they are written under
 * `<dataDir>/crash-dumps/forensics`, bounded in size and count, and a failure to
 * write one is logged and dropped. Nothing here may block the first window
 * (D602) or turn a recoverable exit into a fatal one.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { crashDumpsDirectory, listCrashDumps } from "./crash-report.js";
import { readLogTail } from "./logger.js";
import { localTimestamp } from "./log-timestamp.js";

/** Subdirectory of `crash-dumps` that holds the dump-less reports. */
export const CRASH_FORENSICS_DIR_NAME = "forensics";

/** Reports kept on disk; the oldest is dropped first. */
export const CRASH_FORENSICS_KEEP = 20;

/** Log lines a report carries. Enough for a screenful of context, not a transcript. */
export const CRASH_FORENSICS_TAIL_LINES = 100;

/**
 * The three moments worth a report.
 *
 * `previous-run-vanished` is the only one written after the fact: the process
 * that died could not write anything, so the next launch writes it from the
 * verdict plus the previous run's log.
 */
export type CrashForensicsKind =
  | "previous-run-vanished"
  | "renderer-gone"
  | "child-exited";

export type CrashForensicsLogger = (
  level: "info" | "warn",
  message: string,
  fields?: unknown,
) => void;

export function crashForensicsDirectory(dataDir: string): string {
  return join(crashDumpsDirectory(dataDir), CRASH_FORENSICS_DIR_NAME);
}

/** A filename-safe stamp; the log's own stamp carries `:` and `+`. */
function fileStamp(date: Date = new Date()): string {
  return localTimestamp(date).replace(/[^0-9A-Za-z.-]/g, "-");
}

/**
 * Whether a run that ended this way still needs a report written on its behalf.
 *
 * Only a `killed` verdict does: `crash` already has a dump or a fatal record,
 * `deliberate` recorded its own reason, and `clean` lost nothing. The count is
 * the *main* dump count — a renderer dump explains a child, not the app leaving.
 */
export function missingDumpForensicsWanted(
  outcome: string,
  mainDumpCount: number,
): boolean {
  return outcome === "killed" && mainDumpCount === 0;
}

export type CrashForensicsInput = {
  kind: CrashForensicsKind;
  /** Structured facts a reader needs; never free-form prose. */
  detail: Record<string, unknown>;
  /** Override the tail length (tests use a smaller window). */
  maxTailLines?: number;
};

/**
 * Write one report and return its path, or `null` when it could not be written.
 *
 * The tail is read here rather than passed in, so a caller only has to say what
 * happened: the app's own log tree is the one source that exists in every case,
 * including the one where the caller is the next launch.
 */
export function writeCrashForensicsReport(
  dataDir: string,
  input: CrashForensicsInput,
  logger?: CrashForensicsLogger,
): string | null {
  const directory = crashForensicsDirectory(dataDir);
  try {
    mkdirSync(directory, { recursive: true });
    const at = localTimestamp();
    const path = join(directory, `${fileStamp()}-${input.kind}.json`);
    const report = {
      at,
      kind: input.kind,
      pid: process.pid,
      // The dump list is recorded even when it is empty: "we looked and there was
      // nothing" is a different statement from "nobody looked".
      dumps: listCrashDumps(crashDumpsDirectory(dataDir), 20),
      detail: input.detail,
      logTail: readLogTail(dataDir, {
        maxLines: input.maxTailLines ?? CRASH_FORENSICS_TAIL_LINES,
      }),
    };
    writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`, "utf8");
    pruneCrashForensics(dataDir, CRASH_FORENSICS_KEEP);
    logger?.("warn", "crash forensics report written", { kind: input.kind, path });
    return path;
  } catch (error) {
    // Diagnostics must never be the reason a start fails or a crash is hidden.
    logger?.("info", "crash forensics report failed", String(error));
    return null;
  }
}

/** Keep the newest `keep` reports; a report tree must not grow without bound. */
export function pruneCrashForensics(dataDir: string, keep: number = CRASH_FORENSICS_KEEP): void {
  const directory = crashForensicsDirectory(dataDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  // The stamp prefix sorts as time, so a plain sort is newest-last.
  names.sort();
  for (const name of names.slice(0, names.length - keep)) {
    try {
      rmSync(join(directory, name), { force: true });
    } catch {
      // A report that cannot be dropped is not worth failing over.
    }
  }
}
