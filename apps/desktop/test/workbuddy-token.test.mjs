/**
 * Token acquisition: classification, and the attach / restart orchestration.
 *
 * The transport is exercised against an injected DevTools connection, because
 * what can go wrong here is the sequence — attach before restarting, restore the
 * app afterwards — not the WebSocket framing. The real transport is verified
 * against a live desktop app, not in CI.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireWorkBuddyToken,
  parseJwtClaims,
  pickTokens,
  rendererHookExpression,
  rendererReadExpression,
} from "../electron/main/workbuddy/token.ts";

const b64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically real JWT with the given claims. */
function jwt(claims) {
  return [b64url({ alg: "RS256", typ: "JWT" }), b64url(claims), "x".repeat(64)].join(".");
}

const ACCESS = jwt({ typ: "Bearer", sub: "user-1", exp: 1_796_442_691 });
const OFFLINE = jwt({ typ: "Offline", sub: "user-1", exp: 1_799_000_000 });
const UNLABELLED_OLD = jwt({ sub: "user-1", exp: 1_700_000_000 });
const UNLABELLED_NEW = jwt({ sub: "user-1", exp: 1_796_000_000 });

const environment = {
  homeDir: "C:/Users/fixture",
  localAppData: "C:/Users/fixture/AppData/Local",
  programFiles: "C:/Program Files",
  platform: "win32",
  now: 1_700_000_000_000,
};

test("claims decode from a JWT payload", () => {
  assert.equal(parseJwtClaims(ACCESS).typ, "Bearer");
  assert.equal(parseJwtClaims("not-a-jwt"), null);
  assert.equal(parseJwtClaims("a.b.c"), null);
});

test("the labelled access token wins over a longer-lived refresh token", () => {
  const picked = pickTokens([
    { token: OFFLINE, source: "traffic" },
    { token: ACCESS, source: "traffic" },
  ]);

  assert.equal(picked.accessToken, ACCESS);
  assert.equal(picked.refreshToken, OFFLINE);
});

test("unlabelled tokens fall back to the latest expiry", () => {
  const picked = pickTokens([
    { token: UNLABELLED_OLD, source: "storage" },
    { token: UNLABELLED_NEW, source: "storage" },
  ]);

  assert.equal(picked.accessToken, UNLABELLED_NEW);
  assert.equal(picked.refreshToken, undefined);
});

test("short strings are not tokens", () => {
  assert.deepEqual(pickTokens([{ token: "Bearer", source: "traffic" }]), {});
});

test("the renderer hook stores what it collects", () => {
  assert.match(rendererHookExpression(), /__piWbTokens/);
  assert.match(rendererHookExpression(), /setRequestHeader/);
  assert.match(rendererReadExpression(), /__piWbTokens/);
});

/** A fake DevTools page that answers the expressions the harvester sends. */
function fakeConnection({ tokens, onEvaluate }) {
  return {
    send: async (method, params) => {
      if (method === "Runtime.enable") return { id: 1, result: {} };
      if (method !== "Runtime.evaluate") return { id: 1, result: {} };
      onEvaluate?.(params.expression);
      const returnsTokens = params.expression.includes("__piWbTokens || []");
      return { id: 1, result: { result: { value: returnsTokens ? tokens : "hooked" } } };
    },
    close: () => {},
  };
}

function deps(overrides = {}) {
  const calls = { killed: 0, spawned: [], evaluated: [] };
  return {
    calls,
    input: {
      environment,
      executable: "C:/Program Files/WorkBuddy/WorkBuddy.exe",
      debugPort: 9222,
      inspectPort: 9229,
      harvestTimeoutMs: 50,
      portReadyTimeoutMs: 50,
      sleep: async () => {},
      log: () => {},
      listTargets: async () => [
        { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/page" },
      ],
      connect: async () =>
        fakeConnection({ tokens: [ACCESS], onEvaluate: (e) => calls.evaluated.push(e) }),
      killApp: async () => {
        calls.killed += 1;
        return calls.wasRunning ?? true;
      },
      spawnApp: (exe, args) => calls.spawned.push({ exe, args }),
      ...overrides,
    },
  };
}

test("an app already exposing a DevTools port is used as-is", async () => {
  const { input, calls } = deps();

  const token = await acquireWorkBuddyToken(input);

  assert.equal(token.accessToken, ACCESS);
  assert.equal(token.source, "attach");
  assert.equal(token.expiresAt, 1_796_442_691_000);
  assert.equal(calls.killed, 0, "attaching must not restart the app");
  assert.deepEqual(calls.spawned, []);
});

test("a closed app is restarted behind a port and handed back afterwards", async () => {
  let probes = 0;
  const { input, calls } = deps({
    listTargets: async () => {
      probes += 1;
      // First probe: nothing listening. After the restart: a page target.
      return probes === 1 ? [] : [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/p" }];
    },
  });

  const token = await acquireWorkBuddyToken(input);

  assert.equal(token.source, "launch");
  assert.equal(calls.killed, 2, "one kill to open the port, one to close it again");
  assert.deepEqual(calls.spawned[0].args, [
    "--remote-debugging-port=9222",
    "--inspect=9229",
  ]);
  assert.deepEqual(calls.spawned[1].args, [], "the restored app carries no debug flags");
});

test("a harvest that finds nothing still restores the app, then reports", async () => {
  let probes = 0;
  const { input, calls } = deps({
    listTargets: async () => {
      probes += 1;
      return probes === 1 ? [] : [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/p" }];
    },
    connect: async () => fakeConnection({ tokens: [] }),
  });

  await assert.rejects(() => acquireWorkBuddyToken(input), /no WorkBuddy token was observed/);
  assert.equal(calls.killed, 2);
  assert.deepEqual(calls.spawned.at(-1).args, []);
});

test("an app that was not running is left closed after the harvest", async () => {
  let probes = 0;
  const { input, calls } = deps({
    listTargets: async () => {
      probes += 1;
      return probes === 1 ? [] : [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/p" }];
    },
  });
  calls.wasRunning = false;

  const token = await acquireWorkBuddyToken(input);

  assert.equal(token.source, "launch");
  // Two kill attempts (nothing was running, then the debug instance) and a
  // single launch: the app is left closed, exactly as it was found.
  assert.equal(calls.killed, 2);
  assert.equal(calls.spawned.length, 1);
});

test("an app that never opens the port fails without a restore launch", async () => {
  const { input, calls } = deps({ listTargets: async () => [] });

  await assert.rejects(() => acquireWorkBuddyToken(input), /did not expose a DevTools port/);
  assert.equal(calls.killed, 1);
  // Only the debug launch happened; there is nothing to restore.
  assert.equal(calls.spawned.length, 1);
  assert.deepEqual(calls.spawned[0].args, [
    "--remote-debugging-port=9222",
    "--inspect=9229",
  ]);
});

test("no installed app means no attempt at all", async () => {
  const { input, calls } = deps();
  const { executable, environment: fixtureEnvironment, ...rest } = input;

  await assert.rejects(
    () =>
      acquireWorkBuddyToken({
        ...rest,
        executable: undefined,
        // No candidates at all: the drive sweep must not rescue a bare fixture.
        environment: { ...fixtureEnvironment, executables: [] },
      }),
    /executable was not found/,
  );
  assert.equal(calls.killed, 0);
});
