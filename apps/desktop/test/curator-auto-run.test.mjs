import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCuratorMaintenance, CURATOR_INTERVAL_MS } = await import(
  "../electron/main/runtime/curator-runner.ts"
);

const NOW = 1_000 * CURATOR_INTERVAL_MS;

function fakeHost({ settings = {}, archived = [], failCurate = false } = {}) {
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
  ]);

  // The next tick inside the same day is not a second pass.
  await maintenance.run();
  assert.equal(curateCalls(host).length, 1, "one pass a day, not one per tick");
});

test("a run younger than a day is skipped, and one a day old is due", async () => {
  const recent = fakeHost({ settings: { curatorLastRunAt: NOW - CURATOR_INTERVAL_MS + 1 } });
  await maintenanceFor(recent).maintenance.run();
  assert.equal(curateCalls(recent).length, 0, "not due yet");

  const due = fakeHost({ settings: { curatorLastRunAt: NOW - CURATOR_INTERVAL_MS } });
  await maintenanceFor(due).maintenance.run();
  assert.equal(curateCalls(due).length, 1, "exactly a day old is due");
  assert.equal(due.stored.curatorLastRunAt, NOW);
});

test("the setting turns the automatic pass off, and off is the only thing that does", async () => {
  const off = fakeHost({ settings: { curateAutomatically: false } });
  await maintenanceFor(off).maintenance.run();
  assert.equal(curateCalls(off).length, 0);
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
});

test("a failing pass is logged, retried next tick, and never thrown", async () => {
  const host = fakeHost({ failCurate: true });
  const { maintenance, lines } = maintenanceFor(host);

  await maintenance.run();

  assert.deepEqual(lines, [
    { level: "warn", message: "curator.auto_failed", data: { error: "Error: host unavailable" } },
  ]);
  assert.equal(
    host.stored.curatorLastRunAt,
    undefined,
    "an unwritten timestamp means the next tick tries again",
  );

  await maintenance.run();
  assert.equal(curateCalls(host).length, 2, "the next tick retries instead of giving up");
  assert.equal(lines.length, 2);
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
