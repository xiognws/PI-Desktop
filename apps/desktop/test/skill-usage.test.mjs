import assert from "node:assert/strict";
import test from "node:test";

import { skillUsageBadge, tallySkillUsage } from "../src/lib/skill-usage.ts";

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
