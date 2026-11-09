import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

export type LoadedSkillDocument = {
  id: string;
  name: string;
  body: string;
  /** Absolute path of the loaded SKILL.md document. */
  location: string;
};

/** The container a skill document may own beside itself. */
const REFERENCE_DIRECTORY = "references";
/** A listing is a hint, not a payload: past this many files the model greps. */
const MAX_LISTED_REFERENCES = 50;

/**
 * Reference files that ship beside a `SKILL.md`.
 *
 * `skills.writeFile` accepts exactly `references/<name>.md`, so a flat, sorted
 * listing is the whole truth about what a skill carries beyond its document.
 * A missing directory or an unreadable one is "no references": the load itself
 * already succeeded and must not fail over a listing.
 */
export function listSkillReferences(location: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(dirname(location), REFERENCE_DIRECTORY), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  return entries
    .slice(0, MAX_LISTED_REFERENCES)
    .map((name) => `${REFERENCE_DIRECTORY}/${name}`);
}

/**
 * Add path metadata only when a skill is loaded, not to the catalog prompt.
 *
 * `references` names each file so the model can `Read` the one the document
 * points at without first guessing a filename or globbing the directory.
 */
export function formatSkillToolContent(
  skill: LoadedSkillDocument,
  references: readonly string[] = [],
): string {
  const lines = [
    `# Skill: ${skill.name} (${skill.id})`,
    `Location: ${skill.location}`,
    `References are relative to ${dirname(skill.location)}.`,
  ];
  if (references.length) {
    lines.push(
      "",
      "Reference files in this skill (read one with `Read` when the document points at it):",
      ...references.map((reference) => `- ${reference}`),
    );
  }
  lines.push("", skill.body);
  return lines.join("\n");
}
