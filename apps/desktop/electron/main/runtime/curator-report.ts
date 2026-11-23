/**
 * The curator's artefacts: the pre-run snapshot of the skill library, the
 * single-flight lock, and the per-run report (`run.json` + `REPORT.md`).
 *
 * Why these live here rather than in host-core: the host decides *what* is
 * stale (it owns the library and the ledger), but *when* a pass ran, what it
 * moved and where the evidence of it is kept are facts about this machine's
 * data directory. The host has no data-directory vocabulary for reports and no
 * business blocking on `fs`. So the runner decides and this module records.
 *
 * Ported from Hermes `agent/curator_backup.py` and `agent/curator.py`
 * (`_write_run_report`, `_render_report_markdown`), with these deviations:
 *
 * 1. **Snapshots are directory copies, not `skills.tar.gz`.** Hermes shells out
 *    to `tarfile`; this workspace has no archive dependency in any
 *    `package.json` and adding one means a new native/binary dependency that
 *    the internal registry may not serve. A recursive copy keeps the same
 *    recoverability with zero new surface, at the cost of disk. The manifest
 *    records `mode: "copy"` so a future tar-backed snapshot is distinguishable.
 * 2. **`.archive/` is included.** Hermes excludes it because its rollback swaps
 *    the live tree and an older `.archive/` would lose skills archived since.
 *    Nothing here rolls a snapshot back over a live library, so excluding the
 *    archive would only make the backup incomplete. `.git`, `.locks` and
 *    transient dependency directories are still skipped — they are not library
 *    content and they grow without bound.
 * 3. **No cron-job capture.** This repository has no cron concept (see the
 *    note in `curator-runner.ts`), so there is no jobs store to snapshot.
 */
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One directory per run, under `<dataDir>/logs/curator/`. */
export const CURATOR_REPORT_DIR = join("logs", "curator");
/** One directory per snapshot, under `<dataDir>/skills-backups/`. */
export const CURATOR_BACKUP_DIR = "skills-backups";
/** Single-flight lock, inside the report directory. */
export const CURATOR_LOCK_FILE = ".run.lock";
/**
 * A lock older than an hour belongs to a run that died without releasing it
 * (a crash, a killed process, a closed laptop). Hermes uses the same ceiling;
 * below it, a long curation pass is still merely slow.
 */
export const CURATOR_LOCK_STALE_MS = 60 * 60 * 1000;
/** How many snapshots survive a prune. */
export const DEFAULT_BACKUP_KEEP = 2;

/** Names that are never library content, at any depth. */
const SKIPPED_NAMES = new Set([
  ".git",
  ".locks",
  ".curator_backups",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
]);

const SNAPSHOT_ID = /^\d{8}T\d{6}Z(-\d{2})?$/;

export function curatorReportRoot(dataDir: string): string {
  return join(dataDir, CURATOR_REPORT_DIR);
}

export function curatorBackupsRoot(dataDir: string): string {
  return join(dataDir, CURATOR_BACKUP_DIR);
}

/** `YYYYMMDD-HHMMSS` in UTC — the run directory's name, and stable across machines. */
export function curatorStamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** `YYYYMMDDTHHMMSSZ` in UTC — a snapshot id that sorts lexicographically. */
export function curatorSnapshotId(at: number): string {
  return `${curatorStamp(at).replace("-", "T")}Z`;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EEXIST";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Single-flight lock ----------------------------------------------------

/**
 * Claim the pass for this process. Returns false when somebody else holds it.
 *
 * The in-memory flag in the runner covers two ticks of the same timer; this
 * covers everything the timer cannot see — a second maintenance instance (the
 * manual IPC registers one of its own), a second window of a dev build, or a
 * run still going when the app restarted. `wx` is O_CREAT|O_EXCL: the open
 * itself is the test, so two processes cannot both believe they won.
 */
export async function acquireCuratorLock(
  dataDir: string,
  options: { now?: () => number; staleMs?: number } = {},
): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const staleMs = options.staleMs ?? CURATOR_LOCK_STALE_MS;
  const root = curatorReportRoot(dataDir);
  try {
    await mkdir(root, { recursive: true });
  } catch {
    return false;
  }
  const file = join(root, CURATOR_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }), "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (!isExists(error)) return false;
      const info = await stat(file).catch(() => null);
      // Raced away between the failed open and the stat: try once more.
      if (!info) continue;
      if (now() - info.mtimeMs <= staleMs) return false;
      // A run that died holding it. Taking over is the whole point of the
      // ceiling: without it one crash would disable curation forever.
      await rm(file, { force: true });
    }
  }
  return false;
}

