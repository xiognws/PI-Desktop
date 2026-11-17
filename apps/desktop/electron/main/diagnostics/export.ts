/**
 * The diagnostics export: collect what a support conversation needs, zip it, and
 * write it where the user says.
 *
 * The bundle's contents are decided in `bundle.ts`; this module is the half that
 * needs live state — the log tree, the crash-dump directory, the counts the local
 * service can answer — and it takes all of that as input so the flow itself can
 * be tested without Electron, a host process, or the user's data directory.
 *
 * Nothing here picks up message text. Counts are what an installation *holds*,
 * not what it says, and that is the most a bundle may report about a
 * conversation (see the rule in `bundle.ts`).
 */
import { writeFile } from "node:fs/promises";

import { crashDumpsDirectory, listCrashDumps } from "../crash-report.ts";
import { readLogTail } from "../logger.ts";
import { bundleFiles, buildZip } from "./bundle.ts";

/** The host RPC surface this needs: one call, nothing else. */
export type HostCaller = {
  call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
};

/**
 * Where the counts come from. These are the list calls the app already makes;
 * naming them after what they count keeps the summary readable to someone who
 * does not know the schema.
 */
const COUNT_SOURCES: readonly { key: string; method: string; params?: unknown }[] = [
  { key: "sessions", method: "session.list" },
  { key: "projects", method: "projects.list" },
  { key: "providers", method: "providers.list" },
  { key: "plugins", method: "plugins.list" },
  { key: "skills", method: "skills.list", params: { level: "user" } },
  { key: "mcpServers", method: "mcp.list", params: { level: "user" } },
  { key: "subagents", method: "agents.list" },
];

/** A count that takes longer than this is a broken service, not a slow one. */
const COUNT_TIMEOUT_MS = 5_000;

/** How many crash dumps a bundle names; the newest are the interesting ones. */
const CRASH_DUMP_LIMIT = 20;

/** The listed rows of a `*.list` reply, whatever the reply named the array. */
function listLength(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(entry)) return entry.length;
  }
  return null;
}

export type DiagnosticsCounts = {
  counts: Record<string, number>;
  /** Anything a reader needs in order to trust the counts, in plain language. */
  notes: string[];
};

/**
 * Ask the local service what this installation holds.
 *
 * A list call that fails is not fatal — a bundle missing one count is still
 * worth sending — so the failure becomes a note in the summary instead of an
 * exception. It is recorded rather than dropped: a reader must be able to tell
 * "no sessions" from "could not ask".
 */
export async function readCounts(host: HostCaller | null): Promise<DiagnosticsCounts> {
  if (!host) {
    return {
      counts: {},
      notes: ["counts unavailable: the app's local service is not running"],
    };
  }
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  for (const source of COUNT_SOURCES) {
    let length: number | null = null;
    try {
      length = listLength(await host.call(source.method, source.params, COUNT_TIMEOUT_MS));
    } catch {
      length = null;
    }
    if (length === null) notes.push(`count unavailable: ${source.key}`);
    else counts[source.key] = length;
  }
  return { counts, notes };
}

export type DiagnosticsExportDeps = {
  dataDir: string;
  appVersion: string;
  /** `process.platform` plus `process.arch`, as the report should state it. */
  platform: string;
  readCounts: () => Promise<DiagnosticsCounts>;
  /** Ask the user where the bundle goes; `null` means they cancelled. */
  chooseTarget: (suggestedName: string) => Promise<string | null>;
  /** Injected point so a test can capture the bytes instead of writing them. */
  writeBundle?: (path: string, bytes: Buffer) => Promise<void>;
  now?: () => Date;
  logTail?: (dataDir: string) => string[];
  crashDumps?: (dataDir: string) => string[];
};

export type DiagnosticsExportResult =
  | { ok: true; path: string; files: number; bytes: number }
  | { ok: false; reason: "canceled" };

/** `pi-diagnostics-20261117-143005.zip`: sortable, and obvious in a folder. */
export function bundleFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pi-diagnostics-${date}-${time}.zip`;
}

function defaultCrashDumps(dataDir: string): string[] {
  return listCrashDumps(crashDumpsDirectory(dataDir), CRASH_DUMP_LIMIT);
}

/**
 * Build the bundle and write it to the chosen path.
 *
 * Collection runs before the save dialog opens: the dialog is modal, and a user
 * who is looking at a file picker should not be waiting on log reads behind it.
 */
export async function exportDiagnosticsBundle(
  deps: DiagnosticsExportDeps,
): Promise<DiagnosticsExportResult> {
  const generated = (deps.now ?? (() => new Date()))();
  const { counts, notes } = await deps.readCounts();
  const files = bundleFiles(
    {
      appVersion: deps.appVersion,
      platform: deps.platform,
      dataDir: deps.dataDir,
      logLines: (deps.logTail ?? readLogTail)(deps.dataDir),
      crashDumps: (deps.crashDumps ?? defaultCrashDumps)(deps.dataDir),
      counts,
      notes,
    },
    generated,
  );

  const target = await deps.chooseTarget(bundleFileName(generated));
  if (!target) return { ok: false, reason: "canceled" };

  const bytes = buildZip(files);
  await (deps.writeBundle ?? writeFile)(target, bytes);
  return { ok: true, path: target, files: files.length, bytes: bytes.length };
}
