/**
 * Contract tests for the per-plugin broker budget.
 *
 * All plugins are served by one main process and one shared plugin host, so a
 * single plugin polling in a loop slows every other plugin down. The budget is a
 * token bucket per plugin: under the ceiling nothing waits, over it calls are
 * delayed (never refused) so a bulk scan still finishes without monopolising the
 * broker.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  PluginApiRateLimiter,
  DEFAULT_PLUGIN_API_BURST,
  DEFAULT_PLUGIN_API_MAX_WAIT_MS,
  DEFAULT_PLUGIN_API_PER_SECOND,
} = await import("../electron/main/plugin-api-rate-limit.ts");

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

/** A limiter on a fake clock: `sleep` moves time instead of waiting for it. */
function limiter(options = {}) {
  let clock = 0;
  const waits = [];
  const instance = new PluginApiRateLimiter({
    perSecond: 20,
    burst: 40,
    maxWaitMs: 500,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    ...options,
  });
  return { instance, waits, advance: (ms) => (clock += ms), clock: () => clock };
}

test("a plugin under its burst never waits", async () => {
  const { instance, waits } = limiter({ burst: 40 });
  for (let i = 0; i < 40; i += 1) {
    const decision = await instance.acquire("pi.todo");
    assert.equal(decision.limited, false, `call ${i + 1} must run at once`);
    assert.equal(decision.waitedMs, 0);
  }
  assert.deepEqual(waits, [], "the burst is free");
});

test("a call past the burst is delayed, not refused", async () => {
  const { instance, waits } = limiter({ burst: 2, perSecond: 20 });
  await instance.acquire("pi.todo");
  await instance.acquire("pi.todo");
  const third = await instance.acquire("pi.todo");
  assert.equal(third.limited, true);
  // One token at 20/s is 50 ms away.
  assert.equal(third.waitedMs, 50);
  assert.deepEqual(waits, [50]);
});

test("a sustained loop converges on the per-second ceiling", async () => {
  const { instance, waits, clock } = limiter({ burst: 1, perSecond: 20, maxWaitMs: 5_000 });
  const started = clock();
  for (let i = 0; i < 41; i += 1) await instance.acquire("pi.thinkrail");
  const elapsed = clock() - started;
  // 1 free call plus 40 waits of 50 ms each: one call per 50 ms, no faster.
  assert.equal(elapsed, 40 * 50);
  assert.ok(waits.every((ms) => ms === 50));
});

test("the hold is bounded so an over-limit plugin is not stalled", async () => {
  const { instance } = limiter({ burst: 1, perSecond: 1, maxWaitMs: 750 });
  await instance.acquire("slow.plugin");
  const second = await instance.acquire("slow.plugin");
  assert.equal(second.limited, true);
  // A full token would be 1000 ms away; the budget forgives the difference.
  assert.equal(second.waitedMs, 750);
  assert.equal(DEFAULT_PLUGIN_API_MAX_WAIT_MS, 750);
});

test("one plugin's loop never delays another plugin", async () => {
  const { instance } = limiter({ burst: 2 });
  await instance.acquire("pi.thinkrail");
  await instance.acquire("pi.thinkrail");
  await instance.acquire("pi.thinkrail"); // limited
  const other = await instance.acquire("pi.todo");
  assert.equal(other.limited, false);
  assert.equal(other.waitedMs, 0);
});

test("the decision reports how many calls the plugin made this second", async () => {
  const { instance } = limiter({ burst: 100 });
  const decisions = [];
  for (let i = 0; i < 3; i += 1) decisions.push(await instance.acquire("pi.thinkrail"));
  assert.deepEqual(
    decisions.map((decision) => decision.observedInWindow),
    [1, 2, 3],
  );
});

test("the budget can be switched off without changing the caller's contract", async () => {
  const { instance, waits } = limiter({ perSecond: 0, burst: 1 });
  for (let i = 0; i < 5; i += 1) {
    const decision = await instance.acquire("pi.thinkrail");
    assert.equal(decision.limited, false);
  }
  assert.deepEqual(waits, []);
});

test("the broker waits for the budget before it runs a plugin call", async () => {
  const runtime = await read("../electron/main/plugin-runtime.ts");
  const call = runtime.indexOf('if (message.t === "call")');
  const budget = runtime.indexOf("await this.acquireBrokerBudget", call);
  const dispatch = runtime.indexOf("this.dispatchHostCall(", budget);
  assert.ok(call > 0 && budget > call, "the budget must run on the plugin call path");
  assert.ok(dispatch > budget, "the budget must be taken before the call is dispatched");
  const sites = runtime.split("await this.acquireBrokerBudget").length - 1;
  assert.equal(sites, 2, "both host entries — the plugin process and the panel bridge — take the budget");
  // The panel bridge is a second entry into the host; a polling view must draw on
  // the same budget or the original slow case stays unfixed.
  const panel = runtime.indexOf("async invokePanelBridge(");
  const panelBudget = runtime.indexOf("await this.acquireBrokerBudget", panel);
  const panelInvoke = runtime.indexOf("invokePanelWithoutToolContext(pluginId", panelBudget);
  assert.ok(panelBudget > panel, "the panel bridge must take the budget too");
  assert.ok(panelInvoke > panelBudget, "the panel bridge must wait before it runs the call");
  assert.match(runtime, /plugin\.api\.rate-limited/);
  assert.match(runtime, /API_RATE_WARNING_INTERVAL_MS/);
  assert.equal(DEFAULT_PLUGIN_API_PER_SECOND, 20);
  assert.equal(DEFAULT_PLUGIN_API_BURST, 40);
});

test("a rate-limit warning lands in the log as a warning", async () => {
  const services = await read("../electron/main/services/plugin-services.ts");
  assert.match(
    services,
    /entry\.level === "warn" \|\| entry\.level === "error" \? entry\.level : "info"/,
    "the audit sink must honour the level the caller asked for",
  );
});
