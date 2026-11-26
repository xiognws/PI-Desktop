import assert from "node:assert/strict";
import test from "node:test";
import { sessionTokensSplit } from "../src/lib/status-bar.ts";

// Smart mode pays the orchestrator and the delegated worker in one turn. The status bar
// shows one figure, so this is the arithmetic that decides what that figure includes.

test("the total covers the worker and the tooltip names its share", () => {
  const split = sessionTokensSplit({
    inputTokens: 30_000, outputTokens: 2_000, cacheReadTokens: 10_000, cacheWriteTokens: 0,
    workerInputTokens: 12_000, workerOutputTokens: 800,
    workerCacheReadTokens: 0, workerCacheWriteTokens: 0,
  });
  assert.equal(split.total, 42_000, "both models are billed");
  assert.equal(split.worker, 12_800);
  assert.equal(split.main, 29_200, "what is left is the orchestrator's own spend");
});

test("a session that never delegated reports no worker half", () => {
  const split = sessionTokensSplit({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.deepEqual(split, { total: 10, main: 10, worker: 0 });
});

test("an older host without the worker fields still totals", () => {
  // The fields are optional: a host that predates them must not produce NaN.
  const split = sessionTokensSplit({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
    workerInputTokens: undefined });
  assert.equal(split.total, 10);
  assert.equal(split.worker, 0);
});

test("a worker total larger than the session never shows a negative main", () => {
  // Defensive: a stale turn row could leave the delegated share ahead of the total
  // briefly. A negative label would be worse than a rounded one.
  const split = sessionTokensSplit({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    workerInputTokens: 25 });
  assert.equal(split.main, 0);
  assert.equal(split.worker, 25);
});
