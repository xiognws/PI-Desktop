/**
 * In-app providers (WorkBuddy).
 *
 * These run the supervisor against fakes for the host RPC, the process spawn
 * and the loopback HTTP client: no port is opened and no gateway is built, but
 * every branch the app depends on — disabled, healthy, unhealthy, second boot,
 * custom port — is decided exactly as it is in the app.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import test from "node:test";

const { InAppProviders, resolveProviderSettings } = await import(
  "../electron/main/providers/in-app-providers.ts"
);
const { CreditsCache, readCredits } = await import("../electron/main/providers/credits.ts");
const { IN_APP_PROVIDERS, inAppProviderIdFromVendorKey, inAppProviderVendorKey } = await import(
  "../electron/main/providers/types.ts"
);
const { IN_APP_PROVIDER_CHANNELS } = await import("../src/lib/in-app-provider-channels.ts");
const { creditsVisibility } = await import("../src/lib/in-app-credits-visibility.ts");

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const WORKBUDDY = IN_APP_PROVIDERS[0];
const API_KEY = "k".repeat(48);

/** A host + spawn + fetch triple that records every call. */
function harness({ settings = {}, healthy = true, rows = [], models = ["m-1", "m-2"] } = {}) {
  const calls = [];
  const spawned = [];
  const providerRows = [...rows];
  const fetchCalls = [];
  const host = async (method, params) => {
    calls.push({ method, params });
    if (method === "providers.list") return { providers: providerRows.map((row) => ({ ...row })) };
    if (method === "providers.create") {
      const row = { id: `row-${providerRows.length + 1}`, vendorKey: params.vendorKey };
      providerRows.push(row);
      return { provider: row };
    }
    if (method === "providers.update") {
      const row = providerRows.find((candidate) => candidate.id === params.id);
      if (row) Object.assign(row, params);
      return { provider: row ?? null };
    }
    if (method === "providers.setSecret") return { provider: providerRows[0] ?? null };
    return {};
  };
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    if (String(url).endsWith(WORKBUDDY.healthPath)) {
      if (!healthy) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ ok: true, service: "pi-workbuddy-connect" }) };
    }
    const body = { object: "list", data: models.map((id) => ({ id })) };
    return { ok: true, json: async () => body };
  };
  const supervisor = new InAppProviders({
    callHost: host,
    startGateway: async ({ port }) => {
      spawned.push(port);
      return { stop: async () => {} };
    },
    readSettings: async () => settings,
    readApiKey: async () => API_KEY,
    fetchImpl,
    log: () => {},
    healthPollMs: 1,
    healthTimeoutMs: healthy ? 200 : 5,
  });
  return { supervisor, calls, spawned, providerRows, fetchCalls };
}

test("a disabled provider starts nothing and writes nothing", async () => {
  const { supervisor, calls, spawned } = harness({
    settings: { inAppProvider: { workbuddy: { enabled: false } } },
  });
  await supervisor.start();
  assert.deepEqual(spawned, []);
  assert.deepEqual(calls, []);
});

test("a healthy gateway registers the provider row exactly once", async () => {
  const { supervisor, calls, spawned } = harness();
  await supervisor.start();
  assert.deepEqual(spawned, [WORKBUDDY.defaultPort]);
  const creates = calls.filter((call) => call.method === "providers.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.vendorKey, inAppProviderVendorKey("workbuddy"));
  assert.equal(
    creates[0].params.baseUrl,
    `http://127.0.0.1:${WORKBUDDY.defaultPort}${WORKBUDDY.openaiBasePath}`,
  );
  assert.deepEqual(creates[0].params.models, [{ id: "m-1" }, { id: "m-2" }]);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["providers.list", "providers.create", "providers.setSecret"],
  );
});

test("a second boot updates the existing row instead of creating another", async () => {
  const rows = [{ id: "row-1", vendorKey: inAppProviderVendorKey("workbuddy") }];
  const { supervisor, calls } = harness({ rows });
  await supervisor.start();
  assert.equal(calls.filter((call) => call.method === "providers.create").length, 0);
  assert.equal(calls.filter((call) => call.method === "providers.update").length, 1);
  assert.equal(calls.find((call) => call.method === "providers.update").params.id, "row-1");
  assert.equal(calls.filter((call) => call.method === "providers.setSecret").length, 1);
});

test("a gateway that never becomes healthy writes no provider", async () => {
  const { supervisor, calls, spawned } = harness({ healthy: false });
  await supervisor.start();
  assert.equal(spawned.length, 1);
  assert.deepEqual(calls, []);
});

test("the configured port is honoured over the descriptor default", async () => {
  const { supervisor, spawned } = harness({
    settings: { inAppProvider: { workbuddy: { port: 19100 } } },
  });
  await supervisor.start();
  assert.deepEqual(spawned, [19100]);
});

