/**
 * The archive, read the way the settings page draws it (ADR 0395).
 *
 * Archiving **moves** a document into `<skills root>/.archive/`, so the archive
 * is a second list beside the catalog rather than a state a row carries. The
 * page reads one list per library, and the two reads have to become one list of
 * rows here for two reasons:
 *
 * - a row's restore has to name the library it came from, because the same id
 *   can wait in a project's archive and in the global one;
 * - a busy key must never collide with a live row's. `level:id` already names a
 *   catalog row, and a skill can be live again under an id an older copy still
 *   holds in the archive — sharing that key would freeze the wrong row.
 */
import type { AgentCapabilityLevel, UserSkillRecord } from "@pi-workspace/shared";

/** One row of the archived section, with the library it has to be restored to. */
export type ArchivedSkillRow = {
  /** React key and busy-state key, distinct from every live row's key. */
  key: string;
  level: AgentCapabilityLevel;
  skill: UserSkillRecord;
};

/**
 * The archived rows of both libraries, global first.
 *
 * Each read may be missing (no project selected, an older host that does not
 * answer `skills.archived`), and an absent list is simply no rows: the section
 * must not fail the page it is an accessory to.
 */
export function archivedSkillRows(
  global: readonly UserSkillRecord[] | undefined,
  project: readonly UserSkillRecord[] | undefined,
): ArchivedSkillRow[] {
  const at =
    (level: AgentCapabilityLevel) =>
    (skill: UserSkillRecord): ArchivedSkillRow => ({
      key: `archive:${level}:${skill.id}`,
      level,
      skill,
    });
  return [...(global ?? []).map(at("global")), ...(project ?? []).map(at("project"))];
}
