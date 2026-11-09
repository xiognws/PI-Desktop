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

/** The maintenance state of one skill, as the curation report describes it. */
export type SkillCurationRow = { id: string; idleDays: number; state: "keep" | "stale" | "archive" };

/**
 * The row a curation report is about, by id.
 *
 * The report and the skill list are two reads of the same library; keying by id
 * keeps a row's badge correct when one of them refreshes before the other.
 */
export function curationById(
  entries: readonly SkillCurationRow[] | undefined,
): Map<string, SkillCurationRow> {
  return new Map((entries ?? []).map((entry) => [entry.id, entry]));
}

/**
 * The idle badge a row shows, or `undefined`.
 *
 * Only a skill the pass would actually touch carries one: "idle 12 days" on a
 * skill nobody is about to archive is noise next to the used/never badge.
 */
export function skillIdleBadge(
  entry: SkillCurationRow | undefined,
): { days: number; archivable: boolean } | undefined {
  if (!entry || entry.state === "keep") return undefined;
  return { days: entry.idleDays, archivable: entry.state === "archive" };
}