test("settings resolve to enabled on the descriptor port when absent", () => {
  assert.deepEqual(resolveProviderSettings(WORKBUDDY, {}), {
    enabled: true,
    port: WORKBUDDY.defaultPort,
  });
  assert.deepEqual(
    resolveProviderSettings(WORKBUDDY, { inAppProvider: { workbuddy: { port: 0 } } }),
    { enabled: true, port: WORKBUDDY.defaultPort },
  );
  assert.deepEqual(
    resolveProviderSettings(WORKBUDDY, { inAppProvider: { workbuddy: { enabled: false } } }),
    { enabled: false, port: WORKBUDDY.defaultPort },
  );
});

test("the registry is one descriptor shape, so a second provider is one entry", () => {
  for (const provider of IN_APP_PROVIDERS) {
    assert.equal(typeof provider.id, "string");
    assert.equal(typeof provider.label, "string");
    assert.ok(Number.isInteger(provider.defaultPort) && provider.defaultPort > 0);
    assert.match(provider.healthPath, /^\//);
    assert.match(provider.openaiBasePath, /^\/.+\/v1$/);
    assert.equal(typeof provider.product, "string");
    // Optional by design: a provider without a credit surface hides the chip.
    assert.ok(provider.creditsPath === undefined || /^\//.test(provider.creditsPath));
  }
  assert.equal(inAppProviderIdFromVendorKey(inAppProviderVendorKey("workbuddy")), "workbuddy");
  assert.equal(inAppProviderIdFromVendorKey("custom"), null);
  assert.equal(inAppProviderIdFromVendorKey(undefined), null);
});

test("the credits route maps 402 and 401 instead of inventing a balance", async () => {
  const reply = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const cases = [
    [402, { error: { type: "hard_credit" } }, "hard_credit"],
    [401, { error: { type: "session_dead" } }, "session_dead"],
    [401, { error: { type: "not_signed_in" } }, "signed_out"],
    [500, { error: { type: "upstream_error" } }, "unavailable"],
    [200, { total: "many" }, "unavailable"],
  ];
  for (const [status, body, reason] of cases) {
    const result = await readCredits({
      origin: "http://127.0.0.1:1",
      creditsPath: "/workbuddy/v1/credits",
      apiKey: API_KEY,
      fetchImpl: reply(status, body),
    });
    assert.deepEqual(result, { ok: false, reason }, `status ${status}`);
  }
  const ok = await readCredits({
    origin: "http://127.0.0.1:1",
    creditsPath: "/workbuddy/v1/credits",
    apiKey: API_KEY,
    fetchImpl: reply(200, {
      total: 120,
      accounts: [{ name: "P1", remain: 120, size: 200 }],
      free: false,
      fetchedAt: 7,
    }),
  });
  assert.deepEqual(ok, {
    ok: true,
    credits: { total: 120, accounts: [{ name: "P1", remain: 120, size: 200 }], free: false, fetchedAt: 7 },
  });
});

test("the credit cache answers within its TTL and refresh bypasses it", async () => {
  let reads = 0;
  const cache = new CreditsCache(
    async () => {
      reads += 1;
      return { ok: true, credits: { total: 5, accounts: [], free: false, fetchedAt: reads } };
    },
    { now: () => 1_000, ttlMs: 30_000 },
  );
  await cache.read("workbuddy");
  await cache.read("workbuddy");
  assert.equal(reads, 1);
  await cache.read("workbuddy", { refresh: true });
  assert.equal(reads, 2);
});

test("visibility hides an absent surface, a free plan, a zero total and a failure", () => {
  const visibility = creditsVisibility;
  const cases = [
    [{ hasCreditsPath: true, total: 42 }, "show"],
    [{ hasCreditsPath: false, total: 42 }, "hide"],
    [{ hasCreditsPath: true, total: 42, free: true }, "hide"],
    [{ hasCreditsPath: true, total: 0 }, "hide"],
    [{ hasCreditsPath: true, total: -3 }, "hide"],
    [{ hasCreditsPath: true }, "hide"],
    [{ hasCreditsPath: true, total: 42, reason: "hard_credit" }, "hide"],
    [{ hasCreditsPath: true, total: 42, reason: "session_dead" }, "hide"],
    [{ hasCreditsPath: true, total: 42, reason: "signed_out" }, "hide"],
    [{ hasCreditsPath: true, total: 42, reason: "unavailable" }, "hide"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(visibility(input), expected, JSON.stringify(input));
  }
});

test("main and renderer agree on the channel names", () => {
  const main = read("../electron/main/providers/ipc.ts");
  const renderer = read("../src/lib/in-app-provider-channels.ts");
  for (const channel of ["pi-desktop/in-app-providers/list", "pi-desktop/in-app-providers/credits"]) {
    assert.ok(main.includes(channel), `main is missing ${channel}`);
    assert.ok(renderer.includes(channel), `renderer is missing ${channel}`);
  }
  assert.deepEqual(IN_APP_PROVIDER_CHANNELS, {
    list: "pi-desktop/in-app-providers/list",
    credits: "pi-desktop/in-app-providers/credits",
  });
});
