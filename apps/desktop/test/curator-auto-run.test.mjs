import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCuratorMaintenance, CURATOR_INTERVAL_MS } = await import(
  "../electron/main/runtime/curator-runner.ts"
);

const NOW = 1_000 * CURATOR_INTERVAL_MS;

function fakeHost({ settings = {}, archived = [], failCurate = false, tidy, failTidy = false } = {}) {
  const calls = [];
  let stored = { ...settings };
  const host = {
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
        return { report: { archived, entries: [{}, {}] } };
      }
      if (method === "memory.tidy") {
        if (failTidy) throw new Error("memory store unavailable");
        return tidy ?? { removed: 0, expired: 0, overflow: 0 };
      }
      throw new Error(`unexpected host call: ${method}`);
    },
  };
  return host;
}

function maintenanceFor(host, options = {}) {
  const lines = [];
  const maintenance = createCuratorMaintenance({
    getHost: () => host,
    isBusy: () => false,
    now: () => NOW,
    log: (level, message, data) => lines.push({ level, message, data }),
    ...options,
  });
  return { maintenance, lines };
}

const curateCalls = (host) => host.calls.filter(([method]) => method === "skills.curate");
const tidyCalls = (host) => host.calls.filter(([method]) => method === "memory.tidy");

test("an idle app runs the pass once a day and records that it did", async () => {
  const host = fakeHost({ archived: ["idle-one"] });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.equal(curateCalls(host).length, 1);
  assert.deepEqual(
    curateCalls(host)[0][1],
    { dryRun: false },
    "the automatic pass acts; a dry run would archive nothing",
  );
  assert.equal(host.stored.curatorLastRunAt, NOW, "the run is recorded where settings live");
  assert.deepEqual(lines, [
    {
      level: "info",
      message: "curator.auto_applied",
      data: { archived: 1, archivedIds: ["idle-one"], skillsScanned: 2 },
    },
    {
      level: "info",
      message: "memory.tidy_applied",
      data: { removed: 0, expired: 0, overflow: 0 },
    },
  ]);

  // The next tick inside the same day is not a second pass.
  await maintenance.run();
  assert.equal(curateCalls(host).length, 1, "one pass a day, not one per tick");
  assert.equal(tidyCalls(host).length, 1, "retention shares the same daily cadence");
});

test("a run younger than a day is skipped, and one a day old is due", async () => {
  const recent = fakeHost({ settings: { curatorLastRunAt: NOW - CURATOR_INTERVAL_MS + 1 } });
  await maintenanceFor(recent).maintenance.run();
  assert.equal(curateCalls(recent).length, 0, "not due yet");
  assert.equal(tidyCalls(recent).length, 0, "retention is not due either");

  const due = fakeHost({ settings: { curatorLastRunAt: NOW - CURATOR_INTERVAL_MS } });
  await maintenanceFor(due).maintenance.run();
  assert.equal(curateCalls(due).length, 1, "exactly a day old is due");
  assert.equal(due.stored.curatorLastRunAt, NOW);
});

test("the setting turns the automatic pass off, and off is the only thing that does", async () => {
  const off = fakeHost({ settings: { curateAutomatically: false } });
  await maintenanceFor(off).maintenance.run();
  assert.equal(curateCalls(off).length, 0);
  assert.equal(tidyCalls(off).length, 0, "one switch covers both operations");
  assert.equal(off.stored.curatorLastRunAt, undefined, "nothing ran, so nothing is recorded");

  // A settings document written before this preference existed reads as on.
  const unset = fakeHost();
  await maintenanceFor(unset).maintenance.run();
  assert.equal(curateCalls(unset).length, 1, "absent means the default, which is on");
});

test("a running turn defers the pass without spending its daily run", async () => {
  const host = fakeHost();
  let busy = true;
  const { maintenance, lines } = maintenanceFor(host, { isBusy: () => busy });

  await maintenance.run();
  assert.deepEqual(host.calls, [], "a busy app is not even asked");
  assert.deepEqual(lines, [], "no line for work that did not happen");

  busy = false;
  await maintenance.run();
  assert.equal(curateCalls(host).length, 1, "the pass waits for the next idle tick");
  assert.equal(
    tidyCalls(host).length,
    1,
    "retention waits for idle too: it deletes rows a turn may be reading",
  );
});

test("a failing pass is logged, retried next tick, and never thrown", async () => {
  const host = fakeHost({ failCurate: true });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.deepEqual(lines[0], {
    level: "warn",
    message: "curator.auto_failed",
    data: { error: "Error: host unavailable" },
  });
  assert.equal(
    host.stored.curatorLastRunAt,
    undefined,
    "an unwritten timestamp means the next tick tries again",
  );

  await maintenance.run();
  assert.equal(curateCalls(host).length, 2, "the next tick retries instead of giving up");
  assert.equal(lines.length, 4);
});

test("retention runs on the tick and reports what each rule removed", async () => {
  const host = fakeHost({ tidy: { removed: 7, expired: 5, overflow: 2 } });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.equal(tidyCalls(host).length, 1);
  const line = lines.find((entry) => entry.message === "memory.tidy_applied");
  assert.deepEqual(line, {
    level: "info",
    message: "memory.tidy_applied",
    data: { removed: 7, expired: 5, overflow: 2 },
  });
});

test("a failing archive does not skip retention", async () => {
  const host = fakeHost({ failCurate: true, tidy: { removed: 3, expired: 3, overflow: 0 } });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.equal(tidyCalls(host).length, 1, "the two operations are independent");
  assert.deepEqual(lines[1], {
    level: "info",
    message: "memory.tidy_applied",
    data: { removed: 3, expired: 3, overflow: 0 },
  });
});

test("a failing retention does not skip the archive or its timestamp", async () => {
  const host = fakeHost({ failTidy: true, archived: ["idle-one"] });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.equal(curateCalls(host).length, 1);
  assert.equal(host.stored.curatorLastRunAt, NOW, "retention is housekeeping, not the run");
  assert.deepEqual(lines, [
    {
      level: "info",
      message: "curator.auto_applied",
      data: { archived: 1, archivedIds: ["idle-one"], skillsScanned: 2 },
    },
    {
      level: "warn",
      message: "memory.tidy_failed",
      data: { error: "Error: memory store unavailable" },
    },
  ]);

  // The next tick inside the day is still not a second archive pass: the run
  // was recorded, and retention waits for its own next day.
  await maintenance.run();
  assert.equal(curateCalls(host).length, 1);
  assert.equal(tidyCalls(host).length, 1, "a failed tidy waits for the next daily tick");
});

test("no host means no work and no log", async () => {
  const lines = [];
  const maintenance = createCuratorMaintenance({
    getHost: () => null,
    isBusy: () => false,
    log: (level, message, data) => lines.push({ level, message, data }),
  });
  await maintenance.run();
  assert.deepEqual(lines, []);
});
