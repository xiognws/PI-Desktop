/**
 * The automatic maintenance tick, as the boot wiring calls it: the cadence, the
 * independent failure paths, and the log lines a user diagnoses from.
 *
 * The gates themselves (first-run seeding, pause, quiet window, single flight,
 * dry runs, the report and its snapshot) are covered by
 * `electron/test/curator-runner.test.mjs`; this file keeps the original
 * contract — one pass per interval, retention never costs the archive and the
 * archive never costs retention — on the new weekly cadence.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCuratorMaintenance, DEFAULT_INTERVAL_HOURS, DEFAULT_MIN_IDLE_HOURS } = await import(
  "../electron/main/runtime/curator-runner.ts"
);

const HOUR = 60 * 60 * 1000;
const INTERVAL = DEFAULT_INTERVAL_HOURS * HOUR;
/** Any fixed instant works; what matters is that the clock is ours. */
const NOW = 1_000 * INTERVAL;

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "curator-tick-"));
  const skillsRoot = join(root, "agents", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  writeFileSync(join(skillsRoot, "SKILL.md"), "# library\n", "utf8");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dataDir, skillsRoot };
}

function fakeHost({ settings = {}, archived = [], failCurate = false, tidy, failTidy = false, skillsRoot } = {}) {
  const calls = [];
  let stored = { ...settings };
  return {
    calls,
    get stored() {
      return stored;
    },
    async call(method, params) {
      calls.push([method, params]);
      if (method === "settings.get") return stored;
      if (method === "settings.set") {
        stored = { ...stored, ...params };
        return { ok: true };
      }
      if (method === "skills.curate") {
        if (failCurate) throw new Error("host unavailable");
        return { report: { archived, entries: [{}, {}], dryRun: params?.dryRun !== false }, root: skillsRoot };
      }
      if (method === "memory.tidy") {
        if (failTidy) throw new Error("memory store unavailable");
        return tidy ?? { removed: 0, expired: 0, overflow: 0 };
      }
      throw new Error(`unexpected host call: ${method}`);
    },
  };
}

function maintenanceFor(t, host, options = {}) {
  const { dataDir, skillsRoot } = workspace(t);
  host.skillsRoot = host.skillsRoot ?? skillsRoot;
  const clock = { value: NOW };
  const lines = [];
  const maintenance = createCuratorMaintenance({
    getHost: () => host,
    isBusy: () => false,
    dataDir: () => dataDir,
    now: () => clock.value,
    log: (level, message, data) => lines.push({ level, message, data }),
    ...options,
  });
  return { maintenance, lines, clock, dataDir };
}

const curateCalls = (host) => host.calls.filter(([method]) => method === "skills.curate");
const tidyCalls = (host) => host.calls.filter(([method]) => method === "memory.tidy");

/** Settings for an app that last curated long enough ago to be due. */
function dueSettings(extra = {}) {
  return { curatorLastRunAt: NOW - 2 * INTERVAL, ...extra };
}

test("an idle app runs the pass once an interval and records that it did", async (t) => {
  const host = fakeHost({ archived: ["idle-one"], settings: dueSettings() });
  const { maintenance, lines, clock } = maintenanceFor(t, host);
  // The quiet window starts at boot, so the clock has to have moved.
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();

  assert.equal(curateCalls(host).length, 2, "a plan, then the acting pass");
  assert.deepEqual(
    curateCalls(host)[0][1],
    { staleAfterDays: 14, archiveAfterDays: 30, dryRun: true },
    "the before-picture is a dry run: it classifies without moving anything",
  );
  assert.equal(curateCalls(host)[1][1].dryRun, false, "the automatic pass acts");
  assert.equal(host.stored.curatorLastRunAt, clock.value, "the run is recorded where settings live");
  assert.equal(host.stored.curatorRunCount, 1);
  const tidy = lines.find((entry) => entry.message === "memory.tidy_applied");
  assert.deepEqual(tidy.data, { removed: 0, expired: 0, overflow: 0 }, "retention rides the same tick");
  const applied = lines.find((entry) => entry.message === "curator.auto_applied");
  assert.equal(applied.data.archived, 1);
  assert.ok(applied.data.reportPath, "the report's directory is named in the log");

  // The next tick inside the interval is not a second pass.
  clock.value += HOUR;
  await maintenance.run();
  assert.equal(curateCalls(host).length, 2, "one pass an interval, not one per tick");
  assert.equal(tidyCalls(host).length, 1, "retention shares that cadence");
});

