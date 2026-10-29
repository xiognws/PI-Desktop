/**
 * Contract tests for the handshake-race retry.
 *
 * A cold start builds the window before host-core has answered `app.handshake`,
 * so chrome work that talks to the host can be refused with "handshake
 * required". Only that refusal is retried — a real RPC error must keep its single
 * attempt, or every genuine failure would be silently delayed and hidden.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { callAfterHandshake, isHandshakeRace } = await import(
  "../electron/main/host-handshake-retry.ts"
);

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");
const corners = await read("../electron/main/window-native-corners.ts");

const raceError = () => new Error('host RPC error 1001: handshake required');

test("only the handshake refusal is recognised", () => {
  assert.equal(isHandshakeRace(raceError()), true);
  assert.equal(isHandshakeRace("handshake required"), true);
  assert.equal(isHandshakeRace(new Error("host RPC timeout: window.setNativeCornerPreference")), false);
  assert.equal(isHandshakeRace(new Error("invalid native window corner preference")), false);
  // The other half of the same race: the host process does not exist yet.
  assert.equal(
    isHandshakeRace(new Error("host-core is unavailable for native window corners")),
    true,
  );
  assert.equal(isHandshakeRace(undefined), false);
});

test("a call that races the handshake is retried until it lands", async () => {
  const calls = [];
  const waits = [];
  const result = await callAfterHandshake(
    async () => {
      calls.push(calls.length + 1);
      if (calls.length < 3) throw raceError();
      return "applied";
    },
    { attempts: 6, delayMs: 250, sleep: async (ms) => waits.push(ms) },
  );
  assert.equal(result, "applied");
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [250, 250]);
});

test("a real failure is not retried", async () => {
  let calls = 0;
  const failure = new Error("invalid native window corner preference");
  await assert.rejects(
    () =>
      callAfterHandshake(
        async () => {
          calls += 1;
          throw failure;
        },
        { attempts: 6, delayMs: 250, sleep: async () => {} },
      ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("the race gives up after the last attempt and reports the refusal", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      callAfterHandshake(
        async () => {
          calls += 1;
          throw raceError();
        },
        { attempts: 3, delayMs: 100, sleep: async () => {} },
      ),
    /handshake required/,
  );
  assert.equal(calls, 3);
});

test("the corner controller waits instead of warning on every cold start", async () => {
  assert.match(
    corners,
    /import \{ callAfterHandshake, isHandshakeRace \} from "\.\/host-handshake-retry\.ts";/,
  );
  assert.match(corners, /await callAfterHandshake\(/);
  assert.match(corners, /window\.setNativeCornerPreference/);
  assert.match(corners, /\{ attempts: 5, delayMs: 300 \}/);
  // The null-host check has to live inside the retried call, or that half of the
  // race would still fail on the first attempt.
  assert.match(corners, /async \(\) => \{\s*const host = getHost\(\);\s*if \(!host\) throw/);
  // Window creation must not wait on the host: the first apply is fire-and-forget
  // and the hint is re-applied once the handshake lands.
  assert.match(corners, /void controller\.setRadius\(radius\)\.catch\(\(\) => undefined\)/);
  assert.doesNotMatch(corners, /await controller\.setRadius\(radius\)/);
  assert.match(corners, /export function reapplyWindowCorners\(\): void \{/);
  // The host runtime re-applies the hint the moment the handshake lands.
  const runtime = await read("../electron/main/runtime/host.ts");
  assert.match(runtime, /reapplyWindowCorners\(\);/);
  assert.match(
    runtime,
    /host-core handshake ok"[\s\S]{0,400}reapplyWindowCorners\(\);/,
  );
});
