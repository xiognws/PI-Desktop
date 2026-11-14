import assert from "node:assert/strict";
import test from "node:test";

import { applyBulkLimits, bulkLimitDraftIsEmpty } from "../src/lib/model-bulk-limits.ts";

/*
 * Bulk limit editing for one service's models.
 *
 * A service that publishes nothing about its capacities leaves every row at the
 * generic default; the user asked to fix that in one action instead of opening
 * an advanced sheet per model. These cases pin the two properties that make the
 * action safe: it only touches the fields the draft states, and it never leaves
 * a written number looking like a catalog value a refresh may overwrite.
 */

const binding = (id, contextWindow, maxTokens, extra = {}) => ({
  id,
  contextWindow,
  maxTokens,
  thinkingLevels: [],
  defaultThinkingLevel: null,
  ...extra,
});

test("writes both limits and pins them as the user's own numbers", () => {
  const rows = [binding("10292", 128_000, 32_768), binding("12039", 128_000, 32_768)];
  const next = applyBulkLimits(rows, { contextWindow: 1_000_000, maxTokens: 8_192 });
  assert.deepEqual(
    next.map((row) => [row.contextWindow, row.maxTokens]),
    [
      [1_000_000, 8_192],
      [1_000_000, 8_192],
    ],
  );
  assert.equal(
    next.every((row) => row.contextWindowSource === "user" && row.maxTokensSource === "user"),
    true,
  );
});

test("a draft that states one field leaves the other byte-identical", () => {
  const rows = [binding("a", 128_000, 32_768, { maxTokensSource: "catalog" })];
  const [row] = applyBulkLimits(rows, { contextWindow: 200_000 });
  assert.equal(row.contextWindow, 200_000);
  assert.equal(row.contextWindowSource, "user");
  assert.equal(row.maxTokens, 32_768);
  assert.equal(row.maxTokensSource, "catalog");
});

test("an unpinned row equal to the catalog value still becomes the user's", () => {
  const rows = [binding("a", 128_000, 8_192, { contextWindowSource: "catalog" })];
  const [row] = applyBulkLimits(rows, { contextWindow: 128_000 });
  assert.equal(row.contextWindow, 128_000);
  // Same number, different owner: the catalog may not replace it later.
  assert.equal(row.contextWindowSource, "user");
});

test("a draft that changes nothing returns the same array", () => {
  const rows = [binding("a", 128_000, 8_192, { contextWindowSource: "user" })];
  assert.equal(applyBulkLimits(rows, { contextWindow: 128_000 }), rows);
});

test("unusable drafts are inert instead of destructive", () => {
  const rows = [binding("a", 128_000, 8_192)];
  for (const draft of [
    {},
    { contextWindow: null },
    { contextWindow: 0 },
    { contextWindow: -5 },
    { contextWindow: Number.NaN },
    { maxTokens: 2.5 }, // rounds to a whole count rather than dropping it
  ]) {
    const next = applyBulkLimits(rows, draft);
    if (draft.maxTokens === 2.5) {
      assert.equal(next[0].maxTokens, 3);
      assert.equal(next[0].contextWindow, 128_000);
      continue;
    }
    assert.equal(next, rows, `draft ${JSON.stringify(draft)} should be inert`);
  }
});

test("emptiness matches what applying the draft would do", () => {
  assert.equal(bulkLimitDraftIsEmpty({}), true);
  assert.equal(bulkLimitDraftIsEmpty({ contextWindow: 0, maxTokens: null }), true);
  assert.equal(bulkLimitDraftIsEmpty({ maxTokens: 8_192 }), false);
});