export async function releaseCuratorLock(dataDir: string): Promise<void> {
  await rm(join(curatorReportRoot(dataDir), CURATOR_LOCK_FILE), { force: true }).catch(() => undefined);
}

// --- Pre-run snapshot ------------------------------------------------------

export type CuratorBackupRecord = {
  id: string;
  /** Absolute directory holding the copy and its manifest. */
  path: string;
  /**
   * How the snapshot was taken. `copy` is the only mode this build produces;
   * a `tar.gz` mode would need an archive dependency this workspace does not
   * carry (see the module comment).
   */
  mode: "copy";
  reason: string;
  created_at: string;
  files: number;
  bytes: number;
  /** Snapshot ids removed by the retention rule after this one landed. */
  pruned: string[];
};

type CopyCounters = { files: number; bytes: number };

async function copyTree(source: string, target: string, counters: CopyCounters): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, counters);
    } else if (entry.isSymbolicLink()) {
      // A skill may link a shared reference. Copying the link would point the
      // snapshot at the live tree, which is exactly what a backup must not do.
      const resolved = await stat(from).catch(() => null);
      if (resolved?.isFile()) {
        await copyFile(from, to);
        counters.files += 1;
        counters.bytes += resolved.size;
      }
    } else if (entry.isFile()) {
      const info = await stat(from).catch(() => null);
      if (!info) continue;
      await copyFile(from, to);
      counters.files += 1;
      counters.bytes += info.size;
    }
  }
}

/**
 * Copy the skill library into a new timestamped snapshot, then apply the
 * retention rule. Returns null when there is nothing to copy or the copy
 * failed — a snapshot is safety netting, and netting that cannot be raised must
 * never stop the pass it is protecting.
 */
