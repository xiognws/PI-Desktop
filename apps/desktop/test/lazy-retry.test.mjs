import assert from "node:assert/strict";
import test from "node:test";

import { lazyRoute, retryImport } from "../src/lib/lazy-retry.ts";

test("a route whose module fetch fails once still loads", async () => {
  // Measured: the first entry into Settings threw "Failed to fetch dynamically
  // imported module" while the network re-registered, and the only recovery was
  // restarting the app.
  let calls = 0;
  const value = await retryImport(async () => {
    calls += 1;
    if (calls < 2) throw new TypeError("Failed to fetch dynamically imported module");
    return "loaded";
  }, 3, 1);
  assert.equal(value, "loaded");
  assert.equal(calls, 2);
});

test("a permanently broken import still fails, after the bounded attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryImport(async () => {
        calls += 1;
        throw new Error("nope");
      }, 3, 1),
    /nope/,
  );
  assert.equal(calls, 3);
});

test("a successful route caches its module, like `lazy` does", async () => {
  let calls = 0;
  const load = lazyRoute(async () => {
    calls += 1;
    return { default: "page" };
  });
  await load();
  await load();
  assert.equal(calls, 1);
});
