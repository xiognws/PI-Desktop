import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_BUDGET,
  mergeLegacyInto,
  targetForLegacy,
} from "../src/lib/memory-merge.ts";

test("a preference describes the person, everything else the work", () => {
  assert.equal(targetForLegacy({ kind: "preference" }), "user");
  assert.equal(targetForLegacy({ kind: "Preference" }), "user");
  assert.equal(targetForLegacy({ kind: "fact" }), "memory");
  assert.equal(targetForLegacy({}), "memory");
});

test("title and body become one line, and a body-only record keeps its text", () => {
  const result = mergeLegacyInto(
    [],
    [
      { title: "Cache root", body: "D:/PiWorkspace/cache holds the TMPDIR" },
      { body: "no title here" },
      { title: "Only a title" },
    ],
    "memory",
  );
  assert.deepEqual(result.added, [
    "Cache root: D:/PiWorkspace/cache holds the TMPDIR",
    "no title here",
    "Only a title",
  ]);
});

test("re-running the merge copies nothing twice", () => {
  const legacy = [{ title: "A", body: "one" }, { title: "B", body: "two" }];
  const first = mergeLegacyInto([], legacy, "memory");
  const second = mergeLegacyInto(first.next, legacy, "memory");
  assert.equal(first.added.length, 2);
  assert.equal(second.added.length, 0);
  assert.equal(second.duplicates, 2);
  // Whitespace and case are not new information.
  const third = mergeLegacyInto(["a: ONE"], legacy, "memory");
  assert.equal(third.duplicates, 1);
  assert.equal(third.added.length, 1);
});

test("a record that does not fit the budget is reported, not dropped silently", () => {
  const long = "x".repeat(MEMORY_BUDGET.memory - 10);
  const result = mergeLegacyInto([long], [{ title: "big", body: "y".repeat(50) }], "memory");
  assert.deepEqual(result.added, []);
  assert.equal(result.overflow.length, 1);
  assert.deepEqual(result.next, [long]);
});

test("records only merge into their own store", () => {
  const result = mergeLegacyInto(
    [],
    [{ kind: "preference", body: "prefers terse replies" }, { kind: "fact", body: "disk is D:" }],
    "user",
  );
  assert.deepEqual(result.added, ["prefers terse replies"]);
});

test("an empty input is a no-op rather than an empty write", () => {
  const result = mergeLegacyInto(["keep me"], [], "memory");
  assert.deepEqual(result.next, ["keep me"]);
  assert.deepEqual(result.added, []);
});
