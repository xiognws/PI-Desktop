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
  /**
   * The last time this run was known to be alive, refreshed on a heartbeat.
   *
   * `killed` is the verdict that says least: a run that vanished at boot and one
   * that vanished after three hours of work read identically, and the reader has
   * nothing to line up against a user's recollection or an OS event. A heartbeat
   * turns that into a bounded window. It is best-effort and absent on markers
   * written by older builds — a verifier must treat it as optional.
   */
  lastSeenAt?: string;
};

/** How often the marker is refreshed. Short enough to bound a death to a minute. */
export const RUN_MARKER_HEARTBEAT_MS = 15_000;

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
    ...(typeof candidate.lastSeenAt === "string" && candidate.lastSeenAt !== ""
      ? { lastSeenAt: candidate.lastSeenAt }
      : {}),
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
  if (!marker) marker = { pid: process.pid, startedAt: localTimestamp(), version };
  writeMarker(marker);
}

/** The identity of this run, kept so a heartbeat does not rewrite the start time. */
let marker: RunMarker | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

function writeMarker(next: RunMarker): void {
  if (!markerDirectory) return;
  try {
    mkdirSync(markerDirectory, { recursive: true });
    writeFileSync(runMarkerPath(markerDirectory), JSON.stringify(next), "utf8");
  } catch {
    // A read-only data directory already fails loudly elsewhere.
  }
}

/**
 * Refresh `lastSeenAt` while the run is alive.
 *
 * The timer is `unref`d: a heartbeat must never be the reason the process stays
 * up. Writing the same small file every 15 seconds costs one cached page.
 */
export function startRunMarkerHeartbeat(
  intervalMs: number = RUN_MARKER_HEARTBEAT_MS,
): void {
  if (!marker || heartbeat) return;
  const beat = () => {
    if (!marker) return;
    marker = { ...marker, lastSeenAt: localTimestamp() };
    writeMarker(marker);
  };
  beat();
  heartbeat = setInterval(beat, intervalMs);
  heartbeat.unref?.();
}

/** Stop the heartbeat. The marker itself is cleared by the quit path. */
export function stopRunMarkerHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** Called once the quit is confirmed; a later start must not report this run. */
export function clearRunMarker(): void {
  stopRunMarkerHeartbeat();
  marker = null;
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
  // "last seen" is the only witness a killed process leaves: it bounds the death
  // to the heartbeat interval instead of leaving it anywhere in the run.
  const seen = previous.lastSeenAt ? `, last seen ${previous.lastSeenAt}` : "";
  return `previous run ended without a graceful quit (pid ${previous.pid}, started ${previous.startedAt}${seen}, version ${previous.version})`;
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

