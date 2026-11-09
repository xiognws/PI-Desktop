import assert from "node:assert/strict";
import test from "node:test";

import {
  curationById,
  skillIdleBadge,
  skillUsageBadge,
  tallySkillUsage,
} from "../src/lib/skill-usage.ts";

/*
 * The settings page shows one usage badge per skill and one tally per level.
 * Both rules exist so a host that never counted cannot be read as "this skill is
 * useless": an absent count is "unknown", only a reported zero is "never used".
 */

test("a reported zero means never used, and no count means no claim at all", () => {
  assert.deepEqual(skillUsageBadge({ useCount: 0 }), { kind: "never" });
  assert.deepEqual(skillUsageBadge({ useCount: 3 }), { kind: "used", count: 3 });
  // An older host omits the field; the row must not accuse the skill.
  assert.equal(skillUsageBadge({}), undefined);
});

test("the tally counts only skills the host actually reported", () => {
  assert.deepEqual(
    tallySkillUsage([{ useCount: 0 }, { useCount: 2 }, {}]),
    { unused: 1, total: 3 },
  );
  assert.deepEqual(tallySkillUsage([]), { unused: 0, total: 0 });
  // Every row unknown: nothing to report, so the header note stays away.
  assert.deepEqual(tallySkillUsage([{}, {}]), { unused: 0, total: 2 });
});

test("only a skill the pass would touch carries an idle badge", () => {
  assert.equal(skillIdleBadge({ id: "a", idleDays: 12, state: "keep" }), undefined);
  assert.deepEqual(skillIdleBadge({ id: "a", idleDays: 40, state: "stale" }), {
    days: 40,
    archivable: false,
  });
  assert.deepEqual(skillIdleBadge({ id: "a", idleDays: 120, state: "archive" }), {
    days: 120,
    archivable: true,
  });
  assert.equal(skillIdleBadge(undefined), undefined);
});

test("the report is keyed by id, so one refresh cannot shift a badge", () => {
  const byId = curationById([
    { id: "one", idleDays: 120, state: "archive" },
    { id: "two", idleDays: 40, state: "stale" },
  ]);
  assert.equal(byId.get("one")?.idleDays, 120);
  assert.equal(byId.get("missing"), undefined);
  assert.equal(curationById(undefined).size, 0);
});
