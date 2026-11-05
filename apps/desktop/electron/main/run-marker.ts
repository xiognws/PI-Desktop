import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { localTimestamp } from "./log-timestamp.js";

/**
 * Breadcrumb for the run that is currently starting.
 *
 * A graceful quit logs `app shutdown` and deletes this file. A run that ends any
 * other way — native crash, hard kill, an `app.exit()` on a fatal path — leaves
 * it behind, so the next start can report what the previous one was instead of
 * leaving "why did it disappear" to guesswork. Nothing else in the app can tell
 * those two apart: a killed process writes no shutdown line and, when the crash
 * is not a Chromium one, leaves no dump either.
 */
export type RunMarker = {
  pid: number;
  /** Local time with the machine's offset, matching the log stamps. */
  startedAt: string;
  version: string;
};

const RUN_MARKER_FILE = "run-marker.json";

/**
 * Directory the marker lives in. Set once during boot so the quit path, which
 * has no data directory of its own, can clear it without extra plumbing.
 */
let markerDirectory: string | null = null;

export function runMarkerPath(directory: string): string {
  return join(directory, RUN_MARKER_FILE);
}

export function setRunMarkerDirectory(directory: string): void {
  markerDirectory = directory;
}

/** Parse a stored marker; anything unusable reads as "no marker". */
export function parseRunMarker(raw: string): RunMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<RunMarker>;
  if (typeof candidate.pid !== "number" || !Number.isFinite(candidate.pid)) return null;
  if (typeof candidate.startedAt !== "string" || candidate.startedAt === "") return null;
  return {
    pid: candidate.pid,
    startedAt: candidate.startedAt,
    version: typeof candidate.version === "string" ? candidate.version : "unknown",
  };
}

export function readRunMarker(): RunMarker | null {
  if (!markerDirectory) return null;
  const file = runMarkerPath(markerDirectory);
  if (!existsSync(file)) return null;
  try {
    return parseRunMarker(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Best effort: losing the breadcrumb must never stop the app from starting. */
export function writeRunMarker(version: string): void {
  if (!markerDirectory) return;
  try {
    mkdirSync(markerDirectory, { recursive: true });
    writeFileSync(
      runMarkerPath(markerDirectory),
      JSON.stringify({ pid: process.pid, startedAt: localTimestamp(), version } satisfies RunMarker),
      "utf8",
    );
  } catch {
    // A read-only data directory already fails loudly elsewhere.
  }
}

/** Called once the quit is confirmed; a later start must not report this run. */
export function clearRunMarker(): void {
  if (!markerDirectory) return;
  try {
    rmSync(runMarkerPath(markerDirectory), { force: true });
  } catch {
    // Same reasoning as writeRunMarker.
  }
}

/**
 * One line for the boot log, or null when the previous run ended cleanly.
 *
 * The pid matters: it lets the reader match the death against the process list
 * or a crash dump recorded around the same time.
 */
export function describeUnfinishedRun(previous: RunMarker | null): string | null {
  if (!previous) return null;
  return `previous run ended without a graceful quit (pid ${previous.pid}, started ${previous.startedAt}, version ${previous.version})`;
}

/**
 * Paths that terminate the process on purpose, before any window exists.
 *
 * They run too early for the file logger (its directory may not exist yet) and
 * they are the one class of exit this app chooses deliberately, so they get
 * their own single-line record: without it an `app.exit()` death looks exactly
 * like a hard kill on the next start.
 */
export function recordExitReason(reason: string): void {
  if (!markerDirectory) return;
  try {
    mkdirSync(markerDirectory, { recursive: true });
    appendFileSync(
      join(markerDirectory, "exit-reasons.log"),
      `${localTimestamp()} ${reason}\n`,
      "utf8",
    );
  } catch {
    // Nothing to do: the caller is already leaving.
  }
}

/** The most recent deliberate exit, for the next start's boot line. */
export function readLastExitReason(): { at: string; reason: string } | null {
  if (!markerDirectory) return null;
  try {
    const file = join(markerDirectory, "exit-reasons.log");
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const space = last.indexOf(" ");
    if (space <= 0) return null;
    return { at: last.slice(0, space), reason: last.slice(space + 1) };
  } catch {
    return null;
  }
}

