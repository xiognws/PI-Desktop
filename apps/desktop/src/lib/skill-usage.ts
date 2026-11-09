/**
 * Skill usage, read the way the settings page needs it.
 *
 * The count is written by the host (`skills.recordUse`) every time the `Skill`
 * tool loads a document. Two rules matter here:
 *
 * - An **absent** `useCount` means "this host does not report usage", not "never
 *   used". An older host omits the field, and calling that "never used" would
 *   invite somebody to delete a skill that works.
 * - A **zero** count is a real answer: no session has ever opened the document.
 */

/** The smallest shape this module needs, so it stays usable from a test. */
export type SkillUsageRecord = { useCount?: number };

export type SkillUsageTally = {
  /** Documents no session has loaded. */
  unused: number;
  /** Every document of that list. */
  total: number;
};

export function tallySkillUsage(skills: readonly SkillUsageRecord[]): SkillUsageTally {
  return {
    unused: skills.filter((skill) => skill.useCount === 0).length,
    total: skills.length,
  };
}

/**
 * The badge a row shows, or `undefined` for "no badge".
 *
 * Kept as data rather than JSX so the wording rule is testable without a render:
 * `never` only when the host said zero, `used` with a count when it said more.
 */
export function skillUsageBadge(
  skill: SkillUsageRecord,
): { kind: "never" } | { kind: "used"; count: number } | undefined {
  if (skill.useCount === undefined) return undefined;
  return skill.useCount === 0 ? { kind: "never" } : { kind: "used", count: skill.useCount };
}
