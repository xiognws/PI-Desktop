/**
 * Registration and lifecycle of the WorkBuddy entry.
 *
 * The entry is an ordinary provider row, so what matters is the row the Host is
 * asked to write: created once, kept in step with the account's models, switched
 * off (not deleted) when the local app disappears, and never asked to rewrite
 * itself on a launch where nothing changed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ensureProvider } from "../electron/main/workbuddy/provider.ts";
import { createWorkBuddyService } from "../electron/main/workbuddy/service.ts";

const MODELS = [
  { id: "hy4free", name: "Hy4", contextWindow: 960000, maxOutputTokens: 64000, supportsImages: true },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash" },
];

/** Minimal Host stand-in: the provider rows this feature is allowed to touch. */
function hostFixture({ hasSecret = false } = {}) {
  const providers = new Map();
  const calls = [];
  let id = 0;
  const host = {
    call: async (method, params = {}) => {
      calls.push({ method, params });
      switch (method) {
        case "providers.list":
          return { providers: [...providers.values()] };
        case "providers.create": {
          const row = {
            id: `row-${++id}`,
            hasSecret: false,
            enabled: true,
            ...params,
          };
          providers.set(row.id, row);
          return { provider: row };
        }
        case "providers.update": {
          const row = providers.get(params.id);
          const next = { ...row, ...params };
          providers.set(next.id, next);
          return { provider: next };
        }
        default:
          throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  return {
    host,
    providers,
    calls,
    /** Pretend the user pasted the token in the provider dialog. */
    markSecretStored: () => {
      for (const row of providers.values()) row.hasSecret = hasSecret || true;
    },
  };
}

const baseInput = (host) => ({
  host,
  vendorKey: "workbuddy",
  name: "WorkBuddy",
  baseUrl: "http://127.0.0.1:41000/v1",
  models: MODELS,
  enabled: true,
});

test("the first pass creates the provider row with the account's models", async () => {
  const fixture = hostFixture();
  const result = await ensureProvider(baseInput(fixture.host));

  assert.equal(result.created, true);
  assert.equal(result.changed, true);
  const created = fixture.calls.find((call) => call.method === "providers.create");
  assert.equal(created.params.name, "WorkBuddy");
  assert.equal(created.params.vendorKey, "workbuddy");
  assert.equal(created.params.authKind, "api_key");
  assert.equal(created.params.apiStyle, "chat_completions");
  assert.equal(created.params.baseUrl, "http://127.0.0.1:41000/v1");
  assert.equal(created.params.defaultModelId, "hy4free");
  assert.deepEqual(
    created.params.models.map((model) => model.id),
    ["hy4free", "deepseek-v4.1-flash"],
  );
  assert.equal(created.params.models[0].contextWindow, 960000);
  assert.equal(created.params.models[1].contextWindow, undefined);
});

test("an unchanged launch writes nothing", async () => {
  const fixture = hostFixture();
  await ensureProvider(baseInput(fixture.host));
  fixture.calls.length = 0;

  const second = await ensureProvider(baseInput(fixture.host));

  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.deepEqual(
    fixture.calls.map((call) => call.method),
    ["providers.list"],
  );
});

test("a new model on the account updates the row and keeps the saved key", async () => {
  const fixture = hostFixture();
  const first = await ensureProvider(baseInput(fixture.host));
  fixture.calls.length = 0;

  const second = await ensureProvider({
    ...baseInput(fixture.host),
    models: [...MODELS, { id: "glm-5.3", name: "GLM-5.3" }],
  });

  assert.equal(second.changed, true);
  const update = fixture.calls.find((call) => call.method === "providers.update");
  assert.equal(update.params.id, first.provider.id);
  assert.equal(update.params.models.length, 3);
  // Omitting `secretValue` is what keeps the credential the user stored.
  assert.equal("secretValue" in update.params, false);
});

test("a moved endpoint updates the base URL in place", async () => {
  const fixture = hostFixture();
  const first = await ensureProvider(baseInput(fixture.host));
  fixture.calls.length = 0;

  const second = await ensureProvider({
    ...baseInput(fixture.host),
    baseUrl: "http://127.0.0.1:41001/v1",
  });

  assert.equal(second.provider.id, first.provider.id);
  const update = fixture.calls.find((call) => call.method === "providers.update");
  assert.equal(update.params.baseUrl, "http://127.0.0.1:41001/v1");
});

test("a vanished install disables the row instead of deleting it", async () => {
  const fixture = hostFixture();
  await ensureProvider(baseInput(fixture.host));
  fixture.calls.length = 0;

  await ensureProvider({ ...baseInput(fixture.host), models: [], baseUrl: "", enabled: false });

  const update = fixture.calls.find((call) => call.method === "providers.update");
  assert.equal(update.params.enabled, false);
  assert.equal(fixture.providers.size, 1);
  assert.equal(fixture.calls.some((call) => call.method === "providers.delete"), false);
});

const installed = {
  installation: {
    installed: true,
    loggedIn: true,
    sources: ["auth-store"],
    account: { uid: "user-1" },
  },
  models: MODELS,
};

/** A source that reports whatever the test asks for and opens a stub bridge. */
function sourceFixture(detection, { closed } = { closed: { count: 0 } }) {
  return {
    id: "workbuddy",
    name: "WorkBuddy",
    vendorKey: "workbuddy",
    detect: () => detection,
    startBridge: async () => ({
      baseUrl: "http://127.0.0.1:41000/v1",
      close: async () => {
        closed.count += 1;
      },
    }),
  };
}

test("a signed-in machine gets an entry that waits for its token", async () => {
  const fixture = hostFixture();
  const service = createWorkBuddyService({
    getHost: () => fixture.host,
    sources: [sourceFixture(installed)],
  });

  const [status] = await service.start();

  assert.equal(status.state, "needs-credential");
  assert.equal(status.endpoint, "bridge");
  assert.equal(status.modelCount, 2);
  assert.equal(status.installation.loggedIn, true);
  assert.ok(status.providerId);
  assert.equal(fixture.providers.size, 1);
  await service.dispose();
});

test("a stored token reports the entry as ready", async () => {
  const fixture = hostFixture();
  const service = createWorkBuddyService({
    getHost: () => {
      // The row comes back from `providers.list` with `hasSecret` set.
      return {
        call: async (method, params) => {
          const result = await fixture.host.call(method, params);
          if (method === "providers.create") result.provider.hasSecret = true;
          if (method === "providers.list") {
            return { providers: [...fixture.providers.values()].map((row) => ({ ...row, hasSecret: true })) };
          }
          return result;
        },
      };
    },
    sources: [sourceFixture(installed)],
  });

  const [status] = await service.start();

  assert.equal(status.state, "ready");
  await service.dispose();
});

test("a machine without WorkBuddy creates no row at all", async () => {
  const fixture = hostFixture();
  const service = createWorkBuddyService({
    getHost: () => fixture.host,
    sources: [
      sourceFixture({
        installation: { installed: false, loggedIn: false, sources: [], detail: "not installed" },
        models: [],
      }),
    ],
  });

  const [status] = await service.start();

  assert.equal(status.state, "unavailable");
  assert.equal(status.endpoint, "none");
  assert.equal(fixture.calls.some((call) => call.method === "providers.create"), false);
  await service.dispose();
});

test("dispose closes the gateway it opened", async () => {
  const closed = { count: 0 };
  const fixture = hostFixture();
  const service = createWorkBuddyService({
    getHost: () => fixture.host,
    sources: [sourceFixture(installed, { closed })],
  });

  await service.start();
  await service.dispose();

  assert.equal(closed.count, 1);
});

test("a host that is not up yet degrades instead of throwing", async () => {
  const service = createWorkBuddyService({
    getHost: () => null,
    sources: [sourceFixture(installed)],
  });

  const [status] = await service.start();

  assert.equal(status.state, "unavailable");
  assert.match(status.detail ?? "", /host unavailable/i);
});
