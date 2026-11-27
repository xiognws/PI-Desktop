import assert from "node:assert/strict";
import test from "node:test";
import { isHostNotReadyError, retryWhileHostNotReady } from "../src/lib/host-ready-retry.ts";

// The renderer boots before the host answers IPC. These pin the one error that may be
// retried, and that everything else surfaces immediately.

test("only the host-not-ready message counts as retryable", () => {
  assert.equal(isHostNotReadyError(new Error("host unavailable")), true);
  assert.equal(isHostNotReadyError(new Error("Error: host unavailable\n    at x")), true);
  assert.equal(isHostNotReadyError(new Error("host unavailable for provider")), true);
  assert.equal(isHostNotReadyError(new Error("permission denied")), false);
  assert.equal(isHostNotReadyError(undefined), false);
});

test("a host that starts late is waited out", async () => {
  let calls = 0;
  const value = await retryWhileHostNotReady(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("host unavailable");
      return "catalogue";
    },
    { attempts: 4, delayMs: 1 },
  );
  assert.equal(value, "catalogue");
  assert.equal(calls, 3, "retries until the host answers");
});

test("a real failure is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    retryWhileHostNotReady(async () => {
      calls += 1;
      throw new Error("permission denied");
    }, { attempts: 4, delayMs: 1 }),
    /permission denied/,
  );
  assert.equal(calls, 1, "one attempt, no sleeping on an error that will not change");
});

test("giving up rethrows the last host error", async () => {
  let calls = 0;
  await assert.rejects(
    retryWhileHostNotReady(async () => {
      calls += 1;
      throw new Error("host unavailable");
    }, { attempts: 3, delayMs: 1 }),
    /host unavailable/,
  );
  assert.equal(calls, 3, "every attempt is used before giving up");
});