test("a run younger than the interval is skipped, and one interval old is due", async (t) => {
  // The clock has to clear the quiet window before any of this is due, so the
  // timestamps are measured from the moment the tick actually happens.
  const runAt = NOW + (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;
  const recent = fakeHost({ settings: { curatorLastRunAt: runAt - INTERVAL + 1 } });
  const first = maintenanceFor(t, recent);
  first.clock.value = runAt;
  await first.maintenance.run();
  assert.equal(curateCalls(recent).length, 0, "not due yet");
  assert.equal(tidyCalls(recent).length, 0, "retention is not due either");

  const due = fakeHost({ settings: { curatorLastRunAt: runAt - INTERVAL } });
  const second = maintenanceFor(t, due);
  second.clock.value = runAt;
  await second.maintenance.run();
  assert.equal(curateCalls(due).length, 2, "exactly an interval old is due");
  assert.equal(due.stored.curatorLastRunAt, second.clock.value);
});

test("the setting turns the automatic pass off, and off is the only thing that does", async (t) => {
  const off = fakeHost({ settings: dueSettings({ curateAutomatically: false }) });
  const offRun = maintenanceFor(t, off);
  offRun.clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;
  await offRun.maintenance.run();
  assert.equal(curateCalls(off).length, 0);
  assert.equal(tidyCalls(off).length, 0, "one switch covers both operations");
  assert.equal(
    off.stored.curatorLastRunAt,
    dueSettings().curatorLastRunAt,
    "nothing ran, nothing recorded",
  );

  // A settings document written before this preference existed reads as on.
  const unset = fakeHost({ settings: dueSettings() });
  const unsetRun = maintenanceFor(t, unset);
  unsetRun.clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;
  await unsetRun.maintenance.run();
  assert.equal(curateCalls(unset).length, 2, "absent means the default, which is on");
});

test("a running turn defers the pass without spending its run", async (t) => {
  const host = fakeHost({ settings: dueSettings() });
  let busy = true;
  const { maintenance, lines, clock } = maintenanceFor(t, host, { isBusy: () => busy });
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();
  assert.deepEqual(host.calls, [], "a busy app is not even asked");
  assert.deepEqual(lines, [], "no line for work that did not happen");

  busy = false;
  await maintenance.run();
  assert.equal(curateCalls(host).length, 0, "the turn just ended, so the quiet window restarts");

  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;
  await maintenance.run();
  assert.equal(curateCalls(host).length, 2, "the pass waits for the quiet window");
  assert.equal(
    tidyCalls(host).length,
    1,
    "retention waits for idle too: it deletes rows a turn may be reading",
  );
});

test("a failing pass is logged, retried next tick, and never thrown", async (t) => {
  const host = fakeHost({ failCurate: true, settings: dueSettings() });
  const { maintenance, lines, clock } = maintenanceFor(t, host);
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();

  const failure = lines.find((entry) => entry.message === "curator.auto_failed");
  assert.equal(failure.level, "warn");
  assert.equal(failure.data.error, "host unavailable");
  assert.equal(
    host.stored.curatorLastRunAt,
    dueSettings().curatorLastRunAt,
    "a handled failure puts the timestamp back, so the next tick tries again",
  );
  assert.equal(host.stored.curatorRunCount ?? 0, 0, "a failed pass is not a run");

  await maintenance.run();
  assert.equal(curateCalls(host).length, 2, "the next tick retries instead of giving up");
});

test("retention runs on the tick and reports what each rule removed", async (t) => {
  const host = fakeHost({ tidy: { removed: 7, expired: 5, overflow: 2 }, settings: dueSettings() });
  const { maintenance, lines, clock } = maintenanceFor(t, host);
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();

  assert.equal(tidyCalls(host).length, 1);
  const line = lines.find((entry) => entry.message === "memory.tidy_applied");
  assert.deepEqual(line, {
    level: "info",
    message: "memory.tidy_applied",
    data: { removed: 7, expired: 5, overflow: 2 },
  });
});

test("a failing archive does not skip retention", async (t) => {
  const host = fakeHost({
    failCurate: true,
    tidy: { removed: 3, expired: 3, overflow: 0 },
    settings: dueSettings(),
  });
  const { maintenance, lines, clock } = maintenanceFor(t, host);
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();

  assert.equal(tidyCalls(host).length, 1, "the two operations are independent");
  const tidy = lines.find((entry) => entry.message === "memory.tidy_applied");
  assert.deepEqual(tidy.data, { removed: 3, expired: 3, overflow: 0 });
});

test("a failing retention does not skip the archive or its timestamp", async (t) => {
  const host = fakeHost({ failTidy: true, archived: ["idle-one"], settings: dueSettings() });
  const { maintenance, lines, clock } = maintenanceFor(t, host);
  clock.value += (DEFAULT_MIN_IDLE_HOURS + 1) * HOUR;

  await maintenance.run();

  assert.equal(curateCalls(host).length, 2);
  assert.equal(host.stored.curatorLastRunAt, clock.value, "retention is housekeeping, not the run");
  assert.ok(
    lines.some((entry) => entry.message === "curator.auto_applied"),
    "the run is reported even when retention failed",
  );
  assert.ok(lines.some((entry) => entry.message === "memory.tidy_failed"));

  // The next tick inside the interval is not a second archive pass.
  clock.value += HOUR;
  await maintenance.run();
  assert.equal(curateCalls(host).length, 2);
  assert.equal(tidyCalls(host).length, 1, "a failed tidy waits for the next interval");
});

test("no host means no work and no log", async () => {
  const lines = [];
  const maintenance = createCuratorMaintenance({
    getHost: () => null,
    isBusy: () => false,
    dataDir: () => tmpdir(),
    log: (level, message, data) => lines.push({ level, message, data }),
  });
  await maintenance.run();
  assert.deepEqual(lines, []);
});