export async function snapshotSkillLibrary(options: {
  skillsRoot: string;
  backupsDir: string;
  keep?: number;
  reason: string;
  at: number;
}): Promise<CuratorBackupRecord | null> {
  const keep = Math.max(1, Math.trunc(options.keep ?? DEFAULT_BACKUP_KEEP));
  const root = await stat(options.skillsRoot).catch(() => null);
  if (!root?.isDirectory()) return null;

  const base = curatorSnapshotId(options.at);
  const existing = new Set(await readdir(options.backupsDir).catch(() => [] as string[]));
  // Two passes in one second must not clobber each other.
  let id = base;
  for (let suffix = 2; existing.has(id); suffix += 1) {
    id = `${base}-${String(suffix).padStart(2, "0")}`;
  }
  const directory = join(options.backupsDir, id);
  const counters: CopyCounters = { files: 0, bytes: 0 };
  try {
    await mkdir(directory, { recursive: true });
    await copyTree(options.skillsRoot, join(directory, "skills"), counters);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(
        {
          id,
          created_at: new Date(options.at).toISOString(),
          reason: options.reason,
          mode: "copy",
          source: options.skillsRoot,
          files: counters.files,
          bytes: counters.bytes,
          excluded: [...SKIPPED_NAMES].sort(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // A half-written snapshot would look restorable and would not be.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  return {
    id,
    path: directory,
    mode: "copy",
    reason: options.reason,
    created_at: new Date(options.at).toISOString(),
    files: counters.files,
    bytes: counters.bytes,
    pruned: await pruneSnapshots(options.backupsDir, keep, id),
  };
}

/** Delete every snapshot beyond the newest `keep`, never the one just written. */
async function pruneSnapshots(backupsDir: string, keep: number, protect: string): Promise<string[]> {
  const names = (await readdir(backupsDir).catch(() => [] as string[]))
    .filter((name) => SNAPSHOT_ID.test(name))
    .sort()
    .reverse();
  const pruned: string[] = [];
  for (const name of names.slice(keep)) {
    if (name === protect) continue;
    try {
      await rm(join(backupsDir, name), { recursive: true, force: true });
      pruned.push(name);
    } catch {
      // Retention is housekeeping; a stuck directory is reported, not thrown.
    }
  }
  return pruned;
}

// --- Run report ------------------------------------------------------------

/** One skill the pass moved into `.archive/`. */
export type CuratorPrunedEntry = { name: string; id: string; reason: string; idle_days: number };

/** One activation change the pass applied. */
export type CuratorStateTransition = { name: string; from: string; to: string; idle_days?: number };

export type CuratorRunCounts = {
  before: number;
  after: number;
  delta: number;
  archived_this_run: number;
  added_this_run: number;
  consolidated_this_run: number;
  pruned_this_run: number;
  state_transitions: number;
  cron_jobs_rewritten: number;
  tool_calls_total: number;
};

export type CuratorAutoTransitions = {
  checked: number;
  marked_stale: number;
  archived: number;
  reactivated: number;
  seeded: number;
};

/**
 * `run.json`. Field names are Hermes' (`agent/curator.py:723-736`), snake_case
 * on purpose: a report is evidence that may be compared with Hermes' own
 * reports, so a reader must not have to translate the keys.
 *
 * Fields Hermes fills from its LLM consolidation pass stay present and empty
 * here — this host has no consolidation fork, and a missing key would read as
 * "the pass forgot", not "the pass does not exist".
 */
export type CuratorRunReport = {
  started_at: string;
  duration_seconds: number;
  trigger: "automatic" | "manual";
  dry_run: boolean;
  auto_transitions: CuratorAutoTransitions;
  counts: CuratorRunCounts;
  policy: { stale_after_days: number; archive_after_days: number };
  archived: string[];
  consolidated: never[];
  pruned: CuratorPrunedEntry[];
  pruned_names: string[];
  added: string[];
  state_transitions: CuratorStateTransition[];
  cron_rewrites: { rewritten: number; skipped: string };
  memory_tidy: { removed: number; expired: number; overflow: number } | { error: string };
  backup: CuratorBackupRecord | { error: string } | null;
  llm_final: string;
  llm_summary: string;
  llm_error: string | null;
  tool_calls: never[];
  /** Non-null only when the pass itself failed after recording started. */
  error: string | null;
  /** Every skill the pass classified, in the order `skills.curate` reported them. */
  entries: unknown[];
};

const SECTION_CAP = 50;

function durationLabel(seconds: number): string {
  const whole = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes ? `${minutes}m ${whole % 60}s` : `${whole}s`;
}

function reasonSuffix(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  return trimmed ? ` — ${trimmed}` : "";
}

/** One line describing the pre-run snapshot, whatever its outcome was. */
function backupLabel(backup: CuratorRunReport["backup"]): string {
  if (backup === null) return "none (not requested)";
  if ("error" in backup) return `failed (${backup.error})`;
  const files = `${backup.files} file${backup.files === 1 ? "" : "s"}`;
  return `\`${backup.id}\` (${files}, mode ${backup.mode})`;
}

/**
 * The human-readable report. Section order is Hermes'
 * (`_REPORT_SECTIONS`, then the closing summary): a reader who has read one
 * curator report can read this one.
 */
export function renderCuratorReportMarkdown(report: CuratorRunReport): string {
  const counts = report.counts;
  const auto = report.auto_transitions;
  const lines: string[] = [
    `# Curator run — ${report.started_at}`,
    "",
    `Trigger: \`${report.trigger}\`${report.dry_run ? " (dry run — nothing was changed)" : ""}  ·  ` +
      `Duration: ${durationLabel(report.duration_seconds)}  ·  ` +
      `Agent-created skills: ${counts.before} → ${counts.after} (${counts.delta >= 0 ? "+" : ""}${counts.delta})`,
    "",
  ];
  if (report.error) lines.push(`> ⚠ Curator pass error: \`${report.error}\``, "");

  lines.push(
    "## Auto-transitions (pure, no LLM)",
    "",
    `- checked: ${auto.checked}`,
    `- marked stale: ${auto.marked_stale}`,
    `- archived (no LLM, pure time-based staleness): ${auto.archived}`,
    `- reactivated: ${auto.reactivated}`,
    "",
  );

  if (report.pruned.length) {
    lines.push(
      `### Pruned — archived for staleness (${report.pruned.length})`,
      "",
      "_These skills were moved to the library's `.archive/` without being merged into anything. " +
        "Nothing was deleted: the document is still on disk and the skills page can restore it._",
      "",
    );
    for (const entry of report.pruned.slice(0, SECTION_CAP)) {
      // The reason carries the idle days, so naming them twice reads as two facts.
      lines.push(`- \`${entry.name}\`${reasonSuffix(entry.reason)}`);
    }
    if (report.pruned.length > SECTION_CAP) {
      lines.push(`- … and ${report.pruned.length - SECTION_CAP} more (see \`run.json\`)`);
    }
    lines.push("");
  }

  const archivedOnly = report.archived.filter((id) => !report.pruned.some((entry) => entry.id === id));
  if (archivedOnly.length) {
    lines.push(`### Archived (${archivedOnly.length})`, "");
    for (const id of archivedOnly.slice(0, SECTION_CAP)) lines.push(`- \`${id}\``);
    lines.push("");
  }

  if (report.state_transitions.length) {
    lines.push(`### State transitions (${report.state_transitions.length})`, "");
    for (const transition of report.state_transitions.slice(0, SECTION_CAP)) {
      lines.push(`- \`${transition.name}\`: ${transition.from} → ${transition.to}`);
    }
    lines.push("");
  }

  lines.push("### Cron job skill references rewritten (0)", "", `_${report.cron_rewrites.skipped}_`, "");

  lines.push(
    "## Summary",
    "",
    `- archived: ${counts.archived_this_run}  ·  stale (reported, kept): ${auto.marked_stale}  ·  ` +
      `new skills: ${counts.added_this_run}  ·  consolidated: ${counts.consolidated_this_run}`,
    `- memory retention: ${
      "error" in report.memory_tidy
        ? `failed (${report.memory_tidy.error})`
        : `${report.memory_tidy.removed} removed, ${report.memory_tidy.expired} expired, ${report.memory_tidy.overflow} overflow`
    }`,
    `- pre-run snapshot: ${backupLabel(report.backup)}`,
    `- ${report.llm_summary}`,
    "",
  );
  return lines.join("\n");
}

export type CuratorReportPaths = { directory: string; runJsonPath: string; reportPath: string };

/**
 * Write `run.json` and `REPORT.md` into a fresh directory.
 *
 * Best-effort by design: a report is evidence, and evidence that cannot be
 * written must not turn a completed pass into a failed one. Returns null when
 * the directory could not be created.
 */
export async function writeCuratorRunReport(options: {
  dataDir: string;
  report: CuratorRunReport;
  at: number;
}): Promise<CuratorReportPaths | null> {
  const root = curatorReportRoot(options.dataDir);
  const stamp = curatorStamp(options.at);
  let directory = join(root, stamp);
  try {
    await mkdir(root, { recursive: true });
    // A re-run inside the same second (a crash retry, a manual run after an
    // automatic one) must not overwrite the earlier evidence.
    for (let suffix = 2; ; suffix += 1) {
      try {
        await mkdir(directory);
        break;
      } catch (error) {
        if (!isExists(error) || suffix > 99) throw error;
        directory = join(root, `${stamp}-${String(suffix).padStart(2, "0")}`);
      }
    }
    const runJsonPath = join(directory, "run.json");
    const reportPath = join(directory, "REPORT.md");
    await writeFile(runJsonPath, JSON.stringify(options.report, null, 2) + "\n", "utf8");
    await writeFile(reportPath, renderCuratorReportMarkdown(options.report), "utf8");
    return { directory, runJsonPath, reportPath };
  } catch {
    // Leave no empty directory behind that a reader would take for a report.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

/** Exported for the runner's log lines; keeps error rendering in one place. */
export function curatorErrorMessage(error: unknown): string {
  return message(error);
}
