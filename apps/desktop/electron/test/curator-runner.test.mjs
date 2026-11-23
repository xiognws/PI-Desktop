/**
 * The curator's gates, its single-flight lock and the report it writes.
 *
 * Hermes' curator is what these rules are ported from (`agent/curator.py`:
 * `should_run_now`, `run_curator_review`); the fake host stands in for
 * host-core, so a tick can be driven by a frozen clock instead of a week of
 * wall time.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "..", "..", "test", "helpers", "ts-import-hooks.mjs")));

const {
  createCuratorMaintenance,
  resolveCuratorConfig,
  CURATOR_LAST_RUN_SETTING,
  CURATOR_RUN_COUNT_SETTING,
  CURATOR_LAST_REPORT_SETTING,
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_MIN_IDLE_HOURS,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_ARCHIVE_AFTER_DAYS,
} = await import("../main/runtime/curator-runner.ts");
const { acquireCuratorLock, releaseCuratorLock, snapshotSkillLibrary, curatorReportRoot } = await import(
  "../main/runtime/curator-report.ts"
);

const HOUR = 60 * 60 * 1000;
const BASE = Date.UTC(2026, 4, 1, 12, 0, 0);

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "curator-test-"));
  const dataDir = join(root, "data");
  const skillsRoot = join(root, "agents", "skills");
  mkdirSync(join(skillsRoot, "idle-skill"), { recursive: true });
  writeFileSync(join(skillsRoot, "idle-skill", "SKILL.md"), "# idle skill\n", "utf8");
  mkdirSync(join(skillsRoot, "fresh-skill"), { recursive: true });
  writeFileSync(join(skillsRoot, "fresh-skill", "SKILL.md"), "# fresh skill\n", "utf8");
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dataDir, skillsRoot };
}

function clock(start = BASE) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

const ENTRIES = [
  {
    id: "idle-skill",
    name: "idle-skill",
    level: "global",
    useCount: 0,
    lastActivityAt: BASE - 45 * 24 * HOUR,
    idleDays: 45,
    state: "archive",
  },
  {
    id: "stale-skill",
    name: "stale-skill",
    level: "global",
    useCount: 1,
    lastActivityAt: BASE - 20 * 24 * HOUR,
    idleDays: 20,
    state: "stale",
  },
  {
    id: "fresh-skill",
    name: "fresh-skill",
    level: "global",
    useCount: 3,
    lastActivityAt: BASE - 2 * 24 * HOUR,
    idleDays: 2,
    state: "keep",
  },
];

function fakeHost(options = {}) {
  const settings = { ...(options.settings ?? {}) };
  const calls = [];
  const logs = [];
  let curateInFlight = 0;
  let maxCurateInFlight = 0;
  const host = {
    settings,
    calls,
    logs,
    callsOf: (method) => calls.filter((entry) => entry.method === method),
    get maxCurateInFlight() {
      return maxCurateInFlight;
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "settings.get") return { ...settings };
      if (method === "settings.set") {
        Object.assign(settings, params ?? {});
        return { ...settings };
      }
      if (method === "skills.curate") {
        curateInFlight += 1;
        maxCurateInFlight = Math.max(maxCurateInFlight, curateInFlight);
        try {
          if (options.curateGate) await options.curateGate;
          if (options.curateError) throw new Error(options.curateError);
          if (params?.dryRun !== false) {
            return {
              report: { entries: ENTRIES, archived: [], dryRun: true, policy: null },
              root: options.skillsRoot,
            };
          }
          return {
            report: {
              entries: ENTRIES,
              archived: options.archived ?? ["idle-skill"],
              dryRun: false,
              policy: null,
            },
            root: options.skillsRoot,
          };
        } finally {
          curateInFlight -= 1;
        }
      }
      if (method === "memory.tidy") return { removed: 2, expired: 0, overflow: 0 };
      throw new Error(`unexpected host call: ${method}`);
    },
  };
  return host;
}

function maintenance(options) {
  return createCuratorMaintenance({
    getHost: options.getHost ?? (() => options.host),
    ...(options.isBusy ? { isBusy: options.isBusy } : {}),
    dataDir: () => options.dataDir,
    now: options.now,
    log: (level, message, data) => options.host.logs.push({ level, message, data }),
  });
}

test("the first tick seeds the timestamp and never curates", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({ skillsRoot });
  const curator = maintenance({ host, dataDir, now: time.now });

  const outcome = await curator.run();

  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "seeded", "a fresh install defers one interval");
  assert.equal(host.callsOf("skills.curate").length, 0, "the library was not looked at");
  assert.equal(host.settings[CURATOR_LAST_RUN_SETTING], BASE);
  assert.equal(host.settings[CURATOR_RUN_COUNT_SETTING], undefined, "seeding is not a run");
});

test("a tick younger than the interval does not run", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({
    skillsRoot,
    settings: { [CURATOR_LAST_RUN_SETTING]: BASE - (DEFAULT_INTERVAL_HOURS - 1) * HOUR },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  const outcome = await curator.run();

  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "interval");
  assert.equal(host.callsOf("skills.curate").length, 0);
});

test("a paused curator does not run even long past the interval", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({
    skillsRoot,
    settings: { [CURATOR_LAST_RUN_SETTING]: BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR, curatorPaused: true },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  const outcome = await curator.run();

  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "paused");
  assert.equal(host.callsOf("skills.curate").length, 0);
});

test("an app that has not been quiet long enough does not run", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({
    skillsRoot,
    settings: { [CURATOR_LAST_RUN_SETTING]: BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  time.advance((DEFAULT_MIN_IDLE_HOURS - 1) * HOUR);
  const early = await curator.run();
  assert.equal(early.ran, false);
  assert.equal(early.reason, "idle");
  assert.equal(host.callsOf("skills.curate").length, 0);

  // Past the quiet window the same tick runs.
  time.advance(2 * HOUR);
  const late = await curator.run();
  assert.equal(late.ran, true, `expected a run, got ${late.reason}`);
});

test("two instances in one process run the pass exactly once", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const host = fakeHost({
    skillsRoot,
    curateGate: gate,
    settings: { [CURATOR_LAST_RUN_SETTING]: BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR },
  });
  const first = maintenance({ host, dataDir, now: time.now });
  const second = maintenance({ host, dataDir, now: time.now });

  // Two managers for the same library is the real case: the boot tick and the
  // manual IPC each own an instance.
  const firstRun = first.runNow({});
  const secondRun = second.runNow({});
  release();
  const outcomes = await Promise.all([firstRun, secondRun]);

  const winners = outcomes.filter((outcome) => outcome.ran);
  assert.equal(winners.length, 1, "one pass, one writer");
  assert.deepEqual(
    outcomes.map((outcome) => outcome.reason).sort(),
    ["completed", "locked"],
  );
  assert.equal(host.maxCurateInFlight, 1, "curations never overlapped");
  // The winner planned and then applied; the loser never reached the host.
  assert.equal(host.callsOf("skills.curate").length, 2);
});

test("a dry run writes a report without advancing the schedule", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({
    skillsRoot,
    settings: {
      [CURATOR_LAST_RUN_SETTING]: BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR,
      [CURATOR_RUN_COUNT_SETTING]: 4,
    },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  const outcome = await curator.runNow({ dryRun: true });

  assert.equal(outcome.ran, true);
  assert.equal(host.settings[CURATOR_LAST_RUN_SETTING], BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR);
  assert.equal(host.settings[CURATOR_RUN_COUNT_SETTING], 4);
  assert.equal(host.callsOf("settings.set").length, 0, "a preview writes no preference");
  assert.equal(
    host.callsOf("skills.curate").every((call) => call.params.dryRun !== false),
    true,
    "the library was only ever asked, never changed",
  );
  assert.equal(existsSync(join(dataDir, "skills-backups")), false, "no snapshot for a preview");
  assert.ok(outcome.report.dry_run);
  assert.equal(outcome.report.counts.archived_this_run, 0);
});

test("a completed run records state, a snapshot and a full report", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const host = fakeHost({
    skillsRoot,
    settings: {
      [CURATOR_LAST_RUN_SETTING]: BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR,
      [CURATOR_RUN_COUNT_SETTING]: 2,
    },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  // Two hours of quiet is a gate, so the clock has to have moved since boot.
  time.advance(3 * HOUR);
  const outcome = await curator.run();
  assert.equal(outcome.ran, true, `expected a run, got ${outcome.reason}`);
  assert.equal(host.settings[CURATOR_LAST_RUN_SETTING], BASE + 3 * HOUR);
  assert.equal(host.settings[CURATOR_RUN_COUNT_SETTING], 3);

  const directory = host.settings[CURATOR_LAST_REPORT_SETTING];
  assert.equal(directory, outcome.paths.directory);
  assert.match(directory, /logs[\\/]curator[\\/]\d{8}-\d{6}$/);

  const report = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
  for (const key of [
    "started_at",
    "duration_seconds",
    "auto_transitions",
    "counts",
    "archived",
    "consolidated",
    "pruned",
    "pruned_names",
    "added",
    "state_transitions",
    "cron_rewrites",
    "llm_final",
    "llm_summary",
    "llm_error",
    "tool_calls",
  ]) {
    assert.ok(key in report, `run.json is missing ${key}`);
  }
  assert.equal(report.started_at, new Date(BASE + 3 * HOUR).toISOString());
  assert.deepEqual(report.archived, ["idle-skill"]);
  assert.deepEqual(report.pruned_names, ["idle-skill"]);
  assert.equal(report.counts.before, 3);
  assert.equal(report.counts.after, 2);
  assert.equal(report.counts.archived_this_run, 1);
  assert.equal(report.counts.pruned_this_run, 1);
  assert.equal(report.auto_transitions.checked, 3);
  assert.equal(report.auto_transitions.marked_stale, 1);
  assert.equal(report.auto_transitions.archived, 1);
  assert.equal(report.cron_rewrites.rewritten, 0);
  assert.match(report.cron_rewrites.skipped, /no cron jobs|No cron jobs/i);
  assert.equal(report.dry_run, false);
  assert.equal(report.trigger, "automatic");
  assert.equal(report.memory_tidy.removed, 2);
  assert.equal(report.backup.mode, "copy");
  assert.deepEqual(report.entries, ENTRIES);

  // The snapshot is a real copy of the library, with a manifest.
  const backupDir = join(dataDir, "skills-backups", report.backup.id);
  assert.ok(existsSync(join(backupDir, "skills", "idle-skill", "SKILL.md")));
  const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
  assert.equal(manifest.mode, "copy");
  assert.equal(manifest.files, 2);

  const markdown = readFileSync(join(directory, "REPORT.md"), "utf8");
  assert.match(markdown, /^# Curator run/);
  const order = ["Auto-transitions", "Pruned", "Cron job skill references rewritten", "## Summary"];
  let cursor = -1;
  for (const heading of order) {
    const at = markdown.indexOf(heading);
    assert.ok(at > cursor, `${heading} is missing or out of order`);
    cursor = at;
  }
  assert.match(markdown, /`idle-skill`/);
});

test("a failed pass keeps its retry: the timestamp goes back and the report says why", async (t) => {
  const { dataDir, skillsRoot } = workspace(t);
  const time = clock();
  const previous = BASE - 10 * DEFAULT_INTERVAL_HOURS * HOUR;
  const host = fakeHost({
    skillsRoot,
    curateError: "library unreadable",
    settings: { [CURATOR_LAST_RUN_SETTING]: previous, [CURATOR_RUN_COUNT_SETTING]: 1 },
  });
  const curator = maintenance({ host, dataDir, now: time.now });

  time.advance(3 * HOUR);
  const outcome = await curator.run();

  assert.equal(outcome.ran, false);
  assert.equal(outcome.reason, "failed");
  assert.equal(host.settings[CURATOR_LAST_RUN_SETTING], previous, "the next tick retries");
  assert.equal(host.settings[CURATOR_RUN_COUNT_SETTING], 1);
  const report = JSON.parse(readFileSync(join(outcome.paths.directory, "run.json"), "utf8"));
  assert.match(report.error, /library unreadable/);
  assert.ok(host.logs.some((entry) => entry.level === "warn" && entry.message === "curator.auto_failed"));
});

test("a lock left by a crashed pass is taken over, a live one is respected", async (t) => {
  const { dataDir } = workspace(t);

  assert.equal(await acquireCuratorLock(dataDir), true);
  assert.equal(await acquireCuratorLock(dataDir), false, "a live lock is respected");

  const lockFile = join(curatorReportRoot(dataDir), ".run.lock");
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(lockFile, stale, stale);
  assert.equal(await acquireCuratorLock(dataDir), true, "an hour-old lock belongs to a dead run");

  await releaseCuratorLock(dataDir);
  assert.equal(await acquireCuratorLock(dataDir), true);
  await releaseCuratorLock(dataDir);
});

test("snapshots keep only the newest two", async (t) => {
  const { skillsRoot } = workspace(t);
  const root = dirname(dirname(skillsRoot));
  const backupsDir = join(root, "skills-backups");

  for (const offset of [2 * HOUR, 1 * HOUR, 0]) {
    const record = await snapshotSkillLibrary({
      skillsRoot,
      backupsDir,
      keep: 2,
      reason: "test",
      at: BASE - offset,
    });
    assert.ok(record, "the snapshot was taken");
  }

  const kept = readdirSync(backupsDir).sort();
  assert.equal(kept.length, 2);
  assert.deepEqual(kept, [kept[kept.length - 2], kept[kept.length - 1]].sort());
});

test("defaults are Hermes'", () => {
  const config = resolveCuratorConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.paused, false);
  assert.equal(config.intervalHours, DEFAULT_INTERVAL_HOURS);
  assert.equal(config.minIdleHours, DEFAULT_MIN_IDLE_HOURS);
  assert.equal(config.staleAfterDays, DEFAULT_STALE_AFTER_DAYS);
  assert.equal(config.archiveAfterDays, DEFAULT_ARCHIVE_AFTER_DAYS);
  assert.equal(config.backupEnabled, true);
  assert.equal(config.backupKeep, 2);
  assert.equal(config.lastRunAt, null);
  assert.equal(config.runCount, 0);
  // A settings document written before a key existed must not read as "off".
  assert.equal(resolveCuratorConfig({ curateAutomatically: false }).enabled, false);
});
